// WebP images built in workerd for the decoder and card image suites, with libwebp's own encoder from the pinned
// @jsquash/webp (a devDependency the Worker never bundles: only test files import this module).
import webpDecoderFactory from '@jsquash/webp/codec/dec/webp_dec.js'
import webpDecoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm'
import webpEncoderFactory from '@jsquash/webp/codec/enc/webp_enc.js'
import webpEncoderWasm from '@jsquash/webp/codec/enc/webp_enc.wasm'
import { defaultOptions } from '@jsquash/webp/meta.js'

type Encoder = { encode(data: BufferSource, width: number, height: number, options: object): Uint8Array | null }
type Decoder = { decode(data: BufferSource): { data: Uint8ClampedArray; width: number; height: number } | null }

function instantiate<T>(factory: unknown, wasm: WebAssembly.Module, exported?: (exports: object) => void): Promise<T> {
	return (factory as (options: object) => Promise<T>)({
		noInitialRun: true,
		instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
			const instance = new WebAssembly.Instance(wasm, imports)
			exported?.(instance.exports)
			done(instance)
			return {}
		},
	})
}

let encoder: Promise<Encoder> | null = null

// Deterministic noise (or one colour), so a lossy encoder cannot shrink the decoder's work to nothing.
export function rgba(width: number, height: number, fill: 'noise' | 'flat' = 'noise'): Uint8ClampedArray {
	const data = new Uint8ClampedArray(width * height * 4)
	let seed = 0x9e3779b9
	for (let i = 0; i < data.length; i++) {
		if (fill === 'flat') {
			data[i] = i % 4 === 3 ? 255 : 128
			continue
		}
		seed = (seed ^ (seed << 13)) >>> 0
		seed = (seed ^ (seed >>> 17)) >>> 0
		seed = (seed ^ (seed << 5)) >>> 0
		data[i] = seed & 0xff
	}
	return data
}

export async function encodeWebp(
	width: number,
	height: number,
	options: { fill?: 'noise' | 'flat'; lossless?: boolean; quality?: number } = {}
): Promise<Uint8Array> {
	encoder ??= instantiate<Encoder>(webpEncoderFactory, webpEncoderWasm)
	const result = (await encoder).encode(rgba(width, height, options.fill), width, height, {
		...defaultOptions,
		quality: options.quality ?? 75,
		method: 0,
		lossless: options.lossless === true ? 1 : 0,
	})
	if (result === null) {
		throw new Error('encoding failed')
	}
	return new Uint8Array(result)
}

// The same decoder as src/platform/webp-decode.ts without its memory cap: what the capped one refuses, this one
// decodes, so a refusal is the cap's doing.
export async function uncappedDecode(bytes: Uint8Array): Promise<{ width: number; memoryBytes: number } | null> {
	let memory: WebAssembly.Memory | undefined
	const decoder = await instantiate<Decoder>(webpDecoderFactory, webpDecoderWasm, (exports) => {
		memory = Object.values(exports).find((value) => value instanceof WebAssembly.Memory)
	})
	const result = decoder.decode(bytes)
	return result === null || memory === undefined ? null : { width: result.width, memoryBytes: memory.buffer.byteLength }
}
