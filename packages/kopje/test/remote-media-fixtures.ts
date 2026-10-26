import { env } from 'cloudflare:workers'

// Remote media fixtures with real container structure, built byte by byte where no encoder is at hand in workerd:
// ISO BMFF (MP4, M4A, HEIF-branded, QuickTime), EBML (WebM, Matroska), Ogg pages with their CRC, MPEG audio frames
// behind an ID3v2 tag, FLAC and WAV headers, a baseline JPEG encoder with restart markers, GIF blocks, an animated
// WebP assembled from libwebp's frames, Exif TIFF blocks, and the sharp-made fixtures and reader of
// test-node/image-facts.ts.

const text = (value: string) => new TextEncoder().encode(value)

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

function u32be(value: number): Uint8Array {
	const out = new Uint8Array(4)
	new DataView(out.buffer).setUint32(0, value)
	return out
}

function u16be(value: number): Uint8Array {
	return new Uint8Array([value >> 8, value & 0xff])
}

function u32le(value: number): Uint8Array {
	const out = new Uint8Array(4)
	new DataView(out.buffer).setUint32(0, value, true)
	return out
}

function u16le(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, value >> 8])
}

// --- ISO BMFF ---

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
	const body = concat(...payload)
	return concat(u32be(8 + body.length), text(type), body)
}

export function fullBox(type: string, version: number, ...payload: Uint8Array[]): Uint8Array {
	return box(type, new Uint8Array([version, 0, 0, 0]), ...payload)
}

export function ftyp(major: string, ...compatible: string[]): Uint8Array {
	return box('ftyp', text(major), u32be(0), ...compatible.map(text))
}

function trak(handler: string, width = 0, height = 0): Uint8Array {
	const tkhd = fullBox(
		'tkhd',
		0,
		new Uint8Array(20),
		new Uint8Array(8),
		new Uint8Array(8),
		// The identity matrix.
		concat(
			u32be(0x10000),
			u32be(0),
			u32be(0),
			u32be(0),
			u32be(0x10000),
			u32be(0),
			u32be(0),
			u32be(0),
			u32be(0x40000000)
		),
		u32be(width << 16),
		u32be(height << 16)
	)
	const hdlr = fullBox('hdlr', 0, u32be(0), text(handler), new Uint8Array(12), text('handler\0'))
	const header = handler === 'vide' ? fullBox('vmhd', 0, new Uint8Array(8)) : fullBox('smhd', 0, new Uint8Array(4))
	const stbl = box(
		'stbl',
		fullBox('stsd', 0, u32be(0)),
		fullBox('stts', 0, u32be(0)),
		fullBox('stsc', 0, u32be(0)),
		fullBox('stsz', 0, u32be(0), u32be(0)),
		fullBox('stco', 0, u32be(0))
	)
	const minf = box('minf', header, box('dinf', fullBox('dref', 0, u32be(0))), stbl)
	return box('trak', tkhd, box('mdia', fullBox('mdhd', 0, new Uint8Array(20)), hdlr, minf))
}

// An MP4 of the given tracks' handlers: ftyp, then moov (mvhd and one trak each), then mdat; `before` bytes of mdat
// come before moov instead (a file that is not faststart).
export function mp4(
	options: { brands?: string[]; handlers?: string[]; before?: number; mdat?: number } = {}
): Uint8Array {
	const [major = 'isom', ...compatible] = options.brands ?? ['isom', 'iso2', 'avc1', 'mp41']
	const moov = box(
		'moov',
		fullBox('mvhd', 0, new Uint8Array(96)),
		...(options.handlers ?? ['vide', 'soun']).map((h) => trak(h, 64, 48))
	)
	const mdat = box('mdat', new Uint8Array(options.mdat ?? 64))
	return options.before === undefined
		? concat(ftyp(major, ...compatible), moov, mdat)
		: concat(ftyp(major, ...compatible), box('mdat', new Uint8Array(options.before)), moov)
}

// --- EBML ---

// An EBML element size (RFC 8794 section 4) in the fewest bytes, up to 4.
function ebmlSize(size: number): Uint8Array {
	for (let length = 1; length <= 4; length++) {
		if (size < 2 ** (7 * length) - 1) {
			const out = new Uint8Array(length)
			let value = size
			for (let i = length - 1; i >= 0; i--) {
				out[i] = value & 0xff
				value = Math.floor(value / 256)
			}
			out[0] = (out[0] ?? 0) | (0x80 >> (length - 1))
			return out
		}
	}
	throw new RangeError('an EBML size past 4 bytes')
}

export function element(id: number, ...payload: Uint8Array[]): Uint8Array {
	const body = concat(...payload)
	const idBytes: number[] = []
	for (let value = id; value > 0; value = Math.floor(value / 256)) {
		idBytes.unshift(value & 0xff)
	}
	return concat(new Uint8Array(idBytes), ebmlSize(body.length), body)
}

function uint(id: number, value: number): Uint8Array {
	return element(id, new Uint8Array([value]))
}

// A WebM (or another DocType) of the given TrackTypes (1 video, 2 audio), its Tracks before one Cluster.
export function webm(options: { docType?: string; tracks?: number[]; clusterFirst?: boolean } = {}): Uint8Array {
	const header = element(
		0x1a45dfa3,
		uint(0x4286, 1),
		uint(0x42f7, 1),
		uint(0x42f2, 4),
		uint(0x42f3, 8),
		element(0x4282, text(options.docType ?? 'webm')),
		uint(0x4287, 4),
		uint(0x4285, 2)
	)
	const info = element(0x1549a966, element(0x2ad7b1, u32be(1_000_000)), element(0x4d80, text('fixture')))
	const tracks = element(
		0x1654ae6b,
		...(options.tracks ?? [1, 2]).map((type, i) =>
			element(
				0xae,
				uint(0xd7, i + 1),
				uint(0x83, type),
				element(0x86, text(type === 1 ? 'V_VP8' : 'A_OPUS')),
				...(type === 1 ? [element(0xe0, uint(0xb0, 64), uint(0xba, 48))] : [])
			)
		)
	)
	const cluster = element(0x1f43b675, uint(0xe7, 0), element(0xa3, new Uint8Array([0x81, 0, 0, 0x80, 1, 2, 3])))
	const segment = element(0x18538067, info, ...(options.clusterFirst ? [cluster, tracks] : [tracks, cluster]))
	return concat(header, segment)
}

// --- Ogg (RFC 3533) ---

const OGG_CRC = (() => {
	const table = new Uint32Array(256)
	for (let i = 0; i < 256; i++) {
		let r = i << 24
		for (let k = 0; k < 8; k++) {
			r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
		}
		table[i] = r >>> 0
	}
	return table
})()

// One beginning-of-stream Ogg page holding `packet`, with its CRC.
export function oggPage(packet: Uint8Array, serial = 1): Uint8Array {
	const header = concat(text('OggS'), new Uint8Array([0, 0x02]), new Uint8Array(8), u32le(serial), u32le(0), u32le(0))
	const lacing: number[] = []
	let left = packet.length
	while (left >= 255) {
		lacing.push(255)
		left -= 255
	}
	lacing.push(left)
	const page = concat(header, new Uint8Array([lacing.length, ...lacing]), packet)
	let crc = 0
	for (const byte of page) {
		crc = ((crc << 8) ^ (OGG_CRC[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0
	}
	page.set(u32le(crc), 22)
	return page
}

export const THEORA_PACKET = concat(
	new Uint8Array([0x80]),
	text('theora'),
	new Uint8Array([3, 2, 1, 0, 4, 0, 3, 0, 0, 64, 0, 0, 48])
)
export const VORBIS_PACKET = concat(
	new Uint8Array([0x01]),
	text('vorbis'),
	u32le(0),
	new Uint8Array([1]),
	u32le(44100),
	new Uint8Array(13)
)

// --- MPEG audio, FLAC, WAV ---

// An ID3v2.4 tag holding one TIT2 frame (or none), its size synchsafe.
export function id3(frames = true): Uint8Array {
	const body = frames ? concat(text('TIT2'), new Uint8Array([0, 0, 0, 8, 0, 0, 3]), text('fixture')) : new Uint8Array(0)
	const size = body.length
	return concat(
		text('ID3'),
		new Uint8Array([4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
		body
	)
}

// `count` MPEG-1 Layer III frames at 128 kbit/s and 44.1 kHz: 417 bytes each (144000 × 128 / 44100, no padding).
export function mp3Frames(count = 3): Uint8Array {
	const frame = new Uint8Array(417)
	frame.set([0xff, 0xfb, 0x90, 0x00])
	return concat(...Array.from({ length: count }, () => frame))
}

export function flac(): Uint8Array {
	const streamInfo = new Uint8Array(34)
	streamInfo.set([0x10, 0x00, 0x10, 0x00])
	// 44,100 Hz, 2 channels, 16 bits per sample.
	streamInfo.set([0x0a, 0xc4, 0x42, 0xf0], 10)
	return concat(text('fLaC'), new Uint8Array([0x80, 0, 0, 34]), streamInfo, new Uint8Array([0xff, 0xf8, 0x69, 0x08]))
}

export function wav(format = 1): Uint8Array {
	const fmt = concat(u16le(format), u16le(1), u32le(8000), u32le(16000), u16le(2), u16le(16))
	const data = new Uint8Array(64)
	const body = concat(text('WAVE'), text('fmt '), u32le(fmt.length), fmt, text('data'), u32le(data.length), data)
	return concat(text('RIFF'), u32le(body.length), body)
}

// --- JPEG ---

// The standard luminance DC Huffman table (ITU-T T.81 table K.3): code lengths and categories.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_CODES = (() => {
	const codes: { code: number; length: number }[] = []
	let code = 0
	let k = 0
	for (let length = 1; length <= 16; length++) {
		for (let n = 0; n < (DC_BITS[length - 1] ?? 0); n++) {
			codes[k++] = { code, length }
			code++
		}
		code <<= 1
	}
	return codes
})()

function segment(marker: number, payload: Uint8Array): Uint8Array {
	return concat(new Uint8Array([0xff, marker]), u16be(payload.length + 2), payload)
}

// A baseline grayscale JPEG of 8x8 blocks of the given levels (one row), DC only, with a restart marker after every
// block (DRI 1), as a decoder reads one: DQT of ones, SOF0, the DC table above, an AC table holding only EOB (code 0),
// DRI, SOS, the entropy-coded data with its byte stuffing and RSTn markers, EOI.
export function restartJpeg(levels: number[]): Uint8Array {
	const bits: number[] = []
	const put = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) {
			bits.push((value >> i) & 1)
		}
	}
	const entropy: number[] = []
	const flush = () => {
		while (bits.length % 8 !== 0) {
			bits.push(1)
		}
		for (let i = 0; i < bits.length; i += 8) {
			const byte = bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0)
			entropy.push(byte)
			if (byte === 0xff) {
				entropy.push(0x00)
			}
		}
		bits.length = 0
	}
	levels.forEach((level, i) => {
		// A block's DC coefficient for a flat level: 8 × (level − 128), predicted from 0 after each restart.
		const diff = 8 * (level - 128)
		const magnitude = Math.abs(diff)
		const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1
		const { code, length } = DC_CODES[category] ?? { code: 0, length: 0 }
		put(code, length)
		put(diff >= 0 ? diff : diff + (1 << category) - 1, category)
		put(0, 1)
		flush()
		if (i < levels.length - 1) {
			entropy.push(0xff, 0xd0 + (i % 8))
		}
	})
	return concat(
		new Uint8Array([0xff, 0xd8]),
		segment(0xe0, concat(text('JFIF\0'), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]))),
		segment(0xdb, concat(new Uint8Array([0]), new Uint8Array(64).fill(1))),
		segment(0xc0, concat(new Uint8Array([8]), u16be(8), u16be(8 * levels.length), new Uint8Array([1, 1, 0x11, 0]))),
		segment(
			0xc4,
			concat(
				new Uint8Array([0x00, ...DC_BITS]),
				Uint8Array.from({ length: 12 }, (_, i) => i)
			)
		),
		segment(0xc4, concat(new Uint8Array([0x10, 1, ...new Array<number>(15).fill(0)]), new Uint8Array([0]))),
		segment(0xdd, u16be(1)),
		segment(0xda, new Uint8Array([1, 1, 0x00, 0, 63, 0])),
		new Uint8Array(entropy),
		new Uint8Array([0xff, 0xd9])
	)
}

export function jpegSegment(marker: number, payload: Uint8Array | string): Uint8Array {
	return segment(marker, typeof payload === 'string' ? text(payload) : payload)
}

// The JPEG's markers as a reader that knows nothing of the walk under test sees them: the segments before the first
// SOS, then, after each scan, the next marker found by skipping FF00 and FFD0-FFD7, up to EOI.
export function jpegMarkers(bytes: Uint8Array): number[] {
	const markers: number[] = []
	let i = 2
	while (i < bytes.length) {
		while (bytes[i] === 0xff && bytes[i + 1] === 0xff) {
			i++
		}
		const marker = bytes[i + 1] ?? 0
		markers.push(marker)
		if (marker === 0xd9) {
			break
		}
		if (marker >= 0xd0 && marker <= 0xd7) {
			i += 2
			continue
		}
		i += 2 + (((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))
		if (marker === 0xda) {
			while (!(
				bytes[i] === 0xff &&
				bytes[i + 1] !== 0x00 &&
				!((bytes[i + 1] ?? 0) >= 0xd0 && (bytes[i + 1] ?? 0) <= 0xd7)
			)) {
				i++
			}
		}
	}
	return markers
}

// The positions of the JPEG's SOS markers and of its EOI.
export function jpegScans(bytes: Uint8Array): { sos: number[]; eoi: number } {
	const sos: number[] = []
	let i = 2
	for (;;) {
		const marker = bytes[i + 1] ?? 0
		if (marker === 0xd9) {
			return { sos, eoi: i }
		}
		if (marker === 0xda) {
			sos.push(i)
		}
		i += 2 + (((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))
		if (marker === 0xda) {
			while (!(
				bytes[i] === 0xff &&
				bytes[i + 1] !== 0x00 &&
				!((bytes[i + 1] ?? 0) >= 0xd0 && (bytes[i + 1] ?? 0) <= 0xd7)
			)) {
				i++
			}
		}
	}
}

// An Exif block ("Exif\0\0" and a TIFF of IFD0) holding Orientation, in either byte order.
export function exifOrientation(orientation: number, order: 'II' | 'MM' = 'II'): Uint8Array {
	const tiff = new Uint8Array(8 + 2 + 12 + 4)
	const view = new DataView(tiff.buffer)
	const little = order === 'II'
	tiff.set(text(order))
	view.setUint16(2, 42, little)
	view.setUint32(4, 8, little)
	view.setUint16(8, 1, little)
	view.setUint16(10, 0x0112, little)
	view.setUint16(12, 3, little)
	view.setUint32(14, 1, little)
	view.setUint16(18, orientation, little)
	return concat(text('Exif\0\0'), tiff)
}

// --- PNG, WebP, GIF ---

// A PNG with one more chunk before its IEND (CRC left zero: the walks do not read it).
export function pngWithChunkBeforeEnd(png: Uint8Array, type: string, payload: Uint8Array): Uint8Array {
	const end = png.length - 12
	return concat(png.subarray(0, end), u32be(payload.length), text(type), payload, new Uint8Array(4), png.subarray(end))
}

export function webpChunk(type: string, payload: Uint8Array): Uint8Array {
	return concat(
		text(type),
		u32le(payload.length),
		payload,
		payload.length % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0)
	)
}

export function riff(chunks: Uint8Array[]): Uint8Array {
	const body = concat(text('WEBP'), ...chunks)
	return concat(text('RIFF'), u32le(body.length), body)
}

// The chunks of a WebP after its 12-byte header, as [type, payload] pairs.
export function webpChunks(bytes: Uint8Array): [string, Uint8Array][] {
	const chunks: [string, Uint8Array][] = []
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	for (let i = 12; i + 8 <= bytes.length;) {
		const length = view.getUint32(i + 4, true)
		chunks.push([String.fromCharCode(...bytes.subarray(i, i + 4)), bytes.subarray(i + 8, i + 8 + length)])
		i += 8 + length + (length % 2)
	}
	return chunks
}

function u24le(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff])
}

// An animated WebP of `frames` (each a still WebP's ALPH and VP8 or VP8L chunks) on a canvas of the first frame's size,
// with the ANIM background colour `background` (BGRA), the first frame at `offset`.
export function animatedWebp(
	frames: Uint8Array[],
	size: { width: number; height: number },
	options: { background?: number[]; offset?: number; frameSize?: { width: number; height: number } } = {}
): Uint8Array {
	const flags = 0x02 | 0x10
	const vp8x = webpChunk(
		'VP8X',
		concat(new Uint8Array([flags, 0, 0, 0]), u24le(size.width - 1), u24le(size.height - 1))
	)
	const anim = webpChunk('ANIM', concat(new Uint8Array(options.background ?? [0, 0, 255, 255]), u16le(0)))
	const anmf = frames.map((frame, i) => {
		const chunks = webpChunks(frame).filter(([type]) => type === 'ALPH' || type === 'VP8 ' || type === 'VP8L')
		const frameSize = (i === 0 ? options.frameSize : undefined) ?? size
		const offset = i === 0 ? (options.offset ?? 0) : 0
		return webpChunk(
			'ANMF',
			concat(
				u24le(offset / 2),
				u24le(offset / 2),
				u24le(frameSize.width - 1),
				u24le(frameSize.height - 1),
				u24le(100),
				new Uint8Array([0]),
				...chunks.map(([type, payload]) => webpChunk(type, payload))
			)
		)
	})
	return riff([vp8x, anim, ...anmf])
}

// GIF89a extensions: a comment, plain text, and an application extension (its 11-byte identifier, then data).
export function gifExtension(label: number, ...blocks: Uint8Array[]): Uint8Array {
	return concat(
		new Uint8Array([0x21, label]),
		...blocks.map((block) => concat(new Uint8Array([block.length]), block)),
		new Uint8Array([0])
	)
}

export const gifComment = (value: string) => gifExtension(0xfe, text(value))
export const gifXmp = () => gifExtension(0xff, text('XMP DataXMP'), text('<x:xmpmeta/>'))
export const gifPlainText = () => gifExtension(0x01, new Uint8Array(12), text('hello'))

// The GIF with `blocks` inserted right before its first image's graphic control extension (or descriptor).
export function gifWithBlocks(gif: Uint8Array, at: number, ...blocks: Uint8Array[]): Uint8Array {
	return concat(gif.subarray(0, at), ...blocks, gif.subarray(at))
}

// --- The Node reader and maker (test-node/image-facts.ts) ---

const facts = (env as unknown as { IMAGE_FACTS: Fetcher }).IMAGE_FACTS

export type ImageFacts = {
	format: string
	width: number
	height: number
	pages: number
	orientation: number | null
	exif: boolean
	xmp: boolean
	iptc: boolean
	comments: number
	rgba: Uint8Array
}

// What sharp reads from `bytes`, or null when it cannot decode them.
export async function imageFacts(bytes: Uint8Array): Promise<ImageFacts | null> {
	const response = await facts.fetch('https://facts.example/facts', { method: 'POST', body: bytes })
	if (!response.ok) {
		await response.body?.cancel()
		return null
	}
	const json: Omit<ImageFacts, 'rgba'> & { rgba: string } = await response.json()
	return { ...json, rgba: Uint8Array.from(atob(json.rgba), (c) => c.charCodeAt(0)) }
}

export async function madeFixture(
	name: 'progressive-jpeg' | 'avif-exif' | 'avif' | 'apng-outside'
): Promise<Uint8Array> {
	const response = await facts.fetch(`https://facts.example/make?name=${name}`)
	if (!response.ok) {
		throw new Error(`no fixture ${name}`)
	}
	return new Uint8Array(await response.arrayBuffer())
}
