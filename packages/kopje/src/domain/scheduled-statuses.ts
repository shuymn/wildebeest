import type { Page, PageQuery } from './accounts'
import {
	type ApiVisibility,
	API_VISIBILITIES,
	availableSql,
	QUOTE_POLICY_NAMES,
	type QuotePolicyName,
	scheduledOwnSql,
} from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { allocateLocalId } from './ids'
import { DETACHED_GRACE_MS } from './media'
import { writeOperation } from './operation'
import { checkPoll, isPollInput, type PollInput } from './polls'
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
// Until then it is its owner's alone (R26, scheduledOwnSql): only this module reads scheduled_statuses, every read is
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
// has no applications on statuses and cannot author quotes, so those are always null. The quote policy is the one the
// request chose, or the author's default when it chose none, resolved when the post is scheduled (as Mastodon's
// controller resolves it), by name as the serializer shows it. Ids are strings, and so is a poll's expires_in, as a
// form sends it.
export type ScheduledParams = {
	text: string
	poll: ScheduledPoll | null
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
	quote_approval_policy: QuotePolicyName
}

export type ScheduledPoll = { options: string[]; expires_in: string; multiple: boolean; hide_totals: boolean }

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

// The params of a stored row, or null when not of the shape this module writes (a restored row has only schema
// validation). A row without a quote policy has nobody, the policy such rows were scheduled with.
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
		(p.media_ids === null || (Array.isArray(p.media_ids) && p.media_ids.every((id) => typeof id === 'string'))) &&
		(p.poll === null || p.poll === undefined || isScheduledPoll(p.poll)) &&
		(p.quote_approval_policy === undefined || QUOTE_POLICY_NAMES.includes(p.quote_approval_policy as QuotePolicyName))
	return valid
		? ({ ...p, poll: p.poll ?? null, quote_approval_policy: p.quote_approval_policy ?? 'nobody' } as ScheduledParams)
		: null
}

function isScheduledPoll(value: unknown): value is ScheduledPoll {
	const poll = value as Record<string, unknown>
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray(poll.options) &&
		poll.options.every((option) => typeof option === 'string') &&
		typeof poll.expires_in === 'string' &&
		typeof poll.multiple === 'boolean' &&
		typeof poll.hide_totals === 'boolean'
	)
}

function pollParams(poll: PollInput | undefined): ScheduledPoll | null {
	return poll === undefined
		? null
		: {
				options: poll.options,
				expires_in: String(poll.expiresIn),
				multiple: poll.multiple,
				hide_totals: poll.hideTotals,
			}
}

function paramsOf(
	input: PostInput,
	media: readonly string[],
	inReplyToId: string | null,
	quotePolicy: QuotePolicyName
): ScheduledParams {
	return {
		text: input.text,
		poll: pollParams(input.poll),
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
		quote_approval_policy: quotePolicy,
	}
}

// The post a scheduled status publishes, at the time it is published: the author's defaults (visibility, sensitive,
// language) apply then, as PostStatusService applies them when the worker runs, and a poll is checked again and ends
// its duration after the publication. The quote policy was resolved when it was scheduled; a status published private
// or direct gets nobody (storedQuotePolicy). null: a poll that no longer passes.
function postOf(params: ScheduledParams, now: number): PostInput | null {
	const poll =
		params.poll === null
			? undefined
			: checkPoll({
					options: params.poll.options,
					expiresIn: params.poll.expires_in,
					multiple: params.poll.multiple,
					hideTotals: params.poll.hide_totals,
				})
	if (poll !== undefined && !isPollInput(poll)) {
		return null
	}
	return {
		...(poll === undefined ? {} : { poll }),
		text: params.text,
		visibility: params.visibility ?? undefined,
		spoilerText: params.spoiler_text,
		sensitive: params.sensitive ?? undefined,
		inReplyToId: params.in_reply_to_id ?? undefined,
		language: params.language ?? undefined,
		mediaIds: params.media_ids ?? [],
		quotePolicy: params.quote_approval_policy,
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

export type ScheduleInput = CreateStatusInput & { scheduledAt?: string }

export type ScheduleResult = CreateStatusResult | { status: 'scheduled'; value: ScheduledStatus }

// POST /api/v1/statuses (PostStatusService), with or without scheduled_at. An Idempotency-Key is resolved first,
// against the account's statuses and its scheduled statuses alike, whether this request schedules or not: a repeat
// answers with what the first request made, a Status or a ScheduledStatus, and makes nothing (so a key that reserved
// a scheduled status is never posted twice, once now and once when it is published). Then no scheduled_at, or a time
// not in the future, posts at once; otherwise the post is checked as an immediate one (the status replied to, the
// media, a blank text), then against ScheduledStatus's validations, and kept with its media held.
export const postStatus = userWriteOperation<ScheduleInput, ScheduleResult>((db, input, { accountId }, viewer) => {
	if (input.scheduledAt !== undefined && !isTime(input.scheduledAt)) {
		return { status: 'invalid', error: 'Record invalid' }
	}
	if (input.idempotencyKey !== undefined) {
		const status: Status | null = ownStatusByKey(db, viewer, input.idempotencyKey, input.present)
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
	if (input.scheduledAt === undefined || Date.parse(input.scheduledAt) <= input.now) {
		return postNow(db, viewer, input)
	}
	const scheduledAt = input.scheduledAt
	const prepared = preparePost(db, accountId, input, null)
	if (!isPrepared(prepared)) {
		return prepared
	}
	const errors = scheduleErrors(db, accountId, scheduledAt, input.now, null)
	if (errors.length > 0) {
		return invalid(errors)
	}
	const params = JSON.stringify(
		paramsOf(
			input,
			prepared.media,
			prepared.parent?.id ?? null,
			input.quotePolicy ?? prepared.author.default_quote_policy
		)
	)
	if (new TextEncoder().encode(params).length > MAX_PARAMS_BYTES) {
		return { status: 'invalid', error: 'Record invalid' }
	}
	const row = db.first<ScheduledRow>(
		`INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params, client_key, created_at)
		VALUES (?, ?, ?, ?, ?, ?) RETURNING id, scheduled_at, params`,
		allocateLocalId(db, input.now),
		accountId,
		scheduledAt,
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
	// A new time is a new schedule: failed attempts at the old one no longer count.
	db.run(
		'UPDATE scheduled_statuses SET scheduled_at = ?, attempts = 0, next_attempt_at = NULL WHERE id = ?',
		at,
		row.id
	)
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

// Publication attempts that fail with an error, not a refusal of the post (which drops it at once): retried after
// RETRY_DELAYS_MS (one per failure before the last), then dropped after MAX_ATTEMPTS, its media detached.
export const MAX_ATTEMPTS = 5
export const RETRY_DELAYS_MS = [5, 15, 60, 240].map((minutes) => minutes * 60 * 1000)

// The ids of up to `limit` scheduled statuses due at `now`: those never attempted first, by scheduled time, then those
// to retry, by their next attempt, each through its partial index, so a run publishes what is newly due however many
// keep failing. Declared a write, as the start of the round that publishes them: the Store refuses it in maintenance
// and readonly, so a round then publishes nothing and what is due waits.
export const dueScheduled = writeOperation<{ now: number; limit: number }, string[]>((db, { now, limit }) => {
	const cap = Math.min(limit, PUBLISH_ROUND)
	const fresh = db
		.all<{ id: string }>(
			'SELECT id FROM scheduled_statuses WHERE attempts = 0 AND scheduled_at <= ? ORDER BY scheduled_at, id LIMIT ?',
			iso(now),
			cap
		)
		.map((row) => row.id)
	const retries =
		fresh.length >= cap
			? []
			: db
					.all<{ id: string }>(
						`SELECT id FROM scheduled_statuses WHERE attempts > 0 AND next_attempt_at <= ?
						ORDER BY next_attempt_at, id LIMIT ?`,
						iso(now),
						cap - fresh.length
					)
					.map((row) => row.id)
	return [...fresh, ...retries]
})

export type Failure = { status: 'gone' } | { status: 'retry'; attempts: number } | { status: 'dropped' }

// Records a publication of `id` that failed with an error, in its own transaction after the failed one rolled back:
// one more attempt, and the next after its delay, or, at MAX_ATTEMPTS, the scheduled status dropped and its media
// detached (attachable again for a day).
export const recordPublishFailure = writeOperation<{ id: string; now: number }, Failure>((db, { id, now }) => {
	const row = db.first<{ attempts: number }>('SELECT attempts FROM scheduled_statuses WHERE id = ?', id)
	if (row === undefined) {
		return { status: 'gone' }
	}
	const attempts = row.attempts + 1
	const delay = RETRY_DELAYS_MS[attempts - 1]
	if (attempts >= MAX_ATTEMPTS || delay === undefined) {
		removeScheduled(db, id, now)
		return { status: 'dropped' }
	}
	db.run('UPDATE scheduled_statuses SET attempts = ?, next_attempt_at = ? WHERE id = ?', attempts, iso(now + delay), id)
	return { status: 'retry', attempts }
})

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
			FROM scheduled_statuses ss WHERE ss.id = ?1
				AND (ss.attempts = 0 AND ss.scheduled_at <= ?2 OR ss.attempts > 0 AND ss.next_attempt_at <= ?2)`,
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
	if (input === null) {
		return { status: 'dropped', reason: 'invalid' }
	}
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
