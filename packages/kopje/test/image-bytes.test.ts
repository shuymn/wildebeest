import { describe, expect, it } from 'vitest'

import {
	GIF,
	JPEG_COPYRIGHT_ONLY,
	JPEG_ICC,
	JPEG_SERIAL,
	JPEG_WITH_GPS,
	JPEG_XMP,
	PNG_ICC,
	PNG_PLAIN,
	PNG_WITH_GPS,
	WEBP_ICC,
	WEBP_PLAIN,
	WEBP_SERIAL,
	WEBP_WITH_GPS,
	WEBP_XMP,
	WIDE_PNG,
} from './fixtures/images'
import { bytes, exifWithTag, jpegWithSegment, pngWithChunk } from './media-helpers'
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
	const jpeg = bytes(JPEG_ICC)
	const png = bytes(PNG_PLAIN)

	it('refuses every EXIF block, not only GPS: location, serial numbers, MakerNote', () => {
		expect(retainedMetadata(bytes(JPEG_WITH_GPS), 'image/jpeg')).toBe('exif')
		expect(retainedMetadata(bytes(JPEG_SERIAL), 'image/jpeg')).toBe('exif')
		expect(retainedMetadata(bytes(JPEG_COPYRIGHT_ONLY), 'image/jpeg')).toBe('exif')
		expect(retainedMetadata(jpegWithSegment(jpeg, 0xe1, exifWithTag(0x927c, 'maker')), 'image/jpeg')).toBe('exif')
		expect(retainedMetadata(bytes(PNG_WITH_GPS), 'image/png')).toBe('exif')
		expect(retainedMetadata(bytes(WEBP_WITH_GPS), 'image/webp')).toBe('exif')
		expect(retainedMetadata(bytes(WEBP_SERIAL), 'image/webp')).toBe('exif')
	})

	it('refuses XMP, IPTC, comments, text chunks and unknown JPEG application segments', () => {
		expect(retainedMetadata(bytes(JPEG_XMP), 'image/jpeg')).toBe('xmp')
		expect(retainedMetadata(bytes(WEBP_XMP), 'image/webp')).toBe('xmp')
		expect(retainedMetadata(jpegWithSegment(jpeg, 0xed, 'Photoshop 3.0\0'), 'image/jpeg')).toBe('iptc')
		expect(retainedMetadata(jpegWithSegment(jpeg, 0xfe, 'shot by alice'), 'image/jpeg')).toBe('comment')
		expect(retainedMetadata(jpegWithSegment(jpeg, 0xe3, 'META'), 'image/jpeg')).toBe('segment')
		expect(retainedMetadata(jpegWithSegment(jpeg, 0xe2, 'MPF\0'), 'image/jpeg')).toBe('segment')
		expect(retainedMetadata(pngWithChunk(png, 'tEXt', 'Author\0alice'), 'image/png')).toBe('text')
		expect(retainedMetadata(pngWithChunk(png, 'iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x/>'), 'image/png')).toBe('text')
		expect(retainedMetadata(pngWithChunk(png, 'zTXt', 'Comment\0\0x'), 'image/png')).toBe('text')
	})

	it('accepts plain images and colour profiles (ICC)', () => {
		expect(retainedMetadata(bytes(JPEG_ICC), 'image/jpeg')).toBeNull()
		expect(retainedMetadata(bytes(PNG_ICC), 'image/png')).toBeNull()
		expect(retainedMetadata(bytes(WEBP_ICC), 'image/webp')).toBeNull()
		expect(retainedMetadata(bytes(WEBP_PLAIN), 'image/webp')).toBeNull()
		expect(retainedMetadata(bytes(WIDE_PNG), 'image/png')).toBeNull()
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
