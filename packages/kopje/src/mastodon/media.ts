import {
	type ApiContext,
	type ApiDeps,
	type ApiHandler,
	authorized,
	refuseAfterAuth,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { Params } from './params'
import { type MediaChanges, SWEEP_BATCH } from '../domain/media'
import type { MediaAttachment } from '../domain/status-presenter'
import { readBoundedBody } from '../platform/body'
import { accountMonthlyTransforms, readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { IMAGE_MATRIX_LIMIT, IMAGE_SIZE_LIMIT, processImage, type ProcessedImage } from '../platform/images'
import { fileKey, mediaKeys, originalKey } from '../platform/media-files'
import { callStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'

// /api/v1/media and /api/v2/media (B4b): upload, read and describe own unattached media.
//
// Accepted: JPEG, PNG, GIF, WebP and AVIF, by their signature (MEDIA-4), up to 16 MB and 16,777,216 pixels (RES-1).
// Each is re-encoded through Images (EXIF and location removed, long edge capped, a preview made) and only the
// re-encoded files are served; when re-encoding fails the upload is refused and nothing is served (MEDIA-3).
// Video and audio are refused with 422: the Images binding transforms images only, and serving an un-transcoded
// container would publish its metadata (location included) as uploaded.
//
// Upload order: the Store reserves the row (authorization, the 30-attempts-per-30-minutes budget and the instance's
// monthly Images budget, RES-6) before the body is read or Images is called, so an unauthenticated or over-budget
// request costs no transformation. Processing is synchronous, so v2 answers 200 like v1 (Mastodon answers 200 when
// processing finished in the request).

const NOT_FOUND = () => mastodonError(404, 'Record not found')

// MediaAttachment::MAX_DESCRIPTION_LENGTH.
const MAX_DESCRIPTION = 1500

// The file plus the form's other fields (description, focus, an ignored thumbnail is not read past this bound).
const MEDIA_BODY_LIMIT = IMAGE_SIZE_LIMIT + 64 * 1024

const TOO_LARGE = 'Validation failed: File file size must be less than 16 MB'
const INVALID_TYPE = 'Validation failed: File content type is invalid'

function mediaId(c: ApiContext): string {
	return c.req.param('id') ?? ''
}

// Mastodon's focus: "x,y" with each coordinate in [-1, 1]; unparsable parts read as 0, as Ruby's to_f does.
export function parseFocus(value: string | undefined): { x: number; y: number } | undefined {
	if (value === undefined || value === '') {
		return undefined
	}
	const [x = 0, y = 0] = value.split(',').map((part) => {
		const n = Number.parseFloat(part)
		return Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : 0
	})
	return { x, y }
}

export function descriptionProblem(description: string | undefined): string | undefined {
	return description !== undefined && [...description].length > MAX_DESCRIPTION
		? `Validation failed: Description is too long (maximum is ${MAX_DESCRIPTION} characters)`
		: undefined
}

type MediaForm = { file: Uint8Array; params: Params } | { error: string }

// The multipart body, bounded before it is parsed (RES-1). Only `file` is read as a file.
async function readMediaForm(request: Request): Promise<MediaForm> {
	const body = await readBoundedBody(request, MEDIA_BODY_LIMIT)
	if (body === 'too-large') {
		return { error: TOO_LARGE }
	}
	const contentType = request.headers.get('content-type') ?? ''
	if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
		return { error: "Validation failed: File can't be blank" }
	}
	let form: FormData
	try {
		form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
	} catch {
		return { error: "Validation failed: File can't be blank" }
	}
	// FormData.get is typed as string-only by the runtime types; a file part is a File.
	const file: unknown = form.get('file')
	if (!(file instanceof File)) {
		return { error: "Validation failed: File can't be blank" }
	}
	if (file.size > IMAGE_SIZE_LIMIT) {
		return { error: TOO_LARGE }
	}
	const fields = [...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	const query = [...new URL(request.url).searchParams.entries()]
	return { file: new Uint8Array(await file.arrayBuffer()), params: new Params([...fields, ...query]) }
}

type Failure = { status: number; error: string }

const PROCESSING_FAILURES: Record<'unsupported' | 'too_large' | 'quota' | 'failed', Failure> = {
	unsupported: { status: 422, error: INVALID_TYPE },
	too_large: { status: 422, error: `Validation failed: File dimensions exceed ${IMAGE_MATRIX_LIMIT} pixels` },
	quota: { status: 503, error: 'Media processing is unavailable. Try again later.' },
	failed: { status: 500, error: 'Error processing uploaded media' },
}

// POST /api/v1/media and /api/v2/media.
export const uploadMedia: ApiHandler = async (c, deps) => {
	const token = deps.randomToken()
	const config = readConfig(c.env)
	// The app answers 503 before any route when the env is invalid, so this is the validated value.
	const monthlyTransforms = config.ok
		? { instance: config.config.IMAGES_MONTHLY_TRANSFORMS, account: accountMonthlyTransforms(config.config) }
		: { instance: 0, account: 0 }
	const reserved = authorized(
		await storeCall(c, deps, (s, b) =>
			s.reserveMedia(b, { credential: userCredential(c, deps), token, monthlyTransforms, now: deps.now() })
		)
	)
	if (reserved.status !== 'ok') {
		await c.req.raw.body?.cancel()
		return reserved.status === 'rate_limited'
			? mastodonError(429, 'Too many requests')
			: reserved.scope === 'account'
				? mastodonError(429, 'Your media processing budget for the month is used up')
				: mastodonError(429, "This server's media processing budget for the month is used up")
	}
	const id = reserved.id
	let outcome: Response | MediaAttachment
	try {
		outcome = await processUpload(c, deps, id, token)
	} catch (error) {
		await abandon(c, deps, id, token)
		throw error
	}
	if (outcome instanceof Response) {
		await abandon(c, deps, id, token)
		return outcome
	}
	return c.json(outcome)
}

async function processUpload(
	c: ApiContext,
	deps: ApiDeps,
	id: string,
	token: string
): Promise<Response | MediaAttachment> {
	const form = await readMediaForm(c.req.raw)
	if ('error' in form) {
		return mastodonError(422, form.error)
	}
	const description = form.params.get('description')
	const problem = descriptionProblem(description)
	if (problem !== undefined) {
		return mastodonError(422, problem)
	}
	const processed = await processImage(deps.images(c.env), form.file)
	if (!processed.ok) {
		const failure = PROCESSING_FAILURES[processed.reason]
		if (processed.reason === 'quota') {
			console.warn({ event: 'kopje.media.images_quota' })
		} else if (processed.reason === 'failed') {
			console.error({ event: 'kopje.media.transform_failed', detail: processed.detail ?? null })
		}
		return mastodonError(failure.status, failure.error)
	}
	await writeFiles(c.env.MEDIA, id, token, form.file, processed.image)
	const { full, small } = processed.image
	const media = authorized(
		await storeCall(c, deps, (s, b) =>
			s.completeMedia(b, {
				credential: userCredential(c, deps),
				id,
				contentType: full.contentType,
				original: { width: full.width, height: full.height },
				small: { width: small.width, height: small.height },
				description: description ?? '',
				focus: parseFocus(form.params.get('focus')) ?? { x: 0, y: 0 },
				now: deps.now(),
			})
		)
	)
	return media ?? mastodonError(422, 'Validation failed: The upload expired')
}

// The original is kept (private, for backups) next to the served files. Keys come from the Store's id and token only.
async function writeFiles(
	bucket: R2Bucket,
	id: string,
	token: string,
	original: Uint8Array,
	image: ProcessedImage
): Promise<void> {
	await Promise.all([
		bucket.put(originalKey(id), original, { httpMetadata: { contentType: image.original.type } }),
		bucket.put(fileKey(token, 'full'), image.full.bytes, { httpMetadata: { contentType: image.full.contentType } }),
		bucket.put(fileKey(token, 'small'), image.small.bytes, { httpMetadata: { contentType: image.small.contentType } }),
	])
}

// A failed upload: its R2 objects are deleted now, and its row is doomed for the sweep. Both are best effort; the
// reservation expires on its own if they fail.
async function abandon(c: ApiContext, deps: ApiDeps, id: string, token: string): Promise<void> {
	try {
		await c.env.MEDIA.delete(mediaKeys(id, token))
		authorized(
			await storeCall(c, deps, (s, b) =>
				s.abandonMedia(b, { credential: userCredential(c, deps), id, now: deps.now() })
			)
		)
	} catch (error) {
		console.error({ event: 'kopje.media.abandon_failed', ...errorFields(error) })
	}
}

// GET /api/v1/media/:id.
export const getMedia: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	const media = authorized(
		await storeCall(c, deps, (s, b) => s.getMedia(b, { credential, id: mediaId(c), now: deps.now() }))
	)
	return media === null ? NOT_FOUND() : c.json(media)
}

// PUT /api/v1/media/:id: description and focus of own unattached media. Attached media is described through
// media_attributes[] of a status edit, as in Mastodon.
export const updateMedia: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const description = p.get('description')
	const problem = descriptionProblem(description)
	if (problem !== undefined) {
		return refuseAfterAuth(c, deps, mastodonError(422, problem))
	}
	const changes: MediaChanges = { description, focus: parseFocus(p.get('focus')) }
	const credential = userCredential(c, deps)
	const media = authorized(
		await storeCall(c, deps, (s, b) => s.updateMedia(b, { credential, id: mediaId(c), changes, now: deps.now() }))
	)
	return media === null ? NOT_FOUND() : c.json(media)
}

export type SweepDeps = { build: (env: Env) => string; now: () => number; store: StoreResolver }

// Deletes doomed uploads: their R2 objects first, then their rows, one bounded batch (domain/media.ts). Returns how
// many rows were deleted. In maintenance the Store refuses and the sweep waits for the next run.
export async function sweepMedia(env: Env, deps: SweepDeps): Promise<number> {
	const store = deps.store(env)
	const build = deps.build(env)
	try {
		const now = deps.now()
		const expired = await callStore(() => store.expiredMedia(build, { now, limit: SWEEP_BATCH }))
		if (expired.length === 0) {
			return 0
		}
		const keys = expired.flatMap((m) => (m.token === null ? [originalKey(m.id)] : mediaKeys(m.id, m.token)))
		await env.MEDIA.delete(keys)
		return await callStore(() => store.purgeMedia(build, { ids: expired.map((m) => m.id), now }))
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			return 0
		}
		throw error
	}
}

// Runs a sweep after the response (delete_media, a failed upload), so the files go now rather than at the next cron.
export function sweepSoon(c: ApiContext, deps: ApiDeps): void {
	const sweep = sweepMedia(c.env, deps).catch((error: unknown) => {
		console.error({ event: 'kopje.media.sweep_failed', ...errorFields(error) })
	})
	try {
		c.executionCtx.waitUntil(sweep)
	} catch {
		// No execution context (not reachable in the Worker); the sweep still runs.
	}
}
