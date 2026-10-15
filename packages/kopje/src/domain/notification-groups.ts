import { type Account, edgeRangeSql, type Page, type PageQuery, type Present, presentAccountsById } from './accounts'
import { statusReads } from './audience'
import { type UserContext, userReadOperation, userWriteOperation } from './auth'
import { GROUPABLE_TYPES, NOTIFICATION_ID } from './notifications'
import { presentStatuses, type Status } from './status-presenter'
import type { Db } from '../db/sql'

// Grouped notifications (Mastodon 4.5's API v2: Api::V2::NotificationsController, Notifications::AccountsController,
// NotificationGroup and Notification::Groups) and the unread counts of both versions. A notification's group is set
// when it is written (notify in notifications.ts); a notification without one is a group of its own,
// `ungrouped-<id>`. Every read goes through the notification rule (R15, statusReads(...).notifications), as the v1
// list does: a group counts, samples and pages only the notifications v1 would show the viewer now, so a sender since
// blocked or muted, or a status the viewer may no longer see, is neither shown nor counted.
//
// Mastodon walks the notifications newest first and keeps the first of each group until it has a page of groups, then
// counts each group's notifications between the page's ends. Kopje walks the same way, and the walk is what it counts,
// with one difference: a walk reads at most groupWalkLimit(limit) notifications it shows. When a page's groups hold
// more than that (a status favourited by hundreds within a few hours), the page ends early with the groups found, each
// counted over the notifications read, and its Link continues from the last one read, so a group too large for one
// page goes on in the next, as a group that spans pages does in Mastodon (RES-7).

// Api::V2::NotificationsController::DEFAULT_NOTIFICATIONS_COUNT_LIMIT and MAX_NOTIFICATIONS_COUNT_LIMIT, which the v1
// controller shares.
export const DEFAULT_UNREAD_LIMIT = 100
export const MAX_UNREAD_LIMIT = 1_000

// NotificationGroup::SAMPLE_ACCOUNTS_SIZE.
const SAMPLE_ACCOUNTS = 8

// How many shown notifications a walk for `limit` groups reads at most: GROUP_WALK, or twice the limit when that is
// more (an unread count of up to MAX_UNREAD_LIMIT groups). A group read reads at most GROUP_WALK.
export const GROUP_WALK = 400

function groupWalkLimit(limit: number): number {
	return Math.max(GROUP_WALK, 2 * limit)
}

// The types whose notifications show their status (REST::NotificationGroupSerializer#status_type?).
const STATUS_TYPES = new Set(['favourite', 'reblog', 'status', 'mention', 'poll', 'update'])

// REST::NotificationGroupSerializer. most_recent_notification_id is a number, as Mastodon renders it; the page fields
// are present in a page of groups only.
export type NotificationGroup = {
	group_key: string
	notifications_count: number
	type: string
	most_recent_notification_id: number
	page_min_id?: string
	page_max_id?: string
	latest_page_notification_at?: string
	sample_account_ids: string[]
	status_id?: string | null
}

// REST::DedupNotificationGroupSerializer::PartialAccountSerializer.
export type PartialAccount = Pick<Account, 'id' | 'acct' | 'locked' | 'bot' | 'url' | 'avatar' | 'avatar_static'>

// REST::DedupNotificationGroupSerializer: partial_accounts only with expand_accounts=partial_avatars.
export type GroupedNotifications = {
	accounts: Account[]
	partial_accounts?: PartialAccount[]
	statuses: Status[]
	notification_groups: NotificationGroup[]
}

export type ExpandAccounts = 'full' | 'partial_avatars'

type ShownColumns = { id: string; type: string; from_account_id: string; created_at: string; group_key: string | null }

// The columns of a shown notification besides status_id, which StatusReads.notifications selects first.
const COLUMNS: Record<keyof ShownColumns, string> = {
	id: 'CAST(n.id AS TEXT)',
	type: 'n.type',
	from_account_id: 'n.from_account_id',
	created_at: 'n.created_at',
	group_key: 'n.group_key',
}

// The viewer's notifications the rule shows them that match `where` (over the parameters: ?1 is the viewer, ?2 the
// time of the read), in the order and number `tail` gives.
function shownNotifications(
	db: Db,
	viewer: UserContext,
	where: string,
	tail: string,
	...params: (string | number | null)[]
) {
	const read = statusReads(viewer, { viewer: '?1', now: '?2' })
	return read.notifications<ShownColumns>(
		db,
		{ where: `n.account_id = ?1 AND ${where}`, tail, columns: COLUMNS },
		viewer.accountId,
		viewer.now,
		...params
	)
}

type Shown = ReturnType<typeof shownNotifications>[number]

// A group as a read found it: its notifications in the order read.
type Found = { key: string; rows: Shown[] }

type WalkInput = {
	ascending: boolean
	// The cursors, as the client sent them (CAST to an integer, as Mastodon's to_i).
	maxId: string | null
	minId: string | null
	types: string[]
	excludeTypes: string[]
	// The types grouped: null for every groupable one.
	groupedTypes: string[] | null
	limit: number
}

type Walk = {
	groups: Found[]
	// Whether the walk stopped at its limit of notifications read, before a page of groups or the end.
	cut: boolean
	// The id of the last notification read.
	last: string | null
}

// The group a shown notification counts in, with `grouped` the types grouped (Notification::Groups#paginate_groups'
// group_key_sql): its own group, or `ungrouped-<id>`.
function groupOf(row: Shown, grouped: readonly string[]): string {
	return row.group_key !== null && grouped.includes(row.type) ? row.group_key : `ungrouped-${row.id}`
}

// The types grouped for a request's grouped_types[] (none sent: every groupable type).
function groupedOf(groupedTypes: string[] | null): readonly string[] {
	return groupedTypes === null ? GROUPABLE_TYPES : GROUPABLE_TYPES.filter((type) => groupedTypes.includes(type))
}

// Walks the viewer's shown notifications from the cursor (newest first, or oldest first when ascending) in chunks of a
// page, keeping each group's notifications in the order read, until `limit` groups are found (the last one's first
// notification ends the walk, as it ends Mastodon's range), the notifications run out, or groupWalkLimit(limit) are
// read.
function walkGroups(db: Db, viewer: UserContext, input: WalkInput): Walk {
	const grouped = groupedOf(input.groupedTypes)
	const groups = new Map<string, Found>()
	const budget = groupWalkLimit(input.limit)
	let { maxId, minId } = input
	let read = 0
	let last: string | null = null
	while (input.limit > 0) {
		const chunk = Math.min(input.limit, budget - read)
		const rows = shownNotifications(
			db,
			viewer,
			`${edgeRangeSql('n.id', '?3', '?4')}
			AND (?5 IS NULL OR n.type IN (SELECT value FROM json_each(?5)))
			AND n.type NOT IN (SELECT value FROM json_each(?6))`,
			`ORDER BY n.id ${input.ascending ? 'ASC' : 'DESC'} LIMIT ?7`,
			maxId,
			minId,
			input.types.length === 0 ? null : JSON.stringify(input.types),
			JSON.stringify(input.excludeTypes),
			chunk
		)
		for (const row of rows) {
			read += 1
			last = row.id
			const key = groupOf(row, grouped)
			const group = groups.get(key)
			if (group !== undefined) {
				group.rows.push(row)
				continue
			}
			groups.set(key, { key, rows: [row] })
			if (groups.size === input.limit) {
				return { groups: [...groups.values()], cut: false, last }
			}
		}
		if (rows.length < chunk) {
			break
		}
		if (read >= budget) {
			return { groups: [...groups.values()], cut: true, last }
		}
		if (input.ascending) {
			minId = last
		} else {
			maxId = last
		}
	}
	return { groups: [...groups.values()], cut: false, last }
}

// The groups presented (NotificationGroup.from_notifications and GroupedNotificationsPresenter): each with the
// notifications found of it, newest first, its first one standing for it (type and status). With `paged`, the page
// fields of each. A group whose status or accounts the presenter cannot show is left out, as v1 leaves out such a
// notification.
function presentGroups(
	db: Db,
	viewer: UserContext,
	groups: readonly { key: string; first: Shown; rows: Shown[] }[],
	options: { paged: boolean; expandAccounts: ExpandAccounts; present: Present }
): GroupedNotifications {
	const samples = groups.map((group) => group.rows.slice(0, SAMPLE_ACCOUNTS).map((row) => row.from_account_id))
	const accounts = presentAccountsById(db, samples.flat(), options.present)
	const statusIds = [...new Set(groups.flatMap(({ first }) => (first.status_id === null ? [] : [first.status_id])))]
	const statuses = new Map(
		presentStatuses(db, statusIds, { ...options.present, viewer }).map((status) => [status.id, status])
	)
	const shown: { group: NotificationGroup; accounts: Account[]; status: Status | undefined }[] = []
	groups.forEach(({ key, first, rows }, i) => {
		const sampled = (samples[i] ?? []).flatMap((id) => {
			const account = accounts.get(id)
			return account === undefined ? [] : [account]
		})
		const status = first.status_id === null ? undefined : statuses.get(first.status_id)
		const newest = rows[0]
		const oldest = rows.at(-1)
		if (newest === undefined || oldest === undefined || sampled.length === 0) {
			return
		}
		if (first.status_id !== null && status === undefined) {
			return
		}
		shown.push({
			group: {
				group_key: key,
				notifications_count: rows.length,
				type: first.type,
				most_recent_notification_id: Number(newest.id),
				...(options.paged
					? { page_min_id: oldest.id, page_max_id: newest.id, latest_page_notification_at: newest.created_at }
					: {}),
				sample_account_ids: sampled.map((account) => account.id),
				...(STATUS_TYPES.has(first.type) ? { status_id: status?.id ?? null } : {}),
			},
			accounts: sampled,
			status,
		})
	})
	const unique = <T extends { id: string }>(items: T[]) =>
		items.filter((item, i) => items.findIndex((other) => other.id === item.id) === i)
	const statusesShown = unique(shown.flatMap(({ status }) => (status === undefined ? [] : [status])))
	const notification_groups = shown.map(({ group }) => group)
	if (options.expandAccounts === 'full') {
		return {
			accounts: unique(shown.flatMap(({ accounts: sampled }) => sampled)),
			statuses: statusesShown,
			notification_groups,
		}
	}
	const full = unique(shown.flatMap(({ accounts: sampled }) => sampled.slice(0, 1)))
	const partial = unique(shown.flatMap(({ accounts: sampled }) => sampled.slice(1))).filter(
		(account) => !full.some((other) => other.id === account.id)
	)
	return {
		accounts: full,
		partial_accounts: partial.map(({ id, acct, locked, bot, url, avatar, avatar_static }) => ({
			id,
			acct,
			locked,
			bot,
			url,
			avatar,
			avatar_static,
		})),
		statuses: statusesShown,
		notification_groups,
	}
}

export type ListGroupedInput = {
	page: PageQuery
	types: string[]
	excludeTypes: string[]
	groupedTypes: string[] | null
	expandAccounts: ExpandAccounts
	present: Present
}

// A page of groups, with the cursors of its Link header: next (max_id) and prev (min_id), both whenever the page found
// a group (Api::V2::NotificationsController#next_path and #prev_path).
export type GroupedPage = GroupedNotifications & { next: string | null; prev: string | null }

// GET /api/v2/notifications: newest first by each group's first notification read; with min_id, the groups right
// above it, walked oldest first (each group's oldest notification above min_id stands for it) and answered newest
// first.
export const listGroupedNotifications = userReadOperation<ListGroupedInput, GroupedPage>(
	(db, input, _viewer, viewer) => {
		const { page } = input
		const ascending = page.minId !== undefined
		const walk = walkGroups(db, viewer, {
			ascending,
			maxId: page.maxId ?? null,
			minId: page.minId ?? page.sinceId ?? null,
			types: input.types,
			excludeTypes: input.excludeTypes,
			groupedTypes: input.groupedTypes,
			limit: page.limit,
		})
		const ordered = ascending ? walk.groups.toReversed() : walk.groups
		const groups = ordered.flatMap(({ key, rows }) => {
			const first = rows[0]
			return first === undefined ? [] : [{ key, first, rows: ascending ? rows.toReversed() : rows }]
		})
		const presented = presentGroups(db, viewer, groups, {
			paged: true,
			expandAccounts: input.expandAccounts,
			present: input.present,
		})
		// The page's ends are its groups' first notifications (pagination_max_id and pagination_since_id); a walk cut
		// short continues from the last notification read, so the next page does not read the same ones again.
		const newest = groups[0]?.first.id ?? null
		const oldest = groups.at(-1)?.first.id ?? null
		return {
			...presented,
			next: walk.cut && !ascending ? walk.last : oldest,
			prev: walk.cut && ascending ? walk.last : newest,
		}
	}
)

// The shown notification a group key names (Notification.by_group_key): `ungrouped-<id>` by its id, any other key by
// its group, the newest of it.
function firstOfGroup(db: Db, viewer: UserContext, groupKey: string): Shown | undefined {
	if (groupKey.startsWith('ungrouped-')) {
		const id = groupKey.slice('ungrouped-'.length)
		return NOTIFICATION_ID.test(id)
			? shownNotifications(db, viewer, 'n.id = CAST(?3 AS INTEGER)', '', id)[0]
			: undefined
	}
	return shownNotifications(db, viewer, 'n.group_key = ?3', 'ORDER BY n.id DESC LIMIT 1', groupKey)[0]
}

// GET /api/v2/notifications/:group_key: the group with every notification of it shown (up to groupWalkLimit of the
// default page, newest first), without page fields; null when it has none.
export const getNotificationGroup = userReadOperation<
	{ groupKey: string; present: Present },
	GroupedNotifications | null
>((db, { groupKey, present }, _viewer, viewer) => {
	const first = firstOfGroup(db, viewer, groupKey)
	if (first === undefined) {
		return null
	}
	const grouped = first.group_key !== null && GROUPABLE_TYPES.some((type) => type === first.type)
	const rows = grouped
		? shownNotifications(db, viewer, 'n.group_key = ?3', 'ORDER BY n.id DESC LIMIT ?4', first.group_key, GROUP_WALK)
		: [first]
	return presentGroups(db, viewer, [{ key: groupOf(first, GROUPABLE_TYPES), first, rows }], {
		paged: false,
		expandAccounts: 'full',
		present,
	})
})

// GET /api/v2/notifications/:group_key/accounts: the senders of the group's shown notifications, newest first, paged
// by notification id with max_id and since_id (Notifications::AccountsController, which reads no min_id and no
// `ungrouped-` key).
export const notificationGroupAccounts = userReadOperation<
	{ groupKey: string; page: PageQuery; present: Present },
	Page<Account>
>((db, { groupKey, page, present }, _viewer, viewer) => {
	const rows = shownNotifications(
		db,
		viewer,
		`n.group_key = ?3 AND ${edgeRangeSql('n.id', '?4', '?5')}`,
		'ORDER BY n.id DESC LIMIT ?6',
		groupKey,
		page.maxId ?? null,
		page.sinceId ?? null,
		page.limit
	)
	const accounts = presentAccountsById(
		db,
		rows.map((row) => row.from_account_id),
		present
	)
	return {
		items: rows.flatMap((row) => {
			const account = accounts.get(row.from_account_id)
			return account === undefined ? [] : [account]
		}),
		newest: rows[0]?.id ?? null,
		oldest: rows.at(-1)?.id ?? null,
	}
})

// POST /api/v2/notifications/:group_key/dismiss: deletes the viewer's notifications of the group, shown or not, as
// Mastodon's destroy_all of by_group_key; nothing for a key that names none.
export const dismissNotificationGroup = userWriteOperation<{ groupKey: string }, null>(
	(db, { groupKey }, { accountId }) => {
		if (groupKey.startsWith('ungrouped-')) {
			const id = groupKey.slice('ungrouped-'.length)
			if (NOTIFICATION_ID.test(id)) {
				db.run('DELETE FROM notifications WHERE account_id = ? AND id = CAST(? AS INTEGER)', accountId, id)
			}
			return null
		}
		db.run('DELETE FROM notifications WHERE account_id = ? AND group_key = ?', accountId, groupKey)
		return null
	}
)

// The viewer's notifications marker (last_read_id as stored, or null without one).
function notificationsMarker(db: Db, accountId: string): string | null {
	return (
		db.first<{ last_read_id: string }>(
			"SELECT last_read_id FROM markers WHERE account_id = ? AND timeline = 'notifications'",
			accountId
		)?.last_read_id ?? null
	)
}

export type UnreadCountInput = {
	limit: number
	types: string[]
	excludeTypes: string[]
	// v1 only: the sender (account_id).
	accountId: string | null
	// v2 only: grouped_types[] (null: none sent).
	groupedTypes: string[] | null
}

// GET /api/v1/notifications/unread_count: how many shown notifications are newer than the notifications marker's
// last_read_id (all of them without a marker), up to `limit`.
export const unreadCount = userReadOperation<UnreadCountInput, { count: number }>((db, input, _viewer, viewer) => {
	if (input.limit === 0) {
		return { count: 0 }
	}
	const rows = shownNotifications(
		db,
		viewer,
		`${edgeRangeSql('n.id', 'NULL', '?3')}
		AND (?4 IS NULL OR n.type IN (SELECT value FROM json_each(?4)))
		AND n.type NOT IN (SELECT value FROM json_each(?5))
		AND (?6 IS NULL OR n.from_account_id = ?6)`,
		'ORDER BY n.id ASC LIMIT ?7',
		notificationsMarker(db, viewer.accountId),
		input.types.length === 0 ? null : JSON.stringify(input.types),
		JSON.stringify(input.excludeTypes),
		input.accountId,
		input.limit
	)
	return { count: rows.length }
})

// GET /api/v2/notifications/unread_count: how many groups the notifications newer than the marker make, walked oldest
// first as a page above it, up to `limit` (and within groupWalkLimit(limit) notifications read).
export const unreadGroupCount = userReadOperation<UnreadCountInput, { count: number }>((db, input, _viewer, viewer) => {
	const walk = walkGroups(db, viewer, {
		ascending: true,
		maxId: null,
		minId: notificationsMarker(db, viewer.accountId),
		types: input.types,
		excludeTypes: input.excludeTypes,
		groupedTypes: input.groupedTypes,
		limit: input.limit,
	})
	return { count: walk.groups.length }
})
