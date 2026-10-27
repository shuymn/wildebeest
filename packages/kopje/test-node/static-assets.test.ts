import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { guardFixtures, parse, sources, type Source } from './source-scan.js'

// Every /assets/<name> a source names in a string or template literal is a file of public/assets, which Workers static
// assets serves without running the Worker (wrangler.jsonc run_worker_first). A path with no file is a broken image or
// script in every client that follows it.

const ASSETS = new URL('../public/assets/', import.meta.url)
const HERO = new URL('../../../.github/assets/kopje-hero.jpg', import.meta.url)
const NAMED = /\/assets\/([A-Za-z0-9._-]+)/g
const IMAGE = /\.(png|jpg|ico)$/

function missingAssets(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of files) {
		for (const literal of parse(source).literals) {
			for (const part of literal.parts) {
				if (!('text' in part)) {
					continue
				}
				for (const [, name] of part.text.matchAll(NAMED)) {
					if (!existsSync(new URL(name!, ASSETS))) {
						found.push(`${source.path}: /assets/${name!}`)
					}
				}
			}
		}
	}
	return found
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

type Png = { width: number; height: number; colourType: number; chunks: string[] }
type Jpeg = { width: number; height: number; segments: string[] }

// A PNG's IHDR (the first chunk, at byte 8) and the types of all its chunks in order.
function readPng(bytes: Buffer): Png {
	expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE)
	expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
	const chunks: string[] = []
	for (let at = 8; at < bytes.length; at += 12 + bytes.readUInt32BE(at)) {
		chunks.push(bytes.subarray(at + 4, at + 8).toString('latin1'))
	}
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25]!, chunks }
}

// A JPEG's segments up to its first scan, each named by its marker (an APPn by its identifier too, as 'APP0 JFIF'),
// and the width and height of its frame header (SOF0-SOF15 but DHT C4, JPG C8 and DAC CC).
function readJpeg(bytes: Buffer): Jpeg {
	expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
	const segments: string[] = []
	let size: { width: number; height: number } | null = null
	for (let at = 2; at + 4 <= bytes.length;) {
		expect(bytes[at], `marker at ${at}`).toBe(0xff)
		const marker = bytes[at + 1]!
		if (marker === 0xda) {
			break
		}
		const length = bytes.readUInt16BE(at + 2)
		const body = bytes.subarray(at + 4, at + 2 + length)
		if (marker >= 0xe0 && marker <= 0xef) {
			const end = body.indexOf(0)
			segments.push(`APP${marker - 0xe0} ${body.subarray(0, end < 0 ? body.length : end).toString('latin1')}`)
		} else {
			segments.push(marker === 0xfe ? 'COM' : marker.toString(16).toUpperCase())
		}
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			size = { height: body.readUInt16BE(1), width: body.readUInt16BE(3) }
		}
		at += 2 + length
	}
	expect(size).not.toBeNull()
	return { ...size!, segments }
}

// An .ico's entries (ICONDIR), each with its embedded image; a width or height byte of 0 means 256.
function readIco(bytes: Buffer): { width: number; height: number; image: Buffer }[] {
	expect([bytes.readUInt16LE(0), bytes.readUInt16LE(2)]).toEqual([0, 1])
	return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
		const entry = 6 + 16 * i
		const image = bytes.subarray(
			bytes.readUInt32LE(entry + 12),
			bytes.readUInt32LE(entry + 12) + bytes.readUInt32LE(entry + 8)
		)
		return { width: bytes[entry] || 256, height: bytes[entry + 1] || 256, image }
	})
}

// Shipped images carry no metadata: no text chunk, EXIF, XMP or content-credentials (C2PA) block, which can hold
// the tool, the source and the names of whoever made them. PNG keeps only the image and colour chunks; JPEG only the
// JFIF header, an ICC profile (APP2) and the non-APP segments; an .ico only PNG entries held to the PNG rule.
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP', 'IDAT', 'IEND'])
const JPEG_APP = new Set(['APP0 JFIF', 'APP2 ICC_PROFILE'])

function metadataOf(name: string, bytes: Buffer): string[] {
	if (name.endsWith('.png')) {
		return readPng(bytes)
			.chunks.filter((chunk) => !PNG_CHUNKS.has(chunk))
			.map((chunk) => `${name}: ${chunk}`)
	}
	if (name.endsWith('.jpg')) {
		return readJpeg(bytes)
			.segments.filter((segment) => (segment.startsWith('APP') && !JPEG_APP.has(segment)) || segment === 'COM')
			.map((segment) => `${name}: ${segment}`)
	}
	return readIco(bytes).flatMap(({ width, image }) =>
		image.subarray(0, 8).equals(PNG_SIGNATURE)
			? metadataOf(`${name} ${width}px.png`, image)
			: [`${name} ${width}px: not a PNG entry`]
	)
}

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

function png(...extra: string[]): Buffer {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(1, 0)
	ihdr.writeUInt32BE(1, 4)
	ihdr.set([8, 6], 8)
	return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), ...extra.map((t) => pngChunk(t)), pngChunk('IEND')])
}

function jpegSegment(marker: number, data: Buffer): Buffer {
	const head = Buffer.from([0xff, marker, 0, 0])
	head.writeUInt16BE(data.length + 2, 2)
	return Buffer.concat([head, data])
}

function jpeg(...extra: Buffer[]): Buffer {
	const sof = Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
		...extra,
		jpegSegment(0xc2, sof),
		Buffer.from([0xff, 0xda]),
	])
}

function ico(...images: Buffer[]): Buffer {
	const head = Buffer.alloc(6 + 16 * images.length)
	head.writeUInt16LE(1, 2)
	head.writeUInt16LE(images.length, 4)
	let offset = head.length
	images.forEach((image, i) => {
		head[6 + 16 * i] = 16 * (i + 1)
		head[7 + 16 * i] = 16 * (i + 1)
		head.writeUInt32LE(image.length, 14 + 16 * i)
		head.writeUInt32LE(offset, 18 + 16 * i)
		offset += image.length
	})
	return Buffer.concat([head, ...images])
}

const app = (n: number, id: string) => jpegSegment(0xe0 + n, Buffer.from(`${id}\0payload`, 'latin1'))

// The images public/assets ships, with the size and PNG colour type each must have: the icons keep their alpha
// (colour type 6), and the Apple touch icon is opaque (2), since iOS fills transparency with black.
const IMAGES: Record<string, { width: number; height: number; colourType?: number }> = {
	'avatar.jpg': { width: 400, height: 400 },
	'header.jpg': { width: 1500, height: 500 },
	'thumbnail.jpg': { width: 1200, height: 630 },
	'favicon-48.png': { width: 48, height: 48, colourType: 6 },
	'favicon-192.png': { width: 192, height: 192, colourType: 6 },
	'favicon-512.png': { width: 512, height: 512, colourType: 6 },
	'apple-touch-icon.png': { width: 180, height: 180, colourType: 2 },
}

describe('static assets', () => {
	const SOURCES = sources('src')
	const shipped = readdirSync(ASSETS).filter((name) => IMAGE.test(name))

	it('sees the sources that name assets', () => {
		expect(SOURCES.map((s) => s.path)).toContain('src/platform/brand-assets.ts')
	})

	it('names only assets public/assets holds', () => {
		expect(missingAssets(SOURCES)).toEqual([])
	})

	it('ships exactly the images it describes', () => {
		expect(shipped.sort()).toEqual([...Object.keys(IMAGES), 'favicon.ico'].sort())
	})

	it.each(Object.entries(IMAGES))('ships %s at its size', (name, expected) => {
		const bytes = readFileSync(new URL(name, ASSETS))
		if (name.endsWith('.jpg')) {
			const { width, height } = readJpeg(bytes)
			expect({ width, height }).toEqual(expected)
		} else {
			const { width, height, colourType } = readPng(bytes)
			expect({ width, height, colourType }).toEqual(expected)
		}
	})

	it('ships the favicon with 16, 32 and 48 px PNG entries with alpha', () => {
		const entries = readIco(readFileSync(new URL('favicon.ico', ASSETS)))
		expect(entries.map(({ width, height }) => [width, height])).toEqual([
			[16, 16],
			[32, 32],
			[48, 48],
		])
		for (const { width, image } of entries) {
			const { width: w, height: h, colourType } = readPng(image)
			expect({ w, h, colourType }).toEqual({ w: width, h: width, colourType: 6 })
		}
	})

	it('ships the README hero as a 2172x724 JPEG', () => {
		const { width, height } = readJpeg(readFileSync(HERO))
		expect({ width, height }).toEqual({ width: 2172, height: 724 })
	})

	it('ships no image metadata', () => {
		const found = [
			...shipped.flatMap((name) => metadataOf(name, readFileSync(new URL(name, ASSETS)))),
			...metadataOf('kopje-hero.jpg', readFileSync(HERO)),
		]
		expect(found).toEqual([])
	})

	describe('the metadata finder', () => {
		it.each<[string, string, Buffer, string]>([
			['a PNG text chunk', 'a.png', png('tEXt'), 'a.png: tEXt'],
			['a PNG XMP chunk', 'a.png', png('iTXt'), 'a.png: iTXt'],
			['a PNG compressed text chunk', 'a.png', png('zTXt'), 'a.png: zTXt'],
			['a PNG EXIF chunk', 'a.png', png('eXIf'), 'a.png: eXIf'],
			['a PNG C2PA chunk', 'a.png', png('caBX'), 'a.png: caBX'],
			['a JPEG EXIF segment', 'a.jpg', jpeg(app(1, 'Exif')), 'a.jpg: APP1 Exif'],
			[
				'a JPEG XMP segment',
				'a.jpg',
				jpeg(app(1, 'http://ns.adobe.com/xap/1.0/')),
				'a.jpg: APP1 http://ns.adobe.com/xap/1.0/',
			],
			['a JPEG C2PA (JUMBF) segment', 'a.jpg', jpeg(app(11, 'JP')), 'a.jpg: APP11 JP'],
			['a JPEG comment', 'a.jpg', jpeg(jpegSegment(0xfe, Buffer.from('made by'))), 'a.jpg: COM'],
			['an .ico PNG entry with EXIF', 'a.ico', ico(png(), png('eXIf')), 'a.ico 32px.png: eXIf'],
			['an .ico BMP entry', 'a.ico', ico(Buffer.alloc(40)), 'a.ico 16px: not a PNG entry'],
		])('flags %s', (_name, file, bytes, finding) => {
			expect(metadataOf(file, bytes)).toContain(finding)
		})

		it.each<[string, string, Buffer]>([
			['a PNG with colour chunks', 'a.png', png('sRGB', 'gAMA', 'cHRM', 'iCCP', 'PLTE', 'tRNS', 'IDAT')],
			['a JPEG with an ICC profile', 'a.jpg', jpeg(app(2, 'ICC_PROFILE'))],
			['an .ico of plain PNG entries', 'a.ico', ico(png('IDAT'), png('sRGB', 'IDAT'))],
		])('passes %s', (_name, file, bytes) => {
			expect(metadataOf(file, bytes)).toEqual([])
		})
	})

	describe('the finder', () => {
		guardFixtures(missingAssets, {
			flagged: {
				'a constant': ["const THUMBNAIL = '/assets/missing.png'", 'src/domain/probe.ts: /assets/missing.png'],
				'a template': [
					'export const url = (o: string) => `${o}/assets/gone.js`',
					'src/domain/probe.ts: /assets/gone.js',
				],
				'a removed default': ["const HEADER = '/assets/header.png'", 'src/domain/probe.ts: /assets/header.png'],
			},
			passed: {
				'a shipped asset': "const HEADER = '/assets/header.jpg'",
				'a template of a shipped asset': 'export const url = (o: string) => `${o}/assets/favicon-48.png`',
				'a comment': '// /assets/missing.png\nexport const x = 1',
				'a pattern': "const SKIP = '!/assets/*'",
			},
		})
	})
})
