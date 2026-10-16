import { type Account, type Page, type PageQuery, type Present, presentAccountsById } from './accounts'
import {
	FILTERABLE_TYPES,
	keptFloorSql,
	keptSql,
	notificationPolicySql,
	notifiedSql,
	type PolicyChoice,
	statusReads,
	type WithVisibleStatus,
} from './audience'
import { type UserContext, userReadOperation, userWriteOperation } from './auth'
import { addToConversation } from './conversations'
import { presentStatuses, type Status } from './status-presenter'
import type { Db } from '../db/sql'

// Notifications of local users (Mastodon 4.0.2 v1). They are written by the operation that causes them, in its
// transaction, and read in pages in the Store. One rule (shownSql in audience.ts) decides whether a notification is
// written, shown and pushed: the recipient is not its sender, the sender is not suspended, blocked (either way), muted
// with notifications (while the mute applies), or domain-blocked by the recipient, and the recipient may see the
// status. A mention is also left out when its status mentions or replies to an account the recipient blocks or mutes
// with notifications (Mastodon's FeedManager#filter_from_mentions), and a post notification (`status`) when home would
// leave its status out (FeedInsertWorker), which includes a sender the recipient mutes. Only a local recipient is
// written one, and none about a status in a conversation the recipient mutes (R31); one written before the mute stays.
// A new notification also records a push for each of the recipient's Web Push subscriptions that wants it;
// domain/push.ts checks this rule again, at its own time, before each is sent (PUSH-3).
// The recipient's notification policy (notification-requests.ts) drops or filters what it chooses when it is written:
// a filtered notification is kept apart from the lists, counts and pushes until its request is accepted.
// A favourite, a boost or a follow also records the group it joins in the API v2's grouped notifications
// (group_key, which v1 shows too); notification-groups.ts reads them.

export type NotificationType =
	'mention' | 'status' | 'reblog' | 'favourite' | 'follow' | 'follow_request' | 'update' | 'poll'

export type Notification = {
	id: string
	type: string
	created_at: string
	// Mastodon 4.5's REST::NotificationSerializer#group_key: the notification's group, or `ungrouped-<id>`.
	group_key: string
	account: Account
	status?: Status
}

export type NotifyInput = {
	recipientId: string
	type: NotificationType
	fromId: string
	statusId: string | null
	now: number
}

// Writes a notification if the rule lets it through (notifiedSql: R15, and not in a conversation the recipient mutes,
// R31) and the recipient's policy does not drop it (notificationPolicySql, NotifyService#drop?). A notification the
// policy filters (NotifyService#filter?) is written with `filtered` set and no group (Notification#set_group_key!
// skips it): it is not pushed, does not join a conversation, and a mention opens or updates the request of its sender
// (update_notification_request!, app/services/notify_service.rb:229-256); every read leaves it out unless asked.
// The natural key makes a repeat a no-op, except for `update`: every edit notifies again, so the previous one is
// replaced (and gets a newer id). The replacement is judged first: an edit the rule refuses (its conversation muted
// since) leaves the previous one as it is, as a mute keeps the notifications written before it. An edit is never
// filtered or dropped by the policy.
export function notify(db: Db, input: NotifyInput): void {
	const now = new Date(input.now).toISOString()
	if (input.type === 'update') {
		const eligible = db.first(
			`SELECT 1 AS ok WHERE ${notifiedSql('?1', "'update'", '?2', '?3', '?4')}`,
			input.recipientId,
			input.fromId,
			input.statusId,
			now
		)
		if (eligible === undefined) {
			return
		}
		db.run(
			`DELETE FROM notifications WHERE account_id = ? AND type = 'update' AND from_account_id = ? AND status_id = ?`,
			input.recipientId,
			input.fromId,
			input.statusId
		)
	}
	// A type the policy never filters is accepted without reading it (notificationPolicySql's first arm).
	const policy = !FILTERABLE_TYPES.includes(input.type)
		? 'accept'
		: (db.first<{ policy: PolicyChoice }>(
				`SELECT ${notificationPolicySql('?1', '?2', '?3', '?4', '?5')} AS policy`,
				input.recipientId,
				input.type,
				input.fromId,
				input.statusId,
				now
			)?.policy ?? 'accept')
	if (policy === 'drop') {
		return
	}
	const filtered = policy === 'filter'
	// A row of the natural key that a clear or its group's dismissal hides is deleted, one row by the natural key, so
	// the notification is written again with a new id rather than lost to the conflict while the rounds have yet to
	// delete it.
	db.run(
		`DELETE FROM notifications WHERE account_id = ?1 AND type = ?2 AND from_account_id = ?3
			AND IFNULL(status_id, '') = IFNULL(?4, '') AND NOT ${keptSql('notifications')}`,
		input.recipientId,
		input.type,
		input.fromId,
		input.statusId
	)
	const inserted = db.all<{ id: number }>(
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key, filtered)
		SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
		WHERE EXISTS (SELECT 1 FROM local_accounts WHERE account_id = ?1) AND ${notifiedSql('?1', '?2', '?3', '?4', '?5')}
		ON CONFLICT DO NOTHING RETURNING id`,
		input.recipientId,
		input.type,
		input.fromId,
		input.statusId,
		now,
		filtered ? null : groupKeyOf(db, input),
		filtered ? 1 : 0
	)
	for (const { id } of inserted) {
		if (filtered) {
			if (input.type === 'mention' && input.statusId !== null) {
				openRequest(db, input.recipientId, input.fromId, input.statusId, now)
			}
			continue
		}
		// VIS-10: a push only for a row inserted now, never for a repeat.
		queuePushes(db, id, input.now)
		// NotifyService#push_to_conversation!: a direct status the recipient is notified of joins their conversation.
		if (input.type === 'mention' && input.statusId !== null) {
			addToConversation(db, input.recipientId, input.statusId)
		}
	}
}

// NotificationRequest::MAX_MEANINGFUL_COUNT: a request counts at most this many notifications, and the policy's
// summary at most this many requests.
export const MAX_MEANINGFUL_COUNT = 100

// NotifyService#update_notification_request!: the request of the sender's filtered mentions, opened by the first and
// updated by each later one, with its status as the last. Mastodon recounts the sender's filtered mentions on each
// save (prepare_notifications_count, up to 100); Kopje counts each one as it is written, up to the same 100, so the
// count does not read the sender's notifications.
function openRequest(db: Db, recipientId: string, fromId: string, statusId: string, now: string): void {
	db.run(
		`INSERT INTO notification_requests (account_id, from_account_id, last_status_id, notifications_count, created_at,
			updated_at)
		VALUES (?1, ?2, ?3, 1, ?4, ?4)
		ON CONFLICT (account_id, from_account_id) DO UPDATE SET last_status_id = excluded.last_status_id,
			notifications_count = min(notifications_count + 1, ?5), updated_at = excluded.updated_at`,
		recipientId,
		fromId,
		statusId,
		now,
		MAX_MEANINGFUL_COUNT
	)
}

// The notification types grouped in the API v2 (Mastodon's Notification::GROUPABLE_NOTIFICATION_TYPES, less
// admin.sign_up, which Kopje never notifies).
export const GROUPABLE_TYPES: readonly NotificationType[] = ['favourite', 'reblog', 'follow']

// How many hours a group may span (Notification::Groups::MAXIMUM_GROUP_SPAN_HOURS).
const GROUP_SPAN_HOURS = 12

// The group a new notification joins (Notification#set_group_key!): a favourite or boost of a status, or a follow,
// by the hour it happens, joining the recipient's group of the same kind from up to 11 hours before. Mastodon keeps
// the last hour of each kind in Redis; here it is the newest of those hours that still has a notification the
// recipient has neither cleared nor dismissed (keptFloorSql), found by the group index, one seek per hour, so a
// dismissed or cleared group is not joined, as it would not be once its rows are deleted. Other types are not grouped
// (null).
function groupKeyOf(db: Db, input: NotifyInput): string | null {
	if (!GROUPABLE_TYPES.includes(input.type)) {
		return null
	}
	const kind = input.type === 'follow' ? input.type : `${input.type}-${input.statusId ?? ''}`
	const hour = Math.floor(input.now / 3_600_000)
	const previous = db.first<{ hour: number }>(
		`WITH RECURSIVE h(hour) AS (SELECT CAST(?3 AS INTEGER) UNION ALL SELECT hour - 1 FROM h WHERE hour > ?3 - ?4 + 1)
		SELECT hour FROM h WHERE EXISTS (SELECT 1 FROM notifications
			WHERE account_id = ?1 AND group_key = ?2 || '-' || h.hour AND group_key IS NOT NULL
				AND id > ${keptFloorSql('?1', "?2 || '-' || h.hour")})
		ORDER BY hour DESC LIMIT 1`,
		input.recipientId,
		kind,
		hour,
		GROUP_SPAN_HOURS
	)
	return `${kind}-${previous?.hour ?? hour}`
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

// One push per subscription of the recipient that wants notification `id`, due at once, within the room the backlog
// has left: however many subscriptions want it, the total never passes MAX_PUSH_BACKLOG.
function queuePushes(db: Db, id: number, now: number): void {
	const waiting =
		db.first<{ n: number }>('SELECT count(*) AS n FROM (SELECT 1 FROM push_deliveries LIMIT ?)', MAX_PUSH_BACKLOG)?.n ??
		0
	if (waiting >= MAX_PUSH_BACKLOG) {
		return
	}
	db.run(
		`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
		SELECT p.id, n.id, ?2, ?2 FROM notifications n
			JOIN oauth_tokens t ON t.account_id = n.account_id
			JOIN push_subscriptions p ON p.token_hash = t.token_hash
		WHERE n.id = ?1 AND ${pushWantedSql('p', 't', 'n', '?3')}
		ORDER BY p.id LIMIT ?4
		ON CONFLICT DO NOTHING`,
		id,
		now,
		new Date(now).toISOString(),
		MAX_PUSH_BACKLOG - waiting
	)
}

type NotificationRow = {
	id: string
	type: string
	from_account_id: string
	status_id: string | null
	created_at: string
	group_key: string | null
}

// The columns of a notification row besides status_id, which StatusReads.notifications selects first.
export const NOTIFICATION_COLUMNS = {
	id: 'CAST(n.id AS TEXT)',
	type: 'n.type',
	from_account_id: 'n.from_account_id',
	created_at: 'n.created_at',
	group_key: 'n.group_key',
}

function presentNotifications(
	db: Db,
	rows: WithVisibleStatus<NotificationRow, 'status_id'>[],
	viewer: UserContext,
	present: Present
): Notification[] {
	const accounts = presentAccountsById(
		db,
		rows.map((row) => row.from_account_id),
		present
	)
	const statusIds = [...new Set(rows.flatMap((row) => (row.status_id === null ? [] : [row.status_id])))]
	const statuses = new Map(presentStatuses(db, statusIds, { ...present, viewer }).map((status) => [status.id, status]))
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
				group_key: row.group_key ?? `ungrouped-${row.id}`,
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
	// include_filtered; a sender (account_id) shows filtered ones too (Notification.browserable).
	includeFiltered: boolean
	present: Present
}

export const listNotifications = userReadOperation<ListNotificationsInput, Page<Notification>>(
	(db, input, _viewer, viewer) => {
		const { accountId: viewerId, now } = viewer
		const { page } = input
		const ascending = page.minId !== undefined
		const read = statusReads(viewer, { viewer: '?1', now: '?8' })
		const rows = read.notifications<Omit<NotificationRow, 'status_id'>>(
			db,
			{
				where: `n.account_id = ?1
					AND (?4 IS NULL OR n.type IN (SELECT value FROM json_each(?4)))
					AND n.type NOT IN (SELECT value FROM json_each(?5))
					AND (?6 IS NULL OR n.from_account_id = ?6)`,
				tail: `ORDER BY n.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?7`,
				range: { max: '?2', min: '?3' },
				columns: NOTIFICATION_COLUMNS,
				includeFiltered: input.includeFiltered || input.accountId !== null,
			},
			viewerId,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			input.types.length === 0 ? null : JSON.stringify(input.types),
			JSON.stringify(input.excludeTypes),
			input.accountId,
			page.limit,
			now
		)
		if (ascending) {
			rows.reverse()
		}
		return {
			items: presentNotifications(db, rows, viewer, input.present),
			newest: rows[0]?.id ?? null,
			oldest: rows.at(-1)?.id ?? null,
		}
	}
)

export const NOTIFICATION_ID = /^\d{1,19}$/

export const getNotification = userReadOperation<{ id: string; present: Present }, Notification | null>(
	(db, { id, present }, _viewer, viewer) => {
		const { accountId: viewerId, now } = viewer
		if (!NOTIFICATION_ID.test(id)) {
			return null
		}
		const read = statusReads(viewer, { viewer: '?1', now: '?3' })
		const rows = read.notifications<Omit<NotificationRow, 'status_id'>>(
			db,
			// Api::V1::NotificationsController#show finds any of the viewer's notifications, filtered or not.
			{
				where: 'n.account_id = ?1 AND n.id = CAST(?2 AS INTEGER)',
				columns: NOTIFICATION_COLUMNS,
				includeFiltered: true,
			},
			viewerId,
			id,
			now
		)
		return presentNotifications(db, rows, viewer, present)[0] ?? null
	}
)

export const dismissNotification = userWriteOperation<{ id: string }, boolean>((db, { id }, { accountId }) => {
	if (!NOTIFICATION_ID.test(id)) {
		return false
	}
	return db.run('DELETE FROM notifications WHERE account_id = ? AND id = CAST(? AS INTEGER)', accountId, id) > 0
})

// POST /api/v1/notifications/clear and /api/v2/notifications/clear (Mastodon's delete_all): every notification of the
// viewer, shown or not, filtered or not, gone from every read at once and deleted in batches (removeNotifications).
export const clearNotifications = userWriteOperation<object, null>((db, _input, { accountId }) => {
	removeNotifications(db, accountId, null)
	return null
})

// Clearing and dismissing a group (Mastodon's delete_all and destroy_all) delete any number of notifications, which
// others write at will, so Kopje does it bounded (RES-6, RES-7), as the jobs of answered notification requests do
// (notification-requests.ts): the request records the highest id of what it removes, the account's notifications
// (notification_clears) or the group's (notification_dismissals), which R15 hides at once (keptFloorSql in
// audience.ts), then deletes them REMOVAL_WINDOW at a time, newest first, REMOVAL_BATCHES windows in the request and
// as many in each round of the inbound jobs (runNotificationRequestJobs), until none is left and the record goes. A
// later clear or dismissal raises the id, and a notification written after it is above it, shown as usual.
export const REMOVAL_WINDOW = 500
export const REMOVAL_BATCHES = 4

// What a removal deletes: the account's notifications (group_key null) or one group's, up to max_id.
type Removal = { account_id: string; group_key: string | null; max_id: number }

// Records the removal of the account's notifications (`groupKey` null) or of the group's, at its newest notification
// now (one seek in the account's or the group's index), and runs its first batches. Nothing for none.
export function removeNotifications(db: Db, accountId: string, groupKey: string | null): void {
	const removal =
		groupKey === null
			? db.first<Removal>(
					`INSERT INTO notification_clears (account_id, max_id)
					SELECT ?1, id FROM (SELECT id FROM notifications WHERE account_id = ?1 ORDER BY id DESC LIMIT 1) WHERE true
					ON CONFLICT (account_id) DO UPDATE SET max_id = max(max_id, excluded.max_id)
					RETURNING account_id, NULL AS group_key, max_id`,
					accountId
				)
			: db.first<Removal>(
					`INSERT INTO notification_dismissals (account_id, group_key, max_id)
					SELECT ?1, ?2, id FROM (SELECT id FROM notifications
						WHERE account_id = ?1 AND group_key = ?2 AND group_key IS NOT NULL ORDER BY id DESC LIMIT 1) WHERE true
					ON CONFLICT (account_id, group_key) DO UPDATE SET max_id = max(max_id, excluded.max_id)
					RETURNING account_id, group_key, max_id`,
					accountId,
					groupKey
				)
	for (let batch = 0; removal !== undefined && batch < REMOVAL_BATCHES; batch++) {
		if (!removalBatch(db, removal)) {
			return
		}
	}
}

// One batch of a removal: its next REMOVAL_WINDOW notifications at or below its id, newest first, through the
// account's or the group's index; the push deliveries of each go with it (ON DELETE CASCADE, at most
// MAX_PUSH_BACKLOG in all). With fewer left, the removal is done and its record goes. Returns whether any is left.
function removalBatch(db: Db, removal: Removal): boolean {
	const ids =
		removal.group_key === null
			? db.all<{ id: number }>(
					'SELECT id FROM notifications WHERE account_id = ? AND id <= ? ORDER BY id DESC LIMIT ?',
					removal.account_id,
					removal.max_id,
					REMOVAL_WINDOW
				)
			: db.all<{ id: number }>(
					`SELECT id FROM notifications WHERE account_id = ? AND group_key = ? AND group_key IS NOT NULL AND id <= ?
					ORDER BY id DESC LIMIT ?`,
					removal.account_id,
					removal.group_key,
					removal.max_id,
					REMOVAL_WINDOW
				)
	db.run(
		'DELETE FROM notifications WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))',
		JSON.stringify(ids.map((row) => row.id))
	)
	if (ids.length === REMOVAL_WINDOW) {
		return true
	}
	if (removal.group_key === null) {
		db.run('DELETE FROM notification_clears WHERE account_id = ?', removal.account_id)
	} else {
		db.run(
			'DELETE FROM notification_dismissals WHERE account_id = ? AND group_key = ?',
			removal.account_id,
			removal.group_key
		)
	}
	return false
}

// At most `batches` batches of the pending removals, each kind oldest first, taking turns: a clear, then a group's
// dismissal, then a clear, so neither kind waits while the other has work. Returns whether one is left.
export function runRemovals(db: Db, batches: number): boolean {
	const clear = () =>
		db.first<Removal>('SELECT account_id, NULL AS group_key, max_id FROM notification_clears ORDER BY rowid LIMIT 1')
	const dismissal = () =>
		db.first<Removal>('SELECT account_id, group_key, max_id FROM notification_dismissals ORDER BY rowid LIMIT 1')
	for (let batch = 0; batch < batches; batch++) {
		const removal = batch % 2 === 0 ? (clear() ?? dismissal()) : (dismissal() ?? clear())
		if (removal === undefined) {
			return false
		}
		removalBatch(db, removal)
	}
	return (
		db.first(
			'SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM notification_clears) OR EXISTS (SELECT 1 FROM notification_dismissals)'
		) !== undefined
	)
}
