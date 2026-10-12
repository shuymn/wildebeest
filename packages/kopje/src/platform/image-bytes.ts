// Byte-level checks of images, on both sides of re-encoding:
//   - sniffImageType: the type an upload really is, from its signature, never from the client's Content-Type or file
//     name (MEDIA-4). Only the accepted image types are recognized.
//   - retainedMetadata: whether a re-encoded file still carries any metadata but a colour profile, as a check on the
//     transformation's output (MEDIA-3). It walks the container's chunks and only reads lengths and tags, so its
//     work is linear in the input and bounded by it (RES-2).

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif'

function ascii(bytes: Uint8Array, start: number, length: number): string {
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

// The only application segments a re-encoded JPEG may keep: JFIF and JFXX (APP0), ICC_PROFILE (APP2), Adobe (APP14).
function allowedJpegSegment(marker: number, data: Uint8Array): RetainedMetadata | null {
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

function jpegMetadata(bytes: Uint8Array): RetainedMetadata | null {
	if (sniffImageType(bytes) !== 'image/jpeg') {
		return 'unreadable'
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let i = 2
	while (i + 4 <= bytes.length) {
		if (bytes[i] !== 0xff) {
			return 'unreadable'
		}
		const marker = bytes[i + 1] ?? 0
		if (marker === 0xff) {
			i += 1
			continue
		}
		if (marker === 0xda || marker === 0xd9) {
			// Start of scan (entropy-coded data follows) or end of image: no more metadata segments.
			return null
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2
			continue
		}
		const length = view.getUint16(i + 2)
		if (length < 2 || i + 2 + length > bytes.length) {
			return 'unreadable'
		}
		const found = allowedJpegSegment(marker, bytes.subarray(i + 4, i + 2 + length))
		if (found !== null) {
			return found
		}
		i += 2 + length
	}
	return 'unreadable'
}

// PNG chunks a re-encoded image may keep: structure, transparency, colour (gAMA, cHRM, sRGB, iCCP), pixel density and
// animation (APNG). Anything else counts as metadata.
const PNG_CHUNKS = new Set([
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

function pngMetadata(bytes: Uint8Array): RetainedMetadata | null {
	if (sniffImageType(bytes) !== 'image/png') {
		return 'unreadable'
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let i = 8
	while (i + 12 <= bytes.length) {
		const length = view.getUint32(i)
		const type = ascii(bytes, i + 4, 4)
		const end = i + 12 + length
		if (end > bytes.length) {
			return 'unreadable'
		}
		if (type === 'eXIf') {
			return 'exif'
		}
		if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
			return 'text'
		}
		if (!PNG_CHUNKS.has(type)) {
			return 'segment'
		}
		if (type === 'IEND') {
			// Nothing may follow the end of the image.
			return end === bytes.length ? null : 'unreadable'
		}
		i = end
	}
	return 'unreadable'
}

// WebP chunks a re-encoded image may keep: image data, alpha, the extended header, the colour profile and animation.
const WEBP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP', 'ANIM', 'ANMF'])

function webpMetadata(bytes: Uint8Array): RetainedMetadata | null {
	if (sniffImageType(bytes) !== 'image/webp') {
		return 'unreadable'
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// The RIFF extent must cover the file exactly: nothing outside it, and no chunk past it.
	const end = 8 + view.getUint32(4, true)
	if (end !== bytes.length) {
		return 'unreadable'
	}
	let i = 12
	while (i + 8 <= end) {
		const type = ascii(bytes, i, 4)
		const length = view.getUint32(i + 4, true)
		const next = i + 8 + length + (length % 2)
		if (next > end) {
			return 'unreadable'
		}
		if (type === 'EXIF') {
			return 'exif'
		}
		if (type === 'XMP ') {
			return 'xmp'
		}
		if (!WEBP_CHUNKS.has(type)) {
			return 'segment'
		}
		i = next
	}
	return i === end ? null : 'unreadable'
}
