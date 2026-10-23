import { env } from 'cloudflare:workers'

import { decodeFixture } from './webp-fixtures'

// Stand-ins for the Images binding: the local one with Images' 'rgba' output (localRgba), and a scripted one
// (fakeBinding), each recording every output() it is asked for.

// One output() a stand-in binding was asked for: a copy of the input it was given, its transforms and its options.
export type OutputCall = { input: Uint8Array; transforms: ImageTransform[]; options: ImageOutputOptions }

// The chunks of `stream`, read without detaching them.
async function chunksOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = []
	const reader = stream.getReader()
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		chunks.push(read.value)
	}
	return chunks
}

// How localRgba's 'rgba' output misbehaves, read at each call: `failRgba` an Images error code it fails with;
// `stallRgba` 'output' never answers the output() call, 'read' answers at once (after recording the call) a stream that
// never ends after its first chunk; `rgbaCancelled` counts the cancels of a stalled stream.
export type RgbaControl = { failRgba: number | null; stallRgba: 'output' | 'read' | null; rgbaCancelled: number }

// The local Images binding (or `binding` over it) with Images' 'rgba' output, which miniflare refuses with 9520: the
// chain's still WebP of the same input and transforms, decoded by the fixture decoder and answered as Images answers
// it, a raw buffer of 4 × w × h bytes as application/octet-stream (federation/card-images.ts I15). The binding is given
// the caller's own chunks, so a test can still see that they are not detached. Every output() is recorded.
export function localRgba(
	binding: ImagesBinding = env.IMAGES,
	control: RgbaControl = { failRgba: null, stallRgba: null, rgbaCancelled: 0 }
): { binding: ImagesBinding; outputs: OutputCall[] } {
	const outputs: OutputCall[] = []
	const stand = {
		info: (stream: ReadableStream<Uint8Array>) => binding.info(stream),
		input: (stream: ReadableStream<Uint8Array>) => {
			const transforms: ImageTransform[] = []
			const transformer = {
				transform: (options: ImageTransform) => {
					transforms.push(options)
					return transformer
				},
				output: async (options: ImageOutputOptions) => {
					const chunks = await chunksOf(stream)
					outputs.push({ input: new Uint8Array(await new Blob(chunks).arrayBuffer()), transforms, options })
					let real = binding.input(
						new ReadableStream<Uint8Array>({
							start(controller) {
								chunks.forEach((chunk) => controller.enqueue(chunk))
								controller.close()
							},
						})
					)
					for (const transform of transforms) {
						real = real.transform(transform)
					}
					if (options.format !== 'rgba') {
						return real.output(options)
					}
					if (control.failRgba !== null) {
						throw Object.assign(new Error('injected'), { code: control.failRgba })
					}
					if (control.stallRgba === 'output') {
						return new Promise<never>(() => {})
					}
					if (control.stallRgba === 'read') {
						// Answered at once, before any image work, so the output call takes no time a test's guard could
						// count against it: the read is what stalls.
						const stalled = () =>
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(new Uint8Array(4))
								},
								cancel() {
									control.rgbaCancelled++
								},
							})
						return { image: stalled, contentType: () => 'application/octet-stream' }
					}
					const webp = await real.output({ format: 'image/webp', anim: false })
					const pixels = await decodeFixture(new Uint8Array(await new Response(webp.image()).arrayBuffer()))
					return { image: () => new Blob([pixels.data]).stream(), contentType: () => 'application/octet-stream' }
				},
			}
			return transformer
		},
	}
	return { binding: stand as unknown as ImagesBinding, outputs }
}

// An Images binding whose info() answers `info` (then `outputInfo`), whose WebP output streams `output` or fails with
// `encodeFail`, and whose RGBA output streams `rgba` (none by default) or fails with `rgbaFail`. Every output() is
// recorded in `outputs`.
export function fakeBinding(options: {
	info?: { format: string; width?: number; height?: number }
	output?: ReadableStream<Uint8Array> | Uint8Array
	infoFail?: number
	outputInfoFail?: number
	encodeFail?: number
	outputInfo?: { format: string; width?: number; height?: number }
	rgba?: ReadableStream<Uint8Array> | Uint8Array
	rgbaFail?: number
}): ImagesBinding & { outputs: OutputCall[] } {
	let infos = 0
	const outputs: OutputCall[] = []
	const fail = (code: number) => Promise.reject(Object.assign(new Error('injected'), { code }))
	const body = (from: ReadableStream<Uint8Array> | Uint8Array | undefined) =>
		from instanceof ReadableStream ? from : new Blob([from ?? new Uint8Array()]).stream()
	const binding = {
		info: () => {
			infos++
			if (options.infoFail !== undefined && infos === 1) {
				return fail(options.infoFail)
			}
			if (options.outputInfoFail !== undefined && infos === 2) {
				return fail(options.outputInfoFail)
			}
			return Promise.resolve(infos === 1 ? options.info : (options.outputInfo ?? options.info))
		},
		input: (stream: ReadableStream<Uint8Array>) => {
			const transforms: ImageTransform[] = []
			const transformer = {
				transform: (transform: ImageTransform) => {
					transforms.push(transform)
					return transformer
				},
				output: async (output: ImageOutputOptions) => {
					const input = new Uint8Array(await new Blob(await chunksOf(stream)).arrayBuffer())
					outputs.push({ input, transforms, options: output })
					if (output.format === 'rgba') {
						return options.rgbaFail !== undefined
							? fail(options.rgbaFail)
							: { image: () => body(options.rgba), contentType: () => 'application/octet-stream' }
					}
					return options.encodeFail !== undefined
						? fail(options.encodeFail)
						: { image: () => body(options.output), contentType: () => 'image/webp' }
				},
			}
			return transformer
		},
	}
	return Object.assign(binding as unknown as ImagesBinding, { outputs })
}
