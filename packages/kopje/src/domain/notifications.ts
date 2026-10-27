import { type AccountWarning, presentAccountWarning } from './account-warnings'
import { type Account, accountsOf, type Page, type PageQuery, type Present } from './accounts'
import { adminAccountIdOnce } from './admin-authority'
import { admit, admittedPage, ARRAY_ANSWER_BYTES, firstUses } from './answer-budget'
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
import { currentCredentialSql, type UserContext, userReadOperation, userWriteOperation } from './auth'
import { addToConversation } from './conversations'
import { jobDueSql, nextJob, NOTIFICATION_CLEARS, NOTIFICATION_DISMISSALS, runJobItem } from './job-attempts'
import { presentReport, type Report } from './reports'
import { presentation, type Status, statusStream } from './status-presenter'
import { readWindow, windowJson, windowOf, windowPage } from './windows'
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
// (group_key, which v1 shows too); notification-groups.ts reads them. An admin.report names its report (report_id) and
// is the OAuth admin's alone (R37; reports.ts notifies it). A moderation_warning names its warning (account_warning_id)
// and is its target's alone, sent by the target itself (R42; admin-accounts.ts notifies it).

export type NotificationType =
	| 'mention'
	| 'status'
	| 'reblog'
	| 'favourite'
	| 'follow'
	| 'follow_request'
	| 'update'
	| 'poll'
	| 'quote'
	| 'quoted_update'
	| 'admin.report'
	| 'moderation_warning'

export type Notification = {
	id: string
	type: string
	created_at: string
	// Mastodon 4.5's REST::NotificationSerializer#group_key: the notification's group, or `ungrouped-<id>`.
	group_key: string
	// REST::NotificationSerializer#filtered?: true on a notification the recipient's policy filtered, else absent.
	filtered?: true
	account: Account
	status?: Status
	// An admin.report's report (REST::NotificationSerializer#report_type?).
	report?: Report
	// A moderation_warning's warning (REST::NotificationSerializer#moderation_warning_event?).
	moderation_warning?: AccountWarning
}

export type NotifyInput = {
	recipientId: string
	type: NotificationType
	fromId: string
	statusId: string | null
	// The report of an admin.report.
	reportId?: string
	// The warning of a moderation_warning.
	accountWarningId?: string
	now: number
}

// Writes a notification if the rule lets it through (notifiedSql: R15, and not in a conversation the recipient mutes,
// R31) and the recipient's policy does not drop it (notificationPolicySql, NotifyService#drop?). A notification the
// policy filters (NotifyService#filter?) is written with `filtered` set and no group (Notification#set_group_key!
// skips it): it is not pushed, does not join a conversation, and a mention opens or updates the request of its sender
// (update_notification_request!, app/services/notify_service.rb:229-256); every read leaves it out unless asked.
// The natural key makes a repeat a no-op, except for `update` and `quoted_update`: every edit notifies again, so the
// previous one is replaced (and gets a newer id; LocalNotificationWorker). The replacement is judged first: an edit the
// rule refuses (its conversation muted since) leaves the previous one as it is, as a mute keeps the notifications
// written before it. An edit is never filtered or dropped by the policy. An admin.report is keyed by its report too
// (migrations 0040 and 0041), so each report notifies once, as LocalNotificationWorker keys it by its activity; a
// moderation_warning by its warning (0062 and 0063).
export function notify(db: Db, input: NotifyInput): void {
	const now = new Date(input.now).toISOString()
	// The OAuth admin, for R37 in the rule (shownSql); only an admin.report needs it.
	const admin = input.type === 'admin.report' ? adminAccountIdOnce(db) : null
	const reportId = input.reportId ?? null
	const accountWarningId = input.accountWarningId ?? null
	if (input.type === 'update' || input.type === 'quoted_update') {
		const eligible = db.first(
			`SELECT 1 AS ok WHERE ${notifiedSql('?1', '?5', '?2', '?3', '?4', 'NULL', 'NULL')}`,
			input.recipientId,
			input.fromId,
			input.statusId,
			now,
			input.type
		)
		if (eligible === undefined) {
			return
		}
		db.run(
			'DELETE FROM notifications WHERE account_id = ? AND type = ? AND from_account_id = ? AND status_id = ?',
			input.recipientId,
			input.type,
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
			AND IFNULL(status_id, '') = IFNULL(?4, '') AND IFNULL(report_id, 0) = IFNULL(CAST(?5 AS INTEGER), 0)
			AND IFNULL(account_warning_id, 0) = IFNULL(CAST(?6 AS INTEGER), 0)
			AND NOT ${keptSql('notifications')}`,
		input.recipientId,
		input.type,
		input.fromId,
		input.statusId,
		reportId,
		accountWarningId
	)
	const inserted = db.all<{ id: number }>(
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, report_id, account_warning_id,
			created_at, group_key, filtered)
		SELECT ?1, ?2, ?3, ?4, CAST(?9 AS INTEGER), CAST(?10 AS INTEGER), ?5, ?6, ?7
		WHERE EXISTS (SELECT 1 FROM local_accounts WHERE account_id = ?1)
			AND ${notifiedSql('?1', '?2', '?3', '?4', '?5', '?8', 'CAST(?10 AS INTEGER)')}
		ON CONFLICT DO NOTHING RETURNING id`,
		input.recipientId,
		input.type,
		input.fromId,
		input.statusId,
		now,
		filtered ? null : groupKeyOf(db, input),
		filtered ? 1 : 0,
		admin,
		reportId,
		accountWarningId
	)
	for (const { id } of inserted) {
		if (filtered) {
			if ((input.type === 'mention' || input.type === 'quote') && input.statusId !== null) {
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
// Web::PushSubscription#pushable? decides it: the token is the recipient's, still valid at `now` (an ISO time) and of
// its account's current credential epoch (currentCredentialSql), so no push is queued, claimed or confirmed for an
// earlier one; the subscription's alert for the type is on, and its policy lets the sender through (followed: the
// recipient follows the sender; follower: the sender follows the recipient; none: nothing).
export function pushWantedSql(p: string, t: string, n: string, now: string): string {
	return `(${t}.kind = 'access' AND ${t}.account_id = ${n}.account_id
		AND (${t}.expires_at IS NULL OR ${t}.expires_at > ${now}) AND ${currentCredentialSql(t)}
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
	report_id: string | null
	account_warning_id: string | null
	created_at: string
	group_key: string | null
	filtered: 0 | 1
}

// The columns of a notification row besides status_id, which StatusReads.notifications selects first. `filtered` has
// INTEGER affinity but no CHECK (migration 0020_notification_policies), so an imported row may hold any value: only
// integer 1 reads as filtered, as a scalar, so no stored value of another type or size is read out.
export const NOTIFICATION_COLUMNS = {
	id: 'CAST(n.id AS TEXT)',
	type: 'n.type',
	from_account_id: 'n.from_account_id',
	created_at: 'n.created_at',
	group_key: 'n.group_key',
	filtered: "CASE WHEN typeof(n.filtered) = 'integer' AND n.filtered = 1 THEN 1 ELSE 0 END",
	report_id: 'CAST(n.report_id AS TEXT)',
	account_warning_id: 'CAST(n.account_warning_id AS TEXT)',
}

// Notifications are read this many at a time while an answer is admitted: their accounts (and reports, one at a time)
// are read for this many rows together, their statuses in the chunks statusStream plans.
export const NOTIFICATION_CHUNK = 2

// The notifications of `rows` in order, for an admission (admit): each one atomic, with its account, its status, its
// report and its warning, presented when the admission reaches it; undefined for one whose account, status, report or
// warning the presenter cannot show (left out, as Mastodon leaves out a notification it cannot render). An account or
// status that several notifications share is presented once (firstUses), under one presentation of the rows' statuses.
export function* notificationStream(
	db: Db,
	rows: readonly WithVisibleStatus<NotificationRow, 'status_id'>[],
	viewer: UserContext,
	present: Present
): Generator<Notification | undefined, undefined> {
	const statusIds = [...new Set(rows.flatMap((row) => (row.status_id === null ? [] : [row.status_id])))]
	const shared = presentation(db, statusIds, { ...present, viewer })
	const statusOf = firstUses(statusIds, statusStream(db, shared, statusIds))
	const accountIds = [...new Set(rows.map((row) => row.from_account_id))]
	const accountOf = firstUses(accountIds, accountsOf(db, accountIds, present, NOTIFICATION_CHUNK))
	for (const row of rows) {
		const account = accountOf(row.from_account_id)
		const status = row.status_id === null ? undefined : statusOf(row.status_id)
		const report = row.report_id === null ? undefined : presentReport(db, row.report_id, present)
		const warning = warningOf(db, row, viewer.accountId, account)
		if (
			account === undefined ||
			(row.status_id !== null && status === undefined) ||
			(row.report_id !== null && report === undefined) ||
			warning === null
		) {
			yield undefined
			continue
		}
		yield {
			id: row.id,
			type: row.type,
			created_at: row.created_at,
			group_key: row.group_key ?? `ungrouped-${row.id}`,
			...(row.filtered === 1 ? { filtered: true as const } : {}),
			account,
			...(status === undefined ? {} : { status }),
			...(report === undefined ? {} : { report }),
			...(warning === undefined ? {} : { moderation_warning: warning }),
		}
	}
}

// The warning a notification row of `recipientId` shows, its sender `account` (already presented) standing for the
// warning's target (R42): undefined for a row of another type, which shows none; null for a moderation_warning that
// cannot be shown (no warning, or one whose sender or warning is not the recipient's), which is left out.
export function warningOf(
	db: Db,
	row: { type: string; from_account_id: string; account_warning_id: string | null },
	recipientId: string,
	account: Account | undefined
): AccountWarning | null | undefined {
	if (row.type !== 'moderation_warning') {
		return undefined
	}
	if (row.account_warning_id === null || account === undefined || row.from_account_id !== recipientId) {
		return null
	}
	return presentAccountWarning(db, row.account_warning_id, account) ?? null
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

export type ShownColumns = Omit<NotificationRow, 'status_id'>

// What a read of the viewer's notifications reads: filtered ones only with `includeFiltered`; within `range`, the
// cursor (exclusive ids); of `group` alone (statusReads(...).notifications), each an expression over the parameters.
export type Scope = { includeFiltered: boolean; range?: { max: string; min: string }; group?: string }

// A read of the viewer's notifications as a candidate window (windows.ts): the notifications of `scope` matching
// `where` (over the parameters: ?1 the viewer, ?2 the time of the read, `params` from ?3), in the order and number
// `tail` gives, without the rule; then the rule (R15) over those alone. The shown ones in the candidates' order, and
// the candidates' ids.
export function shownWindow(
	db: Db,
	viewer: UserContext,
	scope: Scope,
	where: string,
	tail: string,
	...params: (string | number | null)[]
) {
	const read = statusReads(viewer, { viewer: '?1', now: '?2' })
	const candidates = read
		.notificationWindow(db, { ...scope, where, tail }, viewer.accountId, viewer.now, ...params)
		.map((row) => row.id)
	const shown =
		candidates.length === 0
			? []
			: read.notifications<ShownColumns>(
					db,
					{
						where: '',
						within: '?3',
						includeFiltered: scope.includeFiltered,
						columns: NOTIFICATION_COLUMNS,
						admin: adminAccountIdOnce(db),
					},
					viewer.accountId,
					viewer.now,
					windowJson(windowOf(candidates, candidates.length))
				)
	const byId = new Map(shown.map((row) => [row.id, row]))
	return { rows: candidates.flatMap((id) => byId.get(id) ?? []), candidates }
}

// A page reads a window of readWindow(limit) of the viewer's notifications from the cursor (shownWindow), with the
// request's types and sender but not the rule, then applies the rule (R15) to those.
export const listNotifications = userReadOperation<ListNotificationsInput, Page<Notification>>(
	(db, input, _viewer, viewer) => {
		const { page } = input
		const ascending = page.minId !== undefined
		const size = readWindow(page.limit)
		const { rows, candidates } = shownWindow(
			db,
			viewer,
			{ includeFiltered: input.includeFiltered || input.accountId !== null, range: { max: '?3', min: '?4' } },
			`(?5 IS NULL OR n.type IN (SELECT value FROM json_each(?5)))
			AND n.type NOT IN (SELECT value FROM json_each(?6))
			AND (?7 IS NULL OR n.from_account_id = ?7)`,
			`ORDER BY n.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?8`,
			page.maxId ?? null,
			page.minId ?? page.sinceId ?? null,
			input.types.length === 0 ? null : JSON.stringify(input.types),
			JSON.stringify(input.excludeTypes),
			input.accountId,
			size
		)
		const shown = windowPage(windowOf(candidates, size), rows, (row) => row.id, page.limit, ascending)
		return admittedPage(
			shown,
			ascending,
			(row) => row.id,
			(traversal) => admit(notificationStream(db, traversal, viewer, input.present), ARRAY_ANSWER_BYTES, true)
		)
	}
)

export const NOTIFICATION_ID = /^\d{1,19}$/

export const getNotification = userReadOperation<{ id: string; present: Present }, Notification | null>(
	// Api::V1::NotificationsController#show finds any of the viewer's notifications, filtered or not.
	(db, { id, present }, _viewer, viewer) => notificationById(db, viewer, id, present, true)
)

// R33 for a `notification` event (domain/streaming.ts): the viewer's notification list positioned at notification
// `id`, which is the list read (R15, unfiltered and kept, any type) restricted to that id, since ids are unique; and
// its presentation. Null when the list would not show it now.
export function streamedNotification(db: Db, viewer: UserContext, id: string, present: Present): Notification | null {
	return notificationById(db, viewer, id, present, false)
}

// The mention reference of R33 (domain/streaming.ts), for `status.update` on `user` (with a notification scope) and on
// `user:notification`: the viewer's notification read (R15: unfiltered, kept) restricted to their mention of the
// status `statusId` (Mastodon's FanOutOnWriteService#notify_about_update! streams an edit to each account a mention
// notified). The status, if that read shows the mention. The mention is found by its key (notifications_natural: the
// viewer, the type, the status's author, the status), so the read does not grow with anyone's notifications.
export function mentionedStatus(db: Db, viewer: UserContext, statusId: string) {
	const read = statusReads(viewer, { viewer: '?1', now: '?3' })
	const rows = read.notifications<{ id: number }>(
		db,
		{
			where: `n.id = (SELECT nm.id FROM main.notifications nm WHERE nm.account_id = ?1 AND nm.type = 'mention'
					AND nm.from_account_id = (SELECT ms.account_id FROM main.statuses ms WHERE ms.id = ?2)
					AND IFNULL(nm.status_id, '') = ?2)
				AND n.type = 'mention' AND n.status_id = ?2`,
			columns: { id: 'n.id' },
			includeFiltered: false,
			// Only a mention is read, which the admin arm of R15 does not touch.
			admin: null,
		},
		viewer.accountId,
		statusId,
		viewer.now
	)
	return rows[0]?.status_id ?? null
}

// The viewer's notification `id` as the notification read shows it (R15, kept; filtered ones only with
// `includeFiltered`), presented; null for anything else.
function notificationById(
	db: Db,
	viewer: UserContext,
	id: string,
	present: Present,
	includeFiltered: boolean
): Notification | null {
	if (!NOTIFICATION_ID.test(id)) {
		return null
	}
	const read = statusReads(viewer, { viewer: '?1', now: '?3' })
	const rows = read.notifications<Omit<NotificationRow, 'status_id'>>(
		db,
		{
			where: 'n.id = CAST(?2 AS INTEGER)',
			columns: NOTIFICATION_COLUMNS,
			includeFiltered,
			admin: adminAccountIdOnce(db),
		},
		viewer.accountId,
		id,
		viewer.now
	)
	return notificationStream(db, rows, viewer, present).next().value ?? null
}

export const dismissNotification = userWriteOperation<{ id: string }, boolean>((db, { id }, { accountId }) => {
	if (!NOTIFICATION_ID.test(id)) {
		return false
	}
	return db.run('DELETE FROM notifications WHERE account_id = ? AND id = CAST(? AS INTEGER)', accountId, id) > 0
})

// POST /api/v1/notifications/clear and /api/v2/notifications/clear (Mastodon's delete_all): every notification of the
// viewer, shown or not, filtered or not, gone from every read at once and deleted in batches (removeNotifications).
export const clearNotifications = userWriteOperation<object, null>((db, _input, { accountId, now }) => {
	removeNotifications(db, accountId, null, now)
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

// What a removal deletes: the account's notifications (group_key null) or one group's, up to max_id; `attempts`: its
// retry state's (RES-5).
type Removal = { account_id: string; group_key: string | null; max_id: number; attempts: number }

const removalTable = (removal: Removal) => (removal.group_key === null ? NOTIFICATION_CLEARS : NOTIFICATION_DISMISSALS)

const removalKey = (removal: Removal) =>
	removal.group_key === null ? [removal.account_id] : [removal.account_id, removal.group_key]

// Records the removal of the account's notifications (`groupKey` null) or of the group's, at its newest notification
// now (one seek in the account's or the group's index), and runs its first batches while it may run (each a removalItem:
// a failed one leaves the record, and so what R15 hides, committed). A record raised to a newer notification is a new
// decision: its retry state is fresh again (RES-5); one left as it was (no newer notification) keeps it, so a parked
// removal runs no batch here. Nothing for none.
export function removeNotifications(db: Db, accountId: string, groupKey: string | null, now: number): void {
	const fresh = `attempts = CASE WHEN excluded.max_id > max_id THEN 0 ELSE attempts END,
		due_at = CASE WHEN excluded.max_id > max_id THEN NULL ELSE due_at END`
	const returning = `max_id, attempts, ${jobDueSql()} AS due`
	const removal =
		groupKey === null
			? db.first<Removal & { due: number }>(
					`INSERT INTO notification_clears (account_id, max_id)
					SELECT ?2, id FROM (SELECT id FROM notifications WHERE account_id = ?2 ORDER BY id DESC LIMIT 1) WHERE true
					ON CONFLICT (account_id) DO UPDATE SET max_id = max(max_id, excluded.max_id), ${fresh}
					RETURNING account_id, NULL AS group_key, ${returning}`,
					now,
					accountId
				)
			: db.first<Removal & { due: number }>(
					`INSERT INTO notification_dismissals (account_id, group_key, max_id)
					SELECT ?2, ?3, id FROM (SELECT id FROM notifications
						WHERE account_id = ?2 AND group_key = ?3 AND group_key IS NOT NULL ORDER BY id DESC LIMIT 1) WHERE true
					ON CONFLICT (account_id, group_key) DO UPDATE SET max_id = max(max_id, excluded.max_id), ${fresh}
					RETURNING account_id, group_key, ${returning}`,
					now,
					accountId,
					groupKey
				)
	if (removal === undefined || removal.due !== 1) {
		return
	}
	let attempts = removal.attempts
	for (let batch = 0; batch < REMOVAL_BATCHES; batch++) {
		const ran = removalItem(db, { ...removal, attempts }, now)
		if (!ran.ok || !ran.value) {
			return
		}
		attempts = 0
	}
}

// One batch of a removal: its next REMOVAL_WINDOW notifications at or below its id, newest first, through the
// account's or the group's index; the push deliveries of each go with it (ON DELETE CASCADE, at most
// MAX_PUSH_BACKLOG in all). With fewer left, the removal is done and its record goes. Returns whether any is left.
function removalBatch(db: Db, removal: Removal): boolean {
	const ids =
		removal.group_key === null
			? db.all<{ id: number }>(
					`DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE account_id = ? AND id <= ?
						ORDER BY id DESC LIMIT ?) RETURNING id`,
					removal.account_id,
					removal.max_id,
					REMOVAL_WINDOW
				)
			: db.all<{ id: number }>(
					`DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE account_id = ? AND group_key = ?
						AND group_key IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT ?) RETURNING id`,
					removal.account_id,
					removal.group_key,
					removal.max_id,
					REMOVAL_WINDOW
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

// One batch of `removal` in its own savepoint (runJobItem): a batch that throws is rolled back and recorded on the
// removal's record, which backs off and parks after MAX_JOB_ATTEMPTS while the other removals run (RES-5).
function removalItem(db: Db, removal: Removal, now: number) {
	return runJobItem(db, removalTable(removal), removalKey(removal), removal.attempts, now, () =>
		removalBatch(db, removal)
	)
}

// At most `batches` batches of the removals that may run at `now`, failed ones included, each kind's first due retry
// then its oldest fresh one (job-attempts.ts nextJob), taking turns: a clear, then a group's dismissal, then a clear,
// so neither kind waits while the other has work. Returns whether one may still run a batch now.
export function runRemovals(db: Db, batches: number, now: number): boolean {
	const clear = () =>
		nextJob<Removal>(db, NOTIFICATION_CLEARS, now, { columns: 'account_id, NULL AS group_key, max_id' })
	const dismissal = () =>
		nextJob<Removal>(db, NOTIFICATION_DISMISSALS, now, { columns: 'account_id, group_key, max_id' })
	for (let batch = 0; batch < batches; batch++) {
		const removal = batch % 2 === 0 ? (clear() ?? dismissal()) : (dismissal() ?? clear())
		if (removal === undefined) {
			return false
		}
		removalItem(db, removal, now)
	}
	return clear() !== undefined || dismissal() !== undefined
}
