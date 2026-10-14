import { type Account, type Page, type PageQuery, type Present, presentAccountsById } from './accounts'
import { domainBlockMatchSql, viewableSql, visibleSql } from './audience'
import { userReadOperation, userWriteOperation } from './auth'
import { presentStatuses, type Status } from './status-presenter'
import type { Db } from '../db/sql'

// Notifications of local users (Mastodon 4.0.2 v1). They are written by the operation that causes them, in its
// transaction, and read in pages in the Store. One rule decides both whether a notification is written and whether
// it is shown: the recipient is local and not its sender, the sender is not suspended, blocked, muted with
// notifications, or domain-blocked by the recipient, and the recipient may see the status (audience rule). A new
// notification also records a push for each of the recipient's Web Push subscriptions that wants it; domain/push.ts
// checks this rule again before each is sent (PUSH-3).

export type NotificationType = 'mention' | 'status' | 'reblog' | 'favourite' | 'follow' | 'follow_request' | 'update'

export type Notification = {
	id: string
	type: string
	created_at: string
	account: Account
	status?: Status
}

// Whether the recipient `r` is shown a notification of `type` from `from` about `status` (SQL expressions or
// parameters). A reblog notification names the original; the boost itself (the sender's one boost of it) must be
// visible to the recipient too, so a followers-only or direct boost is not revealed to an author outside its audience.
export function shownSql(r: string, type: string, from: string, status: string): string {
	return `(${from} <> ${r}
		AND NOT EXISTS (SELECT 1 FROM local_accounts ns WHERE ns.account_id = ${from} AND ns.suspended_at IS NOT NULL)
		AND NOT EXISTS (SELECT 1 FROM blocks nb WHERE nb.account_id = ${r} AND nb.target_account_id = ${from})
		AND NOT EXISTS (SELECT 1 FROM blocks nbb WHERE nbb.account_id = ${from} AND nbb.target_account_id = ${r})
		AND NOT EXISTS (SELECT 1 FROM mutes nm WHERE nm.account_id = ${r} AND nm.target_account_id = ${from} AND nm.hide_notifications = 1)
		AND NOT EXISTS (SELECT 1 FROM domain_blocks nd JOIN accounts na ON na.id = ${from}
			WHERE nd.account_id = ${r} AND ${domainBlockMatchSql('nd', 'na')})
		AND (${status} IS NULL OR EXISTS (SELECT 1 FROM statuses s WHERE s.id = ${status} AND ${viewableSql('s', r)}))
		AND (${type} <> 'reblog' OR EXISTS (SELECT 1 FROM statuses nr
			WHERE nr.account_id = ${from} AND nr.reblog_of_id = ${status} AND ${visibleSql('nr', r)})))`
}

export type NotifyInput = {
	recipientId: string
	type: NotificationType
	fromId: string
	statusId: string | null
	now: number
}

// Writes a notification if the rule lets it through. The natural key makes a repeat a no-op, except for `update`:
// every edit notifies again, so the previous one is replaced (and gets a newer id).
export function notify(db: Db, input: NotifyInput): void {
	if (input.type === 'update') {
		db.run(
			`DELETE FROM notifications WHERE account_id = ? AND type = 'update' AND from_account_id = ? AND status_id = ?`,
			input.recipientId,
			input.fromId,
			input.statusId
		)
	}
	const inserted = db.all<{ id: number }>(
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at)
		SELECT ?1, ?2, ?3, ?4, ?5
		WHERE EXISTS (SELECT 1 FROM local_accounts WHERE account_id = ?1) AND ${shownSql('?1', '?2', '?3', '?4')}
		ON CONFLICT DO NOTHING RETURNING id`,
		input.recipientId,
		input.type,
		input.fromId,
		input.statusId,
		new Date(input.now).toISOString()
	)
	// VIS-10: a push only for a row inserted now, never for a repeat.
	for (const { id } of inserted) {
		queuePushes(db, id, input.now)
	}
}

// At most this many pushes wait at once (RES-4); a notification beyond it gets no push, but is still written.
export const MAX_PUSH_BACKLOG = 1000

// Whether subscription `p`, made with access token `t`, wants a push of notification `n` (table aliases), as Mastodon's
// Web::PushSubscription#pushable? decides it: the token is the recipient's and still valid at `now` (an ISO time), the
// subscription's alert for the type is on, and its policy lets the sender through (followed: the recipient follows
// the sender; follower: the sender follows the recipient; none: nothing).
export function pushWantedSql(p: string, t: string, n: string, now: string): string {
	return `(${t}.kind = 'access' AND ${t}.account_id = ${n}.account_id
		AND (${t}.expires_at IS NULL OR ${t}.expires_at > ${now})
		AND json_extract(${p}.alerts, '$."' || ${n}.type || '"') IS 1
		AND (${p}.policy = 'all'
			OR (${p}.policy = 'followed' AND EXISTS (SELECT 1 FROM follows pf
				WHERE pf.account_id = ${n}.account_id AND pf.target_account_id = ${n}.from_account_id AND pf.state = 'accepted'))
			OR (${p}.policy = 'follower' AND EXISTS (SELECT 1 FROM follows pf
				WHERE pf.account_id = ${n}.from_account_id AND pf.target_account_id = ${n}.account_id AND pf.state = 'accepted'))))`
}

// One push per subscription of the recipient that wants notification `id`, due at once.
function queuePushes(db: Db, id: number, now: number): void {
	db.run(
		`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
		SELECT p.id, n.id, ?2, ?2 FROM notifications n
			JOIN oauth_tokens t ON t.account_id = n.account_id
			JOIN push_subscriptions p ON p.token_hash = t.token_hash
		WHERE n.id = ?1 AND ${pushWantedSql('p', 't', 'n', '?3')}
			AND (SELECT count(*) FROM (SELECT 1 FROM push_deliveries LIMIT ?4)) < ?4
		ON CONFLICT DO NOTHING`,
		id,
		now,
		new Date(now).toISOString(),
		MAX_PUSH_BACKLOG
	)
}

type NotificationRow = {
	id: string
	type: string
	from_account_id: string
	status_id: string | null
	created_at: string
}

const NOTIFICATION_COLUMNS = 'CAST(n.id AS TEXT) AS id, n.type, n.from_account_id, n.status_id, n.created_at'

function presentNotifications(db: Db, rows: NotificationRow[], viewerId: string, present: Present): Notification[] {
	const accounts = presentAccountsById(
		db,
		rows.map((row) => row.from_account_id),
		present
	)
	const statusIds = [...new Set(rows.flatMap((row) => (row.status_id === null ? [] : [row.status_id])))]
	const statuses = new Map(
		presentStatuses(db, statusIds, { ...present, viewerId }).map((status) => [status.id, status])
	)
	return rows.flatMap((row) => {
		const account = accounts.get(row.from_account_id)
		const status = row.status_id === null ? undefined : statuses.get(row.status_id)
		if (account === undefined || (row.status_id !== null && status === undefined)) {
			return []
		}
		return [
			{
				id: row.id,
				type: row.type,
				created_at: row.created_at,
				account,
				...(status === undefined ? {} : { status }),
			},
		]
	})
}

export type ListNotificationsInput = {
	page: PageQuery
	types: string[]
	excludeTypes: string[]
	accountId: string | null
	present: Present
}

export const listNotifications = userReadOperation<ListNotificationsInput, Page<Notification>>(
	(db, input, { accountId: viewerId }) => {
		const { page } = input
		const ascending = page.minId !== undefined
		const rows = db.all<NotificationRow>(
			`SELECT ${NOTIFICATION_COLUMNS} FROM notifications n
			WHERE n.account_id = ?1
				AND (?2 IS NULL OR n.id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR n.id > CAST(?3 AS INTEGER))
				AND (?4 IS NULL OR n.type IN (SELECT value FROM json_each(?4)))
				AND n.type NOT IN (SELECT value FROM json_each(?5))
				AND (?6 IS NULL OR n.from_account_id = ?6)
				AND ${shownSql('?1', 'n.type', 'n.from_account_id', 'n.status_id')}
			ORDER BY n.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?7`,
			viewerId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			input.types.length === 0 ? null : JSON.stringify(input.types),
			JSON.stringify(input.excludeTypes),
			input.accountId,
			page.limit
		)
		if (ascending) {
			rows.reverse()
		}
		return {
			items: presentNotifications(db, rows, viewerId, input.present),
			newest: rows[0]?.id ?? null,
			oldest: rows.at(-1)?.id ?? null,
		}
	}
)

const NOTIFICATION_ID = /^\d{1,19}$/

export const getNotification = userReadOperation<{ id: string; present: Present }, Notification | null>(
	(db, { id, present }, { accountId: viewerId }) => {
		if (!NOTIFICATION_ID.test(id)) {
			return null
		}
		const rows = db.all<NotificationRow>(
			`SELECT ${NOTIFICATION_COLUMNS} FROM notifications n
			WHERE n.account_id = ?1 AND n.id = CAST(?2 AS INTEGER) AND ${shownSql('?1', 'n.type', 'n.from_account_id', 'n.status_id')}`,
			viewerId,
			id
		)
		return presentNotifications(db, rows, viewerId, present)[0] ?? null
	}
)

export const dismissNotification = userWriteOperation<{ id: string }, boolean>((db, { id }, { accountId }) => {
	if (!NOTIFICATION_ID.test(id)) {
		return false
	}
	return db.run('DELETE FROM notifications WHERE account_id = ? AND id = CAST(? AS INTEGER)', accountId, id) > 0
})

export const clearNotifications = userWriteOperation<object, null>((db, _input, { accountId }) => {
	db.run('DELETE FROM notifications WHERE account_id = ?', accountId)
	return null
})
