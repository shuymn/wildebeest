import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { cardWorld, pageWith } from './card-image-helpers'
import { linkCardRoundMemory } from './memory-model'
import { encodeWebp } from './webp-fixtures'
import { CARD_IMAGE_HOLD_MS } from '../src/domain/card-images'
import { outstandingCardImageCalls } from '../src/federation/card-images'
import { FIELD_LINK_OUTPUT_MAX_UNITS } from '../src/federation/field-links'
import { fetchWebImage, WEB_PAGE_BODY_LIMIT } from '../src/federation/web-page'
import { BLURHASH_EDGE } from '../src/platform/blurhash'
import { CARD_DECODE_PIXELS, CARD_IMAGE_BODY_LIMIT, CARD_IMAGE_OUTPUT_LIMIT } from '../src/platform/stored-bounds'
import { DECODER_MEMORY_BYTES, decoderState } from '../src/platform/webp-decode'

// The combined memory model of the cron's web rounds in one isolate (AM7, AM15, RES-6), from the bounds: they run in
// their own waitUntil each, at once.
// - A card image claim, one at a time, nothing collected early: the fetched body's buffer (fetchWebImage reads into
//   one buffer of CARD_IMAGE_BODY_LIMIT bytes and returns a view of it), the output's buffer (CARD_IMAGE_OUTPUT_LIMIT
//   + 1, a view again), the decoder's RGBA copy (CARD_DECODE_PIXELS × 4) and the blurhash fit (BLURHASH_EDGE² × 4).
//   On the Blob path (platform/images.ts CodecInput 'blob') the input is copied once more.
// - A call a round gave up (AM15) keeps its claim's memory until it settles, and no claim starts meanwhile: the
//   outstanding term replaces the active one, never adds to it (test/card-image-rounds.test.ts witnesses it on both
//   paths).
// - The decoder's wasm memory W (platform/webp-decode.ts), kept across rounds: its cap, enforced.
// - The link card round (test/memory-model.ts) and the field link round: one GET at a time, the body prefix and its
//   copy and the scan's strings (two bytes a unit).
// Not counted (named): quote verification and collection sync documents (RES-2), backup streams, deliveries, the
// stream tick, the native transport buffers of fetch, Images and R2, lol-html and JSON.parse's internals.
const ALLOWANCE = 64_000_000

describe('the combined cron memory model (AM7, AM15)', () => {
	it('stays within half the isolate on the stream path the binding takes, and on the Blob path', () => {
		const input = CARD_IMAGE_BODY_LIMIT
		const output = CARD_IMAGE_OUTPUT_LIMIT + 1
		const rgba = CARD_DECODE_PIXELS * 4
		const fit = BLURHASH_EDGE * BLURHASH_EDGE * 4
		const claim = input + output + rgba + fit
		const blobClaim = claim + (CARD_IMAGE_BODY_LIMIT - 1)
		const outstanding = claim
		const cards = linkCardRoundMemory().round
		const fields = WEB_PAGE_BODY_LIMIT + 1 + WEB_PAGE_BODY_LIMIT + 2 * FIELD_LINK_OUTPUT_MAX_UNITS
		const combined = Math.max(claim, outstanding) + DECODER_MEMORY_BYTES + cards + fields
		const blob = blobClaim + DECODER_MEMORY_BYTES + cards + fields
		expect({
			input,
			output,
			rgba,
			fit,
			claim,
			blobClaim,
			w: DECODER_MEMORY_BYTES,
			cards,
			fields,
			combined,
			blob,
		}).toEqual({
			input: 8_388_608,
			output: 524_289,
			rgba: 1_048_576,
			fit: 40_000,
			claim: 10_001_473,
			blobClaim: 18_390_080,
			w: 16_777_216,
			cards: 8_319_336,
			fields: 2_232_449,
			combined: 37_330_474,
			blob: 45_719_081,
		})
		// The stop rule (AM15): a combined figure past the allowance stops the work for a review.
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

	it('keeps only the decoder (W) between two successive rounds', async () => {
		const w = await cardWorld({ IMAGES_CARD_MONTHLY_TRANSFORMS: '10' })
		const body = await encodeWebp(64, 48)
		for (const i of [0, 1]) {
			w.addRoutes({
				[`https://site.example/${i}`]: pageWith(`https://cdn.example/${i}.webp`),
				[`https://cdn.example/${i}.webp`]: () => new Response(body),
			})
			await w.postLink(`https://site.example/${i}`)
		}
		await w.cardRound()
		const first = await w.imageRound()
		w.clock.t = NOW + CARD_IMAGE_HOLD_MS
		expect(outstandingCardImageCalls()).toBe(0)
		expect(await decoderState()).toEqual({ memoryBytes: DECODER_MEMORY_BYTES, spent: false })
		const second = await w.imageRound()
		expect(first.stored + second.stored).toBe(2)
		expect(outstandingCardImageCalls()).toBe(0)
		expect(await decoderState()).toEqual({ memoryBytes: DECODER_MEMORY_BYTES, spent: false })
		for (const row of await w.images()) {
			await env.MEDIA.delete(`files/${row.token}/full`)
		}
	})
})
