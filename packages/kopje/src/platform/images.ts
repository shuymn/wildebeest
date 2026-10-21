import { type ImageType, isAnimated, retainedMetadata, sniffImageType } from './image-bytes'

// Re-encoding of uploaded images (MEDIA-3). The Images binding is reached only through ImageCodec, a narrow
// interface, so tests can substitute a codec that keeps EXIF or fails; production uses imagesCodec(env.IMAGES).
//
// Cost: info() is free; every encode() is one transformation. An upload costs two (the full image and the preview).
// The Images free allowance is 5,000 transformations a month; past it the binding refuses (error 9422) and uploads
// answer 503 until the month turns or the operator enables paid transformations.

export type ImageInfo = { format: string; width?: number; height?: number }

// `still`: the output keeps one frame of an animated input (Images' anim: false); otherwise a WebP output keeps every
// frame. A PNG output always keeps one (imagesCodec).
export type EncodeOptions = { width?: number; height?: number; format: OutputType; still?: true }

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

// Images error codes: 9412 the input is not an image, 9413 it is too large, 9520 its type is not supported, 9422 the
// transformation allowance is used up.
const INPUT_ERRORS = new Set([9412, 9413, 9520])
const QUOTA_ERROR = 9422

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes]).stream() as ReadableStream<Uint8Array>
}

function codecError(error: unknown): ImageCodecError {
	const code = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : Number.NaN
	return new ImageCodecError(Number.isInteger(code) ? code : null, error instanceof Error ? error.message : 'failed')
}

export function imagesCodec(binding: ImagesBinding): ImageCodec {
	return {
		async info(bytes) {
			try {
				return await binding.info(stream(bytes))
			} catch (error) {
				throw codecError(error)
			}
		},
		async encode(bytes, { width, height, format, still }) {
			try {
				let transformer = binding.input(stream(bytes))
				if (width !== undefined && height !== undefined) {
					transformer = transformer.transform({ width, height, fit: 'scale-down' })
				}
				// anim is passed both ways: the binding's default (true) is not relied on. Images makes animated output only
				// as GIF or WebP, and refuses PNG output with anim: true (9401, "Animated output is only supported for GIF or
				// WebP", on the verification instance), so a PNG output is always a still: an APNG upload serves one frame.
				const result = await transformer.output({ format, anim: format === 'image/webp' && still !== true })
				return new Uint8Array(await new Response(result.image()).arrayBuffer())
			} catch (error) {
				throw codecError(error)
			}
		},
	}
}

// Mastodon's limits for images: 16 MB (MediaAttachment::IMAGE_LIMIT) and 16,777,216 pixels (the matrix limit it
// advertises). Workers accept request bodies up to 100 MB and have 128 MB of memory; one upload holds the body, the
// file and two outputs, so 16 MB stays well inside both.
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

export type ProcessedImage = { original: Size & { type: ImageType }; full: EncodedImage; small: EncodedImage }

export type ImageFailure =
	// The bytes are not an accepted image type, or the service could not read them.
	| 'unsupported'
	// More pixels than the matrix limit.
	| 'too_large'
	// The transformation allowance is used up.
	| 'quota'
	// The service failed, or its output was not what it must be (wrong type, metadata kept).
	| 'failed'

export type ProcessResult = { ok: true; image: ProcessedImage } | { ok: false; reason: ImageFailure; detail?: string }

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

// Re-encodes one output and checks it: the declared type, real dimensions from info(), no location or identity
// metadata, and one frame when `still` asks for it. Original bytes are never returned in place of an output.
async function encodeChecked(codec: ImageCodec, bytes: Uint8Array, options: EncodeOptions): Promise<EncodedImage> {
	const output = await codec.encode(bytes, options)
	if (sniffImageType(output) !== options.format) {
		throw new ImageCodecError(null, 'output is not of the requested type')
	}
	const kept = retainedMetadata(output, options.format)
	if (kept !== null) {
		throw new ImageCodecError(null, `output keeps metadata: ${kept}`)
	}
	const animated = isAnimated(output, options.format)
	if (animated && options.still === true) {
		throw new ImageCodecError(null, 'output is animated')
	}
	const info = await codec.info(output)
	if (info.width === undefined || info.height === undefined) {
		throw new ImageCodecError(null, 'output has no dimensions')
	}
	return { bytes: output, contentType: options.format, animated, width: info.width, height: info.height }
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

export async function processImage(codec: ImageCodec, bytes: Uint8Array): Promise<ProcessResult> {
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
		const small = await encodeChecked(codec, full.bytes, { ...fit(full, SMALL_EDGE), format, still: true })
		return { ok: true, image: { original, full, small } }
	} catch (error) {
		if (error instanceof ImageCodecError && error.code === null) {
			return { ok: false, reason: 'failed', detail: error.message }
		}
		return failure(error)
	}
}
