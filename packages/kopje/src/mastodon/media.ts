import { HTTPException } from 'hono/http-exception'

import {
	afterResponse,
	type AfterResponse,
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
import { type FileRule, type Params, parseBody } from './params'
import type { UserCredential } from '../domain/auth'
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
export const MAX_DESCRIPTION = 1500

// The file plus the form's other fields (description, focus, and a thumbnail, which counts toward this bound and is
// refused).
const MEDIA_BODY_LIMIT = IMAGE_SIZE_LIMIT + 64 * 1024

export const THUMBNAIL_MUST_BE_BLANK = 'Validation failed: Thumbnail must be blank'

// MediaAttachment validates `thumbnail, absence: true` unless the media is audio or video (Mastodon v4.5.11
// app/models/media_attachment.rb:207); every local upload Kopje accepts is an image, so any thumbnail is refused.
// Sent: any file part, or non-empty text (a data URI is assigned through Paperclip's DataUriAdapter; other text has
// no handler and answers 500 there, 422 here). Empty text or JSON null is absent. Only presence is read.
export function thumbnailSent(value: string | File | undefined): boolean {
	return value !== undefined && value !== ''
}

// The validation error of an upload or update form: the description first, then the thumbnail (read only when the
// description passes).
function mediaProblem(params: Params, description: string | undefined): string | undefined {
	return (
		descriptionProblem(description) ??
		(thumbnailSent(params.file('thumbnail') ?? params.get('thumbnail')) ? THUMBNAIL_MUST_BE_BLANK : undefined)
	)
}

// PUT /api/v1/media/:id reads a thumbnail only to refuse it: no allowance beyond its part's headers (RES-1).
const THUMBNAIL_FILE: FileRule = { names: ['thumbnail'], maxBytes: 0 }

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

// The file parameters of an upload form, with readParams' query merge (a declared name's body value wins).
const UPLOAD_FILES = ['file', 'thumbnail']

// The multipart body, bounded before it is parsed (RES-1). Only `file` and `thumbnail` are read as files.
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
	let form: Params
	try {
		// Rails' last-part rule (params.ts): of repeated `file` or `thumbnail` parts, text or file, the last is read.
		form = await parseBody(contentType, body, { names: UPLOAD_FILES, maxBytes: IMAGE_SIZE_LIMIT })
	} catch {
		return { error: "Validation failed: File can't be blank" }
	}
	const file = form.file('file')
	if (file === undefined) {
		return { error: "Validation failed: File can't be blank" }
	}
	if (file.size > IMAGE_SIZE_LIMIT) {
		return { error: TOO_LARGE }
	}
	// The bounds hold for what is used: body fields and query parameters together. A thumbnail is only checked for
	// presence and refused, so its length is not bounded here (the body's is).
	const params = form.withQuery([...new URL(request.url).searchParams.entries()], UPLOAD_FILES)
	const long = ([key, value]: readonly [string, string]) => key !== 'thumbnail' && value.length > MAX_FIELD_LENGTH
	if (params.entries.length > MAX_FIELDS || params.entries.some(long)) {
		return { error: 'Validation failed: A form field is too long' }
	}
	return { file: new Uint8Array(await file.arrayBuffer()), params }
}

export type Failure = { status: number; error: string }

// What the pipeline reads of the request context: the bindings and the raw request (its body is the form).
export type UploadContext = { env: Env; req: { raw: Request } }

const PROCESSING_FAILURES: Record<'unsupported' | 'too_large' | 'quota' | 'failed', Failure> = {
	unsupported: { status: 422, error: INVALID_TYPE },
	too_large: { status: 422, error: `Validation failed: File dimensions exceed ${IMAGE_MATRIX_LIMIT} pixels` },
	quota: { status: 503, error: 'Media processing is unavailable. Try again later.' },
	failed: { status: 500, error: 'Error processing uploaded media' },
}

function budgetRefusal(scope: 'account' | 'instance'): Failure {
	return scope === 'account'
		? { status: 429, error: 'Your media processing budget for the month is used up' }
		: { status: 429, error: "This server's media processing budget for the month is used up" }
}

export type UploadOutcome = { ok: true; media: MediaAttachment } | ({ ok: false } & Failure)

// What the caller checks in the form once it is read, before any transformation is spent: a failure refuses the
// upload (the API checks the description).
export type FormCheck = (params: Params) => Failure | null | Promise<Failure | null>

// A reservation (domain/media.ts reserveMedia): the row's id and file token, the writer deadline, and the budgets and
// credential every later Store call of the upload takes.
type Upload = {
	id: string
	token: string
	deadline: number
	monthlyTransforms: MonthlyTransforms
	credential: () => UserCredential
}

async function reserve(
	c: UploadContext,
	deps: ApiDeps,
	credential: () => UserCredential
): Promise<{ ok: true; upload: Upload } | ({ ok: false } & Failure)> {
	const token = deps.randomToken()
	const config = readConfig(c.env)
	// The app answers 503 before any route when the env is invalid, so this is the validated value.
	const monthlyTransforms = config.ok
		? { instance: config.config.IMAGES_MONTHLY_TRANSFORMS, account: accountMonthlyTransforms(config.config) }
		: { instance: 0, account: 0 }
	const reserved = authorized(
		await storeCall(c, deps, (s, b) =>
			s.reserveMedia(b, { credential: credential(), token, monthlyTransforms, now: deps.now() })
		)
	)
	if (reserved.status !== 'ok') {
		return {
			ok: false,
			...(reserved.status === 'rate_limited'
				? { status: 429, error: 'Too many requests' }
				: budgetRefusal(reserved.scope)),
		}
	}
	return { ok: true, upload: { id: reserved.id, token, deadline: reserved.deadline, monthlyTransforms, credential } }
}

// The upload pipeline of POST /api/v{1,2}/media: reserve, read the form, check it, transform, write, complete; a
// failure abandons the reservation.
export async function receiveImageUpload(
	c: UploadContext,
	deps: ApiDeps,
	credential: () => UserCredential,
	check: FormCheck
): Promise<UploadOutcome> {
	const reserved = await reserve(c, deps, credential)
	if (!reserved.ok) {
		await c.req.raw.body?.cancel()
		return reserved
	}
	const { upload } = reserved
	let outcome: Failure | MediaAttachment
	try {
		outcome = await processUpload(c, deps, upload, check)
	} catch (error) {
		await discard(c, deps, upload, 'keep')
		throw error
	}
	if ('error' in outcome) {
		await discard(c, deps, upload, 'keep')
		return { ok: false, ...outcome }
	}
	return { ok: true, media: outcome }
}

// POST /api/v1/media and /api/v2/media.
export const uploadMedia: ApiHandler = async (c, deps) => {
	const outcome = await receiveImageUpload(
		c,
		deps,
		() => userCredential(c, deps),
		(params) => {
			const problem = mediaProblem(params, params.get('description'))
			return problem === undefined ? null : { status: 422, error: problem }
		}
	)
	return outcome.ok ? c.json(outcome.media) : mastodonError(outcome.status, outcome.error)
}

const EXPIRED_MESSAGE = 'Validation failed: The upload expired'
const EXPIRED: Failure = { status: 422, error: EXPIRED_MESSAGE }

async function processUpload(
	c: UploadContext,
	deps: ApiDeps,
	upload: Upload,
	check: FormCheck
): Promise<Failure | MediaAttachment> {
	const form = await readMediaForm(c.req.raw, upload.deadline - deps.now())
	if ('error' in form) {
		return { status: 422, error: form.error }
	}
	const refused = await check(form.params)
	if (refused !== null) {
		return refused
	}
	return transformReserved(c, deps, upload, form.file, {
		description: form.params.get('description') ?? '',
		focus: parseFocus(form.params.get('focus')) ?? { x: 0, y: 0 },
	})
}

// The transformation of a reserved upload's bytes: the Store revalidates the reservation and charges the
// transformations, Images re-encodes, R2 keeps the original and the served files, and the Store completes the row.
async function transformReserved(
	c: UploadContext,
	deps: ApiDeps,
	upload: Upload,
	bytes: Uint8Array,
	fields: { description: string; focus: { x: number; y: number } }
): Promise<Failure | MediaAttachment> {
	const { id, token, credential } = upload
	// The Store revalidates the reservation with the time now and charges the transformations to this month.
	const started = authorized(
		await storeCall(c, deps, (s, b) =>
			s.startTransforms(b, {
				credential: credential(),
				id,
				monthlyTransforms: upload.monthlyTransforms,
				now: deps.now(),
			})
		)
	)
	if (started.status === 'expired') {
		return EXPIRED
	}
	if (started.status === 'budget_exhausted') {
		return budgetRefusal(started.scope)
	}
	const processed = await processImage(deps.images(c.env), bytes)
	if (!processed.ok) {
		if (processed.reason === 'quota') {
			console.warn({ event: 'kopje.media.images_quota' })
		} else if (processed.reason === 'failed') {
			console.error({ event: 'kopje.media.transform_failed', detail: processed.detail ?? null })
		}
		return PROCESSING_FAILURES[processed.reason]
	}
	// The writer deadline fences the sweep: no write starts after it, and the Store refuses to complete after it, so a
	// reservation the sweep may delete has no writer left (domain/media.ts).
	if (deps.now() >= upload.deadline) {
		return EXPIRED
	}
	await writeFiles(c.env.MEDIA, id, token, bytes, processed.image)
	const { full, small } = processed.image
	const complete = async () =>
		authorized(
			await storeCall(c, deps, (s, b) =>
				s.completeMedia(b, {
					credential: credential(),
					id,
					contentType: full.contentType,
					original: { width: full.width, height: full.height },
					small: { width: small.width, height: small.height },
					animated: full.animated,
					description: fields.description,
					focus: fields.focus,
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
	return media ?? EXPIRED
}

// A completed upload that is to become an avatar or header, made from bytes the caller has read and checked. The
// helper owns the reservation until it answers ok, and discards it on any failure, thrown errors and a lost completion
// answer included (discard). After ok the caller owns the upload until the Store applies it, and discards it if that
// does not commit.
export async function storeProfileImage(
	c: UploadContext,
	deps: ApiDeps,
	credential: () => UserCredential,
	bytes: Uint8Array
): Promise<{ ok: true; upload: ProfileUpload } | ({ ok: false } & Failure)> {
	const reserved = await reserve(c, deps, credential)
	if (!reserved.ok) {
		return reserved
	}
	const { upload } = reserved
	let outcome: Failure | MediaAttachment
	try {
		outcome = await transformReserved(c, deps, upload, bytes, { description: '', focus: { x: 0, y: 0 } })
	} catch (error) {
		await discard(c, deps, upload)
		throw error
	}
	if ('error' in outcome) {
		await discard(c, deps, upload)
		return { ok: false, ...outcome }
	}
	return { ok: true, upload }
}

export type ProfileUpload = Pick<Upload, 'id' | 'token' | 'credential'>

// The original is kept (private, for backups) next to the served files. Keys come from the Store's id and token only.
// Every write settles before this returns, so cleanup after a failure never races a write still in flight.
export async function writeFiles(
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

// A failed or unused upload. The Store decides first: it dooms a reservation that never completed (its writer, this
// request, has settled every write), or keeps an upload whose completion committed although its answer was lost. A
// kept upload stays for POST /api/v{1,2}/media (`keep`: an unattached upload the client may still find, swept after
// its grace period), and is doomed as DELETE /api/v1/media/:id dooms one for a profile image (`doom`: nobody else can
// use it), the sweep deleting its objects. Only a doomed or
// vanished reservation's objects are deleted here. If the Store cannot be asked, the objects stay for the sweep, which
// deletes them with the reservation once its writer deadline has passed, or with a completed upload once its grace
// period has (DETACHED_GRACE_MS).
export async function discard(
	c: UploadContext,
	deps: ApiDeps,
	upload: ProfileUpload,
	completed: 'keep' | 'doom' = 'doom'
): Promise<void> {
	const { id, token } = upload
	try {
		const outcome = authorized(
			await storeCall(c, deps, (s, b) => s.abandonMedia(b, { credential: upload.credential(), id, now: deps.now() }))
		)
		if (outcome !== 'kept') {
			await c.env.MEDIA.delete(mediaKeys(id, token))
			return
		}
		if (completed === 'keep') {
			return
		}
		authorized(
			await storeCall(c, deps, (s, b) => s.deleteMedia(b, { credential: upload.credential(), id, now: deps.now() }))
		)
	} catch (error) {
		console.error({ event: 'kopje.media.abandon_failed', ...errorFields(error) })
	}
}

// The cleanup of a profile request that did not commit: each upload it owns is discarded in turn, then a sweep runs
// after the response, so what was discarded, here or by storeProfileImage, goes now rather than at the next cron.
export async function discardProfileUploads(
	c: UploadContext & AfterResponse,
	deps: ApiDeps,
	owned: readonly ProfileUpload[]
): Promise<void> {
	for (const upload of owned) {
		await discard(c, deps, upload)
	}
	sweepSoon(c, deps)
}

// GET /api/v1/media/:id.
export const getMedia: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	const media = authorized(
		await storeCall(c, deps, (s, b) => s.getMedia(b, { credential, id: mediaId(c), now: deps.now() }))
	)
	return media === null ? NOT_FOUND() : c.json(media)
}

// PUT and PATCH /api/v1/media/:id: description and focus of own unattached media. Attached media is described through
// media_attributes[] of a status edit, as in Mastodon.
export const updateMedia: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps, { files: THUMBNAIL_FILE })
	if (p instanceof Response) {
		return p
	}
	const description = p.get('description')
	const problem = mediaProblem(p, description)
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

// DELETE /api/v1/media/:id: own unattached media; the sweep deletes its R2 objects after the response.
export const deleteMedia: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	const outcome = authorized(
		await storeCall(c, deps, (s, b) => s.deleteMedia(b, { credential, id: mediaId(c), now: deps.now() }))
	)
	if (outcome === 'not_found') {
		return NOT_FOUND()
	}
	if (outcome === 'in_use') {
		return mastodonError(422, 'Media attachment is currently used by a status')
	}
	sweepSoon(c, deps)
	return c.json({})
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

// Runs a sweep after the response (delete_media, a deleted upload or profile image), so the files go now rather than
// at the next cron.
export function sweepSoon(c: AfterResponse, deps: SweepDeps): void {
	afterResponse(
		c,
		sweepMedia(c.env, deps).catch((error: unknown) => {
			console.error({ event: 'kopje.media.sweep_failed', ...errorFields(error) })
		})
	)
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
