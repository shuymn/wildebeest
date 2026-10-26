import { ascii, type ImageType, MALFORMED, VP8X_ANIMATION, VP8X_BYTES, walkPng, walkWebp } from './image-bytes'
import { walkGif } from './remote-media-bytes'

// A still of an animated remote image (NET-3), made by remuxing its container, never by decoding or re-encoding:
//   - GIF: the header, the logical screen descriptor and the global colour table, then the first frame's graphic
//     control extension (its delay set to 0), image descriptor, local colour table and LZW data, then the trailer;
//   - APNG: the PNG without acTL, fcTL and fdAT, which is its default image: frame 0 when the first fcTL precedes
//     IDAT, otherwise the static fallback the file declares for viewers without animation;
//   - animated WebP: only when the first ANMF covers the whole canvas at offset 0, a VP8X without the animation flag,
//     the ICCP chunk, then that frame's ALPH and VP8 or VP8L chunks; the ANIM background colour is not applied (as
//     viewers commonly ignore it).
// Anything else (an animated AVIF, a JPEG) gets none. The input is a verified image (remote-media-bytes.ts
// verifyRemoteImage), so it walks; the work is one walk and one copy, linear in the input (RES-2).

// The still of `bytes`, an image of `type`, in a new buffer of at most min(bytes.length, maxBytes) bytes, or null
// when none can be made within that.
export function imageStill(bytes: Uint8Array, type: ImageType, maxBytes: number): Uint8Array | null {
	const still =
		type === 'image/gif'
			? gifStill(bytes)
			: type === 'image/png'
				? pngStill(bytes)
				: type === 'image/webp'
					? webpStill(bytes)
					: null
	if (still === null) {
		return null
	}
	const { ranges, patch } = still
	const total = ranges.reduce((sum, [start, end]) => sum + (end - start), 0)
	if (total > Math.min(bytes.length, maxBytes)) {
		return null
	}
	const out = new Uint8Array(total)
	let at = 0
	for (const [start, end] of ranges) {
		out.set(bytes.subarray(start, end), at)
		at += end - start
	}
	patch?.(out)
	return out
}

// GIF89a section 23: the graphic control extension's sub-block is 4 bytes (packed fields, delay, transparent index).
const GCE_SIZE = 4

type Still = { ranges: [number, number][]; patch?: (out: Uint8Array) => void }

function gifStill(bytes: Uint8Array): Still | null {
	let header = null as [number, number] | null
	let control = null as [number, number] | null
	let frame = null as [number, number] | null
	const walked = walkGif(bytes, (block) => {
		if (block.kind === 'header') {
			header = [block.start, block.end]
		} else if (block.kind === 'extension' && block.label === 0xf9) {
			control = bytes[block.dataStart] === GCE_SIZE ? [block.start, block.end] : null
		} else if (block.kind === 'image') {
			frame = [block.start, block.end]
			return true
		}
		return undefined
	})
	if (walked !== true || header === null || frame === null) {
		return null
	}
	// A verified GIF ends with its trailer.
	const trailer: [number, number] = [bytes.length - 1, bytes.length]
	if (bytes[trailer[0]] !== 0x3b) {
		return null
	}
	if (control === null) {
		return { ranges: [header, frame, trailer] }
	}
	// The delay is bytes 4-5 of the control extension (21 F9 04, the packed fields, the delay), right after the header.
	const delay = header[1] - header[0] + 4
	const patch = (out: Uint8Array) => {
		out[delay] = 0
		out[delay + 1] = 0
	}
	return { ranges: [header, control, frame, trailer], patch }
}

function pngStill(bytes: Uint8Array): Still | null {
	const ranges: [number, number][] = [[0, 8]]
	const walked = walkPng(bytes, (type, start, length) => {
		if (type !== 'acTL' && type !== 'fcTL' && type !== 'fdAT') {
			ranges.push([start - 8, start + length + 4])
		}
		return undefined
	})
	return walked === MALFORMED ? null : { ranges }
}

function u24le(bytes: Uint8Array, i: number): number {
	return (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16)
}

// The chunks a WebP still keeps from its first frame's data (RFC 9649 section 2.7.1.1): alpha and the bitstream.
const FRAME_CHUNKS = new Set(['ALPH', 'VP8 ', 'VP8L'])
// The VP8X flags a still keeps: the ICC profile (0x20) and alpha (0x10).
const STILL_FLAGS = 0x30

function webpStill(bytes: Uint8Array): Still | null {
	let vp8x = -1
	let icc = null as [number, number] | null
	let frame = null as { start: number; length: number } | null
	const walked = walkWebp(bytes, (type, start, length) => {
		if (type === 'VP8X' && length >= VP8X_BYTES) {
			vp8x = start
		} else if (type === 'ICCP') {
			icc = [start - 8, start + length + (length % 2)]
		} else if (type === 'ANMF') {
			frame = { start, length }
			return true
		}
		return undefined
	})
	if (walked !== true || vp8x < 0 || frame === null) {
		return null
	}
	const { start, length } = frame
	const canvasWidth = u24le(bytes, vp8x + 4) + 1
	const canvasHeight = u24le(bytes, vp8x + 7) + 1
	const whole =
		length >= 16 &&
		u24le(bytes, start) === 0 &&
		u24le(bytes, start + 3) === 0 &&
		u24le(bytes, start + 6) + 1 === canvasWidth &&
		u24le(bytes, start + 9) + 1 === canvasHeight
	if (!whole) {
		return null
	}
	const ranges: [number, number][] = [
		[0, 12],
		[vp8x - 8, vp8x + VP8X_BYTES],
	]
	if (icc !== null) {
		ranges.push(icc)
	}
	let bitstreams = 0
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const end = start + length
	for (let i = start + 16; i + 8 <= end;) {
		const chunk = ascii(bytes, i, 4)
		const size = view.getUint32(i + 4, true)
		const next = i + 8 + size + (size % 2)
		if (next > end) {
			return null
		}
		if (FRAME_CHUNKS.has(chunk)) {
			ranges.push([i, next])
			bitstreams += chunk === 'ALPH' ? 0 : 1
		}
		i = next
	}
	if (bitstreams !== 1) {
		return null
	}
	const patch = (out: Uint8Array) => {
		const outView = new DataView(out.buffer, out.byteOffset, out.byteLength)
		outView.setUint32(4, out.length - 8, true)
		// The VP8X chunk is kept at its 10 data bytes: its size field, then its flags without animation.
		outView.setUint32(16, VP8X_BYTES, true)
		out[20] = (out[20] ?? 0) & STILL_FLAGS & ~VP8X_ANIMATION
	}
	return { ranges, patch }
}
