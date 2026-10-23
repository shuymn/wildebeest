import { imageBlurhash, type Rgba } from './blurhash'
import { readBodyPrefix } from './body'
import { DeadlinePassed, within } from './deadline'
import { type ImageType, isAnimated, retainedMetadata, sniffImageType } from './image-bytes'

// Re-encoding of uploaded images (MEDIA-3). The Images binding is reached only through ImageCodec, a narrow
// interface, so tests can substitute a codec that keeps EXIF or fails; production uses imagesCodec(env.IMAGES).
//
// Cost: info() is free; every encode() is one transformation. An upload asks for three outputs (the full image, the
// preview and the preview's RGBA, processImage), and a card image for two (its WebP and its RGBA, federation/
// card-images.ts); an RGBA output is of the same input and transformation as the output it pairs with, which Images may
// bill as one: format and quality are not part of what makes a transformation unique. Kopje charges each output.
// The Images free allowance is 5,000 transformations a month; past it the binding refuses (error 9422) and uploads
// answer 503 until the month turns or the operator enables paid transformations. A 9422 from only the preview's RGBA
// output (the required outputs made) keeps the upload, answered 200 with a null blurhash.

export type ImageInfo = { format: string; width?: number; height?: number }

// `still`: the output keeps one frame of an animated input (Images' anim: false); otherwise a WebP output keeps every
// frame. A PNG output always keeps one (imagesCodec). `limit`: the output's bytes, read up to it and refused past it
// before anything inspects them (a card image, CARD_IMAGE_OUTPUT_LIMIT); without it the output is read whole.
// `guard`: runs each binding call (output() and the output's info()) and each read of the output; one that gives up
// rejects, and a read given up cancels the output stream (readBodyPrefix), so nothing is left reading it. Without it
// the calls run as they are. `format` 'rgba': raw pixels, read only by encodeRgba.
export type CallGuard = <T>(work: () => Promise<T>) => Promise<T>
export type EncodeOptions = {
	width?: number
	height?: number
	format: OutputType | 'rgba'
	still?: true
	limit?: number
	guard?: CallGuard
}

export type ImageCodec = {
	info(bytes: Uint8Array): Promise<ImageInfo>
	encode(bytes: Uint8Array, options: EncodeOptions): Promise<Uint8Array>
}

// A failure of the transformation service, with the Images error code when it gave one.
export class ImageCodecError extends Error {
	constructor(
		readonly code: number | null,
		message: string
	) {
		super(message)
		this.name = 'ImageCodecError'
	}
}

// A check of a re-encoded output failed (encodeChecked). Its message is Kopje's own; a codec's message, which the
// platform writes about the request's bytes, is never passed on as a detail (DATA-5).
class ImageOutputError extends ImageCodecError {
	constructor(message: string) {
		super(null, message)
		this.name = 'ImageOutputError'
	}
}

// Images error codes: 9412 the input is not an image, 9413 it is too large, 9520 its type is not supported, 9422 the
// transformation allowance is used up.
const INPUT_ERRORS = new Set([9412, 9413, 9520])
const QUOTA_ERROR = 9422

// How the input reaches the binding: 'stream', a single-chunk stream over the caller's bytes (no copy), or 'blob', one
// copy in a Blob. The local binding reads a stream without detaching its chunk (test/card-image-process.test.ts
// selects the path); 'blob' is the fallback a binding that detached it would need.
export type CodecInput = 'stream' | 'blob'

function stream(bytes: Uint8Array, input: CodecInput): ReadableStream<Uint8Array> {
	if (input === 'blob') {
		return new Blob([bytes]).stream() as ReadableStream<Uint8Array>
	}
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes)
			controller.close()
		},
	})
}

const unguarded: CallGuard = (work) => work()

// The output's bytes: whole, or within `limit` (EncodeOptions), as a view over the read buffer, each read under
// `guard`.
async function outputBytes(
	image: ReadableStream<Uint8Array>,
	limit: number | undefined,
	guard: CallGuard
): Promise<Uint8Array> {
	if (limit === undefined) {
		return new Uint8Array(await new Response(image).arrayBuffer())
	}
	const prefix = await readBodyPrefix(image, limit, (read) => guard(() => read), { copy: false })
	if (prefix.limitReached) {
		throw new ImageOutputError('output is past its byte limit')
	}
	return prefix.bytes
}

function codecError(error: unknown): ImageCodecError {
	const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : Number.NaN
	return new ImageCodecError(Number.isInteger(code) ? code : null, error instanceof Error ? error.message : 'failed')
}

export function imagesCodec(binding: ImagesBinding, { input = 'stream' }: { input?: CodecInput } = {}): ImageCodec {
	return {
		async info(bytes) {
			try {
				return await binding.info(stream(bytes, input))
			} catch (error) {
				throw codecError(error)
			}
		},
		async encode(bytes, { width, height, format, still, limit, guard = unguarded }) {
			try {
				let transformer = binding.input(stream(bytes, input))
				if (width !== undefined && height !== undefined) {
					transformer = transformer.transform({ width, height, fit: 'scale-down' })
				}
				// anim is passed both ways: the binding's default (true) is not relied on. Images makes animated output only
				// as GIF or WebP, and refuses PNG output with anim: true (9401, "Animated output is only supported for GIF or
				// WebP", on the verification instance), so a PNG output is always a still: an APNG upload serves one frame.
				const result = await guard(() =>
					transformer.output({ format, anim: format === 'image/webp' && still !== true })
				)
				return await outputBytes(result.image() as ReadableStream<Uint8Array>, limit, guard)
			} catch (error) {
				// A guard's give-up and an output check are passed on as they are; the binding's errors carry its code.
				throw error instanceof ImageOutputError || error instanceof DeadlinePassed ? error : codecError(error)
			}
		},
	}
}

// Mastodon's limits for images: 16 MB (MediaAttachment::IMAGE_LIMIT) and 16,777,216 pixels (the matrix limit it
// advertises). Workers accept request bodies up to 100 MB and have 128 MB of memory; one upload holds the body, the
// file, two outputs and the preview's RGBA (at most PREVIEW_RGBA_LIMIT bytes, its blurhash's fit at most 40,000), so
// 16 MB stays well inside both. No test models an upload's peak (the card image's is test/card-image-memory.test.ts).
export const IMAGE_SIZE_LIMIT = 16 * 1024 * 1024
export const IMAGE_MATRIX_LIMIT = 16_777_216

// An avatar or header, as Mastodon's Account::Avatar and Account::Header take one (app/models/concerns/account/
// avatar.rb:6-7, 25, header.rb:6-7, 26, with vips, config/application.rb:97): less than 8 MB (8,388,608 bytes is
// refused), JPEG, PNG, GIF or WebP by signature (MEDIA-4).
export const PROFILE_IMAGE_LIMIT = 8 * 1024 * 1024
export const PROFILE_IMAGE_TYPES: readonly ImageType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export const PROFILE_TOO_LARGE = 'file size must be less than 8 MB'

// The leading bytes sniffImageType reads.
export const SIGNATURE_BYTES = 12

// Paperclip's content type validation of a profile image from its first SIGNATURE_BYTES bytes (its message, without
// the attribute), or null when it is an accepted type.
export function profileImageProblem(head: Uint8Array): 'content type is invalid' | null {
	const type = sniffImageType(head)
	return type !== null && PROFILE_IMAGE_TYPES.includes(type) ? null : 'content type is invalid'
}

// The served image keeps at most this long edge (UHD); the preview at most SMALL_EDGE, close to Mastodon's small
// style (640x360 pixels).
export const FULL_EDGE = 3840
export const SMALL_EDGE = 640
// The longest RGBA output of a preview (fit never upscales past SMALL_EDGE), in bytes: 1,638,400.
export const PREVIEW_RGBA_LIMIT = 4 * SMALL_EDGE * SMALL_EDGE
// The least time an RGBA output of a preview is started with: one binding call and a read of at most
// PREVIEW_RGBA_LIMIT bytes. With less left before its end, processImage does not ask for it.
export const RGBA_MIN_CALL_MS = 2_000
// The most an RGBA output of a preview may take, the call and every read of it, from its start: such a call and a raw
// read of at most PREVIEW_RGBA_LIMIT bytes normally take well under a second, so a stalled one is given up within
// this, and the RGBA output delays what follows it (an upload's save, a rebuilt row's record) by at most this.
export const RGBA_CALL_MS = 5_000

// Only PNG and WebP are produced. The Images binding has no metadata option (its output() takes format, quality and
// anim: https://developers.cloudflare.com/images/transform-images/bindings/), and Images discards all metadata for
// WebP and PNG output but keeps the EXIF copyright tag in JPEG by default ("For all other output formats (e.g. WebP or
// PNG), all metadata will always be discarded":
// https://developers.cloudflare.com/images/transform-images/transform-via-url/#metadata). So metadata is stripped at
// the source, and retainedMetadata is the safety net. PNG keeps PNG (lossless, transparency); JPEG, GIF, WebP and AVIF
// become WebP (it keeps transparency and animation).
type OutputType = 'image/png' | 'image/webp'

const OUTPUT: Record<ImageType, OutputType> = {
	'image/jpeg': 'image/webp',
	'image/png': 'image/png',
	'image/gif': 'image/webp',
	'image/webp': 'image/webp',
	'image/avif': 'image/webp',
}

// The type an image of `type` is served as.
export function servedTypeOf(type: ImageType): OutputType {
	return OUTPUT[type]
}

export type Size = { width: number; height: number }

// `animated`: the output holds several frames, or may (isAnimated fails closed).
export type EncodedImage = { bytes: Uint8Array; contentType: OutputType; animated: boolean } & Size

// `blurhash`: the preview's (previewBlurhash), as stored, or null.
export type ProcessedImage = {
	original: Size & { type: ImageType }
	full: EncodedImage
	small: EncodedImage
	blurhash: string | null
}

export type ImageFailure =
	// The bytes are not an accepted image type, or the service could not read them.
	| 'unsupported'
	// More pixels than the matrix limit.
	| 'too_large'
	// The transformation allowance is used up.
	| 'quota'
	// The service failed, or its output was not what it must be (wrong type, metadata kept).
	| 'failed'

// `blurhashStop`: why the preview has no blurhash when the caller should stop asking Images (9422 from the RGBA
// output), or should give up as for its own deadline (the RGBA output given up or not started at `end`); null
// otherwise. An upload ignores it; the media rebuild stops on it (mastodon/media-rebuild.ts).
export type ProcessResult =
	| { ok: true; image: ProcessedImage; blurhashStop: 'quota' | 'deadline' | null }
	| { ok: false; reason: ImageFailure; detail?: string }

// `blurhash`: the preview's blurhash is made too, its RGBA output and every read of it given up at `end` (by `now`) or
// RGBA_CALL_MS after it starts, whichever is first, and not asked for when less than RGBA_MIN_CALL_MS is left. Without
// it (a custom emoji) nothing more is asked.
export type ProcessOptions = { blurhash?: { end: number; now: () => number } }

export function fit(size: Size, edge: number): Size {
	const scale = Math.min(1, edge / Math.max(size.width, size.height))
	return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

// A codec error as processImage classifies it: quota (9422), an input the service refuses as unsupported, any other
// service failure as failed. Anything that is not an ImageCodecError is thrown again.
function failure(error: unknown): { ok: false; reason: ImageFailure; detail?: string } {
	if (error instanceof ImageCodecError) {
		if (error.code === QUOTA_ERROR) {
			return { ok: false, reason: 'quota' }
		}
		if (error.code !== null && INPUT_ERRORS.has(error.code)) {
			return { ok: false, reason: 'unsupported', detail: `images ${error.code}` }
		}
		return { ok: false, reason: 'failed', detail: `images ${error.code ?? 'error'}` }
	}
	throw error
}

// The class of a codec failure, for a caller that classifies it itself (federation/card-images.ts): processImage's
// reasons, an output check (ImageOutputError) as 'output'. Anything else is thrown again.
export function codecFailure(error: unknown): ImageFailure | 'output' {
	if (error instanceof ImageOutputError) {
		return 'output'
	}
	return failure(error).reason
}

// encodeChecked with the output read within `limit` bytes (EncodeOptions limit) before any check reads it, and every
// binding call and read under `guard` (EncodeOptions guard): the output's info() is not started once it gives up.
export function encodeBounded(
	codec: ImageCodec,
	bytes: Uint8Array,
	options: EncodeOptions & { format: OutputType },
	limit: number,
	guard: CallGuard
): Promise<EncodedImage> {
	return encodeChecked(codec, bytes, { ...options, limit, guard })
}

// Re-encodes one output and checks it: the declared type, real dimensions from info(), no location or identity
// metadata, and one frame when `still` asks for it. Original bytes are never returned in place of an output.
async function encodeChecked(
	codec: ImageCodec,
	bytes: Uint8Array,
	options: EncodeOptions & { format: OutputType }
): Promise<EncodedImage> {
	const output = await codec.encode(bytes, options)
	if (sniffImageType(output) !== options.format) {
		throw new ImageOutputError('output is not of the requested type')
	}
	const kept = retainedMetadata(output, options.format)
	if (kept !== null) {
		throw new ImageOutputError(`output keeps metadata: ${kept}`)
	}
	const animated = isAnimated(output, options.format)
	if (animated && options.still === true) {
		throw new ImageOutputError('output is animated')
	}
	const info = await (options.guard ?? unguarded)(() => codec.info(output))
	if (info.width === undefined || info.height === undefined) {
		throw new ImageOutputError('output has no dimensions')
	}
	return { bytes: output, contentType: options.format, animated, width: info.width, height: info.height }
}

// Images' raw RGBA output of `bytes` under `transform`, the transformation whose WebP output was verified to be of
// `size` (federation/card-images.ts I14, I15). Measured on the binding: application/octet-stream, row-major, 4 bytes a
// pixel with straight alpha, no header and no row padding, of the WebP output's width and height for the same input and
// transformation. A headerless buffer has nothing info() or a signature could check, so `size` is authoritative: the
// output is read within 4 × width × height bytes (refused before any call unless 1 to `limit`), refused while read past
// it and at any other length. The result is a view over the read buffer.
export async function encodeRgba(
	codec: ImageCodec,
	bytes: Uint8Array,
	transform: Partial<Size>,
	size: Size,
	limit: number,
	guard: CallGuard
): Promise<Rgba> {
	const length = 4 * size.width * size.height
	if (!Number.isSafeInteger(length) || length < 1 || length > limit) {
		throw new ImageOutputError('rgba output is past its byte limit')
	}
	const output = await codec.encode(bytes, { ...transform, format: 'rgba', limit: length, guard })
	if (output.byteLength !== length) {
		throw new ImageOutputError('rgba output is not of the image size')
	}
	return {
		data: new Uint8ClampedArray(output.buffer, output.byteOffset, length),
		width: size.width,
		height: size.height,
	}
}

// The free info() of `bytes`, its codec errors classified as processImage classifies them: a preflight before any
// transformation is charged (the custom emoji checks, platform/emoji-image.ts).
export async function inspectImage(
	codec: ImageCodec,
	bytes: Uint8Array
): Promise<{ ok: true; info: ImageInfo } | { ok: false; reason: ImageFailure; detail?: string }> {
	try {
		return { ok: true, info: await codec.info(bytes) }
	} catch (error) {
		return failure(error)
	}
}

// The blurhash of the preview `small`, from Images' RGBA output of the preview's own input (the full image's bytes) and
// transformation, read within 4 × w × h of its checked size (encodeRgba), as Mastodon's BlurhashTranscoder hashes the
// small style (app/models/media_attachment.rb:71-81, 330, lib/paperclip/blurhash_transcoder.rb:6-12, v4.5.11). Any
// failure of that output keeps the image without one (docs/mastodon-deviations.md, "Media"); a thrown error that is
// neither a codec error nor a give-up is passed on.
async function previewBlurhash(
	codec: ImageCodec,
	input: Uint8Array,
	transform: Partial<Size>,
	small: Size,
	{ end, now }: { end: number; now: () => number }
): Promise<{ blurhash: string | null; stop: 'quota' | 'deadline' | null }> {
	if (now() >= end - RGBA_MIN_CALL_MS) {
		return { blurhash: null, stop: 'deadline' }
	}
	const until = Math.min(end, now() + RGBA_CALL_MS)
	try {
		const guard: CallGuard = (work) => within(work, until, now)
		const rgba = await encodeRgba(codec, input, transform, small, PREVIEW_RGBA_LIMIT, guard)
		return { blurhash: imageBlurhash(rgba), stop: null }
	} catch (error) {
		if (error instanceof DeadlinePassed) {
			return { blurhash: null, stop: 'deadline' }
		}
		if (error instanceof ImageCodecError) {
			return { blurhash: null, stop: error.code === QUOTA_ERROR ? 'quota' : null }
		}
		throw error
	}
}

export async function processImage(
	codec: ImageCodec,
	bytes: Uint8Array,
	options: ProcessOptions = {}
): Promise<ProcessResult> {
	const type = sniffImageType(bytes)
	if (type === null) {
		return { ok: false, reason: 'unsupported' }
	}
	const inspected = await inspectImage(codec, bytes)
	if (!inspected.ok) {
		return inspected
	}
	const { info } = inspected
	// The service must read it as the type its signature says (an SVG or polyglot is refused).
	if (info.format !== type || info.width === undefined || info.height === undefined) {
		return { ok: false, reason: 'unsupported' }
	}
	const original = { type, width: info.width, height: info.height }
	if (original.width * original.height > IMAGE_MATRIX_LIMIT) {
		return { ok: false, reason: 'too_large' }
	}
	const format = OUTPUT[type]
	try {
		const target = fit(original, FULL_EDGE)
		const resize = target.width === original.width && target.height === original.height ? {} : target
		const full = await encodeChecked(codec, bytes, { ...resize, format })
		// The preview is made from the re-encoded image, so it starts without metadata and in the served orientation. It
		// is a still, so an animated image's preview serves as its account's avatar_static or header_static (media.ts).
		const preview = fit(full, SMALL_EDGE)
		const small = await encodeChecked(codec, full.bytes, { ...preview, format, still: true })
		const hashed =
			options.blurhash === undefined
				? { blurhash: null, stop: null }
				: await previewBlurhash(codec, full.bytes, preview, small, options.blurhash)
		return { ok: true, image: { original, full, small, blurhash: hashed.blurhash }, blurhashStop: hashed.stop }
	} catch (error) {
		if (error instanceof ImageOutputError) {
			return { ok: false, reason: 'failed', detail: error.message }
		}
		return failure(error)
	}
}
