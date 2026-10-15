import type { Page, PageQuery } from './accounts'
import { type ApiVisibility, API_VISIBILITIES, availableSql, scheduledOwnSql } from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { allocateLocalId } from './ids'
import { DETACHED_GRACE_MS } from './media'
import { writeOperation } from './operation'
import { MEDIA_COLUMNS, type MediaAttachment, type MediaRow, presentMedia, type Status } from './status-presenter'
import {
	type CreateStatusInput,
	type CreateStatusResult,
	iso,
	isPrepared,
	ownStatusByKey,
	type PostInput,
	postNow,
	preparePost,
	statusCursor,
	writePost,
} from './statuses'
import type { Db } from '../db/sql'

// Scheduled statuses (Mastodon 4.5's ScheduledStatus, PostStatusService#schedule_status!,
// Api::V1::ScheduledStatusesController and PublishScheduledStatusWorker). A post sent with a future scheduled_at is
// checked as a post is, then kept with its parameters until it is due; the cron publishes it through the path of an
// ordinary post (statuses.ts, preparePost and writePost), in the transaction that deletes it, so it is published once.
// Until then it is its owner's alone (R25, scheduledOwnSql): only this module reads scheduled_statuses, every read is
// the owner's, and nothing of it is listed, notified or delivered. The uploads it will attach are held
// (media_attachments.scheduled_status_id): the sweep of unattached uploads leaves them and no other post attaches them.

// ScheduledStatus::TOTAL_LIMIT, DAILY_LIMIT and MINIMUM_OFFSET.
export const TOTAL_LIMIT = 300
export const DAILY_LIMIT = 25
export const MINIMUM_OFFSET_MS = 5 * 60 * 1000

// The bound of a stored params document (RES-1), as the schema checks it. What it holds is bounded before (the status
// text's raw bound, at most four media ids of 18 digits, a parent id, a language tag), far under it.
export const MAX_PARAMS_BYTES = 128 * 1024

// At most this many scheduled statuses are published per cron run (RES-6), each in its own transaction.
export const PUBLISH_ROUND = 25

// REST::ScheduledStatusSerializer's params: the post's options as PostStatusService#scheduled_options keeps them. Kopje
// has no polls, applications on statuses or quotes, so those are always null (and the quote policy nobody, as the
// serializer answers for none). Ids are strings.
export type ScheduledParams = {
	text: string
	poll: null
	media_ids: string[] | null
	sensitive: boolean | null
	spoiler_text: string
	visibility: ApiVisibility | null
	language: string | null
	scheduled_at: null
	in_reply_to_id: string | null
	application_id: null
	idempotency: null
	with_rate_limit: false
	allowed_mentions: null
	quoted_status_id: null
	quote_approval_policy: 'nobody'
}

// REST::ScheduledStatusSerializer.
export type ScheduledStatus = {
	id: string
	scheduled_at: string
	params: ScheduledParams
	media_attachments: MediaAttachment[]
}

type ScheduledRow = { id: string; scheduled_at: string; params: string }

const COLUMNS = 'ss.id, ss.scheduled_at, ss.params'

function presentScheduled(db: Db, row: ScheduledRow): ScheduledStatus {
	const media = db.all<MediaRow>(
		`SELECT ${MEDIA_COLUMNS} FROM media_attachments WHERE scheduled_status_id = ? ORDER BY position`,
		row.id
	)
	return {
		id: row.id,
		scheduled_at: row.scheduled_at,
		params: JSON.parse(row.params) as ScheduledParams,
		media_attachments: media.map(presentMedia),
	}
}

// The viewer's scheduled status `id`, if it is theirs.
function ownScheduled(db: Db, viewerId: string, id: string): ScheduledRow | undefined {
	return db.first<ScheduledRow>(
		`SELECT ${COLUMNS} FROM scheduled_statuses ss WHERE ss.id = ?1 AND ${scheduledOwnSql('ss', '?2')}`,
		id,
		viewerId
	)
}

// The params of a stored row, or null when they are not of the shape this module writes (a row restored from a dump
// is only checked by the schema).
function readParams(text: string): ScheduledParams | null {
	const p = JSON.parse(text) as Record<string, unknown>
	const optional = (value: unknown, type: string) => value === null || typeof value === type
	const valid =
		typeof p.text === 'string' &&
		typeof p.spoiler_text === 'string' &&
		optional(p.sensitive, 'boolean') &&
		optional(p.language, 'string') &&
		optional(p.in_reply_to_id, 'string') &&
		(p.visibility === null || API_VISIBILITIES.includes(p.visibility as ApiVisibility)) &&
		(p.media_ids === null || (Array.isArray(p.media_ids) && p.media_ids.every((id) => typeof id === 'string')))
	return valid ? (p as ScheduledParams) : null
}

function paramsOf(input: PostInput, media: readonly string[], inReplyToId: string | null): ScheduledParams {
	return {
		text: input.text,
		poll: null,
		media_ids: media.length === 0 ? null : [...media],
		sensitive: input.sensitive ?? null,
		spoiler_text: input.spoilerText,
		visibility: input.visibility ?? null,
		language: input.language ?? null,
		scheduled_at: null,
		in_reply_to_id: inReplyToId,
		application_id: null,
		idempotency: null,
		with_rate_limit: false,
		allowed_mentions: null,
		quoted_status_id: null,
		quote_approval_policy: 'nobody',
	}
}

// The post a scheduled status publishes, at the time it is published: the author's defaults (visibility, sensitive,
// language) apply then, as PostStatusService applies them when the worker runs.
function postOf(params: ScheduledParams, now: number): PostInput {
	return {
		text: params.text,
		visibility: params.visibility ?? undefined,
		spoilerText: params.spoiler_text,
		sensitive: params.sensitive ?? undefined,
		inReplyToId: params.in_reply_to_id ?? undefined,
		language: params.language ?? undefined,
		mediaIds: params.media_ids ?? [],
		now,
	}
}

const DAY_MS = 24 * 60 * 60 * 1000

// ScheduledStatus's validations, in Mastodon's order and with its messages: at least MINIMUM_OFFSET ahead, at most
// TOTAL_LIMIT in all and DAILY_LIMIT on the UTC day of `at` (scheduled_at::date). `except` is the scheduled status being
// moved, which does not count against itself. The counts read at most the limit's rows.
function scheduleErrors(db: Db, accountId: string, at: string, now: number, except: string | null): string[] {
	const errors: string[] = []
	if (Date.parse(at) <= now + MINIMUM_OFFSET_MS) {
		errors.push('Scheduled at date must be in the future')
	}
	const total =
		db.first<{ n: number }>(
			`SELECT count(*) AS n FROM (SELECT 1 FROM scheduled_statuses ss
				WHERE ${scheduledOwnSql('ss', '?1')} AND ss.id IS NOT ?2 LIMIT ?3)`,
			accountId,
			except,
			TOTAL_LIMIT
		)?.n ?? 0
	if (total >= TOTAL_LIMIT) {
		errors.push(`You have exceeded the limit of ${TOTAL_LIMIT} scheduled posts`)
	}
	const day = Date.parse(`${at.slice(0, 10)}T00:00:00.000Z`)
	const daily =
		db.first<{ n: number }>(
			`SELECT count(*) AS n FROM (SELECT 1 FROM scheduled_statuses ss
				WHERE ${scheduledOwnSql('ss', '?1')} AND ss.scheduled_at >= ?2 AND ss.scheduled_at < ?3 AND ss.id IS NOT ?4
				LIMIT ?5)`,
			accountId,
			iso(day),
			iso(day + DAY_MS),
			except,
			DAILY_LIMIT
		)?.n ?? 0
	if (daily >= DAILY_LIMIT) {
		errors.push(`You have exceeded the limit of ${DAILY_LIMIT} scheduled posts for today`)
	}
	return errors
}

function invalid(errors: string[]): { status: 'invalid'; error: string } {
	return { status: 'invalid', error: `Validation failed: ${errors.join(', ')}` }
}

// Detaches the uploads a scheduled status holds, attachable again for a day (as a deleted status's), and deletes it.
function removeScheduled(db: Db, id: string, now: number): void {
	db.run(
		`UPDATE media_attachments SET scheduled_status_id = NULL, position = 0, gc_at = ?2
		WHERE scheduled_status_id = ?1 AND status_id IS NULL`,
		id,
		iso(now + DETACHED_GRACE_MS)
	)
	db.run('DELETE FROM scheduled_statuses WHERE id = ?', id)
}

// The Store-side time of a scheduled_at the Worker parsed: an ISO 8601 UTC time with milliseconds.
function isTime(at: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) && !Number.isNaN(Date.parse(at))
}

export type ScheduleInput = CreateStatusInput & { scheduledAt: string }

export type ScheduleResult = CreateStatusResult | { status: 'scheduled'; value: ScheduledStatus }

// POST /api/v1/statuses with scheduled_at (PostStatusService): a repeated Idempotency-Key answers with what the first
// request made, a status or a scheduled status; a time not in the future posts at once; otherwise the post is checked
// as an immediate one (the status replied to, the media, a blank text), then against ScheduledStatus's validations,
// and kept with its media held.
export const scheduleStatus = userWriteOperation<ScheduleInput, ScheduleResult>((db, input, { accountId }) => {
	if (!isTime(input.scheduledAt)) {
		return { status: 'invalid', error: 'Record invalid' }
	}
	if (input.idempotencyKey !== undefined) {
		const status: Status | null = ownStatusByKey(db, accountId, input.idempotencyKey, input.present)
		if (status !== null) {
			return { status: 'ok', value: status }
		}
		const scheduled = db.first<ScheduledRow>(
			`SELECT ${COLUMNS} FROM scheduled_statuses ss WHERE ${scheduledOwnSql('ss', '?1')} AND ss.client_key = ?2`,
			accountId,
			input.idempotencyKey
		)
		if (scheduled !== undefined) {
			return { status: 'scheduled', value: presentScheduled(db, scheduled) }
		}
	}
	if (Date.parse(input.scheduledAt) <= input.now) {
		return postNow(db, accountId, input)
	}
	const prepared = preparePost(db, accountId, input, null)
	if (!isPrepared(prepared)) {
		return prepared
	}
	const errors = scheduleErrors(db, accountId, input.scheduledAt, input.now, null)
	if (errors.length > 0) {
		return invalid(errors)
	}
	const params = JSON.stringify(paramsOf(input, prepared.media, prepared.parent?.id ?? null))
	if (new TextEncoder().encode(params).length > MAX_PARAMS_BYTES) {
		return { status: 'invalid', error: 'Record invalid' }
	}
	const row = db.first<ScheduledRow>(
		`INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params, client_key, created_at)
		VALUES (?, ?, ?, ?, ?, ?) RETURNING id, scheduled_at, params`,
		allocateLocalId(db, input.now),
		accountId,
		input.scheduledAt,
		params,
		input.idempotencyKey ?? null,
		iso(input.now)
	)
	if (row === undefined) {
		throw new Error('the scheduled status was not written')
	}
	db.run(
		`UPDATE media_attachments SET scheduled_status_id = ?1, gc_at = NULL,
			position = (SELECT j.key FROM json_each(?2) j WHERE j.value = media_attachments.id)
		WHERE id IN (SELECT value FROM json_each(?2))`,
		row.id,
		JSON.stringify(prepared.media)
	)
	return { status: 'scheduled', value: presentScheduled(db, row) }
})

// The default and largest page of GET /api/v1/scheduled_statuses (DEFAULT_STATUSES_LIMIT, and limit_param's cap at
// twice it).
export const SCHEDULED_PAGE = { limit: 20, max: 40 }

// GET /api/v1/scheduled_statuses: the viewer's scheduled statuses by id, newest first, paged by id
// (to_a_paginated_by_id); a page from the account's own index, whoever else has scheduled statuses.
export const listScheduled = userReadOperation<{ page: PageQuery }, Page<ScheduledStatus>>(
	(db, { page }, { accountId }) => {
		const ascending = page.minId !== undefined
		const rows = db.all<ScheduledRow>(
			`SELECT ${COLUMNS} FROM scheduled_statuses ss
			WHERE ${scheduledOwnSql('ss', '?1')} AND (?2 IS NULL OR ss.id < ?2) AND (?3 IS NULL OR ss.id > ?3)
			ORDER BY ss.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			accountId,
			statusCursor(page.maxId),
			statusCursor(page.minId ?? page.sinceId),
			page.limit
		)
		if (ascending) {
			rows.reverse()
		}
		return {
			items: rows.map((row) => presentScheduled(db, row)),
			newest: rows[0]?.id ?? null,
			oldest: rows.at(-1)?.id ?? null,
		}
	}
)

// GET /api/v1/scheduled_statuses/:id: null when it is not the viewer's.
export const getScheduled = userReadOperation<{ id: string }, ScheduledStatus | null>((db, { id }, { accountId }) => {
	const row = ownScheduled(db, accountId, id)
	return row === undefined ? null : presentScheduled(db, row)
})

export type UpdateScheduledResult =
	{ status: 'ok'; value: ScheduledStatus } | { status: 'not_found' } | { status: 'invalid'; error: string }

// PUT and PATCH /api/v1/scheduled_statuses/:id (update!(scheduled_at)): only the time changes, and the validations
// run again for the new time (or the current one when none is sent). null: a time the Worker could not read.
export const updateScheduled = userWriteOperation<
	{ id: string; scheduledAt: string | null | undefined; now: number },
	UpdateScheduledResult
>((db, input, { accountId }) => {
	const row = ownScheduled(db, accountId, input.id)
	if (row === undefined) {
		return { status: 'not_found' }
	}
	const at = input.scheduledAt === undefined ? row.scheduled_at : input.scheduledAt
	if (at === null || !isTime(at)) {
		return { status: 'invalid', error: 'Record invalid' }
	}
	const errors = scheduleErrors(db, accountId, at, input.now, row.id)
	if (errors.length > 0) {
		return invalid(errors)
	}
	db.run('UPDATE scheduled_statuses SET scheduled_at = ? WHERE id = ?', at, row.id)
	return { status: 'ok', value: presentScheduled(db, { ...row, scheduled_at: at }) }
})

// DELETE /api/v1/scheduled_statuses/:id: its uploads are detached (attachable again for a day), as Mastodon nullifies
// them. Whether it was the viewer's.
export const deleteScheduled = userWriteOperation<{ id: string; now: number }, boolean>((db, input, { accountId }) => {
	const row = ownScheduled(db, accountId, input.id)
	if (row === undefined) {
		return false
	}
	removeScheduled(db, row.id, input.now)
	return true
})

// ---- Publication (the cron, jobs/scheduled.ts).

// The ids of up to `limit` scheduled statuses due at `now`, the earliest first, through the index by time. Declared a
// write, as the start of the round that publishes them: the Store refuses it in maintenance and readonly, so a round
// then publishes nothing and what is due waits.
export const dueScheduled = writeOperation<{ now: number; limit: number }, string[]>((db, { now, limit }) =>
	db
		.all<{ id: string }>(
			'SELECT id FROM scheduled_statuses WHERE scheduled_at <= ? ORDER BY scheduled_at, id LIMIT ?',
			iso(now),
			Math.min(limit, PUBLISH_ROUND)
		)
		.map((row) => row.id)
)

export type Publication =
	| { status: 'gone' }
	| { status: 'published'; statusId: string }
	| { status: 'dropped'; reason: 'unavailable' | 'params' | 'reply_not_found' | 'invalid' }

// Publishes the scheduled status `id` if it is still due: deletes it and, in the same transaction, posts it through
// the path of an immediate post (preparePost, writePost), with its held media, so it is published once however many
// runs or retries reach it. As PublishScheduledStatusWorker, a post that no longer passes (the status replied to is
// gone or hidden, its text is blank without media, its account is suspended) is dropped: deleted without a status,
// its media detached. The status is created at the time of publication (PostStatusService does not take the scheduled
// time), and its Idempotency-Key carries over, so a client repeating the request is answered with it.
export const publishScheduled = writeOperation<{ id: string; now: number; objectId: string }, Publication>(
	(db, { id, now, objectId }) => {
		const row = db.first<{ account_id: string; params: string; client_key: string | null; available: number }>(
			`SELECT ss.account_id, ss.params, ss.client_key, ${availableSql('ss.account_id')} AS available
			FROM scheduled_statuses ss WHERE ss.id = ?1 AND ss.scheduled_at <= ?2`,
			id,
			iso(now)
		)
		if (row === undefined) {
			return { status: 'gone' }
		}
		const publication = publish(db, id, row, now, objectId)
		removeScheduled(db, id, now)
		return publication
	}
)

function publish(
	db: Db,
	id: string,
	row: { account_id: string; params: string; client_key: string | null; available: number },
	now: number,
	objectId: string
): Publication {
	if (row.available !== 1) {
		return { status: 'dropped', reason: 'unavailable' }
	}
	const params = readParams(row.params)
	if (params === null) {
		return { status: 'dropped', reason: 'params' }
	}
	const input = postOf(params, now)
	const prepared = preparePost(db, row.account_id, input, id)
	if (!isPrepared(prepared)) {
		return { status: 'dropped', reason: prepared.status }
	}
	// The key is unique per account among statuses; one already taken is left off rather than refuse the post.
	const keyTaken =
		row.client_key !== null &&
		db.first(
			'SELECT 1 AS taken FROM statuses WHERE account_id = ? AND client_key = ?',
			row.account_id,
			row.client_key
		) !== undefined
	const statusId = writePost(
		db,
		row.account_id,
		{
			...input,
			idempotencyKey: row.client_key === null || keyTaken ? undefined : row.client_key,
			objectId,
			origin: new URL(prepared.author.uri).origin,
		},
		prepared
	)
	return { status: 'published', statusId }
}
