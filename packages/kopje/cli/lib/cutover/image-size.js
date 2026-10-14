// Width and height from an image's header, for `kopje-admin images-export`: PNG (IHDR), JPEG (the first SOF segment),
// GIF (the logical screen) and WebP (VP8, VP8L and VP8X). It reads lengths and fixed fields only, within the bytes it
// is given, so a damaged or hostile file gives null instead of a size. The type comes from Kopje's own signature check
// (sniffImageType); a type it does not read (AVIF) gives null as well.

/**
 * @param {Uint8Array} bytes
 * @param {string} type the type sniffImageType detected
 * @returns {{ width: number, height: number } | null}
 */
export function imageSize(bytes, type) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	/** @type {{ width: number, height: number } | null} */
	let size = null
	switch (type) {
		case 'image/png':
			// Signature (8), IHDR length (4) and type (4), then width and height.
			if (bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR') {
				size = { width: view.getUint32(16), height: view.getUint32(20) }
			}
			break
		case 'image/gif':
			if (bytes.length >= 10) {
				size = { width: view.getUint16(6, true), height: view.getUint16(8, true) }
			}
			break
		case 'image/jpeg':
			size = jpegSize(bytes, view)
			break
		case 'image/webp':
			size = webpSize(bytes, view)
			break
		default:
			break
	}
	return size !== null && size.width > 0 && size.height > 0 ? size : null
}

/** @param {Uint8Array} bytes @param {number} start @param {number} length */
function ascii(bytes, start, length) {
	return String.fromCharCode(...bytes.subarray(start, start + length))
}

// Start-of-frame markers: C0-CF except DHT (C4), JPG (C8) and DAC (CC).
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** @param {Uint8Array} bytes @param {DataView} view */
function jpegSize(bytes, view) {
	let i = 2
	while (i + 4 <= bytes.length) {
		if (bytes[i] !== 0xff) {
			return null
		}
		const marker = bytes[i + 1] ?? 0
		if (marker === 0xff) {
			i += 1
			continue
		}
		if (marker === 0xd9 || marker === 0xda) {
			return null
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2
			continue
		}
		const length = view.getUint16(i + 2)
		if (length < 2 || i + 2 + length > bytes.length) {
			return null
		}
		if (SOF.has(marker)) {
			// Length (2), precision (1), height (2), width (2).
			return length >= 7 ? { width: view.getUint16(i + 7), height: view.getUint16(i + 5) } : null
		}
		i += 2 + length
	}
	return null
}

/** @param {Uint8Array} bytes @param {DataView} view */
function webpSize(bytes, view) {
	if (bytes.length < 30) {
		return null
	}
	const chunk = ascii(bytes, 12, 4)
	if (chunk === 'VP8 ') {
		// Frame tag (3) and start code 9d 01 2a, then 14-bit width and height.
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
			return null
		}
		return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
	}
	if (chunk === 'VP8L') {
		if (bytes[20] !== 0x2f) {
			return null
		}
		const bits = view.getUint32(21, true)
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
	}
	if (chunk === 'VP8X') {
		const u24 = (/** @type {number} */ at) =>
			(bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)
		return { width: u24(24) + 1, height: u24(27) + 1 }
	}
	return null
}
