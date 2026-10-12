import { HTTPException } from 'hono/http-exception'

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
import { type MediaChanges, type MonthlyTransforms, SWEEP_BATCH } from '../domain/media'
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
// Upload order: the Store reserves the row (authorization, the 30-attempts-per-30-minutes budget, and a check of the
// monthly Images budgets, RES-6) before the body is read, and revalidates it and charges the budgets right before
// Images is called (domain/media.ts), so an unauthenticated, over-budget or expired request costs no transformation. Processing is synchronous, so v2 answers 200 like v1 (Mastodon answers 200 when
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
	// At most two components are split off, however many commas the value has.
	const [x = 0, y = 0] = value.split(',', 2).map((part) => {
		const n = Number.parseFloat(part)
		return Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : 0
	})
	return { x, y }
}

// Whether `text` has more than `max` characters (code points), counting no further than max + 1.
function exceedsCharacters(text: string, max: number): boolean {
	if (text.length <= max) {
		return false
	}
	let count = 0
	for (const _ of text) {
		if (++count > max) {
			return true
		}
	}
	return false
}

export function descriptionProblem(description: string | undefined): string | undefined {
	return description !== undefined && exceedsCharacters(description, MAX_DESCRIPTION)
		? `Validation failed: Description is too long (maximum is ${MAX_DESCRIPTION} characters)`
		: undefined
}

// Each text field of the upload form is bounded on its own (a description is at most 1,500 characters, at most 6 KB
// in UTF-16), and so is their number, so a small image cannot carry megabytes of text into later processing (RES-1).
const MAX_FIELD_LENGTH = 4 * MAX_DESCRIPTION
const MAX_FIELDS = 16

type MediaForm = { file: Uint8Array; params: Params } | { error: string }

// The multipart body, bounded before it is parsed (RES-1). Only `file` is read as a file.
// Reads the body within `ms` of wall time (the reservation's deadline): a client that sends its body slowly cannot
// keep a reservation open past it.
async function readWithin(request: Request, ms: number): Promise<Uint8Array | 'too-large' | 'expired'> {
	let timer: ReturnType<typeof setTimeout> | null = null
	const expired = new Promise<'expired'>((resolve) => {
		timer = setTimeout(() => resolve('expired'), Math.max(0, ms))
	})
	try {
		return await Promise.race([readBoundedBody(request, MEDIA_BODY_LIMIT), expired])
	} finally {
		if (timer !== null) {
			clearTimeout(timer)
		}
	}
}

async function readMediaForm(request: Request, ms: number): Promise<MediaForm> {
	const body = await readWithin(request, ms)
	if (body === 'expired') {
		return { error: EXPIRED_MESSAGE }
	}
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
	// The bounds hold for what is used: body fields and query parameters together.
	const all = [...fields, ...new URL(request.url).searchParams.entries()]
	if (all.length > MAX_FIELDS || all.some(([, value]) => value.length > MAX_FIELD_LENGTH)) {
		return { error: 'Validation failed: A form field is too long' }
	}
	return { file: new Uint8Array(await file.arrayBuffer()), params: new Params(all) }
}

type Failure = { status: number; error: string }

const PROCESSING_FAILURES: Record<'unsupported' | 'too_large' | 'quota' | 'failed', Failure> = {
	unsupported: { status: 422, error: INVALID_TYPE },
	too_large: { status: 422, error: `Validation failed: File dimensions exceed ${IMAGE_MATRIX_LIMIT} pixels` },
	quota: { status: 503, error: 'Media processing is unavailable. Try again later.' },
	failed: { status: 500, error: 'Error processing uploaded media' },
}

function budgetRefusal(scope: 'account' | 'instance'): Response {
	return scope === 'account'
		? mastodonError(429, 'Your media processing budget for the month is used up')
		: mastodonError(429, "This server's media processing budget for the month is used up")
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
		return reserved.status === 'rate_limited' ? mastodonError(429, 'Too many requests') : budgetRefusal(reserved.scope)
	}
	const { id, deadline } = reserved
	let outcome: Response | MediaAttachment
	try {
		outcome = await processUpload(c, deps, { id, token, deadline, monthlyTransforms })
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

const EXPIRED_MESSAGE = 'Validation failed: The upload expired'
const EXPIRED = () => mastodonError(422, EXPIRED_MESSAGE)

async function processUpload(
	c: ApiContext,
	deps: ApiDeps,
	upload: { id: string; token: string; deadline: number; monthlyTransforms: MonthlyTransforms }
): Promise<Response | MediaAttachment> {
	const { id, token } = upload
	const form = await readMediaForm(c.req.raw, upload.deadline - deps.now())
	if ('error' in form) {
		return mastodonError(422, form.error)
	}
	const description = form.params.get('description')
	const problem = descriptionProblem(description)
	if (problem !== undefined) {
		return mastodonError(422, problem)
	}
	// The Store revalidates the reservation with the time now and charges the transformations to this month.
	const started = authorized(
		await storeCall(c, deps, (s, b) =>
			s.startTransforms(b, {
				credential: userCredential(c, deps),
				id,
				monthlyTransforms: upload.monthlyTransforms,
				now: deps.now(),
			})
		)
	)
	if (started.status === 'expired') {
		return EXPIRED()
	}
	if (started.status === 'budget_exhausted') {
		return budgetRefusal(started.scope)
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
	// The writer deadline fences the sweep: no write starts after it, and the Store refuses to complete after it, so a
	// reservation the sweep may delete has no writer left (domain/media.ts).
	if (deps.now() >= upload.deadline) {
		return EXPIRED()
	}
	await writeFiles(c.env.MEDIA, id, token, form.file, processed.image)
	const { full, small } = processed.image
	const complete = async () =>
		authorized(
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
	let media: MediaAttachment | null
	try {
		media = await complete()
	} catch (error) {
		// The completion may have committed and only its answer been lost: completing again is idempotent and answers
		// with the media if it did.
		if (error instanceof HTTPException) {
			throw error
		}
		media = await complete()
	}
	return media ?? EXPIRED()
}

// The original is kept (private, for backups) next to the served files. Keys come from the Store's id and token only.
// Every write settles before this returns, so cleanup after a failure never races a write still in flight.
async function writeFiles(
	bucket: R2Bucket,
	id: string,
	token: string,
	original: Uint8Array,
	image: ProcessedImage
): Promise<void> {
	const results = await Promise.allSettled([
		bucket.put(originalKey(id), original, { httpMetadata: { contentType: image.original.type } }),
		bucket.put(fileKey(token, 'full'), image.full.bytes, { httpMetadata: { contentType: image.full.contentType } }),
		bucket.put(fileKey(token, 'small'), image.small.bytes, { httpMetadata: { contentType: image.small.contentType } }),
	])
	const failed = results.find((result) => result.status === 'rejected')
	if (failed !== undefined) {
		throw failed.reason
	}
}

// A failed upload. The Store decides first: it dooms a reservation that never completed (its writer, this request,
// has settled every write), or keeps an upload whose completion committed although its answer was lost. Only then are
// the R2 objects deleted, and only those of a doomed or vanished row. If the Store cannot be asked, the objects stay
// for the sweep, which deletes them with the reservation once its writer deadline has passed.
async function abandon(c: ApiContext, deps: ApiDeps, id: string, token: string): Promise<void> {
	try {
		const outcome = authorized(
			await storeCall(c, deps, (s, b) =>
				s.abandonMedia(b, { credential: userCredential(c, deps), id, now: deps.now() })
			)
		)
		if (outcome !== 'kept') {
			await c.env.MEDIA.delete(mediaKeys(id, token))
		}
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

// Deletes the R2 keys of tombstones that fell due (domain/media.ts), one bounded batch per run (the cron), then the
// tombstones. Nothing else: an object is never deleted because no row names it. In maintenance, a dump or an import the
// Store refuses and the run waits. Returns how many tombstones were handled.
export async function reconcileMedia(env: Env, deps: SweepDeps): Promise<number> {
	const store = deps.store(env)
	const build = deps.build(env)
	try {
		const due = await callStore(() => store.dueOrphans(build, { now: deps.now() }))
		if (due.length === 0) {
			return 0
		}
		await env.MEDIA.delete(due.flatMap((orphan) => mediaKeys(orphan.id, orphan.token)))
		return await callStore(() => store.forgetOrphans(build, { tokens: due.map((orphan) => orphan.token) }))
	} catch (error) {
		if (error instanceof StoreUnavailableError) {
			return 0
		}
		throw error
	}
}
