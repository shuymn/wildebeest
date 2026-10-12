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

// A reservation that never completes (the Worker failed mid-upload) is swept after an hour.
const RESERVATION_MS = HOUR

// Mastodon's rate limit for media uploads: 30 per 30 minutes per account (RES-6).
export const UPLOAD_BUDGET = { count: 30, windowMs: 30 * 60 * 1000 }

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

export type Reserved = { status: 'ok'; id: string } | { status: 'rate_limited' }

// Step 1. `token` is the file token the Worker generated (32 random bytes).
export const reserveMedia = userWriteOperation<{ token: string; now: number }, Reserved>(
	(db, { token, now }, { accountId }) => {
		const recent =
			db.first<{ n: number }>(
				'SELECT COUNT(*) AS n FROM media_attachments WHERE account_id = ? AND created_at > ?',
				accountId,
				iso(now - UPLOAD_BUDGET.windowMs)
			)?.n ?? 0
		if (recent >= UPLOAD_BUDGET.count) {
			return { status: 'rate_limited' }
		}
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
		return { status: 'ok', id }
	}
)

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
// row's own token. Null when the reservation is gone (swept, or its grace ran out): the Worker then deletes what it
// wrote to R2.
export const completeMedia = userWriteOperation<CompleteMediaInput, MediaAttachment | null>(
	(db, input, { accountId }) => {
		const pending = db.first<{ token: string; uri: string }>(
			`SELECT m.file_token AS token, a.uri FROM media_attachments m JOIN accounts a ON a.id = m.account_id
			WHERE m.id = ? AND m.account_id = ? AND m.processed = 0 AND m.gc_at > ? AND m.file_token IS NOT NULL`,
			input.id,
			accountId,
			iso(input.now)
		)
		if (pending === undefined) {
			return null
		}
		const origin = new URL(pending.uri).origin
		db.run(
			`UPDATE media_attachments SET url = ?, preview_url = ?, content_type = ?, meta = ?, description = ?,
				focus_x = ?, focus_y = ?, processed = 1, gc_at = ?
			WHERE id = ?`,
			`${origin}${mediaPath(pending.token, 'full', input.contentType)}`,
			`${origin}${mediaPath(pending.token, 'small', input.contentType)}`,
			input.contentType,
			JSON.stringify({ original: input.original, small: input.small }),
			input.description,
			input.focus.x,
			input.focus.y,
			iso(input.now + DETACHED_GRACE_MS),
			input.id
		)
		const row = ownUpload(db, accountId, input.id, input.now)
		return row === undefined ? null : presentMedia(row)
	}
)

// A failed upload: doomed at once, swept with whatever reached R2.
export const abandonMedia = userWriteOperation<{ id: string; now: number }, void>((db, { id, now }, { accountId }) => {
	db.run(
		'UPDATE media_attachments SET gc_at = ? WHERE id = ? AND account_id = ? AND processed = 0',
		iso(now),
		id,
		accountId
	)
})

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
