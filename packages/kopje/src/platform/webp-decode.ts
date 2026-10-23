// Decodes a WebP to RGBA in the Worker, for a card image's blurhash (federation/card-images.ts). The decoder is
// libwebp built to wasm by @jsquash/webp (pinned in package.json). It is instantiated explicitly from the compiled
// module, as jSquash's Workers example does, so nothing is fetched and the .wasm ships beside dist/worker.js.
//
// Memory (RES-6, AM16): the module's own memory starts at 256 pages and declares a maximum of 32,768. Every growth goes
// through the instance's exported memory as Emscripten's resize hook calls it, so the instance is handed a memory
// whose grow() refuses past DECODER_MEMORY_PAGES: the allocation fails inside libwebp, which answers null (or
// aborts), and decodeWebp answers null. After an abort the instance is dropped and never replaced in this isolate, so
// at most one instance (DECODER_MEMORY_BYTES) is ever held. A backstop reads the real memory after every call.
import webpDecoderFactory from '@jsquash/webp/codec/dec/webp_dec.js'
import webpDecoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm'

const WASM_PAGE_BYTES = 65_536
const DECODER_MEMORY_PAGES = 256
// W in the cron memory model (test/card-image-memory.test.ts).
export const DECODER_MEMORY_BYTES = DECODER_MEMORY_PAGES * WASM_PAGE_BYTES

export type Rgba = { data: Uint8ClampedArray; width: number; height: number }

type DecoderModule = { decode(data: BufferSource): Rgba | null }
type Instance = { module: DecoderModule; memory: WebAssembly.Memory }

// The memory the Emscripten glue sees: reads pass through, growth is refused past the cap.
function cappedMemory(memory: WebAssembly.Memory): WebAssembly.Memory {
	return {
		get buffer() {
			return memory.buffer
		},
		grow(pages: number) {
			if (memory.buffer.byteLength / WASM_PAGE_BYTES + pages > DECODER_MEMORY_PAGES) {
				throw new RangeError('decoder memory cap')
			}
			return memory.grow(pages)
		},
	}
}

// The glue builds its result with `new ImageData(data, width, height)` and installs this same shape itself only when it
// recognizes workerd; it is installed here when the runtime has none.
class RgbaImage {
	constructor(
		readonly data: Uint8ClampedArray,
		readonly width: number,
		readonly height: number
	) {}
}

async function instantiate(): Promise<Instance> {
	const global = globalThis as { ImageData?: unknown }
	global.ImageData ??= RgbaImage
	const exported = WebAssembly.Module.exports(webpDecoderWasm).find((entry) => entry.kind === 'memory')
	if (exported === undefined) {
		throw new Error('the decoder exports no memory')
	}
	let memory: WebAssembly.Memory | undefined
	const factory = webpDecoderFactory as unknown as (options: object) => Promise<DecoderModule>
	const module = await factory({
		noInitialRun: true,
		instantiateWasm(imports: WebAssembly.Imports, done: (instance: { exports: object }) => void) {
			const instance = new WebAssembly.Instance(webpDecoderWasm, imports)
			memory = instance.exports[exported.name] as WebAssembly.Memory
			done({ exports: { ...instance.exports, [exported.name]: cappedMemory(memory) } })
			return {}
		},
	})
	if (memory === undefined || memory.buffer.byteLength > DECODER_MEMORY_BYTES) {
		throw new Error('the decoder memory is not within its cap')
	}
	return { module, memory }
}

// Module scope: kept across rounds in one isolate (the W term). `spent` after a failure that may leave the instance's
// heap inconsistent.
let current: Promise<Instance> | null = null
let spent = false

// The RGBA of `bytes`, or null when the decoder refuses them, runs out of its capped memory, or is spent.
export async function decodeWebp(bytes: Uint8Array): Promise<Rgba | null> {
	if (spent) {
		return null
	}
	current ??= instantiate()
	let instance: Instance
	try {
		instance = await current
	} catch {
		spent = true
		current = null
		return null
	}
	try {
		const result = instance.module.decode(bytes)
		if (instance.memory.buffer.byteLength > DECODER_MEMORY_BYTES) {
			throw new RangeError('decoder memory past its cap')
		}
		if (result === null || !(result.data instanceof Uint8ClampedArray)) {
			return null
		}
		if (result.data.byteLength !== result.width * result.height * 4) {
			return null
		}
		return { data: result.data, width: result.width, height: result.height }
	} catch {
		spent = true
		current = null
		return null
	}
}

// What a test reads: the real memory's size, and whether the decoder is spent.
export async function decoderState(): Promise<{ memoryBytes: number | null; spent: boolean }> {
	if (current === null) {
		return { memoryBytes: null, spent }
	}
	const instance = await current
	return { memoryBytes: instance.memory.buffer.byteLength, spent }
}
