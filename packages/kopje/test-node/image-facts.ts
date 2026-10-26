// An independent image reader and fixture maker on Node, for the remote media suites (the IMAGE_FACTS binding of
// vitest.config.ts): sharp, the copy Miniflare ships for its local Images binding, so the suites need no image tooling
// of their own. POST /facts reads a body as sharp does (its format, size, pages, orientation, whether it keeps Exif,
// XMP, IPTC or comments, and the RGBA of its first page); GET /make?name= makes the fixtures sharp can write.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { deflateSync, crc32 } from 'node:zlib'

type Metadata = {
	format?: string
	width?: number
	height?: number
	pages?: number
	orientation?: number
	exif?: Buffer
	xmp?: Buffer
	iptc?: Buffer
	comments?: unknown[]
}
type Pipeline = {
	metadata(): Promise<Metadata>
	ensureAlpha(): Pipeline
	raw(): Pipeline
	jpeg(options: object): Pipeline
	avif(options?: object): Pipeline
	png(options?: object): Pipeline
	withExif(exif: object): Pipeline
	withXmp(xmp: string): Pipeline
	withIccProfile(icc: string): Pipeline
	toBuffer(): Promise<Buffer>
}
type Sharp = (input: Buffer, options?: object) => Pipeline

const sharp = createRequire(createRequire(import.meta.url).resolve('miniflare'))('sharp') as Sharp

// Deterministic noise, so that a lossy encoder keeps entropy-coded data (and its byte stuffing).
function noise(width: number, height: number): Buffer {
	const data = Buffer.alloc(width * height * 3)
	let seed = 0x2545f491
	for (let i = 0; i < data.length; i++) {
		seed = (seed ^ (seed << 13)) >>> 0
		seed = (seed ^ (seed >>> 17)) >>> 0
		seed = (seed ^ (seed << 5)) >>> 0
		data[i] = seed & 0xff
	}
	return data
}

function pngChunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8)
	head.writeUInt32BE(data.length, 0)
	head.write(type, 4, 'latin1')
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
	return Buffer.concat([head, data, crc])
}

// An 8x6 RGB scanline image of one colour, as zlib data (filter 0 on every row).
function flat(rgb: [number, number, number]): Buffer {
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 8 }, () => rgb).flat())])
	return deflateSync(Buffer.concat(Array.from({ length: 6 }, () => row)))
}

function fcTL(sequence: number): Buffer {
	const data = Buffer.alloc(26)
	data.writeUInt32BE(sequence, 0)
	data.writeUInt32BE(8, 4)
	data.writeUInt32BE(6, 8)
	data.writeUInt16BE(1, 20)
	data.writeUInt16BE(10, 22)
	return data
}

// An APNG whose default image (green IDAT) is outside the animation: IHDR, acTL (1 frame), IDAT, then fcTL 0 and
// fdAT 1 (red). Viewers without APNG support, and its still, show green.
function apngOutside(): Buffer {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(8, 0)
	ihdr.writeUInt32BE(6, 4)
	ihdr[8] = 8
	ihdr[9] = 2
	const actl = Buffer.alloc(8)
	actl.writeUInt32BE(1, 0)
	const sequence = Buffer.alloc(4)
	sequence.writeUInt32BE(1, 0)
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('acTL', actl),
		pngChunk('IDAT', flat([0, 255, 0])),
		pngChunk('fcTL', fcTL(0)),
		pngChunk('fdAT', Buffer.concat([sequence, flat([255, 0, 0])])),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

async function make(name: string): Promise<Buffer | null> {
	const input = () => sharp(noise(64, 48), { raw: { width: 64, height: 48, channels: 3 } })
	switch (name) {
		case 'progressive-jpeg':
			// Several scans, Exif and XMP in APP1, an ICC profile in APP2.
			return input()
				.jpeg({ progressive: true, quality: 90 })
				.withExif({ IFD0: { Copyright: 'fixture', Orientation: '1' } })
				.withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>')
				.withIccProfile('srgb')
				.toBuffer()
		case 'avif-exif':
			return input()
				.avif({ quality: 50 })
				.withExif({ IFD0: { Copyright: 'fixture' } })
				.toBuffer()
		case 'avif':
			return input().avif({ quality: 50 }).toBuffer()
		case 'apng-outside':
			return apngOutside()
		default:
			return null
	}
}

async function facts(body: Buffer): Promise<object> {
	const metadata = await sharp(body, { failOn: 'error' }).metadata()
	const rgba = await sharp(body, { failOn: 'error', page: 0 }).ensureAlpha().raw().toBuffer()
	return {
		format: metadata.format,
		width: metadata.width,
		height: metadata.height,
		pages: metadata.pages ?? 1,
		orientation: metadata.orientation ?? null,
		exif: metadata.exif !== undefined,
		xmp: metadata.xmp !== undefined,
		iptc: metadata.iptc !== undefined,
		comments: (metadata.comments ?? []).length,
		rgba: rgba.toString('base64'),
	}
}

function read(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => resolve(Buffer.concat(chunks)))
		req.on('error', reject)
	})
}

export function imageFacts(req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? '/', 'http://facts.invalid')
	const answer = async () => {
		if (url.pathname === '/facts') {
			try {
				const result = await facts(await read(req))
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify(result))
			} catch (error) {
				res.writeHead(422, { 'content-type': 'application/json' })
				res.end(JSON.stringify({ error: String(error) }))
			}
			return
		}
		const made = url.pathname === '/make' ? await make(url.searchParams.get('name') ?? '') : null
		if (made === null) {
			res.writeHead(404)
			res.end()
			return
		}
		res.writeHead(200, { 'content-type': 'application/octet-stream' })
		res.end(made)
	}
	answer().catch((error: unknown) => {
		res.writeHead(500)
		res.end(String(error))
	})
}
