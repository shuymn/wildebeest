import {
	ascii,
	IMAGE_MATRIX_LIMIT,
	type ImageType,
	isAnimated,
	jpegSegmentMetadata,
	MALFORMED,
	PNG_CHUNKS,
	type RetainedMetadata,
	retainedMetadata,
	sniffImageType,
	VP8X_ANIMATION,
	VP8X_BYTES,
	WEBP_CHUNKS,
	walkJpeg,
	walkPng,
	walkWebp,
	webpSize,
} from './image-bytes'

// The bytes of remote media (NET-3 in docs/threat-model.md), judged without decoding a pixel or transforming
// anything (NET-3: the Worker decodes no image):
//   - verifyRemoteImage: an image's type by its signature (the remote Content-Type is never read), a full walk of its
//     container, the pixel limit read from its headers, a non-identity orientation refused, and its metadata stripped
//     losslessly in place, the output checked again by remoteImageMetadata;
//   - remoteImageMetadata and remoteImageAnimated: what a walkable image of each accepted type carries, and whether it
//     holds several frames, failing closed on anything else;
//   - recognizeMedia: a video or audio file's container and category from its first RECOGNITION_PREFIX_BYTES bytes.
// Every walk reads lengths and tags only and visits each byte a bounded number of times, so its work is linear in its
// input (RES-2), and no output is larger than its input.

// How much of a streamed file is read before its category is decided.
export const RECOGNITION_PREFIX_BYTES = 1024 * 1024

export type RemoteCategory = 'image' | 'video' | 'audio'

export type ImageRefusal = 'type' | 'malformed' | 'orientation' | 'pixels' | 'metadata'

// A verified image: `bytes` is a view of the input's own buffer (the strip compacts it in place).
export type VerifiedImage = {
	ok: true
	type: ImageType
	bytes: Uint8Array
	width: number
	height: number
	animated: boolean
}

type Facts = { width: number; height: number; animated: boolean; end: number }

function u16be(bytes: Uint8Array, i: number): number {
	return ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)
}

function u16le(bytes: Uint8Array, i: number): number {
	return (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)
}

function u24le(bytes: Uint8Array, i: number): number {
	return (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16)
}

function u32be(bytes: Uint8Array, i: number): number {
	return (
		(((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)) >>> 0
	)
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
	return at + text.length <= bytes.length && ascii(bytes, at, text.length) === text
}

// The Orientation (tag 0x0112) in IFD0 of an Exif TIFF block (CIPA DC-008, section 4.6.4), optionally after the
// "Exif\0\0" identifier: 1 when it has none, or null when the block cannot be read. Only IFD0's entries are read.
export function exifOrientation(data: Uint8Array): number | null {
	const tiff = startsWith(data, 0, 'Exif\0\0') ? data.subarray(6) : data
	if (tiff.length < 8) {
		return null
	}
	const order = ascii(tiff, 0, 2)
	if (order !== 'II' && order !== 'MM') {
		return null
	}
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
	const little = order === 'II'
	if (view.getUint16(2, little) !== 42) {
		return null
	}
	const ifd = view.getUint32(4, little)
	if (ifd + 2 > tiff.length) {
		return null
	}
	const count = view.getUint16(ifd, little)
	if (ifd + 2 + count * 12 > tiff.length) {
		return null
	}
	for (let entry = ifd + 2; entry < ifd + 2 + count * 12; entry += 12) {
		if (view.getUint16(entry, little) === 0x0112) {
			// SHORT, one value, held in the entry itself.
			return view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1
				? view.getUint16(entry + 8, little)
				: null
		}
	}
	return 1
}

// Whether an Exif block may be kept as far as orientation goes (it is stripped anyway): its orientation is the
// identity. A block that cannot be read is refused, so a viewer that reads it differently cannot rotate the image.
function orientationRefused(data: Uint8Array): boolean {
	return exifOrientation(data) !== 1
}

// SOFn markers (ITU-T T.81 table B.1): C0-C3, C5-C7, C9-CB, CD-CF.
function isSof(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

type Refused = { refusal: ImageRefusal }

// A JPEG's facts; with `strip`, every segment jpegSegmentMetadata flags, the fill bytes and anything after EOI are
// dropped by moving what is kept towards the start (the walk never reads behind what it has visited).
function jpegFacts(bytes: Uint8Array, strip: boolean): Facts | Refused {
	let width = 0
	let height = 0
	let frames = 0
	let write = 0
	const walked = walkJpeg<ImageRefusal>(bytes, (piece) => {
		if (piece.kind === 'marker') {
			const data = bytes.subarray(piece.dataStart, piece.end)
			if (isSof(piece.marker)) {
				frames++
				if (data.length < 6) {
					return 'malformed'
				}
				height = u16be(data, 1)
				width = u16be(data, 3)
			}
			if (piece.marker === 0xe1 && startsWith(data, 0, 'Exif\0') && orientationRefused(data.subarray(6))) {
				return 'orientation'
			}
			if (data.length > 0 && jpegSegmentMetadata(piece.marker, data) !== null) {
				return undefined
			}
		} else if (piece.kind === 'fill') {
			return undefined
		}
		if (strip) {
			bytes.copyWithin(write, piece.start, piece.end)
		}
		write += piece.end - piece.start
		return undefined
	})
	if (walked === MALFORMED) {
		return { refusal: 'malformed' }
	}
	if (typeof walked === 'string') {
		return { refusal: walked }
	}
	// One frame (no hierarchical file), with its size in its header (no DNL-defined height).
	if (frames !== 1 || width === 0 || height === 0) {
		return { refusal: 'malformed' }
	}
	return { width, height, animated: false, end: write }
}

// PNG chunks the strip drops are every ancillary chunk retainedMetadata does not keep (eXIf, tEXt, zTXt, iTXt and
// tIME among them); an unknown critical chunk (its first letter upper case) cannot be dropped and is refused.
function pngFacts(bytes: Uint8Array, strip: boolean): Facts | Refused {
	let width = 0
	let height = 0
	let animated = false
	let index = 0
	let write = 8
	const walked = walkPng<ImageRefusal>(bytes, (type, start, length) => {
		if (index++ === 0) {
			if (type !== 'IHDR' || length !== 13) {
				return 'malformed'
			}
			width = u32be(bytes, start)
			height = u32be(bytes, start + 4)
		}
		if (type === 'acTL') {
			animated = true
		}
		if (type === 'eXIf' && orientationRefused(bytes.subarray(start, start + length))) {
			return 'orientation'
		}
		if (!PNG_CHUNKS.has(type)) {
			return ((bytes[start - 4] ?? 0) & 0x20) === 0 ? 'malformed' : undefined
		}
		if (strip) {
			bytes.copyWithin(write, start - 8, start + length + 4)
		}
		write += length + 12
		return undefined
	})
	if (walked === MALFORMED) {
		return { refusal: 'malformed' }
	}
	if (walked !== undefined) {
		return { refusal: walked }
	}
	if (width === 0 || height === 0) {
		return { refusal: 'malformed' }
	}
	return { width, height, animated, end: write }
}

// VP8X's flags for Exif and XMP (RFC 9649 section 2.7).
const VP8X_EXIF = 0x08
const VP8X_XMP = 0x04

// The frame data of an ANMF chunk (its payload past the 16-byte frame header, [start, end)), as RFC 9649 section
// 2.7.1.1 orders it: an optional ALPH then VP8, or VP8L alone. Any other chunk counts as metadata (frames are kept
// whole, never rewritten); a chunk past the frame's end or another order is malformed.
function webpFrameProblem(bytes: Uint8Array, start: number, end: number): 'malformed' | 'metadata' | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const order: string[] = []
	for (let i = start; i < end;) {
		if (i + 8 > end) {
			return 'malformed'
		}
		const type = ascii(bytes, i, 4)
		const length = view.getUint32(i + 4, true)
		const next = i + 8 + length + (length % 2)
		if (next > end) {
			return 'malformed'
		}
		if (type !== 'ALPH' && type !== 'VP8 ' && type !== 'VP8L') {
			return 'metadata'
		}
		if (order.length === 2) {
			return 'malformed'
		}
		order.push(type)
		i = next
	}
	const shape = order.join()
	return shape === 'VP8 ' || shape === 'VP8L' || shape === 'ALPH,VP8 ' ? null : 'malformed'
}

// What an animated WebP's frames carry: the first problem webpFrameProblem finds in any ANMF, or null.
function webpFramesProblem(bytes: Uint8Array): 'malformed' | 'metadata' | null {
	let found: 'malformed' | 'metadata' | null = null
	const walked = walkWebp(bytes, (type, start, length) => {
		if (type === 'ANMF') {
			found = length < 16 ? 'malformed' : webpFrameProblem(bytes, start + 16, start + length)
		}
		return found ?? undefined
	})
	return walked === MALFORMED ? 'malformed' : found
}

// A WebP's facts; with `strip`, every chunk retainedMetadata does not keep (EXIF, XMP and unknown chunks) is dropped,
// the VP8X flags for Exif and XMP are cleared and the RIFF size rewritten. An animation frame (ANMF) must lie within
// the canvas and hold only its image data (webpFrameProblem).
function webpFacts(bytes: Uint8Array, strip: boolean): Facts | Refused {
	const size = webpSize(bytes)
	if (size === null) {
		return { refusal: 'malformed' }
	}
	let animated = false
	let vp8x = -1
	let write = 12
	const walked = walkWebp<ImageRefusal>(bytes, (type, start, length) => {
		if (type === 'VP8X') {
			if (start !== 20 || length < VP8X_BYTES) {
				return 'malformed'
			}
			vp8x = start
			animated ||= ((bytes[start] ?? 0) & VP8X_ANIMATION) !== 0
		}
		if (type === 'ANIM') {
			animated = true
		}
		if (type === 'ANMF') {
			animated = true
			if (length < 16) {
				return 'malformed'
			}
			const x = u24le(bytes, start) * 2
			const y = u24le(bytes, start + 3) * 2
			const w = u24le(bytes, start + 6) + 1
			const h = u24le(bytes, start + 9) + 1
			if (x + w > size.width || y + h > size.height) {
				return 'malformed'
			}
			const problem = webpFrameProblem(bytes, start + 16, start + length)
			if (problem !== null) {
				return problem
			}
		}
		if (type === 'EXIF' && orientationRefused(bytes.subarray(start, start + length))) {
			return 'orientation'
		}
		if (!WEBP_CHUNKS.has(type)) {
			return undefined
		}
		const end = start + length + (length % 2)
		if (strip) {
			bytes.copyWithin(write, start - 8, end)
		}
		write += end - start + 8
		return undefined
	})
	if (walked === MALFORMED) {
		return { refusal: 'malformed' }
	}
	if (walked !== undefined) {
		return { refusal: walked }
	}
	if (strip) {
		if (vp8x >= 0) {
			bytes[vp8x] = (bytes[vp8x] ?? 0) & ~(VP8X_EXIF | VP8X_XMP)
		}
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(4, write - 8, true)
	}
	return { width: size.width, height: size.height, animated, end: write }
}

// One block of a GIF (walkGif): the header with the logical screen descriptor and the global colour table, an
// extension (its label, and the offset of its first data sub-block), an image (its descriptor's position and size,
// through its local colour table and LZW data), or the trailer. Offsets are into the file.
export type GifBlock =
	| { kind: 'header'; start: number; end: number; width: number; height: number }
	| { kind: 'extension'; label: number; start: number; end: number; dataStart: number }
	| { kind: 'image'; start: number; end: number; width: number; height: number }
	| { kind: 'trailer'; start: number; end: number }

// The offset past the data sub-blocks starting at `i` (each a length byte and that many bytes, ended by a zero
// length), or -1 when they pass the file's end.
function subBlocksEnd(bytes: Uint8Array, i: number): number {
	let at = i
	for (;;) {
		if (at >= bytes.length) {
			return -1
		}
		const size = bytes[at] ?? 0
		if (size === 0) {
			return at + 1
		}
		at += 1 + size
	}
}

// Walks a GIF's blocks (GIF89a specification, sections 17-27), calling `visit` with each and stopping with the first
// value it returns. MALFORMED for another signature, a block or table past the file's end, an unknown block or
// extension label (GIF89a defines 0x01, 0xF9, 0xFE and 0xFF), an LZW minimum code size past 11 or no trailer;
// otherwise the offset just past the trailer.
export function walkGif<T>(
	bytes: Uint8Array,
	visit: (block: GifBlock) => T | undefined
): T | number | typeof MALFORMED {
	if (sniffImageType(bytes) !== 'image/gif' || bytes.length < 13) {
		return MALFORMED
	}
	const packed = bytes[10] ?? 0
	let i = 13 + ((packed & 0x80) !== 0 ? 3 * (1 << ((packed & 0x07) + 1)) : 0)
	if (i > bytes.length) {
		return MALFORMED
	}
	const header = visit({ kind: 'header', start: 0, end: i, width: u16le(bytes, 6), height: u16le(bytes, 8) })
	if (header !== undefined) {
		return header
	}
	for (;;) {
		const introducer = bytes[i]
		if (introducer === 0x3b) {
			return visit({ kind: 'trailer', start: i, end: i + 1 }) ?? i + 1
		}
		if (introducer === 0x21) {
			const label = bytes[i + 1] ?? -1
			if (label !== 0x01 && label !== 0xf9 && label !== 0xfe && label !== 0xff) {
				return MALFORMED
			}
			const end = subBlocksEnd(bytes, i + 2)
			if (end < 0) {
				return MALFORMED
			}
			const found = visit({ kind: 'extension', label, start: i, end, dataStart: i + 2 })
			if (found !== undefined) {
				return found
			}
			i = end
			continue
		}
		if (introducer === 0x2c) {
			if (i + 11 > bytes.length) {
				return MALFORMED
			}
			const local = bytes[i + 9] ?? 0
			const lzw = i + 10 + ((local & 0x80) !== 0 ? 3 * (1 << ((local & 0x07) + 1)) : 0)
			if (lzw >= bytes.length || (bytes[lzw] ?? 0) > 11) {
				return MALFORMED
			}
			const end = subBlocksEnd(bytes, lzw + 1)
			if (end < 0) {
				return MALFORMED
			}
			const found = visit({ kind: 'image', start: i, end, width: u16le(bytes, i + 5), height: u16le(bytes, i + 7) })
			if (found !== undefined) {
				return found
			}
			i = end
			continue
		}
		return MALFORMED
	}
}

// The application extensions a GIF keeps: looping (NETSCAPE2.0, and its ANIMEXTS1.0 synonym).
function loopExtension(bytes: Uint8Array, block: GifBlock & { kind: 'extension' }): boolean {
	return (
		bytes[block.dataStart] === 11 &&
		(startsWith(bytes, block.dataStart + 1, 'NETSCAPE2.0') || startsWith(bytes, block.dataStart + 1, 'ANIMEXTS1.0'))
	)
}

// What a GIF block carries beyond the image: a comment, plain text, or an application extension other than looping.
function gifBlockMetadata(bytes: Uint8Array, block: GifBlock): RetainedMetadata | null {
	if (block.kind !== 'extension') {
		return null
	}
	switch (block.label) {
		case 0xfe:
			return 'comment'
		case 0x01:
			return 'text'
		case 0xff:
			return loopExtension(bytes, block) ? null : 'segment'
		default:
			return null
	}
}

// A GIF's facts; with `strip`, comments, plain text, application extensions other than looping and anything after
// the trailer are dropped. Its pixels are the larger of the screen's and every frame's.
function gifFacts(bytes: Uint8Array, strip: boolean): Facts | Refused {
	let width = 0
	let height = 0
	let pixels = 0
	let frames = 0
	let write = 0
	const walked = walkGif<ImageRefusal>(bytes, (block) => {
		if (block.kind === 'header') {
			width = block.width
			height = block.height
		}
		if (block.kind === 'image') {
			frames++
			pixels = Math.max(pixels, block.width * block.height)
		}
		if (gifBlockMetadata(bytes, block) !== null) {
			return undefined
		}
		if (strip) {
			bytes.copyWithin(write, block.start, block.end)
		}
		write += block.end - block.start
		return undefined
	})
	if (walked === MALFORMED) {
		return { refusal: 'malformed' }
	}
	if (typeof walked === 'string') {
		return { refusal: walked }
	}
	if (frames === 0 || width === 0 || height === 0) {
		return { refusal: 'malformed' }
	}
	if (pixels > IMAGE_MATRIX_LIMIT) {
		return { refusal: 'pixels' }
	}
	return { width, height, animated: frames > 1, end: write }
}

// The boxes of an ISO BMFF range [start, end) (ISO/IEC 14496-12 section 4.2), each with its type, payload offset and
// end, until `visit` returns a value. A size of 0 runs to `end`, 1 is followed by a 64-bit size, a uuid box's payload
// starts after its 16-byte user type. MALFORMED when a box is shorter than its header or passes `end`, or when a
// header lies past `readable` (the bytes that are present; `end` may be past them). Undefined when the range ended.
function walkBoxes<T>(
	bytes: Uint8Array,
	start: number,
	end: number,
	visit: (type: string, payload: number, boxEnd: number) => T | undefined,
	readable = bytes.length
): T | undefined | typeof MALFORMED {
	let i = start
	while (i < end) {
		if (i + 8 > Math.min(end, readable)) {
			return MALFORMED
		}
		let size = u32be(bytes, i)
		const type = ascii(bytes, i + 4, 4)
		let header = 8
		if (size === 1) {
			if (i + 16 > Math.min(end, readable)) {
				return MALFORMED
			}
			const large = new DataView(bytes.buffer, bytes.byteOffset + i + 8, 8).getBigUint64(0)
			if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
				return MALFORMED
			}
			size = Number(large)
			header = 16
		} else if (size === 0) {
			size = end - i
		}
		if (type === 'uuid') {
			header += 16
		}
		if (size < header || i + size > end) {
			return MALFORMED
		}
		const found = visit(type, i + header, i + size)
		if (found !== undefined) {
			return found
		}
		i += size
	}
	return undefined
}

// Whether any brand of an ftyp box's payload [payload, end) (the major brand, then the compatible ones after the minor
// version) passes `test`, read one at a time so that a long ftyp allocates nothing per brand.
function hasBrand(bytes: Uint8Array, payload: number, end: number, test: (brand: string) => boolean): boolean {
	if (payload + 4 <= end && test(ascii(bytes, payload, 4))) {
		return true
	}
	for (let i = payload + 8; i + 4 <= end; i += 4) {
		if (test(ascii(bytes, i, 4))) {
			return true
		}
	}
	return false
}

// AVIF item types an image may hold: coded AV1 images and grids of them. Exif and mime (XMP) items, and any other
// type, are refused (an AVIF is never transformed, so its metadata cannot be stripped).
const AVIF_ITEMS = new Set(['av01', 'grid'])
// The top-level boxes an AVIF may hold. An image sequence (the avis brand, or a moov box) is not cached: its tracks
// and sample entries would carry their own metadata and orientation.
const AVIF_BOXES = new Set(['meta', 'mdat', 'free', 'skip'])
// The boxes of its meta box (ISO/IEC 23008-12 section 9): anything else, XML boxes among them, counts as metadata.
const AVIF_META = new Set(['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat', 'dinf'])
// The item properties kept: size (ispe), channels (pixi), the AV1 configuration (av1C), colour (colr nclx, or an ICC
// profile as prof or rICC), pixel aspect ratio (pasp), the alpha plane's auxiliary type (auxC) and an identity
// rotation (irot 0). Any other, descriptive ones (udes) and layering among them, counts as metadata; imir and a
// non-zero irot are a non-identity orientation.
const AVIF_PROPERTIES = new Set(['ispe', 'pixi', 'av1C', 'colr', 'pasp', 'auxC', 'irot', 'imir'])
const COLOUR_TYPES = new Set(['nclx', 'prof', 'rICC'])
// The auxiliary types of an alpha plane (AV1 Image File Format section 4, and its HEVC predecessor), NUL-terminated.
const ALPHA_TYPES = ['urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0', 'urn:mpeg:hevc:2015:auxid:1\0']

type AvifFacts = (Facts & { metadata: RetainedMetadata | null }) | Refused

// An AVIF's facts (AV1 Image File Format; ISO/IEC 23008-12 for the item boxes): its top-level and meta boxes, its
// meta box's pict handler, its items (iinf) and their properties (ipco), each against the allowlists above. Its pixels
// are the largest of every ispe. An image sequence is refused as another type.
function avifFacts(bytes: Uint8Array): AvifFacts {
	let metadata: RetainedMetadata | null = null
	let width = 0
	let height = 0
	let pixels = 0
	let metas = 0
	let handler = ''
	let sequence = false
	let orientation = false
	const flag = (found: RetainedMetadata) => {
		metadata ??= found
	}
	const property = (type: string, payload: number, end: number): typeof MALFORMED | undefined => {
		if (!AVIF_PROPERTIES.has(type)) {
			flag('segment')
		} else if (type === 'ispe') {
			if (payload + 12 > end) {
				return MALFORMED
			}
			const w = u32be(bytes, payload + 4)
			const h = u32be(bytes, payload + 8)
			pixels = Math.max(pixels, w * h)
			if (width === 0) {
				width = w
				height = h
			}
		} else if (type === 'irot') {
			if (payload + 1 > end) {
				return MALFORMED
			}
			orientation ||= ((bytes[payload] ?? 0) & 0x03) !== 0
		} else if (type === 'imir') {
			orientation = true
		} else if (type === 'colr') {
			if (payload + 4 > end || !COLOUR_TYPES.has(ascii(bytes, payload, 4))) {
				flag('segment')
			}
		} else if (type === 'auxC') {
			if (!ALPHA_TYPES.some((alpha) => end - payload - 4 >= alpha.length && startsWith(bytes, payload + 4, alpha))) {
				flag('segment')
			}
		}
		return undefined
	}
	const item = (type: string, payload: number, end: number): typeof MALFORMED | undefined => {
		if (type !== 'infe') {
			return MALFORMED
		}
		const version = bytes[payload] ?? 0
		const at = payload + 4 + (version === 3 ? 4 : 2) + 2
		if (version < 2 || at + 4 > end) {
			return MALFORMED
		}
		const itemType = ascii(bytes, at, 4)
		if (itemType === 'Exif') {
			flag('exif')
		} else if (itemType === 'mime') {
			flag('xmp')
		} else if (!AVIF_ITEMS.has(itemType)) {
			flag('segment')
		}
		return undefined
	}
	const meta = (type: string, payload: number, end: number): typeof MALFORMED | undefined => {
		if (!AVIF_META.has(type)) {
			flag('segment')
		} else if (type === 'hdlr') {
			handler = payload + 12 <= end ? ascii(bytes, payload + 8, 4) : ''
		} else if (type === 'iinf') {
			const version = bytes[payload] ?? 0
			return walkBoxes(bytes, payload + 4 + (version === 0 ? 2 : 4), end, item)
		} else if (type === 'iprp') {
			return walkBoxes(bytes, payload, end, (child, at, childEnd) => {
				if (child === 'ipco') {
					return walkBoxes(bytes, at, childEnd, property)
				}
				if (child !== 'ipma') {
					flag('segment')
				}
				return undefined
			})
		}
		return undefined
	}
	let index = 0
	const walked = walkBoxes(bytes, 0, bytes.length, (type, payload, end) => {
		if (index++ === 0) {
			if (type !== 'ftyp') {
				return MALFORMED
			}
			sequence = hasBrand(bytes, payload, end, (brand) => brand === 'avis')
			return undefined
		}
		if (type === 'moov') {
			sequence = true
		} else if (!AVIF_BOXES.has(type)) {
			flag('segment')
		} else if (type === 'meta') {
			metas++
			return walkBoxes(bytes, payload + 4, end, meta)
		}
		return undefined
	})
	if (sequence) {
		return { refusal: 'type' }
	}
	if (walked === MALFORMED || metas !== 1 || handler !== 'pict' || pixels === 0) {
		return { refusal: 'malformed' }
	}
	if (orientation) {
		return { refusal: 'orientation' }
	}
	if (pixels > IMAGE_MATRIX_LIMIT) {
		return { refusal: 'pixels' }
	}
	return { width, height, animated: false, end: bytes.length, metadata }
}

// What a remote image of `type` carries beyond its pixels and colour, as retainedMetadata judges it (MEDIA-3), for
// every type remote media accepts: JPEG (to EOI), PNG and WebP through retainedMetadata itself, with a WebP's frame
// data (webpFrameProblem); GIF comments, plain
// text, application extensions other than looping and data after the trailer; AVIF Exif or mime items, and boxes,
// items or properties outside its allowlists. A file that cannot be walked, or another type, is 'unreadable' (fail
// closed).
export function remoteImageMetadata(bytes: Uint8Array, type: string): RetainedMetadata | null {
	switch (type) {
		case 'image/jpeg':
		case 'image/png':
			return retainedMetadata(bytes, type)
		case 'image/webp': {
			const frames = webpFramesProblem(bytes)
			return (
				retainedMetadata(bytes, type) ?? (frames === null ? null : frames === 'metadata' ? 'segment' : 'unreadable')
			)
		}
		case 'image/gif': {
			let found: RetainedMetadata | null = null
			const walked = walkGif(bytes, (block) => {
				found ??= gifBlockMetadata(bytes, block)
				return undefined
			})
			return walked === MALFORMED || walked !== bytes.length ? 'unreadable' : found
		}
		case 'image/avif': {
			const facts = avifFacts(bytes)
			return 'refusal' in facts ? 'unreadable' : facts.metadata
		}
		default:
			return 'unreadable'
	}
}

// Whether a remote image of `type` holds more than one frame, or may: a JPEG never does once walked to EOI; a PNG or
// WebP as isAnimated judges it; a GIF with more than one image; an AVIF never (an image sequence is refused). A file
// that cannot be walked, or another type, counts as animated (fail closed).
export function remoteImageAnimated(bytes: Uint8Array, type: string): boolean {
	switch (type) {
		case 'image/jpeg':
			return 'refusal' in jpegFacts(bytes, false)
		case 'image/png':
		case 'image/webp':
			return isAnimated(bytes, type)
		case 'image/gif': {
			const facts = gifFacts(bytes, false)
			return 'refusal' in facts || facts.animated
		}
		case 'image/avif': {
			const facts = avifFacts(bytes)
			return 'refusal' in facts || facts.animated
		}
		default:
			return true
	}
}

// Verifies a remote image whose type must be one of `types`, in place: `bytes` is the caller's to give up (the strip
// moves what it keeps towards the start of the same buffer, and the result is a view of it). Refused: another type
// ('type'), a file that does not walk ('malformed'), a non-identity orientation, pixels past IMAGE_MATRIX_LIMIT, an
// AVIF with Exif, mime or foreign items ('metadata'), or an output remoteImageMetadata still flags ('metadata').
export function verifyRemoteImage(
	bytes: Uint8Array,
	types: readonly ImageType[]
): VerifiedImage | { ok: false; refusal: ImageRefusal } {
	const type = sniffImageType(bytes)
	if (type === null || !types.includes(type)) {
		return { ok: false, refusal: 'type' }
	}
	let facts: Facts | Refused
	switch (type) {
		case 'image/jpeg':
			facts = jpegFacts(bytes, true)
			break
		case 'image/png':
			facts = pngFacts(bytes, true)
			break
		case 'image/webp':
			facts = webpFacts(bytes, true)
			break
		case 'image/gif':
			facts = gifFacts(bytes, true)
			break
		case 'image/avif': {
			const avif = avifFacts(bytes)
			facts = 'refusal' in avif ? avif : avif.metadata !== null ? { refusal: 'metadata' } : avif
			break
		}
	}
	if ('refusal' in facts) {
		return { ok: false, refusal: facts.refusal }
	}
	if (facts.width * facts.height > IMAGE_MATRIX_LIMIT) {
		return { ok: false, refusal: 'pixels' }
	}
	const out = bytes.subarray(0, facts.end)
	if (remoteImageMetadata(out, type) !== null) {
		return { ok: false, refusal: 'metadata' }
	}
	return { ok: true, type, bytes: out, width: facts.width, height: facts.height, animated: facts.animated }
}

export type MediaType =
	'video/mp4' | 'video/webm' | 'audio/mp4' | 'audio/webm' | 'audio/mpeg' | 'audio/flac' | 'audio/wav'

export type MediaRefusal = 'type' | 'heif' | 'quicktime' | 'ogg' | 'matroska' | 'moov' | 'tracks' | 'malformed'

export type RecognizedMedia = { ok: true; type: MediaType; category: 'video' | 'audio' }

type Recognition = RecognizedMedia | { ok: false; refusal: MediaRefusal }

// ftyp brands that make an MP4 something else: HEIF and AVIF images or sequences, and QuickTime.
const HEIF_BRANDS = new Set([
	'mif1',
	'mif2',
	'msf1',
	'miaf',
	'heic',
	'heix',
	'heim',
	'heis',
	'hevc',
	'hevx',
	'hevm',
	'hevs',
	'avif',
	'avis',
	'avio',
])

// An MP4 or M4A (ISO/IEC 14496-12 and -14): its ftyp's brands free of HEIF and QuickTime, then every track's handler
// (trak/mdia/hdlr) read within the prefix: a 'vide' handler makes it a video, 'soun' handlers alone an audio file.
// Its moov must come before any box whose header lies past the prefix (a faststart file).
function recognizeMp4(prefix: Uint8Array, length: number): Recognition {
	let video = false
	let audio = false
	let moov = false
	const handlerOf = (box: string, payload: number, end: number): string | undefined => {
		if (box === 'hdlr') {
			return payload + 12 <= end ? ascii(prefix, payload + 8, 4) : ''
		}
		return undefined
	}
	const track = (box: string, payload: number, end: number): typeof MALFORMED | 'tracks' | undefined => {
		if (box !== 'trak') {
			return undefined
		}
		const media = walkBoxes(
			prefix,
			payload,
			end,
			(child, at, childEnd) =>
				child === 'mdia' ? (walkBoxes(prefix, at, childEnd, handlerOf, prefix.length) ?? '') : undefined,
			prefix.length
		)
		if (media === MALFORMED) {
			return MALFORMED
		}
		if (media === 'vide') {
			video = true
		} else if (media === 'soun') {
			audio = true
		} else if (media === undefined || media === '') {
			return 'tracks'
		}
		return undefined
	}
	let index = 0
	const walked = walkBoxes(
		prefix,
		0,
		length,
		(box, payload, end): MediaRefusal | typeof MALFORMED | 'done' | undefined => {
			if (index++ === 0) {
				if (box !== 'ftyp' || end > prefix.length) {
					return 'malformed'
				}
				if (hasBrand(prefix, payload, end, (brand) => brand === 'qt  ')) {
					return 'quicktime'
				}
				return hasBrand(prefix, payload, end, (brand) => HEIF_BRANDS.has(brand)) ? 'heif' : undefined
			}
			if (box !== 'moov') {
				return undefined
			}
			moov = true
			const tracks = walkBoxes(prefix, payload, end, track, prefix.length)
			return tracks === MALFORMED ? 'moov' : (tracks ?? 'done')
		},
		prefix.length
	)
	if (walked === MALFORMED) {
		return { ok: false, refusal: moov || index > 1 ? 'moov' : 'malformed' }
	}
	if (walked !== 'done') {
		return { ok: false, refusal: walked ?? 'moov' }
	}
	if (video) {
		return { ok: true, type: 'video/mp4', category: 'video' }
	}
	return audio ? { ok: true, type: 'audio/mp4', category: 'audio' } : { ok: false, refusal: 'tracks' }
}

// An EBML variable-size integer at `i` (RFC 8794 section 4): its length in bytes and its value (an element ID keeps
// its marker bits); null when it is longer than 8 bytes or passes the prefix. A size of all ones is unknown (-1).
function vint(bytes: Uint8Array, i: number, id: boolean): { length: number; value: number } | null {
	const first = bytes[i]
	if (first === undefined || first === 0) {
		return null
	}
	const length = Math.clz32(first) - 23
	if (i + length > bytes.length || (id && length > 4)) {
		return null
	}
	let value = id ? first : first & (0xff >> length)
	let ones = value === 0xff >> length
	for (let k = 1; k < length; k++) {
		const byte = bytes[i + k] ?? 0
		value = value * 256 + byte
		ones &&= byte === 0xff
	}
	return { length, value: !id && ones ? -1 : value }
}

const EBML_HEADER = 0x1a45dfa3
const EBML_DOCTYPE = 0x4282
const SEGMENT = 0x18538067
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_TYPE = 0x83
const CLUSTER = 0x1f43b675

// The EBML elements in [start, end) of the prefix, each with its ID, payload offset and end, until `visit` returns a
// value. An unknown size runs to `end`. MALFORMED when an ID or size does not read or an element passes `end`; the
// walk stops at the prefix's end ('prefix').
function walkEbml<T>(
	bytes: Uint8Array,
	start: number,
	end: number,
	visit: (id: number, payload: number, elementEnd: number) => T | undefined
): T | undefined | 'prefix' | typeof MALFORMED {
	let i = start
	while (i < end) {
		if (i >= bytes.length) {
			return 'prefix'
		}
		const id = vint(bytes, i, true)
		const size = id === null ? null : vint(bytes, i + id.length, false)
		if (id === null || size === null) {
			return i + 12 > bytes.length ? 'prefix' : MALFORMED
		}
		const payload = i + id.length + size.length
		const elementEnd = size.value < 0 ? end : payload + size.value
		if (elementEnd > end) {
			return MALFORMED
		}
		const found = visit(id.value, payload, elementEnd)
		if (found !== undefined) {
			return found
		}
		i = elementEnd
	}
	return undefined
}

// Whether the EBML string in [start, end) is `name`, padded with NULs only (RFC 8794 section 7.4), read in place so
// that a long one allocates nothing.
function ebmlStringIs(bytes: Uint8Array, start: number, end: number, name: string): boolean {
	if (end - start < name.length || !startsWith(bytes, start, name)) {
		return false
	}
	for (let i = start + name.length; i < end; i++) {
		if (bytes[i] !== 0) {
			return false
		}
	}
	return true
}

// A WebM (Matroska with DocType webm): its EBML header, then its Segment's Tracks, which must be read whole within the
// prefix before any Cluster: a video track (TrackType 1) makes it a video, audio tracks (2) alone an audio file.
function recognizeWebm(prefix: Uint8Array, length: number): Recognition {
	let docType = null as 'webm' | 'matroska' | 'other' | null
	let video = false
	let audio = false
	let tracksRead = false
	const header = walkEbml(prefix, 0, length, (id, payload, end) => {
		if (id !== EBML_HEADER) {
			return 'malformed' as const
		}
		const inner = walkEbml(prefix, payload, end, (child, at, childEnd) => {
			if (child === EBML_DOCTYPE && childEnd <= prefix.length) {
				docType = ebmlStringIs(prefix, at, childEnd, 'webm')
					? 'webm'
					: ebmlStringIs(prefix, at, childEnd, 'matroska')
						? 'matroska'
						: 'other'
			}
			return undefined
		})
		return inner === undefined ? end : ('malformed' as const)
	})
	if (typeof header !== 'number') {
		return { ok: false, refusal: 'malformed' }
	}
	if (docType !== 'webm') {
		return { ok: false, refusal: docType === 'matroska' ? 'matroska' : 'type' }
	}
	const entry = (id: number, payload: number, end: number) => {
		if (id !== TRACK_ENTRY) {
			return undefined
		}
		let trackType = -1
		const read = walkEbml(prefix, payload, end, (child, at, childEnd) => {
			if (child === TRACK_TYPE && childEnd - at >= 1 && childEnd - at <= 8) {
				trackType = 0
				for (let k = at; k < childEnd; k++) {
					trackType = trackType * 256 + (prefix[k] ?? 0)
				}
			}
			return undefined
		})
		if (read !== undefined || trackType < 0) {
			return 'tracks' as const
		}
		video ||= trackType === 1
		audio ||= trackType === 2
		return undefined
	}
	const segment = walkEbml(prefix, header, length, (id, payload, end) => {
		if (id !== SEGMENT) {
			return 'malformed' as const
		}
		return walkEbml(prefix, payload, end, (child, at, childEnd) => {
			if (child === CLUSTER) {
				return 'tracks' as const
			}
			if (child !== TRACKS) {
				return undefined
			}
			if (childEnd > prefix.length) {
				return 'tracks' as const
			}
			tracksRead = true
			return walkEbml(prefix, at, childEnd, entry) ?? ('done' as const)
		})
	})
	if (segment !== 'done' || !tracksRead) {
		return { ok: false, refusal: segment === MALFORMED || segment === 'malformed' ? 'malformed' : 'tracks' }
	}
	if (video) {
		return { ok: true, type: 'video/webm', category: 'video' }
	}
	return audio ? { ok: true, type: 'audio/webm', category: 'audio' } : { ok: false, refusal: 'tracks' }
}

// MPEG audio Layer III frame headers (ISO/IEC 11172-3 and 13818-3): bitrates in kbit/s by version, sample rates.
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SAMPLE_RATES: Record<number, readonly number[]> = {
	3: [44100, 48000, 32000],
	2: [22050, 24000, 16000],
	0: [11025, 12000, 8000],
}

// The Layer III frame header at `i`: its version, sample rate and frame length in bytes, or null.
function mpegFrame(bytes: Uint8Array, i: number): { version: number; rate: number; length: number } | null {
	if (i + 4 > bytes.length || bytes[i] !== 0xff || ((bytes[i + 1] ?? 0) & 0xe0) !== 0xe0) {
		return null
	}
	const b1 = bytes[i + 1] ?? 0
	const b2 = bytes[i + 2] ?? 0
	const version = (b1 >> 3) & 0x03
	const layer = (b1 >> 1) & 0x03
	const bitrateIndex = b2 >> 4
	const rate = SAMPLE_RATES[version]?.[(b2 >> 2) & 0x03]
	if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rate === undefined) {
		return null
	}
	const kbps = (version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex] ?? 0
	const length = Math.floor(((version === 3 ? 144_000 : 72_000) * kbps) / rate) + ((b2 >> 1) & 0x01)
	return { version, rate, length }
}

// An MP3 (after an ID3v2 tag skipped by its synchsafe size, ID3v2.4 section 3.1): a Layer III frame header and a second
// one of the same version and sample rate at the first one's computed length, both within the prefix. A FLAC stream
// may also follow the tag.
function recognizeMp3(prefix: Uint8Array): Recognition {
	let i = 0
	if (startsWith(prefix, 0, 'ID3')) {
		if (prefix.length < 10 || [6, 7, 8, 9].some((k) => (prefix[k] ?? 0) >= 0x80)) {
			return { ok: false, refusal: 'malformed' }
		}
		const size = ((prefix[6] ?? 0) << 21) | ((prefix[7] ?? 0) << 14) | ((prefix[8] ?? 0) << 7) | (prefix[9] ?? 0)
		i = 10 + size + (((prefix[5] ?? 0) & 0x10) !== 0 ? 10 : 0)
		if (startsWith(prefix, i, 'fLaC')) {
			return recognizeFlac(prefix, i)
		}
	}
	const first = mpegFrame(prefix, i)
	const second = first === null || first.length < 4 ? null : mpegFrame(prefix, i + first.length)
	if (first === null || second === null || second.version !== first.version || second.rate !== first.rate) {
		return { ok: false, refusal: 'type' }
	}
	return { ok: true, type: 'audio/mpeg', category: 'audio' }
}

// A FLAC stream at `i` (RFC 9639 section 8): "fLaC" and a STREAMINFO block (type 0) of 34 bytes within the prefix.
function recognizeFlac(prefix: Uint8Array, i: number): Recognition {
	const block = i + 4
	const ok =
		block + 4 + 34 <= prefix.length &&
		((prefix[block] ?? 0) & 0x7f) === 0 &&
		(((prefix[block + 1] ?? 0) << 16) | ((prefix[block + 2] ?? 0) << 8) | (prefix[block + 3] ?? 0)) === 34
	return ok ? { ok: true, type: 'audio/flac', category: 'audio' } : { ok: false, refusal: 'malformed' }
}

// WAVE format tags: PCM, IEEE float, A-law, mu-law and WAVE_FORMAT_EXTENSIBLE.
const WAVE_FORMATS = new Set([0x0001, 0x0003, 0x0006, 0x0007, 0xfffe])

// A WAV: RIFF/WAVE, and a 'fmt ' chunk of a known format within the prefix, before any chunk past it.
function recognizeWav(prefix: Uint8Array): Recognition {
	let i = 12
	while (i + 8 <= prefix.length) {
		const size = new DataView(prefix.buffer, prefix.byteOffset + i + 4, 4).getUint32(0, true)
		if (ascii(prefix, i, 4) === 'fmt ') {
			const known = size >= 16 && i + 8 + 16 <= prefix.length && WAVE_FORMATS.has(u16le(prefix, i + 8))
			return known ? { ok: true, type: 'audio/wav', category: 'audio' } : { ok: false, refusal: 'type' }
		}
		i += 8 + size + (size % 2)
	}
	return { ok: false, refusal: 'type' }
}

// Recognizes a video or audio file of `length` bytes from its first min(length, RECOGNITION_PREFIX_BYTES) bytes,
// positively: MP4 or M4A, WebM, MP3, FLAC or WAV, each by its container's structure as above. Ogg is refused
// whatever it carries (chained streams cannot be ruled out from a prefix), as is anything else, an image included.
export function recognizeMedia(prefix: Uint8Array, length: number): Recognition {
	if (prefix.length < 12) {
		return { ok: false, refusal: 'type' }
	}
	if (startsWith(prefix, 0, 'OggS')) {
		return { ok: false, refusal: 'ogg' }
	}
	if (startsWith(prefix, 4, 'ftyp')) {
		return recognizeMp4(prefix, length)
	}
	if (u32be(prefix, 0) === EBML_HEADER) {
		return recognizeWebm(prefix, length)
	}
	if (startsWith(prefix, 0, 'fLaC')) {
		return recognizeFlac(prefix, 0)
	}
	if (startsWith(prefix, 0, 'RIFF') && startsWith(prefix, 8, 'WAVE')) {
		return recognizeWav(prefix)
	}
	return recognizeMp3(prefix)
}
