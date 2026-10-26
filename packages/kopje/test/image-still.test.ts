import { describe, expect, it } from 'vitest'

import { ANIMATED_GIF, ANIMATED_WEBP, APNG, AVIF, JPEG_ICC } from './fixtures/images'
import { bytes } from './media-helpers'
import { animatedWebp, concat, imageFacts, madeFixture, webpChunks } from './remote-media-fixtures'
import { decodeFixture, encodeWebp } from './webp-fixtures'
import { imageStill } from '../src/platform/image-still'
import { remoteImageAnimated, remoteImageMetadata, verifyRemoteImage } from '../src/platform/remote-media-bytes'

const LARGE = 16 * 1024 * 1024

function still(input: Uint8Array, type: 'image/gif' | 'image/png' | 'image/webp', maxBytes = LARGE): Uint8Array {
	const out = imageStill(input, type, maxBytes)
	if (out === null) {
		throw new Error('no still')
	}
	return out
}

// A still is itself a verified, single-frame image of the same type, no larger than its input.
function expectStill(out: Uint8Array, input: Uint8Array, type: 'image/gif' | 'image/png' | 'image/webp') {
	expect(out.length).toBeLessThanOrEqual(input.length)
	expect(remoteImageAnimated(out, type)).toBe(false)
	expect(remoteImageMetadata(out, type)).toBeNull()
	expect(verifyRemoteImage(out.slice(), [type])).toMatchObject({ ok: true, animated: false })
}

describe('imageStill', () => {
	it("makes a GIF's first frame, its delay cleared, as a decoder reads frame 0", async () => {
		const gif = bytes(ANIMATED_GIF)
		const out = still(gif, 'image/gif')
		expectStill(out, gif, 'image/gif')
		const [original, made] = await Promise.all([imageFacts(gif), imageFacts(out)])
		expect(original?.pages).toBe(3)
		expect(made).toMatchObject({ format: 'gif', pages: 1, width: 10, height: 8 })
		expect(made?.rgba).toEqual(original?.rgba)
		// The graphic control extension right after the header and its colour table (2 entries) has delay 0.
		const control = 13 + 6
		expect([...out.subarray(control, control + 3)]).toEqual([0x21, 0xf9, 0x04])
		expect([...out.subarray(control + 4, control + 6)]).toEqual([0, 0])
		// The input's own control extension, after its 19-byte NETSCAPE2.0 extension, has a delay of 10.
		expect(gif[control + 19 + 4]).toBe(10)
	})

	it("makes an APNG's default image, inside the animation and outside it", async () => {
		const inside = bytes(APNG)
		const out = still(inside, 'image/png')
		expectStill(out, inside, 'image/png')
		// Frame 0 (red) is the default image.
		const red = await imageFacts(out)
		expect(red).toMatchObject({ format: 'png', pages: 1 })
		expect([...(red?.rgba.subarray(0, 4) ?? [])]).toEqual([255, 0, 0, 255])
		const outside = await madeFixture('apng-outside')
		const fallback = still(outside, 'image/png')
		expectStill(fallback, outside, 'image/png')
		// The static fallback (green), never the animation's frame (red).
		const green = await imageFacts(fallback)
		expect([...(green?.rgba.subarray(0, 4) ?? [])]).toEqual([0, 255, 0, 255])
		expect(green?.rgba).toEqual((await imageFacts(outside))?.rgba)
	})

	it("makes an animated WebP's first frame when it covers the canvas, alpha kept, the background ignored", async () => {
		const first = await encodeWebp(16, 12)
		const second = await encodeWebp(16, 12, { fill: 'flat' })
		expect(webpChunks(first).map(([type]) => type)).toContain('ALPH')
		const animated = animatedWebp([first, second], { width: 16, height: 12 }, { background: [0, 0, 255, 255] })
		expect(verifyRemoteImage(animated.slice(), ['image/webp'])).toMatchObject({ ok: true, animated: true })
		const out = still(animated, 'image/webp')
		expectStill(out, animated, 'image/webp')
		expect(webpChunks(out).map(([type]) => type)).toEqual(['VP8X', 'ALPH', 'VP8 '])
		// The pixels are the frame's as a decoder reads it, its alpha included: no red background is composited.
		const [frame, made] = await Promise.all([decodeFixture(first), decodeFixture(out)])
		expect(made.width).toBe(16)
		expect(made.data).toEqual(frame.data)
		expect(made.data.some((_, i) => i % 4 === 3 && (made.data[i] ?? 255) < 255)).toBe(true)
		// The lossless two-frame fixture too.
		const lossless = bytes(ANIMATED_WEBP)
		expectStill(still(lossless, 'image/webp'), lossless, 'image/webp')
	})

	it('makes no WebP still when the first frame is offset or smaller than the canvas', async () => {
		const frame = await encodeWebp(8, 6)
		const offset = animatedWebp(
			[frame, frame],
			{ width: 16, height: 12 },
			{ offset: 2, frameSize: { width: 8, height: 6 } }
		)
		expect(verifyRemoteImage(offset.slice(), ['image/webp'])).toMatchObject({ ok: true, animated: true })
		expect(imageStill(offset, 'image/webp', LARGE)).toBeNull()
		const smaller = animatedWebp([frame, frame], { width: 16, height: 12 }, { frameSize: { width: 8, height: 6 } })
		expect(verifyRemoteImage(smaller.slice(), ['image/webp'])).toMatchObject({ ok: true })
		expect(imageStill(smaller, 'image/webp', LARGE)).toBeNull()
	})

	it('makes no still of an AVIF image sequence or a JPEG', () => {
		const sequence = bytes(AVIF)
		sequence.set(new TextEncoder().encode('avis'), 8)
		expect(remoteImageAnimated(sequence, 'image/avif')).toBe(true)
		expect(imageStill(sequence, 'image/avif', LARGE)).toBeNull()
		expect(imageStill(bytes(JPEG_ICC), 'image/jpeg', LARGE)).toBeNull()
	})

	it('makes none past the still cap, and keeps one exactly at it', () => {
		const gif = bytes(ANIMATED_GIF)
		const out = still(gif, 'image/gif')
		expect(imageStill(gif, 'image/gif', out.length)).toEqual(out)
		expect(imageStill(gif, 'image/gif', out.length - 1)).toBeNull()
		const apng = bytes(APNG)
		const png = still(apng, 'image/png')
		expect(imageStill(apng, 'image/png', png.length - 1)).toBeNull()
	})

	it('never makes one larger than its input', () => {
		for (const [file, type] of [
			[bytes(ANIMATED_GIF), 'image/gif'],
			[bytes(APNG), 'image/png'],
			[bytes(ANIMATED_WEBP), 'image/webp'],
		] as const) {
			const out = imageStill(file, type, LARGE)
			expect(out?.length ?? 0).toBeLessThanOrEqual(file.length)
		}
	})

	it('handles a hostile 16 MiB GIF in linear time', { timeout: 60_000 }, () => {
		// Thousands of frames of one-byte LZW sub-blocks after the first.
		const gif = bytes(ANIMATED_GIF)
		const header = gif.subarray(0, 13 + 6)
		const frame = concat(
			new Uint8Array([0x2c, 0, 0, 0, 0, 10, 0, 8, 0, 0, 2]),
			new Uint8Array(1 << 16).map((_, i) => (i % 2 === 0 ? 1 : 0)),
			new Uint8Array([0])
		)
		const frames = Array.from({ length: Math.floor((16 * 1024 * 1024) / frame.length) }, () => frame)
		const hostile = concat(header, ...frames, new Uint8Array([0x3b]))
		const start = performance.now()
		expect(verifyRemoteImage(hostile, ['image/gif'])).toMatchObject({ ok: true, animated: true })
		const out = imageStill(hostile, 'image/gif', LARGE)
		expect(performance.now() - start).toBeLessThan(5000)
		expect(out?.length).toBe(header.length + frame.length + 1)
	})
})
