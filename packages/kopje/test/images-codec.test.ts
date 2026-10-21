import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { ANIMATED_GIF, ANIMATED_WEBP, APNG, PNG_PLAIN, WEBP_PLAIN } from './fixtures/images'
import { bytes, TestCodec } from './media-helpers'
import { isAnimated } from '../src/platform/image-bytes'
import { ImageCodecError, imagesCodec, processImage } from '../src/platform/images'

// The chunks of a PNG (type, data) and of a WebP, walked plainly to check the fixtures.
function pngChunks(file: Uint8Array): { type: string; data: Uint8Array }[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
	const chunks = []
	for (let i = 8; i + 12 <= file.length; i += 12 + view.getUint32(i)) {
		const length = view.getUint32(i)
		chunks.push({
			type: String.fromCharCode(...file.subarray(i + 4, i + 8)),
			data: file.subarray(i + 8, i + 8 + length),
		})
	}
	return chunks
}

function webpChunks(file: Uint8Array): string[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
	const chunks = []
	for (let i = 12; i + 8 <= file.length;) {
		const length = view.getUint32(i + 4, true)
		chunks.push(String.fromCharCode(...file.subarray(i, i + 4)))
		i += 8 + length + (length % 2)
	}
	return chunks
}

// The image descriptors of a GIF (GIF89a: header, logical screen descriptor, global colour table, then blocks).
function gifFrames(file: Uint8Array): number {
	let i = 13 + ((file[10] ?? 0) & 0x80 ? 3 * 2 ** (((file[10] ?? 0) & 7) + 1) : 0)
	const subBlocks = () => {
		while ((file[i] ?? 0) !== 0) {
			i += (file[i] ?? 0) + 1
		}
		i += 1
	}
	let frames = 0
	while (i < file.length && file[i] !== 0x3b) {
		if (file[i] === 0x21) {
			i += 2
			subBlocks()
		} else if (file[i] === 0x2c) {
			const packed = file[i + 9] ?? 0
			i += 10 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1
			subBlocks()
			frames++
		} else {
			throw new Error(`unexpected GIF block at ${i}`)
		}
	}
	return frames
}

type Recorded = { input: number; transforms: unknown[]; output: unknown[] }

// An ImagesBinding that records what the adapter asks for and answers with `answer`, or fails with `fail`.
function recordingBinding(answer: Uint8Array, fail?: { code: number; message: string }) {
	const recorded: Recorded = { input: 0, transforms: [], output: [] }
	const transformer = {
		transform(transform: unknown) {
			recorded.transforms.push(transform)
			return transformer
		},
		output(options: unknown) {
			recorded.output.push(options)
			if (fail !== undefined) {
				return Promise.reject(Object.assign(new Error(fail.message), { code: fail.code }))
			}
			return Promise.resolve({ image: () => new Blob([answer]).stream(), contentType: () => 'image/webp' })
		},
	}
	const binding = {
		info: () => Promise.resolve({ format: 'image/webp', width: 3, height: 2, fileSize: answer.length }),
		input: () => {
			recorded.input++
			return transformer
		},
	}
	return { binding: binding as unknown as ImagesBinding, recorded }
}

describe('imagesCodec', () => {
	it('asks for anim: false with `still`, and anim: true without it', async () => {
		const { binding, recorded } = recordingBinding(bytes(WEBP_PLAIN))
		const codec = imagesCodec(binding)
		expect(await codec.encode(bytes(PNG_PLAIN), { width: 4, height: 3, format: 'image/webp', still: true })).toEqual(
			bytes(WEBP_PLAIN)
		)
		await codec.encode(bytes(PNG_PLAIN), { format: 'image/png' })
		expect(recorded).toEqual({
			input: 2,
			transforms: [{ width: 4, height: 3, fit: 'scale-down' }],
			output: [
				{ format: 'image/webp', anim: false },
				{ format: 'image/png', anim: true },
			],
		})
		expect(await codec.info(bytes(WEBP_PLAIN))).toMatchObject({ format: 'image/webp', width: 3, height: 2 })
	})

	it('maps a binding error to its Images code', async () => {
		const { binding } = recordingBinding(new Uint8Array(), { code: 9422, message: 'quota' })
		const error = await imagesCodec(binding)
			.encode(bytes(PNG_PLAIN), { format: 'image/png' })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ImageCodecError)
		expect(error).toMatchObject({ code: 9422, message: 'quota' })
	})
})

describe('animated fixtures', () => {
	it('are decoded by the local binding and really hold two frames', async () => {
		const real = imagesCodec(env.IMAGES)
		expect(await real.info(bytes(ANIMATED_WEBP))).toMatchObject({ format: 'image/webp', width: 8, height: 6 })
		expect(await real.info(bytes(APNG))).toMatchObject({ format: 'image/png', width: 8, height: 6 })
		expect(webpChunks(bytes(ANIMATED_WEBP)).filter((type) => type === 'ANMF')).toHaveLength(2)
		const apng = pngChunks(bytes(APNG))
		const acTL = apng.find((chunk) => chunk.type === 'acTL')
		expect(acTL === undefined ? 0 : new DataView(acTL.data.buffer, acTL.data.byteOffset).getUint32(0)).toBe(2)
		expect(apng.filter((chunk) => chunk.type === 'fdAT')).toHaveLength(1)
		expect(gifFrames(bytes(ANIMATED_GIF))).toBeGreaterThanOrEqual(2)
	})
})

describe('processImage of an animated upload', () => {
	it('encodes the preview as a still and reports which output is animated', async () => {
		const codec = new TestCodec()
		// The full image stands in for Images keeping the frames; the preview comes from the local binding.
		codec.encodeResponder = (_options, index) => (index === 0 ? bytes(ANIMATED_WEBP) : null)
		const result = await processImage(codec, bytes(ANIMATED_WEBP))
		expect(codec.encodeCalls).toEqual([
			{ format: 'image/webp' },
			{ width: 8, height: 6, format: 'image/webp', still: true },
		])
		if (!result.ok) {
			throw new Error(result.reason)
		}
		expect([result.image.full.animated, result.image.small.animated]).toEqual([true, false])
		expect(isAnimated(result.image.small.bytes, 'image/webp')).toBe(false)
	})

	it('fails when the preview asked for as a still is animated', async () => {
		const codec = new TestCodec()
		codec.encodeResponder = () => bytes(ANIMATED_WEBP)
		expect(await processImage(codec, bytes(ANIMATED_WEBP))).toEqual({
			ok: false,
			reason: 'failed',
			detail: 'output is animated',
		})
	})

	it('reads a GIF as still through the local binding, which decodes one frame (the real one: docs/setup.md)', async () => {
		const result = await processImage(new TestCodec(), bytes(ANIMATED_GIF))
		expect(result.ok && [result.image.full.animated, result.image.small.animated]).toEqual([false, false])
	})
})
