import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { ANIMATED_GIF, ANIMATED_WEBP, APNG, PNG_PLAIN, WEBP_PLAIN, WIDE_PNG } from './fixtures/images'
import { bytes, TestCodec } from './media-helpers'
import { imageBlurhash } from '../src/platform/blurhash'
import { isAnimated } from '../src/platform/image-bytes'
import {
	type EncodeOptions,
	ImageCodecError,
	imagesCodec,
	PREVIEW_RGBA_LIMIT,
	processImage,
	type ProcessOptions,
	RGBA_CALL_MS,
	RGBA_MIN_CALL_MS,
	SMALL_EDGE,
} from '../src/platform/images'

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
	it('asks for anim: true only for a WebP output without `still`', async () => {
		const { binding, recorded } = recordingBinding(bytes(WEBP_PLAIN))
		const codec = imagesCodec(binding)
		expect(await codec.encode(bytes(PNG_PLAIN), { width: 4, height: 3, format: 'image/webp', still: true })).toEqual(
			bytes(WEBP_PLAIN)
		)
		await codec.encode(bytes(PNG_PLAIN), { format: 'image/webp' })
		await codec.encode(bytes(PNG_PLAIN), { format: 'image/png' })
		expect(recorded).toEqual({
			input: 3,
			transforms: [{ width: 4, height: 3, fit: 'scale-down' }],
			output: [
				{ format: 'image/webp', anim: false },
				{ format: 'image/webp', anim: true },
				{ format: 'image/png', anim: false },
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

// The preview's blurhash (platform/images.ts processImage, previewBlurhash): Images' RGBA output of the preview's own
// input and transformation, read within 4 × w × h of its checked size; any failure keeps the image without one.
describe('processImage, the preview blurhash', () => {
	// The RGBA output given up a minute from now (by the real clock), as an upload's would be.
	const hashed = (end = Date.now() + 60_000): ProcessOptions => ({ blurhash: { end, now: Date.now } })

	// The bytes of every RGBA output the codec answered.
	function recordRgba(codec: TestCodec): Uint8Array[] {
		const seen: Uint8Array[] = []
		const encode = codec.encode.bind(codec)
		codec.encode = async (input: Uint8Array, options: EncodeOptions) => {
			const output = await encode(input, options)
			if (options.format === 'rgba') {
				seen.push(output.slice())
			}
			return output
		}
		return seen
	}

	it('asks for the RGBA of the preview: its input and transformation, within 4 × w × h of its checked size', async () => {
		expect(PREVIEW_RGBA_LIMIT).toBe(4 * SMALL_EDGE ** 2)
		const codec = new TestCodec()
		const result = await processImage(codec, bytes(WIDE_PNG), hashed())
		if (!result.ok) {
			throw new Error(result.reason)
		}
		const { small } = result.image
		const [full, preview, rgba] = codec.outputs
		expect(codec.outputs).toHaveLength(3)
		// The full image's bytes, not the original's; the preview's transformation, not the full image's.
		expect(rgba?.input).toEqual(preview?.input)
		expect(rgba?.input).not.toEqual(bytes(WIDE_PNG))
		expect(rgba?.transforms).toEqual(preview?.transforms)
		expect(rgba?.transforms).not.toEqual(full?.transforms)
		expect(rgba?.options).toEqual({ format: 'rgba', anim: false })
		expect(codec.encodeCalls[2]).toEqual({
			width: 640,
			height: 160,
			format: 'rgba',
			limit: 4 * small.width * small.height,
			guard: expect.any(Function),
		})
		expect(result.blurhashStop).toBeNull()
	})

	it("reads the RGBA within the preview's checked size, not the size it asked for", async () => {
		const codec = new TestCodec()
		const info = codec.info.bind(codec)
		// The preview's info() (the third) answers half the asked size.
		codec.info = async (input: Uint8Array) =>
			codec.infoCalls === 2 ? (codec.infoCalls++, { format: 'image/png', width: 320, height: 80 }) : info(input)
		const result = await processImage(codec, bytes(WIDE_PNG), hashed())
		expect(result.ok && result.image.small).toMatchObject({ width: 320, height: 80 })
		expect(codec.encodeCalls[2]).toMatchObject({ width: 640, height: 160, format: 'rgba', limit: 4 * 320 * 80 })
		// The output, of the asked size, is past that bound.
		expect(result.ok && result.image.blurhash).toBeNull()
	})

	it('computes the 4 × 4 blurhash of the pixels Images answered', async () => {
		const codec = new TestCodec()
		const seen = recordRgba(codec)
		const result = await processImage(codec, bytes(WIDE_PNG), hashed())
		if (!result.ok) {
			throw new Error(result.reason)
		}
		const { small, blurhash } = result.image
		expect(blurhash).toHaveLength(36)
		expect(blurhash?.[0]).toBe('U')
		expect(seen).toHaveLength(1)
		const data = new Uint8ClampedArray(seen[0]!.buffer)
		expect(blurhash).toBe(imageBlurhash({ data, width: small.width, height: small.height }))
	})

	it.each([
		['one byte short', -1],
		['one byte long', 1],
	])('keeps the image without a blurhash for an RGBA output %s', async (_name, delta) => {
		const codec = new TestCodec()
		codec.encodeResponder = (options) =>
			options.format === 'rgba' ? new Uint8Array((options.limit ?? 0) + delta).fill(200) : null
		const result = await processImage(codec, bytes(WIDE_PNG), hashed())
		expect(codec.encodeCalls.map((call) => call.format)).toEqual(['image/png', 'image/png', 'rgba'])
		expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: null })
	})

	it.each<[number, 'quota' | null]>([
		[9422, 'quota'],
		[9520, null],
		[9523, null],
	])('keeps the image without a blurhash when the RGBA output fails with %i', async (code, stop) => {
		const codec = new TestCodec()
		codec.failRgba = code
		const result = await processImage(codec, bytes(WIDE_PNG), hashed())
		expect(codec.outputs.map((call) => call.options.format)).toEqual(['image/png', 'image/png', 'rgba'])
		expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: stop })
		expect(result.ok && result.image.small.bytes.length).toBeGreaterThan(0)
	})

	// processImage reads `now` only for the RGBA output, so a clock it is given fixes the time left after the preview
	// whatever the preview took.
	const T = Date.parse('2026-10-12T00:00:00.000Z')

	it.each(['output', 'read'] as const)(
		'gives up a stalled RGBA %s at its end, cancelling the read, and keeps the image',
		async (stall) => {
			const codec = new TestCodec()
			codec.stallRgba = stall
			// RGBA_MIN_CALL_MS and 300 ms left at a stopped clock: the end comes before RGBA_CALL_MS.
			const result = await processImage(codec, bytes(WIDE_PNG), {
				blurhash: { end: T + RGBA_MIN_CALL_MS + 300, now: () => T },
			})
			expect(codec.outputs.map((call) => call.options.format)).toEqual(['image/png', 'image/png', 'rgba'])
			expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: 'deadline' })
			expect(codec.rgbaCancelled).toBe(stall === 'read' ? 1 : 0)
		},
		30_000
	)

	it.each(['output', 'read'] as const)(
		'gives up a stalled RGBA %s RGBA_CALL_MS after it starts, long before its end',
		async (stall) => {
			expect(RGBA_CALL_MS).toBeLessThan(10 * 60_000)
			const codec = new TestCodec()
			codec.stallRgba = stall
			// Each reading of the clock is RGBA_CALL_MS - 300 ms later: the skip check, the cap's start, then the guard,
			// which has 300 ms of the cap left; the end is ten minutes away.
			let reads = 0
			const now = () => T + reads++ * (RGBA_CALL_MS - 300)
			const started = Date.now()
			const result = await processImage(codec, bytes(WIDE_PNG), { blurhash: { end: T + 10 * 60_000, now } })
			expect(Date.now() - started).toBeLessThan(25_000)
			expect(codec.outputs.map((call) => call.options.format)).toEqual(['image/png', 'image/png', 'rgba'])
			expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: 'deadline' })
			expect(codec.rgbaCancelled).toBe(stall === 'read' ? 1 : 0)
		},
		30_000
	)

	it('does not ask for the RGBA with less than RGBA_MIN_CALL_MS before its end', async () => {
		const codec = new TestCodec()
		const result = await processImage(codec, bytes(WIDE_PNG), {
			blurhash: { end: T + RGBA_MIN_CALL_MS - 1, now: () => T },
		})
		expect(codec.encodeCalls.map((call) => call.format)).toEqual(['image/png', 'image/png'])
		expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: 'deadline' })
	})

	it('asks for no RGBA without the option (a custom emoji)', async () => {
		const codec = new TestCodec()
		const result = await processImage(codec, bytes(WIDE_PNG))
		expect(codec.outputs.map((call) => call.options.format)).toEqual(['image/png', 'image/png'])
		expect(result).toMatchObject({ ok: true, image: { blurhash: null }, blurhashStop: null })
	})
})
