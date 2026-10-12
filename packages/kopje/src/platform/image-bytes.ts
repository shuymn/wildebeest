// Byte-level checks of images, on both sides of re-encoding:
//   - sniffImageType: the type an upload really is, from its signature, never from the client's Content-Type or file
//     name (MEDIA-4). Only the accepted image types are recognized.
//   - retainedMetadata: whether a re-encoded file still carries metadata that can locate or identify the uploader
//     (GPS EXIF, XMP, IPTC), as a check on the transformation's output (MEDIA-3). It walks the container's chunks and
//     only reads lengths and tags, so its work is linear in the input and bounded by it (RES-2).

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

// What the output still carries, or null when it carries nothing that locates or identifies. A file that cannot be
// walked counts as carrying metadata (fail closed).
export type RetainedMetadata = 'gps' | 'xmp' | 'iptc' | 'unreadable'

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

const EXIF_HEADER = 'Exif\0\0'
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0'

function jpegMetadata(bytes: Uint8Array): RetainedMetadata | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (sniffImageType(bytes) !== 'image/jpeg') {
		return 'unreadable'
	}
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
		const segment = bytes.subarray(i + 4, i + 2 + length)
		if (marker === 0xe1) {
			if (ascii(segment, 0, EXIF_HEADER.length) === EXIF_HEADER) {
				const gps = tiffHasGps(segment.subarray(EXIF_HEADER.length))
				if (gps !== false) {
					return gps === 'unreadable' ? 'unreadable' : 'gps'
				}
			} else if (ascii(segment, 0, XMP_HEADER.length) === XMP_HEADER) {
				return 'xmp'
			}
		} else if (marker === 0xed) {
			return 'iptc'
		}
		i += 2 + length
	}
	return 'unreadable'
}

function pngMetadata(bytes: Uint8Array): RetainedMetadata | null {
	if (sniffImageType(bytes) !== 'image/png') {
		return 'unreadable'
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let i = 8
	while (i + 8 <= bytes.length) {
		const length = view.getUint32(i)
		const type = ascii(bytes, i + 4, 4)
		if (i + 12 + length > bytes.length) {
			return 'unreadable'
		}
		const data = bytes.subarray(i + 8, i + 8 + length)
		if (type === 'IEND') {
			return null
		}
		if (type === 'eXIf') {
			const gps = tiffHasGps(data)
			if (gps !== false) {
				return gps === 'unreadable' ? 'unreadable' : 'gps'
			}
		} else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
			// PNG keywords are 1-79 bytes.
			const keyword = ascii(data, 0, Math.min(Math.max(data.indexOf(0), 0), 79))
			if (keyword === 'XML:com.adobe.xmp' || keyword === 'Raw profile type xmp') {
				return 'xmp'
			}
			if (keyword === 'Raw profile type exif' || keyword === 'Raw profile type APP1') {
				return 'gps'
			}
			if (keyword === 'Raw profile type iptc') {
				return 'iptc'
			}
		}
		i += 12 + length
	}
	return 'unreadable'
}

function webpMetadata(bytes: Uint8Array): RetainedMetadata | null {
	if (sniffImageType(bytes) !== 'image/webp') {
		return 'unreadable'
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const end = Math.min(bytes.length, 8 + view.getUint32(4, true))
	let i = 12
	while (i + 8 <= end) {
		const type = ascii(bytes, i, 4)
		const length = view.getUint32(i + 4, true)
		if (i + 8 + length > end) {
			return 'unreadable'
		}
		const data = bytes.subarray(i + 8, i + 8 + length)
		if (type === 'EXIF') {
			const tiff = ascii(data, 0, EXIF_HEADER.length) === EXIF_HEADER ? data.subarray(EXIF_HEADER.length) : data
			const gps = tiffHasGps(tiff)
			if (gps !== false) {
				return gps === 'unreadable' ? 'unreadable' : 'gps'
			}
		} else if (type === 'XMP ') {
			return 'xmp'
		}
		i += 8 + length + (length % 2)
	}
	return i === end ? null : 'unreadable'
}

const GPS_IFD_POINTER = 0x8825

// Whether a TIFF structure (the body of an EXIF block) has a GPS IFD in IFD0, where EXIF keeps it.
function tiffHasGps(tiff: Uint8Array): boolean | 'unreadable' {
	if (tiff.length < 8) {
		return 'unreadable'
	}
	const order = ascii(tiff, 0, 2)
	if (order !== 'II' && order !== 'MM') {
		return 'unreadable'
	}
	const little = order === 'II'
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
	const ifd = view.getUint32(4, little)
	if (ifd + 2 > tiff.length) {
		return 'unreadable'
	}
	const count = view.getUint16(ifd, little)
	if (ifd + 2 + count * 12 > tiff.length) {
		return 'unreadable'
	}
	for (let entry = 0; entry < count; entry++) {
		if (view.getUint16(ifd + 2 + entry * 12, little) === GPS_IFD_POINTER) {
			return true
		}
	}
	return false
}
