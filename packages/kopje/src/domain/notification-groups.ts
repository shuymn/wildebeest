import {
	type Account,
	accountsOf,
	admitAccounts,
	type Page,
	type PageQuery,
	type PartialAccount,
	partialAccountsOf,
	type Present,
} from './accounts'
import { adminAccountIdOnce } from './admin-authority'
import { admittedPage, ANSWER_BYTES, ARRAY_ANSWER_BYTES, firstUses, jsonBytes } from './answer-budget'
import { statusReads } from './audience'
import { type UserContext, userReadOperation, userWriteOperation } from './auth'
import {
	GROUPABLE_TYPES,
	NOTIFICATION_COLUMNS,
	NOTIFICATION_ID,
	removeNotifications,
	type Scope,
	type ShownColumns,
	shownWindow,
} from './notifications'
import { presentReport, type Report } from './reports'
import { presentation, type Status, statusStream } from './status-presenter'
import { readWindow, windowOf, windowPage } from './windows'
import type { Db } from '../db/sql'

// Grouped notifications (Mastodon 4.5's API v2: Api::V2::NotificationsController, Notifications::AccountsController,
// NotificationGroup and Notification::Groups) and the unread counts of both versions. A notification's group is set
// when it is written (notify in notifications.ts); a notification without one is a group of its own,
// `ungrouped-<id>`. Every read goes through the notification rule (R15, statusReads(...).notifications), as the v1
// list does: a group counts, samples and pages only the notifications v1 would show the viewer now, so a sender since
// blocked or muted, or a status the viewer may no longer see, is neither shown nor counted. A notification the
// recipient's policy filtered is left out of the walk and the counts unless include_filtered asks for it; it has no
// group, so a group never holds one.
//
// Mastodon walks the notifications newest first and keeps the first of each group until it has a page of groups, then
// reads each group's notifications up to the page's upper end (NotificationGroup.load_groups_data): its count, its
// sample accounts and its newest, however far below the page they reach, and its oldest from the page's lower end.
// Kopje does the same, through the group index, with two bounds (RES-7): a walk reads at most GROUP_WALK
// notifications, skipping those of the groups it has found and those the rule hides, and a group's count reads at most
// GROUP_COUNT of them (shownWindow: candidates first, then the rule over them). A page ends early, with the groups
// found, only when its walk meets more than GROUP_WALK notifications of the groups it has already found or hidden
// (in practice a status favourited by thousands within a few hours); its Link continues from the last one read, so
// the walk goes on in the next page. A group's count, samples and oldest are of the shown among its newest GROUP_COUNT
// (oldest: from the page's lower end up).
//
// Dismissing a group and clearing remove its notifications, or all of them, as Mastodon's destroy_all and delete_all
// do: gone from every read at once (R15), and deleted in bounded batches in the request and the job rounds
// (removeNotifications in notifications.ts). A read of one group starts above its dismissal in the group index; the
// walk checks each notification's group by its key.

// Api::V2::NotificationsController::DEFAULT_NOTIFICATIONS_COUNT_LIMIT and MAX_NOTIFICATIONS_COUNT_LIMIT, which the v1
// controller shares.
export const DEFAULT_UNREAD_LIMIT = 100
export const MAX_UNREAD_LIMIT = 1_000

// NotificationGroup::SAMPLE_ACCOUNTS_SIZE.
const SAMPLE_ACCOUNTS = 8

// How many shown notifications a walk reads at most, for a page or an unread count (at most MAX_UNREAD_LIMIT groups).
export const GROUP_WALK = 2_000

// How many of a group's shown notifications its count reads at most: a larger group counts this many.
export const GROUP_COUNT = 400

// How many of a group's own notifications, shown or hidden, a read of the group by its key walks to find its newest
// shown one (firstOfGroup), through the group index (notifications_group): a group whose newest GROUP_DISCOVERY are all
// hidden is not found (404), whatever a page of the list shows.
export const GROUP_DISCOVERY = 20_000

// The types whose notifications show their status (REST::NotificationGroupSerializer#status_type?).
const STATUS_TYPES = new Set(['favourite', 'reblog', 'status', 'mention', 'poll', 'update', 'quote', 'quoted_update'])

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
	// An admin.report's report (REST::NotificationGroupSerializer#report_type?).
	report?: Report
}

// REST::DedupNotificationGroupSerializer: partial_accounts only with expand_accounts=partial_avatars.
export type GroupedNotifications = {
	accounts: Account[]
	partial_accounts?: PartialAccount[]
	statuses: Status[]
	notification_groups: NotificationGroup[]
}

export type ExpandAccounts = 'full' | 'partial_avatars'

// The viewer's notifications the rule shows them in `scope` that match `where` (over the parameters: ?1 is the viewer,
// ?2 the time of the read), in the order and number `tail` gives.
function shownNotifications(
	db: Db,
	viewer: UserContext,
	scope: Scope,
	where: string,
	tail: string,
	...params: (string | number | null)[]
) {
	const read = statusReads(viewer, { viewer: '?1', now: '?2' })
	return read.notifications<ShownColumns>(
		db,
		{ ...scope, where, tail, columns: NOTIFICATION_COLUMNS, admin: adminAccountIdOnce(db) },
		viewer.accountId,
		viewer.now,
		...params
	)
}

type Shown = ReturnType<typeof shownNotifications>[number]

// A group as a walk found it: its first notification read stands for it.
type Found = { key: string; first: Shown }

type WalkInput = {
	ascending: boolean
	// The cursors, as the client sent them (CAST to an integer, as Mastodon's to_i).
	maxId: string | null
	minId: string | null
	types: string[]
	excludeTypes: string[]
	// The types grouped: null for every groupable one.
	groupedTypes: string[] | null
	// include_filtered (Notification.browserable).
	includeFiltered: boolean
	limit: number
}

type Walk = {
	groups: Found[]
	// Whether the walk found `limit` groups.
	full: boolean
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

// Walks the viewer's notifications from the cursor (newest first, or oldest first when ascending) in chunks of a page
// and then in chunks twice as large as the last, keeping the first shown notification of each group, until `limit`
// groups are found, the notifications run out, or GROUP_WALK are read, shown or hidden.
function walkGroups(db: Db, viewer: UserContext, input: WalkInput): Walk {
	const grouped = groupedOf(input.groupedTypes)
	const groups = new Map<string, Found>()
	let { maxId, minId } = input
	let read = 0
	let last: string | null = null
	while (input.limit > 0) {
		const chunk = Math.min(Math.max(input.limit, read), GROUP_WALK - read)
		const { rows, candidates } = shownWindow(
			db,
			viewer,
			{ includeFiltered: input.includeFiltered, range: { max: '?3', min: '?4' } },
			`(?5 IS NULL OR n.type IN (SELECT value FROM json_each(?5)))
			AND n.type NOT IN (SELECT value FROM json_each(?6))`,
			`ORDER BY n.id ${input.ascending ? 'ASC' : 'DESC'} LIMIT ?7`,
			maxId,
			minId,
			input.types.length === 0 ? null : JSON.stringify(input.types),
			JSON.stringify(input.excludeTypes),
			chunk
		)
		const shown = new Map(rows.map((row) => [row.id, row]))
		for (const id of candidates) {
			read += 1
			last = id
			const row = shown.get(id)
			const key = row === undefined ? undefined : groupOf(row, grouped)
			if (row === undefined || key === undefined || groups.has(key)) {
				continue
			}
			groups.set(key, { key, first: row })
			if (groups.size === input.limit) {
				return { groups: [...groups.values()], full: true, cut: false, last }
			}
		}
		if (candidates.length < chunk) {
			break
		}
		if (read >= GROUP_WALK) {
			return { groups: [...groups.values()], full: false, cut: true, last }
		}
		if (input.ascending) {
			minId = last
		} else {
			maxId = last
		}
	}
	return { groups: [...groups.values()], full: false, cut: false, last }
}

// The ids a page's groups are read between (NotificationGroup.load_groups_data's pagination_range), both inclusive,
// null for no end.
type Range = { lower: string | null; upper: string | null }

// A group's shown notifications among its newest GROUP_COUNT up to the range's upper end, with the walk's first one of
// it in the last slot when they miss it, newest first; with no grouped key, its first one alone.
function membersOf(db: Db, viewer: UserContext, group: Found, upper: string | null): Shown[] {
	if (group.key.startsWith('ungrouped-')) {
		return [group.first]
	}
	const { rows } = shownWindow(
		db,
		viewer,
		{ includeFiltered: false, range: { max: 'CAST(?4 AS INTEGER) + 1', min: 'NULL' }, group: '?3' },
		'',
		'ORDER BY n.id DESC LIMIT ?5',
		group.key,
		upper,
		GROUP_COUNT
	)
	// One slot is kept for the walk's own find, which the rule already passed: a group whose newest are hidden keeps it.
	if (rows.some((row) => row.id === group.first.id)) {
		return rows
	}
	const byId = (a: Shown, b: Shown) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0)
	return [...rows.slice(0, GROUP_COUNT - 1), group.first].sort(byId)
}

// The id of a group's oldest shown notification from the range's lower end up (load_groups_data's min_id), among the
// GROUP_COUNT oldest there; the group's first one read when none is shown.
function oldestOf(db: Db, viewer: UserContext, group: Found, lower: string | null): string {
	if (group.key.startsWith('ungrouped-')) {
		return group.first.id
	}
	return (
		shownWindow(
			db,
			viewer,
			{ includeFiltered: false, range: { max: 'NULL', min: 'CAST(?4 AS INTEGER) - 1' }, group: '?3' },
			'',
			'ORDER BY n.id ASC LIMIT ?5',
			group.key,
			lower,
			GROUP_COUNT
		).rows[0]?.id ?? group.first.id
	)
}

// A group as the answer holds it: its entity, the ids of its sample accounts that are shown, and its status.
type PresentedGroup = { group: NotificationGroup; samples: string[]; status: Status | undefined }

// The groups admitted into an answer, with the accounts and statuses they add, each once.
type AdmittedGroups = {
	groups: PresentedGroup[]
	// The groups walked: the admitted ones, and those with nothing to show before the first one left out.
	consumed: number
	// The groups walked up to the first one admitted, that one included.
	leading: number
	cut: boolean
	accounts: Map<string, Account>
	partial: Map<string, { account: PartialAccount; bytes: number }>
	statuses: Map<string, Status>
}

// The empty answer of a mode, whose JSON (keys and brackets) the budget reserves.
function emptyAnswer(expandAccounts: ExpandAccounts): GroupedNotifications {
	return expandAccounts === 'full'
		? { accounts: [], statuses: [], notification_groups: [] }
		: { accounts: [], partial_accounts: [], statuses: [], notification_groups: [] }
}

// The groups presented (NotificationGroup.from_notifications and GroupedNotificationsPresenter) and admitted (RES-3) in
// discovery order (`groups`, as the walk found them): each with its notifications found up to the range (membersOf,
// read when admission reaches the group), newest first, its first one standing for it (type and status). With a
// `range`, the page fields of each. A group counts with what it adds to the answer, each account and status once: its
// entity, its status unless an admitted group shows it, and its sample accounts unless shown; with partial_avatars,
// its first sample as an account (a partial account shown so far moves to the accounts), the others as partial
// accounts unless shown either way. Admission stops at the first group that does not fit `budget`, after the first.
// A group whose status or accounts the presenter cannot show is left out, as v1 leaves out such a notification.
function admitGroups(
	db: Db,
	viewer: UserContext,
	groups: readonly Found[],
	range: Range | null,
	statusOf: (id: string) => Status | undefined,
	options: { expandAccounts: ExpandAccounts; present: Present },
	budget: number
): AdmittedGroups {
	const admitted: AdmittedGroups = {
		groups: [],
		consumed: 0,
		leading: 0,
		cut: false,
		accounts: new Map(),
		partial: new Map(),
		statuses: new Map(),
	}
	const partialMode = options.expandAccounts === 'partial_avatars'
	let bytes = 0
	for (const found of groups) {
		const { key, first } = found
		const rows = membersOf(db, viewer, found, range?.upper ?? null)
		const newest = rows[0]
		const sampleIds = [...new Set(rows.slice(0, SAMPLE_ACCOUNTS).map((row) => row.from_account_id))]
		// The sample accounts the group would add: whole (all of them, or the first shown with partial_avatars), and
		// partial (the others with partial_avatars), each with its JSON bytes.
		const unknown = sampleIds.filter((id) => !admitted.accounts.has(id) && !admitted.partial.has(id))
		const partial = new Map<string, { account: PartialAccount; bytes: number }>()
		if (partialMode) {
			const reading = partialAccountsOf(db, unknown, options.present, SAMPLE_ACCOUNTS)
			for (const id of unknown) {
				const account = reading.next().value
				if (account !== undefined) {
					partial.set(id, { account, bytes: jsonBytes(account) + 1 })
				}
			}
		}
		const shown = (id: string) => admitted.accounts.has(id) || admitted.partial.has(id) || partial.has(id)
		const sampled = partialMode ? sampleIds.filter(shown) : []
		const whole = new Map<string, Account>()
		const wholeIds = partialMode
			? sampled.slice(0, 1).filter((id) => !admitted.accounts.has(id))
			: unknown.filter((id) => !admitted.accounts.has(id))
		const presented = accountsOf(db, wholeIds, options.present, SAMPLE_ACCOUNTS)
		for (const id of wholeIds) {
			const account = presented.next().value
			if (account !== undefined) {
				whole.set(id, account)
			}
		}
		const samples = partialMode ? sampled : sampleIds.filter((id) => admitted.accounts.has(id) || whole.has(id))
		const status = first.status_id === null ? undefined : statusOf(first.status_id)
		const report = first.report_id === null ? undefined : presentReport(db, first.report_id, options.present)
		if (
			newest === undefined ||
			samples.length === 0 ||
			(first.status_id !== null && status === undefined) ||
			(first.report_id !== null && report === undefined)
		) {
			admitted.consumed++
			continue
		}
		const group: NotificationGroup = {
			group_key: key,
			notifications_count: rows.length,
			type: first.type,
			most_recent_notification_id: Number(newest.id),
			...(range === null
				? {}
				: {
						page_min_id: oldestOf(db, viewer, found, range.lower),
						page_max_id: newest.id,
						latest_page_notification_at: newest.created_at,
					}),
			sample_account_ids: samples,
			...(STATUS_TYPES.has(first.type) ? { status_id: status?.id ?? null } : {}),
			...(report === undefined ? {} : { report }),
		}
		// What the group adds, each with a separator.
		let size = jsonBytes(group) + 1
		if (status !== undefined && !admitted.statuses.has(status.id)) {
			size += jsonBytes(status) + 1
		}
		for (const account of whole.values()) {
			size += jsonBytes(account) + 1
		}
		const promoted = [...whole.keys()].flatMap((id) => admitted.partial.get(id) ?? [])
		size -= promoted.reduce((sum, entry) => sum + entry.bytes, 0)
		const added = [...partial].filter(([id]) => !whole.has(id) && samples.includes(id))
		size += added.reduce((sum, [, entry]) => sum + entry.bytes, 0)
		if (bytes + size > budget && admitted.groups.length > 0) {
			admitted.cut = true
			return admitted
		}
		bytes += size
		admitted.consumed++
		if (admitted.groups.length === 0) {
			admitted.leading = admitted.consumed
		}
		for (const [id, account] of whole) {
			admitted.accounts.set(id, account)
			admitted.partial.delete(id)
		}
		for (const [id, entry] of added) {
			admitted.partial.set(id, entry)
		}
		if (status !== undefined) {
			admitted.statuses.set(status.id, status)
		}
		admitted.groups.push({ group, samples, status })
	}
	return admitted
}

// The answer of admitted groups, `ordered` (newest first): each array in the groups' order, each item once; with
// partial_avatars, the first sample of each group as an account and the others as partial accounts.
function answerOf(
	admitted: AdmittedGroups,
	ordered: readonly PresentedGroup[],
	expandAccounts: ExpandAccounts
): GroupedNotifications {
	const unique = <T>(items: readonly T[]) => [...new Set(items)]
	const statuses = unique(ordered.flatMap(({ status }) => (status === undefined ? [] : [status])))
	const notification_groups = ordered.map(({ group }) => group)
	const accountsOf = (ids: readonly string[]) => ids.flatMap((id) => admitted.accounts.get(id) ?? [])
	if (expandAccounts === 'full') {
		return { accounts: unique(ordered.flatMap(({ samples }) => accountsOf(samples))), statuses, notification_groups }
	}
	return {
		accounts: unique(ordered.flatMap(({ samples }) => accountsOf(samples.slice(0, 1)))),
		partial_accounts: unique(
			ordered.flatMap(({ samples }) => samples.flatMap((id) => admitted.partial.get(id) ?? []))
		).map((entry) => entry.account),
		statuses,
		notification_groups,
	}
}

export type ListGroupedInput = {
	page: PageQuery
	types: string[]
	excludeTypes: string[]
	groupedTypes: string[] | null
	includeFiltered: boolean
	expandAccounts: ExpandAccounts
	present: Present
}

// A page of groups, with the cursors of its Link header: next (max_id) and prev (min_id), both whenever the page found
// a group (Api::V2::NotificationsController#next_path and #prev_path).
export type GroupedPage = GroupedNotifications & { next: string | null; prev: string | null }

// The range of a page (Api::V2::NotificationsController#load_grouped_notifications), with `ordered` its groups newest
// first: between its groups' first notifications; on a last page (no more notifications), down to since_id (or the
// oldest) or, walking up, to below max_id (or the newest). A walk cut short reaches as far as it read.
function pageRange(walk: Walk, ordered: readonly Found[], ascending: boolean, page: PageQuery): Range {
	const newest = ordered[0]?.first.id ?? null
	const oldest = ordered.at(-1)?.first.id ?? null
	if (walk.full) {
		return { lower: oldest, upper: newest }
	}
	if (ascending) {
		const below = page.maxId === undefined ? null : String(BigInt(page.maxId) - 1n)
		return { lower: oldest, upper: walk.cut ? walk.last : below }
	}
	const above = page.sinceId === undefined ? null : String(BigInt(page.sinceId) + 1n)
	return { lower: walk.cut ? walk.last : above, upper: newest }
}

// Admission passes over a page's groups after the first, each over the range of the groups the one before kept,
// before the page falls back to its first group alone: at most four passes in all (the first, MAX_READMISSIONS, and the
// first group alone).
const MAX_READMISSIONS = 2

// GET /api/v2/notifications: newest first by each group's first notification read; with min_id, the groups right
// above it, walked oldest first (each group's oldest notification above min_id stands for it) and answered newest
// first.
// The answer is within ANSWER_BYTES (RES-3): groups are admitted in discovery order (admitGroups). Cut by bytes, the
// page is the groups up to the last one admitted, as if the walk had found those alone: its range (membersOf,
// oldestOf) and cursors are of those groups, and the walk's continuation (a walk cut at GROUP_WALK), which lies past
// a group left out, is dropped. Those groups are then admitted again over that range, since sampling below a lower
// upper end can show other accounts; while they do not all fit, the last ones are dropped the same way, at most
// MAX_READMISSIONS times, after which the page is its first group alone, over its own range. A group left out is
// found again by the next page.
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
			includeFiltered: input.includeFiltered,
			limit: page.limit,
		})
		// One presentation of the groups' statuses; each pass presents the statuses of its own groups, each once, so a
		// pass holds nothing of a group an earlier pass dropped.
		const statusesOf = (groups: readonly Found[]) => [
			...new Set(groups.flatMap(({ first }) => (first.status_id === null ? [] : [first.status_id]))),
		]
		const shared = presentation(db, statusesOf(walk.groups), { ...input.present, viewer })
		const budget = ANSWER_BYTES - jsonBytes(emptyAnswer(input.expandAccounts))
		let read = walk
		for (let round = 0; ; round++) {
			const ordered = ascending ? read.groups.toReversed() : read.groups
			const statusIds = statusesOf(read.groups)
			const admitted = admitGroups(
				db,
				viewer,
				read.groups,
				pageRange(read, ordered, ascending, page),
				// One status's rows at a time ("Heap at 8 MiB per answer" in docs/threat-model.md).
				firstUses(statusIds, statusStream(db, shared, statusIds, 1)),
				input,
				budget
			)
			if (admitted.cut) {
				// After MAX_READMISSIONS passes that still do not fit, the first group alone, over its own range.
				const groups = read.groups.slice(0, round < MAX_READMISSIONS ? admitted.consumed : admitted.leading)
				read = { groups, full: true, cut: false, last: groups.at(-1)?.first.id ?? null }
				continue
			}
			const shown = ascending ? admitted.groups.toReversed() : admitted.groups
			// The page's ends are its groups' first notifications (pagination_max_id and pagination_since_id); a walk cut
			// short continues from the last notification read, so the next page does not read the same ones again.
			const newest = ordered[0]?.first.id ?? null
			const oldest = ordered.at(-1)?.first.id ?? null
			return {
				...answerOf(admitted, shown, input.expandAccounts),
				next: read.cut && !ascending ? read.last : oldest,
				prev: read.cut && ascending ? read.last : newest,
			}
		}
	}
)

// The shown notification a group key names (Notification.by_group_key): `ungrouped-<id>` by its id, any other key by
// its group, the newest of it. Api::V2::NotificationsController#show reads any of the viewer's notifications, filtered
// or not (no browserable); a filtered notification has no group, so only its `ungrouped-` key names it. A group's
// newest shown one is found by a walk of that group's own notifications from the newest, through the group index, in
// chunks of GROUP_WALK, as far as GROUP_DISCOVERY of them.
function firstOfGroup(db: Db, viewer: UserContext, groupKey: string): Shown | undefined {
	if (groupKey.startsWith('ungrouped-')) {
		const id = groupKey.slice('ungrouped-'.length)
		return NOTIFICATION_ID.test(id)
			? shownNotifications(db, viewer, { includeFiltered: true }, 'n.id = CAST(?3 AS INTEGER)', '', id)[0]
			: undefined
	}
	let max: string | null = null
	for (let read = 0; read < GROUP_DISCOVERY;) {
		const chunk = Math.min(GROUP_WALK, GROUP_DISCOVERY - read)
		const { rows, candidates } = shownWindow(
			db,
			viewer,
			{ includeFiltered: false, range: { max: '?4', min: 'NULL' }, group: '?3' },
			'',
			'ORDER BY n.id DESC LIMIT ?5',
			groupKey,
			max,
			chunk
		)
		if (rows[0] !== undefined) {
			return rows[0]
		}
		if (candidates.length < chunk) {
			return undefined
		}
		read += candidates.length
		max = candidates.at(-1) ?? null
	}
	return undefined
}

// GET /api/v2/notifications/:group_key: the group with its shown notifications among its newest GROUP_COUNT and the
// one firstOfGroup found (membersOf), newest first, without page fields; null when firstOfGroup finds none.
export const getNotificationGroup = userReadOperation<
	{ groupKey: string; present: Present },
	GroupedNotifications | null
>((db, { groupKey, present }, _viewer, viewer) => {
	const first = firstOfGroup(db, viewer, groupKey)
	if (first === undefined) {
		return null
	}
	// One group, a unit (RES-3, "Maxima of presented units").
	const found = { key: groupOf(first, GROUPABLE_TYPES), first }
	const status = first.status_id === null ? [] : [first.status_id]
	const statusOf = firstUses(status, statusStream(db, presentation(db, status, { ...present, viewer }), status))
	const options = { expandAccounts: 'full', present } as const
	const admitted = admitGroups(db, viewer, [found], null, statusOf, options, Infinity)
	return answerOf(admitted, admitted.groups, 'full')
})

// GET /api/v2/notifications/:group_key/accounts: the senders of the group's shown notifications, newest first, paged
// by notification id with max_id and since_id (Notifications::AccountsController, which reads no min_id and no
// `ungrouped-` key). A page reads a window of readWindow(limit) of the group's notifications from the cursor.
export const notificationGroupAccounts = userReadOperation<
	{ groupKey: string; page: PageQuery; present: Present },
	Page<Account>
>((db, { groupKey, page, present }, _viewer, viewer) => {
	const size = readWindow(page.limit)
	// A group's notifications are never filtered (a filtered notification has no group).
	const { rows, candidates } = shownWindow(
		db,
		viewer,
		{ includeFiltered: false, range: { max: '?4', min: '?5' }, group: '?3' },
		'',
		'ORDER BY n.id DESC LIMIT ?6',
		groupKey,
		page.maxId ?? null,
		page.sinceId ?? null,
		size
	)
	const shown = windowPage(windowOf(candidates, size), rows, (row) => row.id, page.limit, false)
	return admittedPage(
		shown,
		false,
		(row) => row.id,
		(traversal) =>
			admitAccounts(
				db,
				traversal.map((row) => row.from_account_id),
				present,
				ARRAY_ANSWER_BYTES,
				true
			)
	)
})

// POST /api/v2/notifications/:group_key/dismiss: removes the viewer's notifications of the group, shown or not, as
// Mastodon's destroy_all of by_group_key: gone from every read at once and deleted in batches (removeNotifications);
// an `ungrouped-` key's one notification is deleted at once. Nothing for a key that names none.
export const dismissNotificationGroup = userWriteOperation<{ groupKey: string }, null>(
	(db, { groupKey }, { accountId }) => {
		if (groupKey.startsWith('ungrouped-')) {
			const id = groupKey.slice('ungrouped-'.length)
			if (NOTIFICATION_ID.test(id)) {
				db.run('DELETE FROM notifications WHERE account_id = ? AND id = CAST(? AS INTEGER)', accountId, id)
			}
			return null
		}
		removeNotifications(db, accountId, groupKey)
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
	// include_filtered; in v1, a sender (account_id) shows filtered ones too (Notification.browserable).
	includeFiltered: boolean
}

// GET /api/v1/notifications/unread_count: how many shown notifications are newer than the notifications marker's
// last_read_id (all of them without a marker), up to `limit`, among the GROUP_WALK from the marker, shown or hidden
// (as the grouped count's walk).
export const unreadCount = userReadOperation<UnreadCountInput, { count: number }>((db, input, _viewer, viewer) => {
	if (input.limit === 0) {
		return { count: 0 }
	}
	let shown = 0
	let read = 0
	let min = notificationsMarker(db, viewer.accountId)
	while (shown < input.limit && read < GROUP_WALK) {
		const chunk = Math.min(Math.max(input.limit, read), GROUP_WALK - read)
		const { rows, candidates } = shownWindow(
			db,
			viewer,
			{ includeFiltered: input.includeFiltered || input.accountId !== null, range: { max: 'NULL', min: '?3' } },
			`(?4 IS NULL OR n.type IN (SELECT value FROM json_each(?4)))
			AND n.type NOT IN (SELECT value FROM json_each(?5))
			AND (?6 IS NULL OR n.from_account_id = ?6)`,
			'ORDER BY n.id ASC LIMIT ?7',
			min,
			input.types.length === 0 ? null : JSON.stringify(input.types),
			JSON.stringify(input.excludeTypes),
			input.accountId,
			chunk
		)
		shown += rows.length
		read += candidates.length
		min = candidates.at(-1) ?? min
		if (candidates.length < chunk) {
			break
		}
	}
	return { count: Math.min(shown, input.limit) }
})

// GET /api/v2/notifications/unread_count: how many groups the notifications newer than the marker make, walked oldest
// first as a page above it, up to `limit` (and within GROUP_WALK notifications read).
export const unreadGroupCount = userReadOperation<UnreadCountInput, { count: number }>((db, input, _viewer, viewer) => {
	const walk = walkGroups(db, viewer, {
		ascending: true,
		maxId: null,
		minId: notificationsMarker(db, viewer.accountId),
		types: input.types,
		excludeTypes: input.excludeTypes,
		groupedTypes: input.groupedTypes,
		includeFiltered: input.includeFiltered,
		limit: input.limit,
	})
	return { count: walk.groups.length }
})
