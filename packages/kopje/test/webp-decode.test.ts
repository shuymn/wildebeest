import { describe, expect, it } from 'vitest'

import { encodeWebp, rgba, uncappedDecode } from './webp-fixtures'
import { DECODER_MEMORY_BYTES, decoderState, decodeWebp } from '../src/platform/webp-decode'

// The largest card image output decodeWebp is given (CARD_DECODE_PIXELS), in the shapes that stress libwebp most: a
// square, and wide strips up to WebP's 16,383-pixel edge.
const MAXIMAL_SHAPES = [
	[512, 512],
	[1024, 256],
	[4096, 64],
	[16_383, 16],
] as const

describe('the WebP decoder in workerd (AM3, AM16)', () => {
	it('is instantiated from the compiled module and decodes exactly', async () => {
		const bytes = await encodeWebp(7, 5, { lossless: true })
		const decoded = await decodeWebp(bytes)
		expect(decoded?.width).toBe(7)
		expect(decoded?.height).toBe(5)
		expect([...(decoded?.data ?? [])]).toEqual([...rgba(7, 5)])
		expect(await decoderState()).toEqual({ memoryBytes: DECODER_MEMORY_BYTES, spent: false })
	})

	it('decodes every maximal output 20 times within 256 pages', { timeout: 120_000 }, async () => {
		expect(DECODER_MEMORY_BYTES).toBe(16_777_216)
		const fixtures = []
		for (const [width, height] of MAXIMAL_SHAPES) {
			expect(width * height).toBeLessThanOrEqual(262_144)
			fixtures.push(await encodeWebp(width, height, { quality: 100 }))
			fixtures.push(await encodeWebp(width, height, { lossless: true }))
		}
		let peak = 0
		for (let round = 0; round < 20; round++) {
			for (const bytes of fixtures) {
				const decoded = await decodeWebp(bytes)
				expect(decoded?.data.byteLength).toBe((decoded?.width ?? 0) * (decoded?.height ?? 0) * 4)
				peak = Math.max(peak, (await decoderState()).memoryBytes ?? 0)
			}
		}
		expect(peak).toBe(DECODER_MEMORY_BYTES)
	})

	it('refuses growth past the cap safely: null, the memory unchanged, the next decode works', async () => {
		const large = await encodeWebp(2100, 2100, { fill: 'flat' })
		const unbounded = await uncappedDecode(large)
		expect(unbounded?.width).toBe(2100)
		expect(unbounded?.memoryBytes).toBeGreaterThan(DECODER_MEMORY_BYTES)
		expect(await decodeWebp(large)).toBeNull()
		expect(await decoderState()).toEqual({ memoryBytes: DECODER_MEMORY_BYTES, spent: false })
		expect((await decodeWebp(await encodeWebp(3, 3)))?.width).toBe(3)
	})
})
