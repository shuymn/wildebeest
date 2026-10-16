import { type Account, edgeRangeSql, type Page, type PageQuery, type Present, presentAccountsById } from './accounts'
import {
	availableSql,
	notifiedSql,
	POLICY_DEFAULTS,
	type PolicyChoice,
	type PolicyColumn,
	shownSql,
	statusReads,
} from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { addToConversation } from './conversations'
import { MAX_MEANINGFUL_COUNT } from './notifications'
import { writeOperation } from './operation'
import { presentStatuses, type Status } from './status-presenter'
import type { Db } from '../db/sql'

// Notification policies and requests (Mastodon 4.5's NotificationPolicy, NotificationRequest and
// NotificationPermission; Api::V1 and Api::V2::Notifications::PoliciesController, Api::V1::Notifications::
// RequestsController). notify (notifications.ts) applies the policy as it writes a notification
// (notificationPolicySql in audience.ts, R15): it drops what a condition chooses to drop, and writes what one chooses
// to filter with `filtered` set, opening the sender's request for a mention. The lists, counts and pushes leave
// filtered notifications out unless asked (include_filtered, account_id).
//
// Accepting a request (AcceptNotificationRequestService) records a permission for the sender, so nothing of theirs is
// filtered or dropped again, and unfilters the sender's filtered notifications, adding the direct mentions among them
// to the recipient's conversations (UnfilterNotificationsWorker). Dismissing one (DismissNotificationRequestService)
// deletes the sender's filtered notifications (FilteredNotificationCleanupWorker). Mastodon does both in a worker; so
// does Kopje, bounded (RES-6, RES-7): a job walks the sender's notifications by id, newest first, REQUEST_JOB_WINDOW
// at a time, from the newest one when the request was answered. The first batches run in the request and
// runNotificationRequestJobs runs the rest with the inbound jobs (store.ts), as the domain block cleanups are run.
// `merged` answers whether an accepted request's notifications are all unfiltered, as Mastodon's counter of pending
// UnfilterNotificationsWorker jobs does.

// The sender's notifications one job batch walks, and the batches one request or one round runs at most.
export const REQUEST_JOB_WINDOW = 500
export const REQUEST_JOB_BATCHES = 4

// Api::V1::Notifications::RequestsController's accept_bulk and dismiss_bulk take any number of ids; Kopje takes at
// most this many, so the request's writes are bounded.
export const MAX_BULK_REQUESTS = 100

const REQUEST_ID = /^\d{1,19}$/

export type Policy = Record<PolicyColumn, PolicyChoice>

// NotificationPolicy#summarize!: the pending requests from available senders and their notifications.
export type PolicySummary = { pending_requests_count: number; pending_notifications_count: number }

export type PolicyView = { policy: Policy; summary: PolicySummary }

function policyOf(db: Db, accountId: string): Policy {
	const row = db.first<Policy>(
		`SELECT for_not_following, for_not_followers, for_new_accounts, for_private_mentions, for_limited_accounts
		FROM notification_policies WHERE account_id = ?`,
		accountId
	)
	return row ?? { ...POLICY_DEFAULTS }
}

// NotificationPolicy#pending_notification_requests: the count of the recipient's requests from available senders
// (NotificationRequest.without_suspended) and the sum of their counts, over at most MAX_MEANINGFUL_COUNT requests.
// Mastodon names that limit, but `limit(100).pick(...)` replaces it with pick's LIMIT 1, so its query counts every
// request; Kopje reads at most 100 (RES-7).
function summaryOf(db: Db, accountId: string): PolicySummary {
	const row = db.first<{ requests: number; notifications: number }>(
		`SELECT count(*) AS requests, coalesce(sum(c), 0) AS notifications FROM (
			SELECT r.notifications_count AS c FROM notification_requests r
			WHERE r.account_id = ?1 AND ${availableSql('r.from_account_id')}
			ORDER BY r.id DESC LIMIT ?2)`,
		accountId,
		MAX_MEANINGFUL_COUNT
	)
	return { pending_requests_count: row?.requests ?? 0, pending_notifications_count: row?.notifications ?? 0 }
}

// GET /api/v1/notifications/policy and /api/v2/notifications/policy (NotificationPolicy.find_or_initialize_by and
// summarize!): the policy, the defaults without a row.
export const getNotificationPolicy = userReadOperation<object, PolicyView>((db, _input, { accountId }) => ({
	policy: policyOf(db, accountId),
	summary: summaryOf(db, accountId),
}))

// PATCH and PUT of the policy (NotificationPolicy#update!): the choices sent, the others kept.
export const updateNotificationPolicy = userWriteOperation<{ changes: Partial<Policy>; now: number }, PolicyView>(
	(db, { changes, now }, { accountId }) => {
		const policy = { ...policyOf(db, accountId), ...changes }
		const at = new Date(now).toISOString()
		db.run(
			`INSERT INTO notification_policies (account_id, for_not_following, for_not_followers, for_new_accounts,
				for_private_mentions, for_limited_accounts, created_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
			ON CONFLICT (account_id) DO UPDATE SET for_not_following = excluded.for_not_following,
				for_not_followers = excluded.for_not_followers, for_new_accounts = excluded.for_new_accounts,
				for_private_mentions = excluded.for_private_mentions, for_limited_accounts = excluded.for_limited_accounts,
				updated_at = excluded.updated_at`,
			accountId,
			policy.for_not_following,
			policy.for_not_followers,
			policy.for_new_accounts,
			policy.for_private_mentions,
			policy.for_limited_accounts,
			at
		)
		return { policy, summary: summaryOf(db, accountId) }
	}
)

// REST::NotificationRequestSerializer: the id and the count as strings, the sender as `account`, and the last status
// (null when it is gone, or when the notification rule no longer shows its mention to the viewer). A block deletes the
// pair's request (AfterBlockService#clear_notification_requests!, blocks.ts).
export type NotificationRequest = {
	id: string
	created_at: string
	updated_at: string
	notifications_count: string
	account: Account
	last_status: Status | null
}

type RequestRow = {
	id: string
	from_account_id: string
	last_status_id: string | null
	notifications_count: number
	created_at: string
	updated_at: string
}

const REQUEST_COLUMNS = `CAST(r.id AS TEXT) AS id, r.from_account_id, r.last_status_id, r.notifications_count,
	r.created_at, r.updated_at`

function presentRequests(
	db: Db,
	viewer: { accountId: string; now: string },
	rows: RequestRow[],
	present: Present
): NotificationRequest[] {
	const accounts = presentAccountsById(
		db,
		rows.map((row) => row.from_account_id),
		present
	)
	// The last status of each request whose mention the notification rule still shows the viewer (R15 at the time of
	// the read, which includes R2): not after the viewer blocks or mutes its sender, or one it mentions.
	const visible = statusReads(viewer, { viewer: '?1', now: '?3' }).select(
		db,
		'visible',
		{
			from: 'main.notification_requests r JOIN',
			join: 'ON s.id = r.last_status_id',
			where: 'r.account_id = ?1 AND r.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?2))',
			// The request's own column, not `s.id`: shownSql names its own `statuses s`, inside which `s.id` would be that
			// status and not this one.
			and: shownSql('?1', "'mention'", 'r.from_account_id', 'r.last_status_id', '?3'),
		},
		viewer.accountId,
		JSON.stringify(rows.map((row) => row.id)),
		viewer.now
	)
	const statuses = new Map(
		presentStatuses(
			db,
			visible.map((row) => row.id),
			{ ...present, viewer }
		).map((status) => [status.id, status])
	)
	return rows.flatMap((row) => {
		const account = accounts.get(row.from_account_id)
		if (account === undefined) {
			return []
		}
		return [
			{
				id: row.id,
				created_at: row.created_at,
				updated_at: row.updated_at,
				notifications_count: String(row.notifications_count),
				account,
				last_status: row.last_status_id === null ? null : (statuses.get(row.last_status_id) ?? null),
			},
		]
	})
}

// GET /api/v1/notifications/requests: the viewer's requests from available senders (without_suspended), newest
// first, paged by id (to_a_paginated_by_id; min_id reads up from it).
export const listNotificationRequests = userReadOperation<
	{ page: PageQuery; present: Present },
	Page<NotificationRequest>
>((db, { page, present }, _viewer, viewer) => {
	const ascending = page.minId !== undefined
	const rows = db.all<RequestRow>(
		`SELECT ${REQUEST_COLUMNS} FROM notification_requests r
		WHERE r.account_id = ?1 AND ${edgeRangeSql('r.id', '?2', '?3')} AND ${availableSql('r.from_account_id')}
		ORDER BY r.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
		viewer.accountId,
		page.maxId ?? null,
		page.minId ?? page.sinceId ?? null,
		page.limit
	)
	if (ascending) {
		rows.reverse()
	}
	return {
		items: presentRequests(db, viewer, rows, present),
		newest: rows[0]?.id ?? null,
		oldest: rows.at(-1)?.id ?? null,
	}
})

// GET /api/v1/notifications/requests/:id: one of the viewer's requests, whoever its sender (Mastodon's find has no
// without_suspended); anyone else's is not found.
export const getNotificationRequest = userReadOperation<{ id: string; present: Present }, NotificationRequest | null>(
	(db, { id, present }, _viewer, viewer) => {
		if (!REQUEST_ID.test(id)) {
			return null
		}
		const row = db.first<RequestRow>(
			`SELECT ${REQUEST_COLUMNS} FROM notification_requests r WHERE r.account_id = ?1 AND r.id = CAST(?2 AS INTEGER)`,
			viewer.accountId,
			id
		)
		return row === undefined ? null : (presentRequests(db, viewer, [row], present)[0] ?? null)
	}
)

type Job = { id: number; account_id: string; from_account_id: string; kind: 'accept' | 'dismiss'; cursor: number }

// One batch of a job: the next REQUEST_JOB_WINDOW of the sender's notifications by id, newest first (whoever they
// notify, so the rows read are bounded however few are the recipient's), of which the recipient's filtered ones are
// unfiltered (accept: the direct mentions among them join the recipient's conversations first, as
// UnfilterNotificationsWorker#push_to_conversations! adds them) or deleted (dismiss). An accept unfilters only what
// the notification rule would let notify write now (notifiedSql, R15 at `now`): a batch that runs after the recipient
// blocked or muted the sender, or muted a conversation, leaves those notifications filtered and adds none of them to a
// conversation, so a later batch never brings back what a block cleared. The job is done when the walk reaches the
// sender's first notification.
function jobBatch(db: Db, job: Job, now: string): void {
	const window = db.first<{ low: number | null; walked: number }>(
		`SELECT min(id) AS low, count(*) AS walked FROM (
			SELECT id FROM notifications WHERE from_account_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3)`,
		job.from_account_id,
		job.cursor,
		REQUEST_JOB_WINDOW
	)
	const low = window?.low ?? null
	if (low !== null) {
		const range = 'from_account_id = ?1 AND id >= ?2 AND id < ?3 AND account_id = ?4 AND filtered = 1'
		const params = [job.from_account_id, low, job.cursor, job.account_id] as const
		if (job.kind === 'accept') {
			const shown = db.all<{ id: number; type: string; status_id: string | null }>(
				`SELECT n.id, n.type, n.status_id FROM notifications n
				WHERE n.from_account_id = ?1 AND n.id >= ?2 AND n.id < ?3 AND n.account_id = ?4 AND n.filtered = 1
					AND ${notifiedSql('?4', 'n.type', 'n.from_account_id', 'n.status_id', '?5')}
				ORDER BY n.id DESC`,
				...params,
				now
			)
			for (const { type, status_id } of shown) {
				if (type === 'mention' && status_id !== null) {
					addToConversation(db, job.account_id, status_id)
				}
			}
			db.run(
				'UPDATE notifications SET filtered = 0 WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))',
				JSON.stringify(shown.map((row) => row.id))
			)
		} else {
			db.run(`DELETE FROM notifications WHERE ${range}`, ...params)
		}
	}
	if (low === null || (window?.walked ?? 0) < REQUEST_JOB_WINDOW) {
		db.run('DELETE FROM notification_request_jobs WHERE id = ?', job.id)
	} else {
		db.run('UPDATE notification_request_jobs SET cursor = ? WHERE id = ?', low, job.id)
	}
}

const JOB_COLUMNS = 'id, account_id, from_account_id, kind, cursor'

// Runs at most `batches` batches of the jobs `ids` (or of any job, oldest first, when null), judged at `now`.
function runJobs(db: Db, ids: readonly number[] | null, batches: number, now: string): void {
	for (let batch = 0; batch < batches; batch++) {
		const job =
			ids === null
				? db.first<Job>(`SELECT ${JOB_COLUMNS} FROM notification_request_jobs ORDER BY id LIMIT 1`)
				: db.first<Job>(
						`SELECT ${JOB_COLUMNS} FROM notification_request_jobs
						WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1`,
						JSON.stringify(ids)
					)
		if (job === undefined) {
			return
		}
		jobBatch(db, job, now)
	}
}

// Records the job of an answered request, from the newest notification stored on down (read by the primary key, one
// row). Returns its id, or null when no notification is stored at all. A recipient and sender have one job at most:
// the latest answer replaces a job an earlier one left, and applies to all of the pair's filtered notifications that
// remain, so the outcome does not depend on the order the rounds would run two jobs in.
function startJob(db: Db, kind: Job['kind'], accountId: string, fromId: string, now: string): number | null {
	db.run('DELETE FROM notification_request_jobs WHERE account_id = ? AND from_account_id = ?', accountId, fromId)
	return (
		db.first<{ id: number }>(
			`INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor, created_at)
			SELECT ?1, ?2, ?3, n.id + 1, ?4 FROM (SELECT id FROM notifications ORDER BY id DESC LIMIT 1) n RETURNING id`,
			accountId,
			fromId,
			kind,
			now
		)?.id ?? null
	)
}

type Answered = { from_account_id: string }

// The viewer's requests among `ids`, deleted.
function takeRequests(db: Db, accountId: string, ids: readonly string[]): Answered[] {
	return db.all<Answered>(
		`DELETE FROM notification_requests WHERE account_id = ?1
			AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?2)) RETURNING from_account_id`,
		accountId,
		JSON.stringify(ids.filter((id) => REQUEST_ID.test(id)))
	)
}

// AcceptNotificationRequestService#call for each request: a permission for its sender, its job, and the request gone;
// then the first batches of the jobs.
function accept(db: Db, accountId: string, requests: readonly Answered[], now: string): void {
	const jobs: number[] = []
	for (const { from_account_id } of requests) {
		db.run(
			`INSERT INTO notification_permissions (account_id, from_account_id, created_at) VALUES (?, ?, ?)
			ON CONFLICT DO NOTHING`,
			accountId,
			from_account_id,
			now
		)
		const job = startJob(db, 'accept', accountId, from_account_id, now)
		if (job !== null) {
			jobs.push(job)
		}
	}
	runJobs(db, jobs, REQUEST_JOB_BATCHES, now)
}

// POST /api/v1/notifications/requests/:id/accept. Returns whether the request was the viewer's.
export const acceptNotificationRequest = userWriteOperation<{ id: string; now: number }, boolean>(
	(db, { id, now }, { accountId }) => {
		const requests = takeRequests(db, accountId, [id])
		accept(db, accountId, requests, new Date(now).toISOString())
		return requests.length > 0
	}
)

// POST /api/v1/notifications/requests/:id/dismiss (DismissNotificationRequestService#call): the request gone, and its
// sender's filtered notifications deleted by a job. Returns whether the request was the viewer's.
export const dismissNotificationRequest = userWriteOperation<{ id: string; now: number }, boolean>(
	(db, { id, now }, { accountId }) => {
		const requests = takeRequests(db, accountId, [id])
		const jobs = requests.flatMap(({ from_account_id }) => {
			const job = startJob(db, 'dismiss', accountId, from_account_id, new Date(now).toISOString())
			return job === null ? [] : [job]
		})
		runJobs(db, jobs, REQUEST_JOB_BATCHES, new Date(now).toISOString())
		return requests.length > 0
	}
)

// POST /api/v1/notifications/requests/accept (accept_bulk): each of the viewer's requests among `ids` accepted; ids
// that name none are ignored.
export const acceptNotificationRequests = userWriteOperation<{ ids: string[]; now: number }, null>(
	(db, { ids, now }, { accountId }) => {
		accept(db, accountId, takeRequests(db, accountId, ids), new Date(now).toISOString())
		return null
	}
)

// POST /api/v1/notifications/requests/dismiss (dismiss_bulk): each of the viewer's requests among `ids` deleted.
// Mastodon's dismiss_bulk destroys the requests alone (`@requests.each(&:destroy!)`,
// app/controllers/api/v1/notifications/requests_controller.rb:47-49), without DismissNotificationRequestService, so
// the senders' filtered notifications stay, shown with include_filtered; Kopje does the same.
export const dismissNotificationRequests = userWriteOperation<{ ids: string[] }, null>((db, { ids }, { accountId }) => {
	takeRequests(db, accountId, ids)
	return null
})

// GET /api/v1/notifications/requests/merged: whether every request the viewer accepted has had its notifications
// unfiltered (no accept job left).
export const notificationRequestsMerged = userReadOperation<object, { merged: boolean }>(
	(db, _input, { accountId }) => ({
		merged:
			db.first(
				"SELECT 1 AS x FROM notification_request_jobs WHERE account_id = ? AND kind = 'accept' LIMIT 1",
				accountId
			) === undefined,
	})
)

// A round of the jobs, oldest first, at most REQUEST_JOB_BATCHES batches (the Queue and the cron run it with the
// inbound jobs, store.ts). pending: a job has batches left.
export const runNotificationRequestJobs = writeOperation<{ now: number }, { pending: boolean; delivers: boolean }>(
	(db, { now }) => {
		runJobs(db, null, REQUEST_JOB_BATCHES, new Date(now).toISOString())
		return {
			pending: db.first('SELECT 1 AS x FROM notification_request_jobs LIMIT 1') !== undefined,
			delivers: false,
		}
	}
)
