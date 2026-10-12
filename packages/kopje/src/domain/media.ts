import { userReadOperation, userWriteOperation } from './auth'
import { allocateLocalId } from './ids'
import { readOperation, writeOperation } from './operation'
import { MEDIA_COLUMNS, type MediaAttachment, type MediaRow, presentMedia } from './status-presenter'
import type { Db } from '../db/sql'
import { mediaPath } from '../platform/media-files'

// Local media attachments (B4b). An upload is three steps, because re-encoding and R2 are external I/O the Store does
// not do:
//   1. reserveMedia (Store): authorizes, applies the upload budget, and creates the row (processed = 0) with its id and
//      file token, so the R2 keys exist in the Store before anything is written to R2;
//   2. the Worker re-encodes the image and writes the original and the served files to R2;
//   3. completeMedia (Store) records type, URLs and dimensions; abandonMedia marks a failed upload for deletion.
//
// The writer (the uploading request) gets a deadline, WRITE_WINDOW_MS after the reservation: it starts no R2 write
// after it, and completeMedia refuses after it. The reservation itself is kept until RESERVATION_MS, so the sweep never
// deletes a row, and the objects it names, while its writer may still write. processed = 0 means a writer may still be
// at work; completion and abandonment both set it to 1. Completion is idempotent, so a request whose completion
// answer was lost can ask again, and abandonment never dooms a completed upload.
//
// Lifecycle: an unattached upload carries gc_at. It is attachable only while gc_at is in the future. A status that
// stops using media (edit, delete) detaches it with a new grace period, so a redraft can attach it again; delete_media
// dooms it at once. The sweep (expiredMedia, then R2 deletes, then purgeMedia) removes doomed rows and their R2 objects in
// bounded batches. A row stays until its objects are deleted, so no R2 object is left without a row (MEDIA-2).
//
// Only the uploader reads, updates or attaches an upload, and only while it is unattached (MEDIA-1); Mastodon's
// MediaController finds `current_account.media_attachments.where(status_id: nil)`.

const HOUR = 60 * 60 * 1000

// Media a status no longer uses may be attached again for a day (Mastodon vacuums unattached media after a day).
export const DETACHED_GRACE_MS = 24 * HOUR

// The writer of a reservation must finish within WRITE_WINDOW_MS. A reservation that never completes (the Worker failed
// mid-upload) is swept after RESERVATION_MS, which leaves 45 minutes for writes started before the deadline to settle.
export const WRITE_WINDOW_MS = 15 * 60 * 1000
const RESERVATION_MS = HOUR

// Mastodon's rate limit for media uploads: 30 per 30 minutes per account (RES-6). Attempts are counted, not rows: a
// deleted or failed upload still counts, so upload-and-delete cannot loop.
export const UPLOAD_BUDGET = { count: 30, windowMs: 30 * 60 * 1000 }

// Images transformations one upload may spend (the full image and the preview; platform/images.ts).
export const TRANSFORMS_PER_UPLOAD = 2

// The attempt and transformation counters live in kopje_state, outside the dumped tables: each account's attempt times
// in the window (at most UPLOAD_BUDGET.count), and the transformations reserved per UTC month, for the instance and
// for each account. A reservation is charged to the month of its own time, also when its transformations run after
// midnight (they run within WRITE_WINDOW_MS). Months before the previous one are pruned; the current and later months
// are never touched by a request, so one that reaches the Store late cannot reset newer counters.
const ATTEMPTS = 'media_attempts:'
const TRANSFORMS = 'images_transforms:'
const ACCOUNT_TRANSFORMS = 'images_account_transforms:'

function state(db: Db, name: string): string | undefined {
	return db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', name)?.value
}

function setState(db: Db, name: string, value: string): void {
	db.run('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, value)
}

// At most this many uploads are swept per run; each is three R2 keys.
export const SWEEP_BATCH = 100

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

// The condition for an upload that may still be used: processed and not doomed. `now` is a parameter expression.
export function liveMediaSql(m: string, now: string): string {
	return `(${m}.processed = 1 AND (${m}.gc_at IS NULL OR ${m}.gc_at > ${now}))`
}

function ownUpload(db: Db, accountId: string, id: string, now: number): MediaRow | undefined {
	return db.first<MediaRow>(
		`SELECT ${MEDIA_COLUMNS} FROM media_attachments m
		WHERE m.id = ?1 AND m.account_id = ?2 AND m.status_id IS NULL AND ${liveMediaSql('m', '?3')}`,
		id,
		accountId,
		iso(now)
	)
}

export type Reserved =
	| { status: 'ok'; id: string; deadline: number }
	| { status: 'rate_limited' }
	| { status: 'budget_exhausted'; scope: 'account' | 'instance' }

export type MonthlyTransforms = { instance: number; account: number }

// Step 1. `token` is the file token the Worker generated (32 random bytes). `monthlyTransforms` holds the instance's
// Images budget and each account's share of it (IMAGES_MONTHLY_TRANSFORMS, IMAGES_ACCOUNT_MONTHLY_TRANSFORMS), so one
// account (R4) cannot use up the instance's budget for everyone. All budgets are checked and charged here, in the
// transaction that makes the reservation, so concurrent uploads cannot overshoot them and nothing reaches Images past
// them (RES-6).
export const reserveMedia = userWriteOperation<
	{ token: string; monthlyTransforms: MonthlyTransforms; now: number },
	Reserved
>((db, { token, monthlyTransforms, now }, { accountId }) => {
	const attemptsName = `${ATTEMPTS}${accountId}`
	const since = now - UPLOAD_BUDGET.windowMs
	const attempts = (JSON.parse(state(db, attemptsName) ?? '[]') as number[]).filter((at) => at > since)
	if (attempts.length >= UPLOAD_BUDGET.count) {
		return { status: 'rate_limited' }
	}
	const month = iso(now).slice(0, 7)
	const instanceName = `${TRANSFORMS}${month}`
	const accountName = `${ACCOUNT_TRANSFORMS}${month}:${accountId}`
	const instanceSpent = Number(state(db, instanceName) ?? '0')
	const accountSpent = Number(state(db, accountName) ?? '0')
	if (accountSpent + TRANSFORMS_PER_UPLOAD > monthlyTransforms.account) {
		return { status: 'budget_exhausted', scope: 'account' }
	}
	if (instanceSpent + TRANSFORMS_PER_UPLOAD > monthlyTransforms.instance) {
		return { status: 'budget_exhausted', scope: 'instance' }
	}
	setState(db, attemptsName, JSON.stringify([...attempts, now]))
	// Counters of months before the previous one go (at most ten local accounts, so this stays small).
	db.run(
		`DELETE FROM kopje_state WHERE (substr(name, 1, ?1) = ?2 AND substr(name, ?1 + 1, 7) < ?5)
			OR (substr(name, 1, ?3) = ?4 AND substr(name, ?3 + 1, 7) < ?5)`,
		TRANSFORMS.length,
		TRANSFORMS,
		ACCOUNT_TRANSFORMS.length,
		ACCOUNT_TRANSFORMS,
		previousMonth(now)
	)
	setState(db, instanceName, String(instanceSpent + TRANSFORMS_PER_UPLOAD))
	setState(db, accountName, String(accountSpent + TRANSFORMS_PER_UPLOAD))
	const id = allocateLocalId(db, now)
	db.run(
		`INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
		VALUES (?, ?, 'image', '', ?, 0, ?, ?)`,
		id,
		accountId,
		token,
		iso(now + RESERVATION_MS),
		iso(now)
	)
	return { status: 'ok', id, deadline: now + WRITE_WINDOW_MS }
})

// YYYY-MM of the month before the one `now` is in (UTC).
function previousMonth(now: number): string {
	const date = new Date(now)
	return iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).slice(0, 7)
}

export type CompleteMediaInput = {
	id: string
	contentType: string
	original: { width: number; height: number }
	small: { width: number; height: number }
	description: string
	focus: { x: number; y: number }
	now: number
}

// Step 3. The URLs are made here, on the instance origin of the uploader's actor URI (as status URIs are), from the
// row's own token. Completing an upload that is already complete answers with it (the first answer may have been lost).
// Null when the reservation is gone or its writer deadline has passed: the Worker then abandons it.
export const completeMedia = userWriteOperation<CompleteMediaInput, MediaAttachment | null>(
	(db, input, { accountId }) => {
		const row = db.first<{ token: string | null; uri: string; processed: number; url: string; created_at: string }>(
			`SELECT m.file_token AS token, a.uri, m.processed, m.url, m.created_at
			FROM media_attachments m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.account_id = ?`,
			input.id,
			accountId
		)
		if (row === undefined || row.token === null) {
			return null
		}
		if (row.processed === 1) {
			const done = row.url === '' ? undefined : ownUpload(db, accountId, input.id, input.now)
			return done === undefined ? null : presentMedia(done)
		}
		if (row.created_at <= iso(input.now - WRITE_WINDOW_MS)) {
			return null
		}
		const origin = new URL(row.uri).origin
		db.run(
			`UPDATE media_attachments SET url = ?, preview_url = ?, content_type = ?, meta = ?, description = ?,
				focus_x = ?, focus_y = ?, processed = 1, gc_at = ?
			WHERE id = ?`,
			`${origin}${mediaPath(row.token, 'full', input.contentType)}`,
			`${origin}${mediaPath(row.token, 'small', input.contentType)}`,
			input.contentType,
			JSON.stringify({ original: input.original, small: input.small }),
			input.description,
			input.focus.x,
			input.focus.y,
			iso(input.now + DETACHED_GRACE_MS),
			input.id
		)
		const done = ownUpload(db, accountId, input.id, input.now)
		return done === undefined ? null : presentMedia(done)
	}
)

// abandoned: the reservation is doomed (or already was) and its objects may go; kept: the upload completed, so its
// objects stay; gone: there is no such row, so nothing refers to its objects.
export type Abandoned = 'abandoned' | 'kept' | 'gone'

// A failed upload: doomed at once and released from its writer, so the sweep takes it right away. A completed upload is
// never doomed here.
export const abandonMedia = userWriteOperation<{ id: string; now: number }, Abandoned>(
	(db, { id, now }, { accountId }) => {
		const row = db.first<{ processed: number; url: string }>(
			'SELECT processed, url FROM media_attachments WHERE id = ? AND account_id = ?',
			id,
			accountId
		)
		if (row === undefined) {
			return 'gone'
		}
		if (row.processed === 1 && row.url !== '') {
			return 'kept'
		}
		db.run('UPDATE media_attachments SET processed = 1, gc_at = ? WHERE id = ? AND status_id IS NULL', iso(now), id)
		return 'abandoned'
	}
)

export const getMedia = userReadOperation<{ id: string; now: number }, MediaAttachment | null>(
	(db, { id, now }, { accountId }) => {
		const row = ownUpload(db, accountId, id, now)
		return row === undefined ? null : presentMedia(row)
	}
)

export type MediaChanges = { description?: string; focus?: { x: number; y: number } }

export const updateMedia = userWriteOperation<
	{ id: string; changes: MediaChanges; now: number },
	MediaAttachment | null
>((db, { id, changes, now }, { accountId }) => {
	if (ownUpload(db, accountId, id, now) === undefined) {
		return null
	}
	db.run(
		`UPDATE media_attachments SET description = COALESCE(?, description), focus_x = COALESCE(?, focus_x),
				focus_y = COALESCE(?, focus_y)
			WHERE id = ?`,
		changes.description ?? null,
		changes.focus?.x ?? null,
		changes.focus?.y ?? null,
		id
	)
	const row = ownUpload(db, accountId, id, now)
	return row === undefined ? null : presentMedia(row)
})

// token is null for rows with no R2 files (migrated media), which are only deleted.
export type ExpiredMedia = { id: string; token: string | null }

// Doomed uploads, oldest first. They cannot be attached or read any more (liveMediaSql), so the R2 objects can go
// before the rows.
export const expiredMedia = readOperation<{ now: number; limit: number }, ExpiredMedia[]>((db, { now, limit }) =>
	db.all<ExpiredMedia>(
		`SELECT id, file_token AS token FROM media_attachments
		WHERE status_id IS NULL AND gc_at IS NOT NULL AND gc_at <= ?
		ORDER BY gc_at LIMIT ?`,
		iso(now),
		Math.min(limit, SWEEP_BATCH)
	)
)

// Deletes swept rows whose R2 objects are gone; a row attached again meanwhile cannot match (it has no gc_at).
export const purgeMedia = writeOperation<{ ids: string[]; now: number }, number>((db, { ids, now }) =>
	db.run(
		`DELETE FROM media_attachments
		WHERE id IN (SELECT value FROM json_each(?)) AND status_id IS NULL AND gc_at IS NOT NULL AND gc_at <= ?`,
		JSON.stringify(ids.slice(0, SWEEP_BATCH)),
		iso(now)
	)
)
