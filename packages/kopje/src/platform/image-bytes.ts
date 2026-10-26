// Byte-level checks of images, on both sides of re-encoding:
//   - sniffImageType: the type an upload really is, from its signature, never from the client's Content-Type or file
//     name (MEDIA-4). Only the accepted image types are recognized.
//   - retainedMetadata: whether a re-encoded file still carries any metadata but a colour profile, as a check on the
//     transformation's output (MEDIA-3). It walks the container's chunks (a JPEG's segments and scans up to EOI) and
//     only reads lengths and tags, so its work is linear in the input and bounded by it (RES-2).
//   - isAnimated: whether a re-encoded file holds several frames, through the same chunk walks.
// The walkers are shared with the checks of remote media's bytes (platform/remote-media-bytes.ts).

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif'

// Mastodon's matrix limit for images (the pixels it advertises), for local uploads (platform/images.ts), card images
// and remote media, which read it from the file's headers.
export const IMAGE_MATRIX_LIMIT = 16_777_216

export function ascii(bytes: Uint8Array, start: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(start, start + length))
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function sniffImageType(bytes: Uint8Array): ImageType | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg'
	}
	if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
		return 'image/png'
	}
	if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
		return 'image/gif'
	}
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
		return 'image/webp'
	}
	if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 4))) {
		return 'image/avif'
	}
	return null
}

// What the output still carries, or null when it carries no metadata beyond colour (ICC profiles are kept). Any EXIF
// block (serial numbers, MakerNote and timestamps identify a camera and its owner, wherever a GPS IFD may sit), XMP,
// IPTC, comments, text chunks and unknown JPEG application segments count. A file that cannot be walked counts too
// (fail closed); so does any type the walker does not know.
export type RetainedMetadata = 'exif' | 'xmp' | 'iptc' | 'comment' | 'text' | 'segment' | 'unreadable'

export function retainedMetadata(bytes: Uint8Array, type: string): RetainedMetadata | null {
	switch (type) {
		case 'image/jpeg':
			return jpegMetadata(bytes)
		case 'image/png':
			return pngMetadata(bytes)
		case 'image/webp':
			return webpMetadata(bytes)
		default:
			return 'unreadable'
	}
}

function startsWith(data: Uint8Array, prefix: string): boolean {
	return data.length >= prefix.length && ascii(data, 0, prefix.length) === prefix
}

// What a JPEG marker segment with `data` carries, or null when a re-encoded JPEG may keep it: the only application
// segments kept are JFIF and JFXX (APP0), ICC_PROFILE (APP2) and Adobe (APP14); COM and every other APPn count.
export function jpegSegmentMetadata(marker: number, data: Uint8Array): RetainedMetadata | null {
	switch (marker) {
		case 0xe0:
			return startsWith(data, 'JFIF\0') || startsWith(data, 'JFXX\0') ? null : 'segment'
		case 0xe1:
			return startsWith(data, 'Exif\0') ? 'exif' : startsWith(data, 'http://ns.adobe.com/') ? 'xmp' : 'segment'
		case 0xe2:
			return startsWith(data, 'ICC_PROFILE\0') ? null : 'segment'
		case 0xed:
			return 'iptc'
		case 0xee:
			return startsWith(data, 'Adobe') ? null : 'segment'
		case 0xfe:
			return 'comment'
		default:
			return marker >= 0xe0 && marker <= 0xef ? 'segment' : null
	}
}

// A container walk that met a malformed file.
export const MALFORMED = Symbol('malformed')

// One piece of a JPEG (walkJpeg): a marker with its segment (its payload from `dataStart` to `end`, empty for SOI,
// EOI, RSTn and TEM), the entropy-coded data of a scan, or fill bytes (0xFF) before a marker. Offsets are into the
// file; the pieces cover it from 0 to the end of EOI without gaps.
export type JpegPiece =
	| { kind: 'marker'; marker: number; start: number; end: number; dataStart: number }
	| { kind: 'entropy' | 'fill'; start: number; end: number }

// Walks a JPEG from SOI to EOI (ITU-T T.81 B.1): its marker segments, and after each SOS its entropy-coded data, where
// FF00 is stuffing, FFD0-FFD7 are restart markers and any other marker ends the scan; the markers between and after
// scans (DHT, DQT, DRI, DNL, further SOS) are walked the same way up to EOI. Calls `visit` with every piece and stops
// with the first value it returns. MALFORMED when there is no SOI, a second SOI, a byte outside a scan that starts no
// marker, a segment past the file's end or no EOI; otherwise the offset just past EOI (what follows it is not walked).
// Each byte is looked at a bounded number of times (the scan's search is indexOf), so the work is linear (RES-2).
export function walkJpeg<T>(
	bytes: Uint8Array,
	visit: (piece: JpegPiece) => T | undefined
): T | number | typeof MALFORMED {
	if (sniffImageType(bytes) !== 'image/jpeg') {
		return MALFORMED
	}
	const n = bytes.length
	const soi = visit({ kind: 'marker', marker: 0xd8, start: 0, end: 2, dataStart: 2 })
	if (soi !== undefined) {
		return soi
	}
	let i = 2
	for (;;) {
		if (i >= n || bytes[i] !== 0xff) {
			return MALFORMED
		}
		let at = i
		while (at + 1 < n && bytes[at + 1] === 0xff) {
			at++
		}
		if (at + 1 >= n) {
			return MALFORMED
		}
		if (at > i) {
			const fill = visit({ kind: 'fill', start: i, end: at })
			if (fill !== undefined) {
				return fill
			}
		}
		const marker = bytes[at + 1] ?? 0
		if (marker === 0x00 || marker === 0xd8) {
			return MALFORMED
		}
		if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			const found = visit({ kind: 'marker', marker, start: at, end: at + 2, dataStart: at + 2 })
			if (found !== undefined) {
				return found
			}
			if (marker === 0xd9) {
				return at + 2
			}
			i = at + 2
			continue
		}
		if (at + 4 > n) {
			return MALFORMED
		}
		const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
		const end = at + 2 + length
		if (length < 2 || end > n) {
			return MALFORMED
		}
		const found = visit({ kind: 'marker', marker, start: at, end, dataStart: at + 4 })
		if (found !== undefined) {
			return found
		}
		i = end
		if (marker !== 0xda) {
			continue
		}
		// The scan's entropy-coded data, up to the first marker that is neither stuffing nor a restart marker.
		let k = i
		for (;;) {
			k = bytes.indexOf(0xff, k)
			if (k < 0 || k + 1 >= n) {
				return MALFORMED
			}
			const next = bytes[k + 1] ?? 0
			if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
				k += 2
				continue
			}
			break
		}
		if (k > i) {
			const entropy = visit({ kind: 'entropy', start: i, end: k })
			if (entropy !== undefined) {
				return entropy
			}
		}
		i = k
	}
}

function jpegMetadata(bytes: Uint8Array): RetainedMetadata | null {
	const found = walkJpeg<RetainedMetadata>(bytes, (piece) =>
		piece.kind === 'marker' && piece.end > piece.dataStart
			? (jpegSegmentMetadata(piece.marker, bytes.subarray(piece.dataStart, piece.end)) ?? undefined)
			: undefined
	)
	if (found === MALFORMED) {
		return 'unreadable'
	}
	// Anything after EOI (a second image, an appended file) is not an image the walk can vouch for.
	return typeof found === 'number' ? (found === bytes.length ? null : 'unreadable') : found
}

// PNG chunks a re-encoded image may keep: structure, transparency, colour (gAMA, cHRM, sRGB, iCCP), pixel density and
// animation (APNG). Anything else counts as metadata.
export const PNG_CHUNKS: ReadonlySet<string> = new Set([
	'IHDR',
	'PLTE',
	'IDAT',
	'IEND',
	'tRNS',
	'gAMA',
	'cHRM',
	'sRGB',
	'iCCP',
	'pHYs',
	'acTL',
	'fcTL',
	'fdAT',
])

// Walks a PNG's chunks after its signature, calling `visit` with each chunk's type, data offset and data length, and
// stops with the first value it returns. MALFORMED when a chunk passes the file's end, when anything follows IEND, or
// when IEND is missing; undefined when it reached IEND and `visit` returned nothing. Only lengths and tags are read.
export function walkPng<T>(bytes: Uint8Array, visit: (type: string, start: number, length: number) => T | undefined) {
	if (sniffImageType(bytes) !== 'image/png') {
		return MALFORMED
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let i = 8
	while (i + 12 <= bytes.length) {
		const length = view.getUint32(i)
		const type = ascii(bytes, i + 4, 4)
		const end = i + 12 + length
		if (end > bytes.length) {
			return MALFORMED
		}
		const found = visit(type, i + 8, length)
		if (found !== undefined) {
			return found
		}
		if (type === 'IEND') {
			// Nothing may follow the end of the image.
			return end === bytes.length ? undefined : MALFORMED
		}
		i = end
	}
	return MALFORMED
}

function pngMetadata(bytes: Uint8Array): RetainedMetadata | null {
	const found = walkPng<RetainedMetadata>(bytes, (type) => {
		if (type === 'eXIf') {
			return 'exif'
		}
		if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
			return 'text'
		}
		return PNG_CHUNKS.has(type) ? undefined : 'segment'
	})
	return found === MALFORMED ? 'unreadable' : (found ?? null)
}

// WebP chunks a re-encoded image may keep: image data, alpha, the extended header, the colour profile and animation.
export const WEBP_CHUNKS: ReadonlySet<string> = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP', 'ANIM', 'ANMF'])

// Walks a WebP's chunks as walkPng walks a PNG's. MALFORMED unless the RIFF extent covers the file exactly and every
// chunk, with its padding to an even length, ends within it.
export function walkWebp<T>(bytes: Uint8Array, visit: (type: string, start: number, length: number) => T | undefined) {
	if (sniffImageType(bytes) !== 'image/webp') {
		return MALFORMED
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// The RIFF extent must cover the file exactly: nothing outside it, and no chunk past it.
	const end = 8 + view.getUint32(4, true)
	if (end !== bytes.length) {
		return MALFORMED
	}
	let i = 12
	while (i + 8 <= end) {
		const type = ascii(bytes, i, 4)
		const length = view.getUint32(i + 4, true)
		const next = i + 8 + length + (length % 2)
		if (next > end) {
			return MALFORMED
		}
		const found = visit(type, i + 8, length)
		if (found !== undefined) {
			return found
		}
		i = next
	}
	return i === end ? undefined : MALFORMED
}

function webpMetadata(bytes: Uint8Array): RetainedMetadata | null {
	const found = walkWebp<RetainedMetadata>(bytes, (type) => {
		if (type === 'EXIF') {
			return 'exif'
		}
		if (type === 'XMP ') {
			return 'xmp'
		}
		return WEBP_CHUNKS.has(type) ? undefined : 'segment'
	})
	return found === MALFORMED ? 'unreadable' : (found ?? null)
}

// VP8X's flags byte (the first of its 10 data bytes) marks an animation with 0x02 (RFC 9649 section 2.7).
export const VP8X_BYTES = 10
export const VP8X_ANIMATION = 0x02

// Whether a re-encoded file holds more than one frame, or may: a WebP with the VP8X animation flag or an ANIM or ANMF
// chunk (RFC 9649 section 2.7), a PNG with an acTL chunk anywhere (APNG). A file the walkers cannot walk, a short
// VP8X, and any other type count as animated (fail closed: a preview is refused, and a served image only gets its
// preview as a still). The walk reads only lengths and tags, so its work is linear in the output (RES-2).
export function isAnimated(bytes: Uint8Array, type: string): boolean {
	switch (type) {
		case 'image/png':
			return walkPng(bytes, (chunk) => (chunk === 'acTL' ? true : undefined)) !== undefined
		case 'image/webp':
			return (
				walkWebp(bytes, (chunk, start, length) => {
					if (chunk === 'ANIM' || chunk === 'ANMF') {
						return true
					}
					if (chunk === 'VP8X') {
						return length < VP8X_BYTES || ((bytes[start] ?? 0) & VP8X_ANIMATION) !== 0 ? true : undefined
					}
					return undefined
				}) !== undefined
			)
		default:
			return true
	}
}

// A WebP's size as its header states it (RFC 9649 sections 2.5-2.7), from its first chunk: VP8X's canvas (24-bit
// width and height minus one), else VP8's frame header (14-bit sizes after the start code 9D 01 2A) or VP8L's (14-bit
// sizes minus one after the signature 0x2F). Null for a file the walker cannot walk, a short or malformed first
// chunk, or another type. Reads at most the first chunk's leading bytes (RES-2).
export function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
	let first: { type: string; start: number; length: number } | undefined
	const walked = walkWebp(bytes, (type, start, length) => {
		first ??= { type, start, length }
		return undefined
	})
	if (walked === MALFORMED || first === undefined) {
		return null
	}
	const { type, start, length } = first
	const at = (i: number) => bytes[start + i] ?? 0
	if (type === 'VP8X' && length >= VP8X_BYTES) {
		const u24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16)
		return { width: u24(4) + 1, height: u24(7) + 1 }
	}
	if (type === 'VP8 ' && length >= 10 && at(3) === 0x9d && at(4) === 0x01 && at(5) === 0x2a) {
		const width = (at(6) | (at(7) << 8)) & 0x3fff
		const height = (at(8) | (at(9) << 8)) & 0x3fff
		return width > 0 && height > 0 ? { width, height } : null
	}
	if (type === 'VP8L' && length >= 5 && at(0) === 0x2f) {
		const bits = at(1) | (at(2) << 8) | (at(3) << 16) | (at(4) << 24)
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
	}
	return null
}
