import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { fakeBinding, localRgba, type OutputCall } from './card-image-helpers'
import { GIF, PNG_PLAIN } from './fixtures/images'
import { bytes } from './media-helpers'
import { decodeFixture, encodeWebp, rgba } from './webp-fixtures'
import { type CardImageHooks, cardImageTarget, processCardImage } from '../src/federation/card-images'
import { fitRgba, cardBlurhash } from '../src/platform/blurhash'
import { DeadlinePassed } from '../src/platform/deadline'
import { webpSize } from '../src/platform/image-bytes'
import { type CodecInput, encodeRgba, type ImageCodec, imagesCodec } from '../src/platform/images'
import {
	CARD_DECODE_PIXELS,
	CARD_IMAGE_OUTPUT_LIMIT,
	CARD_IMAGE_PIXELS,
	storedBlurhash,
} from '../src/platform/stored-bounds'

// One claim's steps after its fetch (federation/card-images.ts processCardImage, I4-I15), over the local Images
// binding and over fakes of it.

// Hooks that record the admissions; `starts` answers admission #2 in turn (then 'ok').
const hooks = (
	overrides: Partial<CardImageHooks> = {},
	starts: ('ok' | 'budget' | 'lost')[] = []
): CardImageHooks & { calls: string[] } => {
	const calls: string[] = []
	return {
		calls,
		guard: (work) => work(),
		admit: () => {
			calls.push('admit')
			return Promise.resolve(true)
		},
		start: () => {
			calls.push('start')
			return Promise.resolve(starts.shift() ?? 'ok')
		},
		...overrides,
	}
}

const formats = (binding: { outputs: OutputCall[] }) => binding.outputs.map((call) => call.options.format)

describe('the target size (AM13)', () => {
	it('keeps an image of at most CARD_IMAGE_PIXELS, and floors a larger one into the box', () => {
		expect(cardImageTarget({ width: 480, height: 480 })).toBeNull()
		expect(cardImageTarget({ width: 1200, height: 500 })).toEqual({ width: 743, height: 309 })
		// Mastodon's round would ask for 744 × 310 = 230,640 pixels.
		expect(Math.round(Math.sqrt(230_400 * 2.4)) * Math.round(Math.sqrt(230_400 / 2.4))).toBe(230_640)
		for (const [w, h] of [
			[1200, 500],
			[65_535, 4],
			[4, 65_535],
			[4000, 3000],
			[481, 480],
			[100_000, 3],
		]) {
			const target = cardImageTarget({ width: w!, height: h! })!
			expect(target.width * target.height, `${w}x${h}`).toBeLessThanOrEqual(CARD_IMAGE_PIXELS)
			expect(target.width).toBeLessThanOrEqual(w!)
			expect(target.height).toBeLessThanOrEqual(h!)
			expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(1)
		}
		// The decode bound: the box plus one line of the longer edge Images may round up, for edges up to 31,744.
		expect(CARD_IMAGE_PIXELS + 31_744).toBe(CARD_DECODE_PIXELS)
		expect(CARD_DECODE_PIXELS * 4).toBe(1_048_576)
	})
})

describe('processCardImage over the local binding', () => {
	it('asks for 743 × 309 for a 1,200 × 500 image (I19) and stores what fits it, reading its input without a copy', async () => {
		const input = await encodeWebp(1200, 500)
		const before = input.byteLength
		// The local binding, its transforms recorded.
		const transforms: ImageTransform[] = []
		const recording = {
			info: (stream: ReadableStream<Uint8Array>) => env.IMAGES.info(stream),
			input: (stream: ReadableStream<Uint8Array>) => {
				let transformer = env.IMAGES.input(stream)
				const wrapper = {
					transform: (options: ImageTransform) => {
						transforms.push(options)
						transformer = transformer.transform(options)
						return wrapper
					},
					output: (options: ImageOutputOptions) => transformer.output(options),
				}
				return wrapper
			},
		} as unknown as ImagesBinding
		const box = { bytes: input as Uint8Array | null }
		const h = hooks()
		const local = localRgba(recording)
		const result = await processCardImage(imagesCodec(local.binding), box, h)
		// Both outputs (A5): the same original bytes and transformation, one charge right before each.
		expect(transforms).toEqual([
			{ width: 743, height: 309, fit: 'scale-down' },
			{ width: 743, height: 309, fit: 'scale-down' },
		])
		expect(local.outputs.map((call) => call.options)).toEqual([
			{ format: 'image/webp', anim: false },
			{ format: 'rgba', anim: false },
		])
		for (const call of local.outputs) {
			expect(call.input).toEqual(input)
		}
		expect(h.calls).toEqual(['admit', 'start', 'start'])
		if (result.kind !== 'encoded') {
			throw new Error(`not encoded: ${JSON.stringify(result)}`)
		}
		// The local binding fits 742 × 309 in the box; Images may round the other edge up by one (CARD_DECODE_PIXELS).
		expect(result.width).toBeLessThanOrEqual(743)
		expect(result.height).toBeLessThanOrEqual(310)
		expect(result.width * result.height).toBeLessThanOrEqual(CARD_DECODE_PIXELS)
		expect(webpSize(result.bytes)).toEqual({ width: result.width, height: result.height })
		expect(result.bytes.byteLength).toBeLessThanOrEqual(CARD_IMAGE_OUTPUT_LIMIT)
		expect(result).toMatchObject({ stop: false })
		// The blurhash is of the stored image's own pixels at its header's size.
		expect(result.blurhash).toBe(cardBlurhash(await decodeFixture(result.bytes)))
		expect(result.blurhash).toHaveLength(36)
		expect(storedBlurhash(result.blurhash)).toBe(result.blurhash)
		expect(box.bytes).toBeNull()
		// The stream path (AM13): the binding read the caller's bytes without detaching them, three times (info and the
		// two outputs).
		expect(input.byteLength).toBe(before)
	})

	it('selects the stream path: the local binding never detaches the chunk of a stream', async () => {
		const input = await encodeWebp(64, 48)
		for (const mode of ['stream', 'blob'] satisfies CodecInput[]) {
			const codec = imagesCodec(env.IMAGES, { input: mode })
			expect(await codec.info(input)).toMatchObject({ format: 'image/webp', width: 64, height: 48 })
			await codec.encode(input, { format: 'image/webp', still: true, limit: CARD_IMAGE_OUTPUT_LIMIT })
			expect(input.byteLength, mode).toBeGreaterThan(0)
		}
	})

	it('stores a small PNG and a GIF at their own size as a still WebP, with a blurhash', async () => {
		for (const fixture of [PNG_PLAIN, GIF]) {
			const result = await processCardImage(imagesCodec(localRgba().binding), { bytes: bytes(fixture) }, hooks())
			expect(result).toMatchObject({ kind: 'encoded', stop: false, blurhash: expect.stringMatching(/^.{36}$/) })
		}
	})

	it('keeps the image without a blurhash where the binding refuses the RGBA output (the local one: 9520)', async () => {
		const box = { bytes: (await encodeWebp(64, 48)) as Uint8Array | null }
		const h = hooks()
		const result = await processCardImage(imagesCodec(env.IMAGES), box, h)
		expect(result).toMatchObject({ kind: 'encoded', width: 64, height: 48, blurhash: null, stop: false })
		expect(h.calls).toEqual(['admit', 'start', 'start'])
		expect(box.bytes).toBeNull()
	})
})

describe('the transitions of processCardImage (I4-I15)', () => {
	const WEBP = { format: 'image/webp', width: 64, height: 48 }
	const run = (codec: ImageCodec, input: Uint8Array, h = hooks()) => processCardImage(codec, { bytes: input }, h)

	it('I4: refuses a signature that is not JPEG, PNG, GIF or WebP before any admission', async () => {
		const h = hooks()
		const codec = imagesCodec(fakeBinding({ info: WEBP }))
		for (const body of [new Uint8Array([0x3c, 0x73, 0x76, 0x67]), new TextEncoder().encode('<html>')]) {
			expect(await run(codec, body, h)).toEqual({ kind: 'none', reason: 'type' })
		}
		expect(h.calls).toEqual([])
	})

	it('I5, I9: a refused admission is lost; a share used up is unattempted without stopping the round', async () => {
		const input = await encodeWebp(64, 48)
		const codec = imagesCodec(fakeBinding({ info: WEBP }))
		expect(await run(codec, input, hooks({ admit: () => Promise.resolve(false) }))).toEqual({ kind: 'lost' })
		expect(await run(codec, input, hooks({ start: () => Promise.resolve('lost') }))).toEqual({ kind: 'lost' })
		expect(await run(codec, input, hooks({ start: () => Promise.resolve('budget') }))).toEqual({
			kind: 'unattempted',
			reason: 'budget',
			stop: false,
		})
	})

	it('I6-I8: refuses another format, no size, too many pixels or a target edge past 65,535, before the start', async () => {
		const input = await encodeWebp(64, 48)
		const gif = bytes(GIF)
		for (const [body, info, reason] of [
			[input, { format: 'image/png', width: 64, height: 48 }, 'info'],
			[input, { format: 'image/webp' }, 'info'],
			[input, { format: 'image/webp', width: 0, height: 48 }, 'info'],
			[input, { format: 'image/webp', width: 4096, height: 4097 }, 'pixels'],
			[gif, { format: 'image/gif', width: 961, height: 960 }, 'pixels'],
			[input, { format: 'image/webp', width: 65_536, height: 1 }, 'edge'],
			[input, { format: 'image/webp', width: 3_000_000, height: 5 }, 'edge'],
		] as const) {
			const h = hooks()
			expect(await run(imagesCodec(fakeBinding({ info })), body, h), JSON.stringify(info)).toEqual({
				kind: 'none',
				reason,
			})
			expect(h.calls).toEqual(['admit'])
		}
		// At the limits: 16,777,216 pixels, and a GIF of 921,600.
		for (const [body, info] of [
			[input, { format: 'image/webp', width: 4096, height: 4096 }],
			[gif, { format: 'image/gif', width: 960, height: 960 }],
		] as const) {
			const h = hooks()
			await run(imagesCodec(fakeBinding({ info, encodeFail: 9520 })), body, h)
			expect(h.calls).toEqual(['admit', 'start'])
		}
	})

	it('I11: error 9422 from either info() or encode is unattempted and stops the round; I12 others are no image', async () => {
		const input = await encodeWebp(64, 48)
		expect(await run(imagesCodec(fakeBinding({ info: WEBP, infoFail: 9422 })), input)).toEqual({
			kind: 'unattempted',
			reason: 'quota',
			stop: true,
		})
		expect(await run(imagesCodec(fakeBinding({ info: WEBP, encodeFail: 9422 })), input)).toEqual({
			kind: 'unattempted',
			reason: 'quota',
			stop: true,
		})
		// The output's info() is an Images call too.
		const output = await encodeWebp(64, 48)
		expect(await run(imagesCodec(fakeBinding({ info: WEBP, output, outputInfoFail: 9422 })), input)).toEqual({
			kind: 'unattempted',
			reason: 'quota',
			stop: true,
		})
		for (const code of [9412, 9413, 9520, 5000]) {
			expect((await run(imagesCodec(fakeBinding({ info: WEBP, encodeFail: code })), input)).kind).toBe('none')
			expect((await run(imagesCodec(fakeBinding({ info: WEBP, infoFail: code })), input)).kind).toBe('none')
		}
	})

	it('I10: a guard that gives up on info() or encode is unattempted and stops the round', async () => {
		const input = await encodeWebp(64, 48)
		const codec = imagesCodec(fakeBinding({ info: WEBP }))
		const late = (at: number) => {
			let n = 0
			return hooks({ guard: (work) => (n++ === at ? Promise.reject(new DeadlinePassed()) : work()) })
		}
		expect(await run(codec, input, late(0))).toEqual({ kind: 'unattempted', reason: 'deadline', stop: true })
		const after = late(1)
		expect(await run(codec, input, after)).toEqual({ kind: 'unattempted', reason: 'deadline', stop: true })
		expect(after.calls).toEqual(['admit', 'start'])
	})

	it('I10: starts no output info() once the deadline passes during the output read', async () => {
		const input = await encodeWebp(64, 48)
		const output = await encodeWebp(64, 48)
		let infos = 0
		let done = false
		const stream = () =>
			new ReadableStream<Uint8Array>({
				start: (controller) => {
					controller.enqueue(output)
					controller.close()
					done = true
				},
			})
		const binding = {
			info: () => {
				infos++
				return Promise.resolve(WEBP)
			},
			input: () => {
				const transformer = {
					transform: () => transformer,
					output: () => Promise.resolve({ image: stream, contentType: () => 'image/webp' }),
				}
				return transformer
			},
		} as unknown as ImagesBinding
		// The deadline passes once the output's stream has ended: the read that ends it is given up.
		const h = hooks({ guard: (work) => (done ? Promise.reject(new DeadlinePassed()) : work()) })
		expect(await run(imagesCodec(binding), input, h)).toEqual({ kind: 'unattempted', reason: 'deadline', stop: true })
		expect(infos).toBe(1)
	})

	it('I13: refuses an output of CARD_IMAGE_OUTPUT_LIMIT + 1 bytes while it is read, cancelling it', async () => {
		const input = await encodeWebp(64, 48)
		let pulled = 0
		let cancelled = false
		const chunk = 64 * 1024
		const output = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += chunk
				controller.enqueue(new Uint8Array(chunk))
				if (pulled > 4 * CARD_IMAGE_OUTPUT_LIMIT) {
					controller.close()
				}
			},
			cancel() {
				cancelled = true
			},
		})
		expect(await run(imagesCodec(fakeBinding({ info: WEBP, output })), input)).toEqual({
			kind: 'none',
			reason: 'encode output',
		})
		expect(cancelled).toBe(true)
		expect(pulled).toBeLessThanOrEqual(CARD_IMAGE_OUTPUT_LIMIT + 2 * chunk)
		// One byte more than the limit, in one chunk, is refused too; the limit itself is read.
		const exact = await encodeWebp(64, 48)
		const padded = new Uint8Array(CARD_IMAGE_OUTPUT_LIMIT + 1)
		padded.set(exact)
		expect((await run(imagesCodec(fakeBinding({ info: WEBP, output: padded })), input)).kind).toBe('none')
	})

	it('I14: refuses an output whose header size differs from info(), or is past the decode bound', async () => {
		const input = await encodeWebp(64, 48)
		const output = await encodeWebp(64, 48)
		const ok = await run(imagesCodec(fakeBinding({ info: WEBP, output })), input)
		expect(ok).toMatchObject({ kind: 'encoded', width: 64, height: 48 })
		expect(
			await run(
				imagesCodec(fakeBinding({ info: WEBP, output, outputInfo: { format: 'image/webp', width: 65, height: 48 } })),
				input
			)
		).toEqual({ kind: 'none', reason: 'output size' })
		const large = await encodeWebp(1024, 257, { fill: 'flat' })
		expect(1024 * 257).toBeGreaterThan(CARD_DECODE_PIXELS)
		expect(
			await run(
				imagesCodec(
					fakeBinding({ info: WEBP, output: large, outputInfo: { format: 'image/webp', width: 1024, height: 257 } })
				),
				input
			)
		).toEqual({ kind: 'none', reason: 'output size' })
	})

	it('I15: admission #2 again right before the RGBA output: past the share keeps the image and stops the round', async () => {
		const input = await encodeWebp(64, 48)
		const output = await encodeWebp(64, 48)
		const budget = fakeBinding({ info: WEBP, output })
		const box = { bytes: input as Uint8Array | null }
		const h = hooks({}, ['ok', 'budget'])
		expect(await processCardImage(imagesCodec(budget), box, h)).toEqual({
			kind: 'encoded',
			bytes: output,
			width: 64,
			height: 48,
			blurhash: null,
			stop: true,
		})
		expect(h.calls).toEqual(['admit', 'start', 'start'])
		expect(formats(budget)).toEqual(['image/webp'])
		expect(box.bytes).toBeNull()
		const lost = fakeBinding({ info: WEBP, output })
		const lostBox = { bytes: input as Uint8Array | null }
		expect(await processCardImage(imagesCodec(lost), lostBox, hooks({}, ['ok', 'lost']))).toEqual({ kind: 'lost' })
		expect(formats(lost)).toEqual(['image/webp'])
		expect(lostBox.bytes).toBeNull()
	})

	it('I15: the RGBA output is of the same input and transformation as the WebP, read at its header size', async () => {
		// A 1,200 × 500 source asks for 743 × 309; the binding answers a 200 × 100 WebP, whose header size the RGBA is
		// read at and the blurhash fitted from, not the target's.
		const input = await encodeWebp(64, 48)
		const output = await encodeWebp(200, 100)
		const info = { format: 'image/webp', width: 1200, height: 500 }
		const outputInfo = { format: 'image/webp', width: 200, height: 100 }
		const pixels = rgba(200, 100)
		const binding = fakeBinding({ info, output, outputInfo, rgba: new Uint8Array(pixels.buffer) })
		const box = { bytes: input as Uint8Array | null }
		const result = await processCardImage(imagesCodec(binding), box, hooks())
		expect(result).toMatchObject({ kind: 'encoded', width: 200, height: 100, stop: false })
		expect(result.kind === 'encoded' && result.blurhash).toBe(cardBlurhash({ data: pixels, width: 200, height: 100 }))
		expect(binding.outputs.map((call) => [call.options, call.transforms])).toEqual([
			[{ format: 'image/webp', anim: false }, [{ width: 743, height: 309, fit: 'scale-down' }]],
			[{ format: 'rgba', anim: false }, [{ width: 743, height: 309, fit: 'scale-down' }]],
		])
		expect(binding.outputs[1]!.input).toEqual(input)
		expect(binding.outputs[0]!.input).toEqual(input)
		expect(box.bytes).toBeNull()
		// Shorter or longer than 4 × 200 × 100 bytes: the image is kept without a blurhash.
		for (const length of [80_000 - 4, 80_000 + 4]) {
			const padded = new Uint8Array(length)
			padded.set(new Uint8Array(pixels.buffer).subarray(0, Math.min(length, 80_000)))
			const short = fakeBinding({ info, output, outputInfo, rgba: padded })
			expect(await processCardImage(imagesCodec(short), { bytes: input }, hooks()), String(length)).toMatchObject({
				kind: 'encoded',
				width: 200,
				blurhash: null,
				stop: false,
			})
			expect(formats(short)).toEqual(['image/webp', 'rgba'])
		}
	})

	it('I15: encodeRgba refuses a size past its limit or empty before any call, and reads one exactly at it', async () => {
		const calls: unknown[] = []
		const codec: ImageCodec = {
			info: () => Promise.reject(new Error('unused')),
			encode: (_bytes, options) => {
				calls.push(options)
				return Promise.resolve(new Uint8Array(options.limit ?? 0))
			},
		}
		const guard = <T>(work: () => Promise<T>) => work()
		const limit = CARD_DECODE_PIXELS * 4
		for (const size of [
			{ width: 1024, height: 257 },
			{ width: 0, height: 5 },
			{ width: 5, height: 0 },
		]) {
			await expect(encodeRgba(codec, new Uint8Array(1), {}, size, limit, guard), JSON.stringify(size)).rejects.toThrow(
				'rgba output is past its byte limit'
			)
		}
		expect(calls).toEqual([])
		const at = await encodeRgba(codec, new Uint8Array(1), {}, { width: 1024, height: 256 }, limit, guard)
		expect([at.width, at.height, at.data.byteLength]).toEqual([1024, 256, limit])
		expect(calls).toEqual([{ format: 'rgba', limit, guard }])
	})

	it('I15: reads the RGBA within 4 × w × h bytes, refusing one more while it is read and cancelling it', async () => {
		const size = { width: 200, height: 100 }
		const length = 80_000
		const guard = <T>(work: () => Promise<T>) => work()
		let pulled = 0
		let cancelled = false
		const chunk = 16 * 1024
		const long = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += chunk
				controller.enqueue(new Uint8Array(chunk))
				if (pulled > 64 * length) {
					controller.close()
				}
			},
			cancel() {
				cancelled = true
			},
		})
		const read = (rgba: ReadableStream<Uint8Array> | Uint8Array) =>
			encodeRgba(imagesCodec(fakeBinding({ rgba })), new Uint8Array(1), {}, size, CARD_DECODE_PIXELS * 4, guard)
		await expect(read(long)).rejects.toThrow('output is past its byte limit')
		expect(cancelled).toBe(true)
		expect(pulled).toBeLessThanOrEqual(length + 2 * chunk)
		await expect(read(new Uint8Array(length + 1))).rejects.toThrow('output is past its byte limit')
		await expect(read(new Uint8Array(length - 1))).rejects.toThrow('rgba output is not of the image size')
		// Exactly 4 × w × h: a view over the one read buffer of 4 × w × h + 1 bytes.
		const exact = await read(new Uint8Array(length).fill(7))
		expect(exact.data.byteLength).toBe(length)
		expect(exact.data.buffer.byteLength).toBe(length + 1)
		expect(exact.data[length - 1]).toBe(7)
	})

	it('I11, I15: an RGBA output failing keeps the image without a blurhash; 9422 also stops the round', async () => {
		const input = await encodeWebp(64, 48)
		const output = await encodeWebp(64, 48)
		for (const [code, stop] of [
			[9412, false],
			[9413, false],
			[9520, false],
			[5000, false],
			[9422, true],
		] as const) {
			const binding = fakeBinding({ info: WEBP, output, rgbaFail: code })
			const box = { bytes: input as Uint8Array | null }
			expect(await processCardImage(imagesCodec(binding), box, hooks()), String(code)).toEqual({
				kind: 'encoded',
				bytes: output,
				width: 64,
				height: 48,
				blurhash: null,
				stop,
			})
			expect(formats(binding)).toEqual(['image/webp', 'rgba'])
			expect(box.bytes).toBeNull()
		}
	})

	it('I15: computes the blurhash from the raw RGBA pixels as Images answers them', async () => {
		// 4 × 2: the left half opaque red, the right half opaque blue, row-major with no header or padding.
		const raw = new Uint8Array(4 * 2 * 4)
		for (let at = 0; at < raw.length; at += 4) {
			raw.set((at / 4) % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], at)
		}
		const size = { format: 'image/webp', width: 4, height: 2 }
		const binding = fakeBinding({ info: size, output: await encodeWebp(4, 2), rgba: raw })
		expect(await processCardImage(imagesCodec(binding), { bytes: await encodeWebp(4, 2) }, hooks())).toMatchObject({
			kind: 'encoded',
			blurhash: 'U~LjfL|U|T$D|l]4,SsZfQfQfQfQ|l]4,SsZ',
			stop: false,
		})
	})

	it('I10: a guard that gives up on the RGBA output or its read is unattempted and stops the round', async () => {
		const input = await encodeWebp(64, 48)
		const output = await encodeWebp(64, 48)
		// Gives up on the first guarded call after admission #2's second answer (the RGBA output()), or on the one after
		// it (the RGBA output's first read).
		for (const skip of [0, 1]) {
			const binding = fakeBinding({ info: WEBP, output, rgba: new Uint8Array(64 * 48 * 4) })
			let starts = 0
			let after = 0
			const h = hooks({
				start: () => {
					starts++
					return Promise.resolve('ok')
				},
				// As within() gives up: the work started is left to settle on its own.
				guard: (work) => {
					if (starts === 2 && after++ === skip) {
						work().catch(() => {})
						return Promise.reject(new DeadlinePassed())
					}
					return work()
				},
			})
			const box = { bytes: input as Uint8Array | null }
			expect(await processCardImage(imagesCodec(binding), box, h), String(skip)).toEqual({
				kind: 'unattempted',
				reason: 'deadline',
				stop: true,
			})
			expect(h.calls).toEqual(['admit'])
			expect(starts).toBe(2)
			expect(box.bytes).toBeNull()
		}
	})
})

describe('the blurhash (Mastodon BlurhashTranscoder)', () => {
	it('fits within 100 pixels by area averaging and encodes 4 × 4 components', () => {
		const flat = { data: rgba(300, 150, 'flat'), width: 300, height: 150 }
		const fitted = fitRgba(flat)
		expect([fitted.width, fitted.height]).toEqual([100, 50])
		expect([...fitted.data.subarray(0, 4)]).toEqual([128, 128, 128, 255])
		const hash = cardBlurhash({ data: rgba(743, 309), width: 743, height: 309 })
		expect(hash).toHaveLength(36)
		expect(storedBlurhash(hash)).toBe(hash)
		// A small image is not resampled.
		const small = { data: rgba(10, 10), width: 10, height: 10 }
		expect(fitRgba(small)).toBe(small)
	})
})
