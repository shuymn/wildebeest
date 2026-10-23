import { describe, expect, it } from 'vitest'

import { fakeBinding } from './images-binding'
import { linkCardRoundMemory } from './memory-model'
import { FIELD_LINK_OUTPUT_MAX_UNITS } from '../src/federation/field-links'
import { fetchWebImage, WEB_PAGE_BODY_LIMIT } from '../src/federation/web-page'
import { BLURHASH_EDGE } from '../src/platform/blurhash'
import { encodeRgba, imagesCodec } from '../src/platform/images'
import { CARD_DECODE_PIXELS, CARD_IMAGE_BODY_LIMIT, CARD_IMAGE_OUTPUT_LIMIT } from '../src/platform/stored-bounds'

// The combined memory model of the cron's web rounds in one isolate (RES-6), from the bounds: they run in their own
// waitUntil each, at once.
// - A card image claim, one at a time, nothing collected early: the fetched body's buffer (fetchWebImage reads into
//   one buffer of CARD_IMAGE_BODY_LIMIT bytes and returns a view of it), the WebP output's buffer
//   (CARD_IMAGE_OUTPUT_LIMIT + 1, a view again), the RGBA output's buffer (CARD_DECODE_PIXELS × 4 + 1 at most:
//   platform/images.ts encodeRgba reads within 4 × w × h of the checked WebP and returns a view) and the blurhash fit
//   (BLURHASH_EDGE² × 4). On the Blob path (platform/images.ts CodecInput 'blob') the input is copied once more. A read
//   of a stream that is not a byte stream also holds its incoming chunk while copying it (platform/body.ts), a native
//   buffer like the transport's below.
// - A call a round gave up keeps its claim's memory until it settles, and no claim starts meanwhile: the outstanding
//   term replaces the active one, never adds to it (test/card-image-rounds.test.ts witnesses it on both paths).
// - The link card round (test/memory-model.ts) and the field link round: one GET at a time, the body prefix and its
//   copy and the scan's strings (two bytes a unit).
// Not counted (named): quote verification and collection sync documents (RES-2), backup streams, deliveries, the
// stream tick, the native transport buffers of fetch, Images and R2, lol-html and JSON.parse's internals.
const ALLOWANCE = 64_000_000

describe('the combined cron memory model (AM7, AM15)', () => {
	it('stays within half the isolate on the stream path the binding takes, and on the Blob path', () => {
		const input = CARD_IMAGE_BODY_LIMIT
		const output = CARD_IMAGE_OUTPUT_LIMIT + 1
		const rgba = CARD_DECODE_PIXELS * 4 + 1
		const fit = BLURHASH_EDGE * BLURHASH_EDGE * 4
		const claim = input + output + rgba + fit
		const blobClaim = claim + (CARD_IMAGE_BODY_LIMIT - 1)
		const outstanding = claim
		const cards = linkCardRoundMemory().round
		const fields = WEB_PAGE_BODY_LIMIT + 1 + WEB_PAGE_BODY_LIMIT + 2 * FIELD_LINK_OUTPUT_MAX_UNITS
		const combined = Math.max(claim, outstanding) + cards + fields
		const blob = blobClaim + cards + fields
		expect({
			input,
			output,
			rgba,
			fit,
			claim,
			blobClaim,
			cards,
			fields,
			combined,
			blob,
		}).toEqual({
			input: 8_388_608,
			output: 524_289,
			rgba: 1_048_577,
			fit: 40_000,
			claim: 10_001_474,
			blobClaim: 18_390_081,
			cards: 8_319_336,
			fields: 2_232_449,
			combined: 20_553_259,
			blob: 28_941_866,
		})
		// The stop rule: a combined figure past the allowance stops the work for a review.
		expect(combined).toBeLessThanOrEqual(ALLOWANCE)
		expect(blob).toBeLessThanOrEqual(ALLOWANCE)
	})

	it('reads a body into one buffer of CARD_IMAGE_BODY_LIMIT bytes, as the model counts it', async () => {
		const body = new Uint8Array(1000)
		const answer = await fetchWebImage(
			'https://cdn.example/a',
			{
				fetch: () => Promise.resolve(new Response(body)),
				checkHost: () => Promise.resolve(),
				refusesHost: () => Promise.resolve(false),
				userAgent: 'Kopje/test',
				now: () => Date.now(),
			},
			{ maxBytes: CARD_IMAGE_BODY_LIMIT - 1 }
		)
		expect(answer.ok && answer.bytes.buffer.byteLength).toBe(CARD_IMAGE_BODY_LIMIT)
	})

	it('reads the largest RGBA output a checked WebP allows into one buffer of 4 × w × h + 1 bytes, as it counts it', async () => {
		// 1,024 × 256 is CARD_DECODE_PIXELS, the most a checked WebP holds (I14).
		const size = { width: 1024, height: 256 }
		expect(size.width * size.height).toBe(CARD_DECODE_PIXELS)
		const binding = fakeBinding({ rgba: new Uint8Array(CARD_DECODE_PIXELS * 4) })
		const rgba = await encodeRgba(imagesCodec(binding), new Uint8Array(1), {}, size, CARD_DECODE_PIXELS * 4, (work) =>
			work()
		)
		expect(rgba.data.byteLength).toBe(CARD_DECODE_PIXELS * 4)
		expect(rgba.data.buffer.byteLength).toBe(CARD_DECODE_PIXELS * 4 + 1)
	})
})
