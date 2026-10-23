import { cardBlurhash } from '../platform/blurhash'
import { DeadlinePassed } from '../platform/deadline'
import { webpSize, sniffImageType } from '../platform/image-bytes'
import { codecFailure, encodeBounded, IMAGE_MATRIX_LIMIT, type ImageCodec, type Size } from '../platform/images'
import {
	CARD_DECODE_PIXELS,
	CARD_GIF_MATRIX_LIMIT,
	CARD_IMAGE_EDGE_MAX,
	CARD_IMAGE_OUTPUT_LIMIT,
	CARD_IMAGE_PIXELS,
} from '../platform/stored-bounds'
import { decodeWebp } from '../platform/webp-decode'

// Card images, the Worker's part (domain/card-images.ts; Mastodon's PreviewCard image with its vips processing,
// app/models/preview_card.rb and lib/paperclip/vips_lazy_thumbnail.rb, v4.5.11). The steps of one claim after its
// fetch (processCardImage), each Images call under the claim's guard:
//   I4   a signature that is not JPEG, PNG, GIF or WebP (sniffImageType) is no image;
//   I5   admission #1 (the env's maintenance and the fence, as a write) refused: the claim is lost;
//   I6   the preflight info() failing, naming another format or no size is no image;
//   I7   a GIF past CARD_GIF_MATRIX_LIMIT or another image past IMAGE_MATRIX_LIMIT pixels is no image;
//   I8   a target edge past CARD_IMAGE_EDGE_MAX is no image;
//   I9   admission #2 (startCardImage, which charges the transformation): lost, or unattempted past the share;
//   I10  a guard that gives up on encode, its output read or the output's info() leaves the claim unattempted (the
//        transformation stays charged) and stops the round (AM15: the call may still hold its memory);
//   I11  error 9422 from any Images call leaves the claim unattempted and stops the round, whatever else failed;
//   I12  another Images error, or an output encodeChecked refuses, is no image;
//   I13  an output past CARD_IMAGE_OUTPUT_LIMIT bytes, refused while it is read, is no image;
//   I14  an output whose WebP header size differs from info()'s, or is past CARD_IMAGE_EDGE_MAX or
//        CARD_DECODE_PIXELS, is no image, before any decoding;
//   I15  a decode or blurhash failure keeps the image without a blurhash.
// The target (cardImageTarget): an image of more than CARD_IMAGE_PIXELS is resized to fit floor(sqrt(P × W / H)) by
// floor(sqrt(P × H / W)), each edge from 1 to the original's (AM13: Mastodon rounds, at most 1 pixel more an edge);
// the output is always a still WebP without metadata (platform/images.ts).

// The box a source of `size` is resized to fit, or null when it is stored at its own size.
export function cardImageTarget(size: Size): Size | null {
	const { width, height } = size
	if (width * height <= CARD_IMAGE_PIXELS) {
		return null
	}
	const edge = (a: number, b: number, limit: number) =>
		Math.min(limit, Math.max(1, Math.floor(Math.sqrt((CARD_IMAGE_PIXELS * a) / b))))
	return { width: edge(width, height, width), height: edge(height, width, height) }
}

// What processCardImage made of one claim's bytes.
export type ProcessedCardImage =
	| { kind: 'encoded'; bytes: Uint8Array; width: number; height: number; blurhash: string | null }
	| { kind: 'none'; reason: string }
	// `stop`: the round starts no further claim (a 9422, or a call given up that may still run).
	| { kind: 'unattempted'; reason: 'budget' | 'deadline' | 'quota'; stop: boolean }
	| { kind: 'lost' }

export type CardImageHooks = {
	// Runs one Images call (and its output read) under the claim's deadline; rejects with DeadlinePassed once given up.
	guard: <T>(work: () => Promise<T>) => Promise<T>
	// Admission #1 (I5), before the preflight info().
	admit: () => Promise<boolean>
	// Admission #2 (I9), right before encode.
	start: () => Promise<'ok' | 'budget' | 'lost'>
}

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

// A failed Images call as a claim's outcome (I10-I12): a guard's give-up first, then 9422, then the rest.
function callFailure(error: unknown, what: string): ProcessedCardImage {
	if (error instanceof DeadlinePassed) {
		return { kind: 'unattempted', reason: 'deadline', stop: true }
	}
	const failure = codecFailure(error)
	return failure === 'quota'
		? { kind: 'unattempted', reason: 'quota', stop: true }
		: { kind: 'none', reason: `${what} ${failure}` }
}

// Steps I4 to I14 over the fetched bytes: the checked output, or the claim's outcome. Its scope alone holds the
// input, so nothing does once it returns (unless a call it gave up still runs: AM15).
async function encodeInput(
	codec: ImageCodec,
	bytes: Uint8Array,
	hooks: CardImageHooks
): Promise<{ bytes: Uint8Array; width: number; height: number } | ProcessedCardImage> {
	const type = sniffImageType(bytes)
	if (type === null || !ACCEPTED.has(type)) {
		return { kind: 'none', reason: 'type' }
	}
	if (!(await hooks.admit())) {
		return { kind: 'lost' }
	}
	let info
	try {
		info = await hooks.guard(() => codec.info(bytes))
	} catch (error) {
		return callFailure(error, 'info')
	}
	const { width, height } = info
	if (info.format !== type || width === undefined || height === undefined || width < 1 || height < 1) {
		return { kind: 'none', reason: 'info' }
	}
	if (width * height > (type === 'image/gif' ? CARD_GIF_MATRIX_LIMIT : IMAGE_MATRIX_LIMIT)) {
		return { kind: 'none', reason: 'pixels' }
	}
	const target = cardImageTarget({ width, height })
	if (Math.max(target?.width ?? width, target?.height ?? height) > CARD_IMAGE_EDGE_MAX) {
		return { kind: 'none', reason: 'edge' }
	}
	const started = await hooks.start()
	if (started !== 'ok') {
		return started === 'lost' ? { kind: 'lost' } : { kind: 'unattempted', reason: 'budget', stop: false }
	}
	let output
	try {
		output = await hooks.guard(() =>
			encodeBounded(codec, bytes, { ...target, format: 'image/webp', still: true }, CARD_IMAGE_OUTPUT_LIMIT)
		)
	} catch (error) {
		return callFailure(error, 'encode')
	}
	const header = webpSize(output.bytes)
	if (
		header === null ||
		header.width !== output.width ||
		header.height !== output.height ||
		Math.max(header.width, header.height) > CARD_IMAGE_EDGE_MAX ||
		header.width * header.height > CARD_DECODE_PIXELS
	) {
		return { kind: 'none', reason: 'output size' }
	}
	return { bytes: output.bytes, width: header.width, height: header.height }
}

// Steps I4 to I15 over a claim's fetched bytes (`input.bytes`, dropped before the decode). See the module's head.
export async function processCardImage(
	codec: ImageCodec,
	input: { bytes: Uint8Array | null },
	hooks: CardImageHooks
): Promise<ProcessedCardImage> {
	const encoded =
		input.bytes === null ? { kind: 'none' as const, reason: 'empty' } : await encodeInput(codec, input.bytes, hooks)
	input.bytes = null
	if ('kind' in encoded) {
		return encoded
	}
	const rgba = await decodeWebp(encoded.bytes)
	return { kind: 'encoded', ...encoded, blurhash: rgba === null ? null : cardBlurhash(rgba) }
}
