import { writeFiles } from './media'
import type { AdminEmoji, EmojiRefusal } from '../domain/local-emojis'
import {
	EMOJI_IMAGE_LIMIT,
	emojiInputProblem,
	emojiInputSizeProblem,
	emojiOutputProblem,
} from '../platform/emoji-image'
import { errorFields } from '../platform/error-message'
import { sniffImageType } from '../platform/image-bytes'
import { type ImageCodec, type ImageFailure, inspectImage, processImage } from '../platform/images'
import { mediaKeys } from '../platform/media-files'
import type { ImportAuthority } from '../platform/store-admin'
import type { StoreStub } from '../platform/store-client'
import { LOCAL_EMOJI_SHORTCODE, storedEmojiCategory } from '../platform/stored-bounds'

// The Access admin's upload of a local custom emoji (POST /admin/emojis, `kopje-admin emoji add`; domain/
// local-emojis.ts). The admin CLI holds an Access service token, not an OAuth token, so it cannot use /api/v1/media:
// the image comes base64 in the JSON body (app/admin.ts JSON_BODY_LIMIT, 1 MiB, holds 262,143 bytes encoded).
//
// Order: the request is checked whole and the image's free info() read (platform/emoji-image.ts emojiInputProblem,
// RES-1, MEDIA-4) before the Store reserves the row and charges the two transformations (RES-6); then processImage
// re-encodes (MEDIA-3), emojiOutputProblem judges the published files before any R2 write (an output refused keeps
// the consumed charge), the files are written while the writer deadline holds, and completeEmoji promotes the row
// (MEDIA-2). Any failure after the reservation abandons it; its R2 keys are deleted unless the Store keeps the row.

export type EmojiUploadDeps = {
	build: string
	store: StoreStub
	bucket: R2Bucket
	images: ImageCodec
	now: () => number
	authority: ImportAuthority
	// IMAGES_MONTHLY_TRANSFORMS.
	monthlyTransforms: number
	token: string
}

export type EmojiUploadRefusal =
	| EmojiRefusal
	| {
			ok: false
			code:
				| 'invalid-shortcode'
				| 'invalid-category'
				| 'invalid-image'
				| 'image-too-large'
				| 'images-unavailable'
				| 'image-processing-failed'
			message: string
	  }

export type EmojiUploadResult = { ok: true; emoji: AdminEmoji } | EmojiUploadRefusal

// Strict base64 (RFC 4648 §4, padded, no whitespace): a body atob would read leniently is refused.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
// The longest encoding of an image below EMOJI_IMAGE_LIMIT bytes.
const MAX_IMAGE_BASE64 = Math.ceil((EMOJI_IMAGE_LIMIT - 1) / 3) * 4

function refused(code: Exclude<EmojiUploadRefusal['code'], EmojiRefusal['code']>, message: string): EmojiUploadRefusal {
	return { ok: false, code, message }
}

const TOO_LARGE = `an emoji image is below ${EMOJI_IMAGE_LIMIT} bytes and at most 1024x1024, also once re-encoded`
const INVALID = 'an emoji image is a PNG, GIF or WebP'

function imageFailure(reason: ImageFailure, detail?: string): EmojiUploadRefusal {
	switch (reason) {
		case 'unsupported':
			return refused('invalid-image', INVALID)
		case 'too_large':
			return refused('image-too-large', TOO_LARGE)
		case 'quota':
			return refused('images-unavailable', 'Images refused for quota (9422); try again once the allowance renews')
		case 'failed':
			return refused('image-processing-failed', `re-encoding failed${detail === undefined ? '' : ` (${detail})`}`)
	}
}

type EmojiRequest = {
	shortcode: string
	category: string | null
	visibleInPicker: boolean
	replace: boolean
	image: Uint8Array
}

function readRequest(body: Record<string, unknown>): EmojiRequest | EmojiUploadRefusal {
	const { shortcode, image, category, visibleInPicker, replace } = body
	if (typeof shortcode !== 'string' || !LOCAL_EMOJI_SHORTCODE.test(shortcode)) {
		return refused('invalid-shortcode', 'a shortcode is 2 to 128 ASCII letters, digits and underscores')
	}
	const stored =
		category === undefined || category === null
			? null
			: typeof category === 'string'
				? storedEmojiCategory(category)
				: undefined
	if (stored === undefined) {
		return refused('invalid-category', 'a category is 1 to 64 characters within 256 bytes, with no control character')
	}
	if (
		(visibleInPicker !== undefined && typeof visibleInPicker !== 'boolean') ||
		(replace !== undefined && typeof replace !== 'boolean')
	) {
		return refused('invalid-image', 'visibleInPicker and replace are booleans')
	}
	if (typeof image !== 'string' || !BASE64.test(image)) {
		return refused('invalid-image', 'image is the file in base64')
	}
	if (image.length > MAX_IMAGE_BASE64) {
		return refused('image-too-large', TOO_LARGE)
	}
	return {
		shortcode,
		category: stored,
		visibleInPicker: visibleInPicker !== false,
		replace: replace === true,
		image: Uint8Array.from(atob(image), (c) => c.charCodeAt(0)),
	}
}

export async function uploadEmoji(deps: EmojiUploadDeps, body: Record<string, unknown>): Promise<EmojiUploadResult> {
	const request = readRequest(body)
	if ('ok' in request) {
		return request
	}
	// The size and signature first, so nothing that is not an emoji input reaches Images; then the free info(), judged
	// before anything is charged (a codec error is classified as processImage classifies it).
	const preflight = emojiInputSizeProblem(request.image.length, sniffImageType(request.image))
	if (preflight !== null) {
		return refused(preflight, preflight === 'invalid-image' ? INVALID : TOO_LARGE)
	}
	const inspected = await inspectImage(deps.images, request.image)
	if (!inspected.ok) {
		return imageFailure(inspected.reason, inspected.detail)
	}
	const problem = emojiInputProblem(request.image, inspected.info)
	if (problem !== null) {
		return refused(problem, problem === 'invalid-image' ? INVALID : TOO_LARGE)
	}
	const { build, store, token } = deps
	const reserved = await store.reserveEmoji(build, {
		authority: deps.authority,
		token,
		shortcode: request.shortcode,
		replace: request.replace,
		limit: deps.monthlyTransforms,
	})
	if (!reserved.ok) {
		return reserved
	}
	const upload = { id: reserved.id, deadline: reserved.deadline }
	let outcome: EmojiUploadResult
	try {
		outcome = await finish(deps, request, upload)
	} catch (error) {
		await abandon(deps, upload.id)
		throw error
	}
	if (!outcome.ok) {
		await abandon(deps, upload.id)
	}
	return outcome
}

async function finish(
	deps: EmojiUploadDeps,
	request: EmojiRequest,
	upload: { id: string; deadline: number }
): Promise<EmojiUploadResult> {
	const processed = await processImage(deps.images, request.image)
	if (!processed.ok) {
		return imageFailure(processed.reason, processed.detail)
	}
	const problem = emojiOutputProblem(processed.image)
	if (problem !== null) {
		return refused(problem, problem === 'invalid-image' ? INVALID : TOO_LARGE)
	}
	const expired = refusalOf('upload-expired', 'the upload expired before it completed; add the emoji again')
	// No write starts after the writer deadline, and the Store refuses to complete after it (domain/media.ts).
	if (deps.now() >= upload.deadline) {
		return expired
	}
	await writeFiles(deps.bucket, upload.id, deps.token, request.image, processed.image)
	const { full, small } = processed.image
	const complete = () =>
		deps.store.completeEmoji(deps.build, {
			authority: deps.authority,
			id: upload.id,
			token: deps.token,
			shortcode: request.shortcode,
			category: request.category,
			visibleInPicker: request.visibleInPicker,
			replace: request.replace,
			contentType: full.contentType,
			original: { width: full.width, height: full.height },
			small: { width: small.width, height: small.height },
		})
	try {
		return await complete()
	} catch {
		// The completion may have committed and only its answer been lost: completing again is idempotent.
		return await complete()
	}
}

function refusalOf(code: EmojiRefusal['code'], message: string): EmojiRefusal {
	return { ok: false, code, message }
}

// A failed upload, as mastodon/media.ts abandons one: the Store decides first, and the R2 keys go only for a doomed or
// vanished reservation. If the Store cannot be asked, the keys stay for the sweep and its tombstone.
async function abandon(deps: EmojiUploadDeps, id: string): Promise<void> {
	try {
		const outcome = await deps.store.abandonEmoji(deps.build, { authority: deps.authority, id, token: deps.token })
		if (outcome === 'abandoned' || outcome === 'gone') {
			await deps.bucket.delete(mediaKeys(id, deps.token))
		}
	} catch (error) {
		console.error({ event: 'kopje.emoji.abandon_failed', ...errorFields(error) })
	}
}
