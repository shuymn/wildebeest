import { describe, expect, it } from 'vitest'

import { GIF, JPEG_COPYRIGHT_ONLY, JPEG_WITH_GPS, PNG_WITH_GPS, WEBP_WITH_GPS, WIDE_PNG } from './fixtures/images'
import { bytes } from './media-helpers'
import { retainedMetadata, sniffImageType } from '../src/platform/image-bytes'
import { keyOfPath, mediaKeys, originalKey } from '../src/platform/media-files'

const text = (value: string) => new TextEncoder().encode(value)

describe('sniffImageType (MEDIA-4)', () => {
	it('recognizes the accepted image types by signature', () => {
		expect(sniffImageType(bytes(JPEG_WITH_GPS))).toBe('image/jpeg')
		expect(sniffImageType(bytes(WIDE_PNG))).toBe('image/png')
		expect(sniffImageType(bytes(GIF))).toBe('image/gif')
		expect(sniffImageType(bytes(WEBP_WITH_GPS))).toBe('image/webp')
		expect(sniffImageType(new Uint8Array([0, 0, 0, 0x1c, ...text('ftypavif')]))).toBe('image/avif')
	})

	it('recognizes nothing else: HTML, SVG, video, audio, HEIC', () => {
		for (const input of [
			text('<!doctype html><script>alert(1)</script>'),
			text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
			new Uint8Array([0, 0, 0, 0x18, ...text('ftypisom'), 0, 0, 0, 0]),
			new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
			text('ID3\u0004\u0000\u0000\u0000\u0000'),
			new Uint8Array([0, 0, 0, 0x18, ...text('ftypheic'), 0, 0, 0, 0]),
			new Uint8Array([0xff, 0xd8]),
		]) {
			expect(sniffImageType(input)).toBeNull()
		}
	})
})

describe('retainedMetadata (MEDIA-3)', () => {
	it('finds GPS EXIF in JPEG, PNG and WebP', () => {
		expect(retainedMetadata(bytes(JPEG_WITH_GPS), 'image/jpeg')).toBe('gps')
		expect(retainedMetadata(bytes(PNG_WITH_GPS), 'image/png')).toBe('gps')
		expect(retainedMetadata(bytes(WEBP_WITH_GPS), 'image/webp')).toBe('gps')
	})

	it('allows EXIF without location (Images keeps the copyright tag by default) and plain images', () => {
		expect(retainedMetadata(bytes(JPEG_COPYRIGHT_ONLY), 'image/jpeg')).toBeNull()
		expect(retainedMetadata(bytes(WIDE_PNG), 'image/png')).toBeNull()
	})

	it('finds XMP and IPTC segments', () => {
		const jpeg = bytes(JPEG_COPYRIGHT_ONLY)
		const segment = (marker: number, payload: Uint8Array) =>
			new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload])
		const withSegment = (marker: number, payload: Uint8Array) =>
			new Uint8Array([...jpeg.subarray(0, 2), ...segment(marker, payload), ...jpeg.subarray(2)])
		expect(retainedMetadata(withSegment(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')), 'image/jpeg')).toBe(
			'xmp'
		)
		expect(retainedMetadata(withSegment(0xed, text('Photoshop 3.0\0')), 'image/jpeg')).toBe('iptc')
	})

	it('fails closed on truncated or unknown files', () => {
		expect(retainedMetadata(bytes(JPEG_WITH_GPS).subarray(0, 40), 'image/jpeg')).toBe('unreadable')
		expect(retainedMetadata(bytes(PNG_WITH_GPS).subarray(0, 30), 'image/png')).toBe('unreadable')
		expect(retainedMetadata(bytes(GIF), 'image/gif')).toBe('unreadable')
		expect(retainedMetadata(text('<html>'), 'image/jpeg')).toBe('unreadable')
	})

	it('walks a worst-case file at the upload bound within a generous time (RES-2)', () => {
		// 16 MB of fill bytes after the JPEG signature: one step per byte.
		const worst = new Uint8Array(16 * 1024 * 1024).fill(0xff)
		worst[1] = 0xd8
		const start = performance.now()
		expect(retainedMetadata(worst, 'image/jpeg')).toBe('unreadable')
		expect(performance.now() - start).toBeLessThan(2000)
	})
})

describe('media keys (MEDIA-2)', () => {
	const token = 'A'.repeat(43)

	it('builds keys from server ids and tokens only', () => {
		expect(mediaKeys('100000000000000001', token)).toEqual([
			'originals/100000000000000001',
			`files/${token}/full`,
			`files/${token}/small`,
		])
		expect(() => originalKey('../x')).toThrow()
	})

	it('maps only served files of a well-formed token to a key', () => {
		expect(keyOfPath(token, 'full.jpg')).toEqual({ key: `files/${token}/full`, extension: 'jpg' })
		expect(keyOfPath(token, 'small.webp')).toEqual({ key: `files/${token}/small`, extension: 'webp' })
		for (const [t, file] of [
			[token, 'original.jpg'],
			[token, 'full.html'],
			[token, 'full.svg'],
			[token, 'full'],
			[token, '../full.jpg'],
			['..', 'full.jpg'],
			[`${token}/..`, 'full.jpg'],
			['originals%2F100000000000000001', 'full.jpg'],
			['short', 'full.jpg'],
		] as const) {
			expect(keyOfPath(t, file), `${t} ${file}`).toBeNull()
		}
	})
})
