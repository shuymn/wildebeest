import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { rowsRead } from './read-helpers'
import { listFollowRequests, listFollows, type Page, type PageQuery } from '../src/domain/accounts'
import { getOutbox } from '../src/domain/activities'
import { listEndorsements } from '../src/domain/endorsements'
import { listAccounts } from '../src/domain/lists'
import { listGroupedNotifications, notificationGroupAccounts } from '../src/domain/notification-groups'
import { getNotificationPolicy, listNotificationRequests } from '../src/domain/notification-requests'
import { listNotifications } from '../src/domain/notifications'
import { interactors } from '../src/domain/statuses'
import {
	accountStatuses,
	bookmarks,
	favourites,
	homeTimeline,
	listTimeline,
	publicTimeline,
	tagTimeline,
} from '../src/domain/timelines'
import { profilePage } from '../src/domain/web-pages'
import type { StoreStub } from '../src/platform/store-client'
import type { StoreOperation } from '../src/platform/store-kernel'

// Candidate windows (src/domain/windows.ts, docs/visibility.md "Read bounds", RES-7): every paged read that filters
// through availability, visibility, blocks, mutes or domain blocks reads a window from its cursor, so a dense hidden
// range in front of the visible rows costs a window per request, not its length, and paging moves through it.
//
// The world: the viewer follows FRIEND and lists FRIEND; everything visible (FRIEND's statuses, the edges and
// notifications on them, the follows and requests of available accounts) is older than the hidden range, or, with
// `newer`, also newer. The hidden range is `hidden` rows of each kind, newest:
//   - availability (an account being deleted): GHOST's public statuses, FRIEND's boosts of them (home, the list,
//     FRIEND's statuses), the viewer's bookmarks and favourites of them, GHOST's mentions of the viewer, and GONE_i
//     (each being deleted) as notification and follow request senders, list members and endorsements, and as
//     favouriters of FRIEND's status;
//   - a block: BLOCKED's public #cats statuses;
//   - a domain block: DOMAINED's public statuses;
//   - a mute: MUTED_i following FRIEND;
//   - availability again: LOCAL's boosts of GHOST's statuses (its outbox).
// With `privates`, LOCAL's private statuses, newer than its others, are hidden by visibility: no window takes them as
// candidates, so they never supply a cursor (docs/visibility.md "Read bounds"); the walk passes them, so they are not
// part of the growth cases.

const PRESENT = { origin: 'https://kopje.test' }
const PAGE = { limit: 20 }
const ALLOWANCE = 10
const TOKEN = 'read-windows-token'
const credential = { tokenHash: TOKEN, scope: 'read', now: NOW } as const

const VIEWER = '900000000000000001'
const FRIEND = '900000000000000002'
const GHOST = '900000000000000003'
const BLOCKED = '900000000000000004'
const DOMAINED = '900000000000000005'
const LOCAL = '900000000000000006'
const LIST = '900000000000000007'
// The list whose members are read: its timeline would read a stream per member (the owner's own choice, not a range).
const MEMBERS = '900000000000000008'
// Enough that the few hidden rows and these fill every window (readWindow: 60, or 63 for the outbox's 21).
const OLDER = 50
const id = (base: bigint, i: number) => String(base + BigInt(i))
// Accounts: available older ones (listed by account id below the hidden range), GONE_i, newer available ones, MUTED_i.
const VISIBLE_ACCOUNT = 910000000000000000n
const GONE_ACCOUNT = 920000000000000000n
const NEWER_ACCOUNT = 930000000000000000n
const MUTED_ACCOUNT = 940000000000000000n
// Statuses.
const FRIEND_OLDER = 700000000000000000n
const LOCAL_OLDER = 600000000000000000n
// GHOST's statuses are the newest of the hidden public ones, so both worlds' public windows start with them.
const GHOST_STATUS = 840000000000000000n
const FRIEND_BOOST = 810000000000000000n
const BLOCKED_STATUS = 820000000000000000n
const DOMAINED_STATUS = 830000000000000000n
const LOCAL_PRIVATE = 850000000000000000n
const LOCAL_BOOST = 860000000000000000n
// Boosts of FRIEND's second status (reblogged_by).
const BOOST_OLDER = 750000000000000000n
const BOOST_HIDDEN = 760000000000000000n
const BOOST_NEWER = 897000000000000000n
const FRIEND_NEWER = 890000000000000000n
const LOCAL_NEWER = 895000000000000000n

async function world(hidden: number, newer = 0, privates = 0): Promise<StoreStub> {
	const store = await migratedStore()
	await runInDurableObject(store, (_instance, state) => {
		const sql = state.storage.sql
		const at = new Date(NOW).toISOString()
		const remote = (account: string, name: string, domain: string, deleting = false) =>
			sql.exec(
				'INSERT INTO accounts (id, uri, username, domain, deleted_at) VALUES (?, ?, ?, ?, ?)',
				account,
				`https://${domain}/users/${name}`,
				name,
				domain,
				deleting ? at : null
			)
		const local = (account: string, name: string) => {
			sql.exec(
				'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
				account,
				`https://kopje.test/ap/users/${name}`,
				name
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
				account,
				`${name}@example.com`
			)
		}
		// `query` over n(i), the numbers 0 to `count` - 1, with ?1 the count, ?2 `base` and `params` from ?3.
		const each = (count: number, base: bigint, query: string, ...params: SqlStorageValue[]) =>
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1) ${query}`,
				count,
				String(base),
				...params
			)
		// `count` accounts from `base`, on `domain`, being deleted or not.
		const accounts = (base: bigint, count: number, domain: string, deleting: boolean) =>
			each(
				count,
				base,
				`INSERT INTO accounts (id, uri, username, domain, deleted_at)
				SELECT CAST(?2 + i AS TEXT), 'https://' || ?3 || '/users/a' || (?2 + i), 'a' || (?2 + i), ?3, ?4 FROM n WHERE ?1 > 0`,
				domain,
				deleting ? at : null
			)
		// `count` statuses of `author` from `base`, with a hashtag and, for boosts, the originals from `reblogOf`.
		const statuses = (
			base: bigint,
			count: number,
			author: string,
			visibility: string,
			reblogOf: bigint | null = null
		) =>
			each(
				count,
				base,
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id)
				SELECT CAST(?2 + i AS TEXT), 'https://example.test/objects/' || (?2 + i), ?3, ?4,
					CASE WHEN ?6 IS NULL THEN '<p>#cats</p>' ELSE '' END, ?5,
					CASE WHEN ?6 IS NULL THEN NULL ELSE CAST(?6 + i AS TEXT) END
				FROM n WHERE ?1 > 0`,
				author,
				visibility,
				at,
				reblogOf === null ? null : String(reblogOf)
			)
		const tagged = (base: bigint, count: number) =>
			each(
				count,
				base,
				`INSERT INTO status_tags (status_id, name, public) SELECT CAST(?2 + i AS TEXT), 'cats', 1 FROM n WHERE ?1 > 0`
			)
		// The viewer's edges (favourites, bookmarks) and notifications on `count` statuses from `base`, in id order.
		const edges = (base: bigint, count: number, from: string) => {
			for (const table of ['favourites', 'bookmarks']) {
				each(
					count,
					base,
					`INSERT INTO ${table} (account_id, status_id) SELECT ?3, CAST(?2 + i AS TEXT) FROM n WHERE ?1 > 0`,
					VIEWER
				)
			}
			each(
				count,
				base,
				`INSERT INTO notifications (account_id, type, from_account_id, status_id)
				SELECT ?3, 'mention', ?4, CAST(?2 + i AS TEXT) FROM n WHERE ?1 > 0`,
				VIEWER,
				from
			)
		}
		// Rows of `table` from the viewer (or to FRIEND, for follows) to `count` accounts from `base`, in id order.
		const toAccounts = (base: bigint, count: number) => {
			each(
				count,
				base,
				`INSERT INTO notification_requests (account_id, from_account_id) SELECT ?3, CAST(?2 + i AS TEXT) FROM n WHERE ?1 > 0`,
				VIEWER
			)
			each(
				count,
				base,
				`INSERT INTO list_accounts (list_id, account_id) SELECT ?3, CAST(?2 + i AS TEXT) FROM n WHERE ?1 > 0`,
				MEMBERS
			)
			each(
				count,
				base,
				`INSERT INTO account_pins (account_id, target_account_id) SELECT ?3, CAST(?2 + i AS TEXT) FROM n WHERE ?1 > 0`,
				VIEWER
			)
			each(
				count,
				base,
				`INSERT INTO favourites (account_id, status_id) SELECT CAST(?2 + i AS TEXT), ?3 FROM n WHERE ?1 > 0`,
				id(FRIEND_OLDER, 0)
			)
			each(
				count,
				base,
				`INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(?2 + i AS TEXT), ?3, 'pending' FROM n
				WHERE ?1 > 0`,
				VIEWER
			)
		}
		// `count` accounts from `base` follow FRIEND, FRIEND follows them, and they boost FRIEND's second status (the
		// boosts' ids from `boosts`), in id order.
		const followers = (base: bigint, count: number, boosts: bigint) => {
			each(
				count,
				base,
				`INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(?2 + i AS TEXT), ?3, 'accepted' FROM n
				WHERE ?1 > 0`,
				FRIEND
			)
			each(
				count,
				base,
				`INSERT INTO follows (account_id, target_account_id, state) SELECT ?3, CAST(?2 + i AS TEXT), 'accepted' FROM n
				WHERE ?1 > 0`,
				FRIEND
			)
			each(
				count,
				base,
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id)
				SELECT CAST(?3 + i AS TEXT), 'https://example.test/boosts/' || (?3 + i), CAST(?2 + i AS TEXT), 'public', '', ?5, ?4
				FROM n WHERE ?1 > 0`,
				String(boosts),
				id(FRIEND_OLDER, 1),
				at
			)
		}

		local(VIEWER, 'viewer')
		local(LOCAL, 'local')
		remote(FRIEND, 'friend', 'friend.example')
		remote(GHOST, 'ghost', 'ghost.example', true)
		remote(BLOCKED, 'blocked', 'blocking.example')
		remote(DOMAINED, 'domained', 'blocked.example')
		sql.exec(
			"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('windows', 'secret', 'windows', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
		)
		sql.exec(
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'windows', ?, 'read')",
			TOKEN,
			VIEWER
		)
		sql.exec("INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", VIEWER, FRIEND)
		sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER, BLOCKED)
		sql.exec("INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", VIEWER)
		sql.exec(
			"INSERT INTO lists (id, account_id, title, replies_policy) VALUES (?, ?, 'friends', 'followed')",
			LIST,
			VIEWER
		)
		sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', LIST, FRIEND)
		sql.exec("INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'members')", MEMBERS, VIEWER)

		accounts(VISIBLE_ACCOUNT, OLDER, 'visible.example', false)
		accounts(GONE_ACCOUNT, hidden, 'gone.example', true)
		accounts(NEWER_ACCOUNT, newer, 'visible.example', false)
		accounts(MUTED_ACCOUNT, hidden, 'muted.example', false)
		sql.exec(
			`INSERT INTO mutes (account_id, target_account_id)
			SELECT ?1, id FROM accounts WHERE id >= ?2 AND id < ?3`,
			VIEWER,
			String(MUTED_ACCOUNT),
			String(MUTED_ACCOUNT + 1000000n)
		)

		// Older visible rows, then the hidden range, then newer visible rows: ids and edge ids in that order.
		statuses(FRIEND_OLDER, OLDER, FRIEND, 'public')
		tagged(FRIEND_OLDER, OLDER)
		statuses(LOCAL_OLDER, OLDER, LOCAL, 'public')
		edges(FRIEND_OLDER, OLDER, FRIEND)
		toAccounts(VISIBLE_ACCOUNT, OLDER)
		followers(VISIBLE_ACCOUNT, OLDER, BOOST_OLDER)

		statuses(GHOST_STATUS, hidden, GHOST, 'public')
		statuses(FRIEND_BOOST, hidden, FRIEND, 'public', GHOST_STATUS)
		statuses(BLOCKED_STATUS, hidden, BLOCKED, 'public')
		tagged(BLOCKED_STATUS, hidden)
		statuses(DOMAINED_STATUS, hidden, DOMAINED, 'public')
		statuses(LOCAL_PRIVATE, privates, LOCAL, 'private')
		statuses(LOCAL_BOOST, hidden, LOCAL, 'public', GHOST_STATUS)
		edges(GHOST_STATUS, hidden, GHOST)
		toAccounts(GONE_ACCOUNT, hidden)
		followers(MUTED_ACCOUNT, hidden, BOOST_HIDDEN)

		statuses(FRIEND_NEWER, newer, FRIEND, 'public')
		tagged(FRIEND_NEWER, newer)
		statuses(LOCAL_NEWER, newer, LOCAL, 'public')
		edges(FRIEND_NEWER, newer, FRIEND)
		toAccounts(NEWER_ACCOUNT, newer)
		followers(NEWER_ACCOUNT, newer, BOOST_NEWER)
	})
	return store
}

type Read = {
	name: string
	operation: StoreOperation<never, unknown>
	input: (page: PageQuery) => unknown
	// The ids the read lists, newest first, in a world with `newer` newer visible rows.
	expected: (newer: number) => string[]
	// The item's id as the expected list names it, and whether the read pages by min_id too.
	key?: (item: { id: string }) => string
	minId?: boolean
}

const range = (base: bigint, count: number) => Array.from({ length: count }, (_, i) => id(base, count - 1 - i))
const friendStatuses = (newer: number) => [...range(FRIEND_NEWER, newer), ...range(FRIEND_OLDER, OLDER)]
const visibleAccounts = (newer: number) => [...range(NEWER_ACCOUNT, newer), ...range(VISIBLE_ACCOUNT, OLDER)]
const byId = (ids: string[]) => [...ids].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1))

const READS: Read[] = [
	{
		name: 'home',
		operation: homeTimeline,
		input: (page) => ({ credential, page, present: PRESENT }),
		expected: friendStatuses,
		minId: true,
	},
	{
		name: 'list',
		operation: listTimeline,
		input: (page) => ({ credential, id: LIST, page, present: PRESENT }),
		expected: friendStatuses,
		minId: true,
	},
	{
		name: 'public',
		operation: publicTimeline,
		input: (page) => ({ credential, now: NOW, page, local: false, remote: false, onlyMedia: false, present: PRESENT }),
		expected: (newer) => byId([...friendStatuses(newer), ...range(LOCAL_NEWER, newer), ...range(LOCAL_OLDER, OLDER)]),
		minId: true,
	},
	{
		name: 'hashtag',
		operation: tagTimeline,
		input: (page) => ({
			credential,
			now: NOW,
			page,
			tag: 'cats',
			any: [],
			all: [],
			none: [],
			local: false,
			remote: false,
			onlyMedia: false,
			present: PRESENT,
		}),
		expected: friendStatuses,
		minId: true,
	},
	{
		name: 'account statuses',
		operation: accountStatuses,
		input: (page) => ({
			credential,
			now: NOW,
			account: FRIEND,
			page,
			onlyMedia: false,
			excludeReplies: false,
			excludeReblogs: false,
			pinned: false,
			tagged: null,
			present: PRESENT,
		}),
		expected: friendStatuses,
		minId: true,
	},
	{
		name: 'bookmarks',
		operation: bookmarks,
		input: (page) => ({ credential, page, present: PRESENT }),
		expected: friendStatuses,
		minId: true,
	},
	{
		name: 'favourites',
		operation: favourites,
		input: (page) => ({ credential, page, present: PRESENT }),
		expected: friendStatuses,
		minId: true,
	},
	{
		name: 'notifications',
		operation: listNotifications,
		input: (page) => ({ credential, page, types: [], excludeTypes: [], accountId: null, present: PRESENT }),
		expected: friendStatuses,
		key: (item) => (item as unknown as { status: { id: string } }).status.id,
		minId: true,
	},
	{
		name: 'followers',
		operation: listFollows,
		input: (page) => ({ credential, now: NOW, account: FRIEND, direction: 'followers', page, present: PRESENT }),
		// The viewer follows FRIEND first, below every other follower.
		expected: (newer) => [...visibleAccounts(newer), VIEWER],
		minId: true,
	},
	{
		name: 'follow requests',
		operation: listFollowRequests,
		input: (page) => ({ credential, page, present: PRESENT }),
		expected: visibleAccounts,
		minId: true,
	},
	{
		name: 'notification requests',
		operation: listNotificationRequests,
		input: (page) => ({ credential, page, present: PRESENT }),
		expected: visibleAccounts,
		key: (item) => (item as unknown as { account: { id: string } }).account.id,
		minId: true,
	},
	{
		name: 'list members',
		operation: listAccounts,
		input: (page) => ({ credential, id: MEMBERS, page, present: PRESENT }),
		expected: visibleAccounts,
		minId: true,
	},
	{
		name: 'endorsements',
		operation: listEndorsements,
		input: (page) => ({ credential, page, present: PRESENT }),
		expected: visibleAccounts,
		minId: true,
	},
	{
		name: 'following',
		operation: listFollows,
		input: (page) => ({ credential, now: NOW, account: FRIEND, direction: 'following', page, present: PRESENT }),
		expected: visibleAccounts,
		minId: true,
	},
	{
		name: 'reblogged_by',
		operation: interactors,
		input: (page) => ({ credential, now: NOW, id: id(FRIEND_OLDER, 1), kind: 'reblogged_by', page, present: PRESENT }),
		expected: visibleAccounts,
		minId: true,
	},
	{
		name: 'favourited_by',
		operation: interactors,
		input: (page) => ({ credential, now: NOW, id: id(FRIEND_OLDER, 0), kind: 'favourited_by', page, present: PRESENT }),
		// The viewer favourited it first.
		expected: (newer) => [...visibleAccounts(newer), VIEWER],
		minId: true,
	},
]

// An operation's answer, unwrapped from its result.
function answerOf(output: unknown): Record<string, unknown> {
	let value = output as Record<string, unknown>
	while (value.status === 'ok' && 'value' in value) {
		value = value.value as Record<string, unknown>
	}
	return value
}

// The page a read answered: its items and cursors.
function pageOf(output: unknown): Page<{ id: string }> {
	return answerOf(output) as unknown as Page<{ id: string }>
}

async function read(store: StoreStub, r: Read, page: PageQuery): Promise<Page<{ id: string }>> {
	return pageOf(
		await runInDurableObject(store, (_instance, state) => r.operation.run(state.storage.sql, r.input(page) as never))
	)
}

// Every page of a read, by max_id from the newest or by min_id from the oldest, following the cursors the read
// answers (its Link header's): the next page is asked while the page is full or cut at its window.
async function walk(store: StoreStub, r: Read, direction: 'older' | 'newer') {
	const key = r.key ?? ((item: { id: string }) => item.id)
	const seen: string[] = []
	const requests: number[] = []
	let page: PageQuery = direction === 'older' ? PAGE : { ...PAGE, minId: '0' }
	for (;;) {
		const answer = await read(store, r, page)
		requests.push(answer.items.length)
		const items = answer.items.map(key)
		seen.push(...(direction === 'older' ? items : items.toReversed()))
		const more = answer.cut === true || answer.items.length >= PAGE.limit
		const cursor = direction === 'older' ? answer.oldest : answer.newest
		if (!more || cursor === null) {
			return { seen, requests }
		}
		page = direction === 'older' ? { ...PAGE, maxId: cursor } : { ...PAGE, minId: cursor }
		expect(requests.length, `${r.name} ${direction}: too many requests`).toBeLessThan(200)
	}
}

describe('filtered reads read a candidate window, however long the hidden range in front (RES-7)', () => {
	// A hidden row may cost the rule more or fewer rows than a visible one (its kind decides), so the reads are compared
	// with windows of hidden rows only: 100 (more than any window holds) or 20,000. With 20, the windows reach the
	// visible rows behind them.
	it('reads the same rows with 100 or 20,000 hidden rows of each kind before the visible ones', async () => {
		const short = await world(20)
		const few = await world(100)
		const many = await world(20_000)
		const grown: string[] = []
		for (const r of READS) {
			// The public timeline's three kinds of hidden rows fill its window even with 20 of each.
			const shortPage = await read(short, r, PAGE)
			expect([r.name, shortPage.items.length > 0 || r.name === 'public']).toEqual([r.name, true])
			for (const store of [few, many]) {
				const page = await read(store, r, PAGE)
				expect([r.name, page.items.length, page.cut]).toEqual([r.name, 0, true])
			}
			const fewRows = await rowsRead({ store: few }, r.operation, r.input(PAGE) as never)
			const manyRows = await rowsRead({ store: many }, r.operation, r.input(PAGE) as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${r.name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 300_000)

	// The grouped list's walk reads at most GROUP_WALK notifications, shown or hidden: it is compared beyond that.
	it('reads the same rows on the outbox, the notification policy, and the grouped notifications past their walk', async () => {
		const reads: [string, StoreOperation<never, unknown>, unknown, number][] = [
			['outbox', getOutbox, { username: 'local', before: '999999999999999999' }, 100],
			// The collection itself: its totalItems is the account's stored count.
			['outbox collection', getOutbox, { username: 'local', before: null }, 100],
			// Its summary counts the newest 100 requests, then applies availability: GONE_i's are the newest.
			['notification policy', getNotificationPolicy, { credential }, 100],
			[
				'grouped notifications',
				listGroupedNotifications,
				{
					credential,
					page: PAGE,
					types: [],
					excludeTypes: [],
					groupedTypes: null,
					includeFiltered: false,
					expandAccounts: 'full',
					present: PRESENT,
				},
				2_500,
			],
		]
		const grown: string[] = []
		const many = await world(20_000)
		for (const [name, operation, input, hidden] of reads) {
			const few = await world(hidden)
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 300_000)
})

describe('the profile web page reads from its cursor, however many newer posts', () => {
	// A fixed cursor with 20 of LOCAL's public posts below it, and 100 or 20,000 newer public posts above it.
	it('reads the same rows below a cursor with 100 or 20,000 newer posts', async () => {
		const input = { username: 'local', maxId: id(LOCAL_OLDER, 20), present: PRESENT, now: NOW }
		const rows: number[] = []
		for (const newer of [100, 20_000]) {
			const store = await world(0, newer)
			const output = answerOf(
				await runInDurableObject(store, (_instance, state) => profilePage.run(state.storage.sql, input as never))
			) as { statuses: { id: string }[] }
			expect(output.statuses.map((status) => status.id)).toEqual(range(LOCAL_OLDER, 20))
			rows.push(await rowsRead({ store }, profilePage, input as never))
		}
		expect(rows[1]).toBeLessThanOrEqual((rows[0] ?? 0) + ALLOWANCE)
	}, 120_000)
})

describe('paging moves through empty windows (RES-7)', () => {
	it('reaches every visible row on both sides of 1,000 hidden ones, once and in order, by max_id and by min_id', async () => {
		const NEWER = 5
		const store = await world(1_000, NEWER)
		for (const r of READS) {
			const expected = r.expected(NEWER)
			const older = await walk(store, r, 'older')
			expect([r.name, older.seen]).toEqual([r.name, expected])
			// Some pages in the hidden range are empty, and each still moved the cursor on.
			expect([r.name, older.requests.includes(0)]).toEqual([r.name, true])
			if (r.minId === true) {
				const newer = await walk(store, r, 'newer')
				expect([r.name, newer.seen]).toEqual([r.name, expected.toReversed()])
			}
		}
	}, 300_000)

	it('pages the profile web page through hidden private posts to the public ones below', async () => {
		const store = await world(0, 5, 1_000)
		const seen: string[] = []
		let maxId: string | null = null
		for (let requests = 0; ; requests++) {
			expect(requests).toBeLessThan(100)
			const output = answerOf(
				await runInDurableObject(store, (_instance, state) =>
					profilePage.run(state.storage.sql, { username: 'local', maxId, present: PRESENT, now: NOW } as never)
				)
			) as { statuses: { id: string }[]; next: string | null }
			seen.push(...output.statuses.map((status) => status.id))
			if (output.next === null) {
				break
			}
			maxId = output.next
		}
		expect(seen).toEqual([...range(LOCAL_NEWER, 5), ...range(LOCAL_OLDER, OLDER)])
	}, 120_000)

	it("pages the outbox through boosts of unavailable authors' statuses to the posts below", async () => {
		const store = await world(1_000, 5)
		const seen: string[] = []
		let before = '999999999999999999'
		for (let requests = 0; ; requests++) {
			expect(requests).toBeLessThan(100)
			const output = answerOf(
				await runInDurableObject(store, (_instance, state) =>
					getOutbox.run(state.storage.sql, { username: 'local', before } as never)
				)
			) as { items: string[]; next: string | null }
			seen.push(...output.items.map((item) => (JSON.parse(item) as { object: { id: string } }).object.id))
			if (output.next === null) {
				break
			}
			before = output.next
		}
		// Each Create's object is the status (its uri ends in its id).
		expect(seen.map((object) => object.slice(object.lastIndexOf('/') + 1))).toEqual([
			...range(LOCAL_NEWER, 5),
			...range(LOCAL_OLDER, OLDER),
		])
	}, 120_000)

	it("pages a notification group's accounts through hidden senders", async () => {
		const store = await world(0)
		const GROUP = 'favourite-1'
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			// Favourites of one status by 30 available senders, then 500 being deleted, then 5 available, all in one group.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 500 - 1)
				INSERT INTO accounts (id, uri, username, domain, deleted_at)
				SELECT CAST(?1 + i AS TEXT), 'https://gone.example/users/g' || i, 'g' || i, 'gone.example', ?2 FROM n`,
				String(GONE_ACCOUNT),
				new Date(NOW).toISOString()
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 5 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?1 + i AS TEXT), 'https://visible.example/users/n' || i, 'n' || i, 'visible.example' FROM n`,
				String(NEWER_ACCOUNT)
			)
			sql.exec(
				"INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, 'https://kopje.test/s', ?, 'public', '', ?)",
				id(LOCAL_NEWER, 0),
				VIEWER,
				new Date(NOW).toISOString()
			)
			for (const base of [VISIBLE_ACCOUNT, GONE_ACCOUNT, NEWER_ACCOUNT]) {
				sql.exec(
					`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key)
					SELECT ?1, 'favourite', id, ?2, ?3 FROM accounts WHERE id >= ?4 AND id < ?5 ORDER BY id`,
					VIEWER,
					id(LOCAL_NEWER, 0),
					GROUP,
					String(base),
					String(base + 1000000n)
				)
			}
		})
		const r: Read = {
			name: 'notification group accounts',
			operation: notificationGroupAccounts,
			input: (page) => ({ credential, groupKey: GROUP, page, present: PRESENT }),
			expected: visibleAccounts,
		}
		const older = await walk(store, r, 'older')
		expect(older.seen).toEqual(visibleAccounts(5))
		expect(older.requests.includes(0)).toBe(true)
	}, 120_000)
})

// A viewer who may not see a status by its visibility never learns its id from a windowed read: LOCAL's 1,000 private
// and 1,000 direct statuses (to someone else), newer than everything else, longer than any window; the viewer does not
// follow LOCAL, and has bookmarked and favourited some of the private ones (as a former follower might have).
describe('windows never take a row hidden by its visibility as a candidate (docs/visibility.md "Read bounds")', () => {
	it('answers no id of a private or direct status in any field, to the viewer or anonymously', async () => {
		const HIDDEN = 1_000
		const DIRECT = 870000000000000000n
		const store = await world(0)
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const at = new Date(NOW).toISOString()
			for (const [base, visibility] of [
				[LOCAL_PRIVATE, 'private'],
				[DIRECT, 'direct'],
			] as const) {
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/objects/' || (?2 + i), ?3, ?4, '<p>#cats</p>', ?5 FROM n`,
					HIDDEN,
					String(base),
					LOCAL,
					visibility,
					at
				)
				sql.exec(
					`INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 0 FROM statuses WHERE account_id = ? AND visibility = ?`,
					LOCAL,
					visibility
				)
			}
			sql.exec(
				"INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM statuses WHERE visibility = 'direct'",
				FRIEND
			)
			for (const table of ['bookmarks', 'favourites']) {
				sql.exec(
					`INSERT INTO ${table} (account_id, status_id) SELECT ?, id FROM statuses WHERE account_id = ? AND visibility = 'private'`,
					VIEWER,
					LOCAL
				)
			}
			// Mentions of the viewer in them, as a notification kept from before the mention was edited out.
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id)
				SELECT ?, 'mention', ?, id FROM statuses WHERE account_id = ? AND visibility = 'private'`,
				VIEWER,
				LOCAL,
				LOCAL
			)
			// The viewer lists LOCAL without following it.
			sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', LIST, LOCAL)
			// FRIEND (followed) boosts its own direct statuses to LOCAL, and the boosts name the viewer as their mention:
			// the wrappers address the viewer, their originals do not.
			const ORIGINAL = 880000000000000000n
			const WRAPPER = 885000000000000000n
			for (const [base, reblogOf] of [
				[ORIGINAL, null],
				[WRAPPER, ORIGINAL],
			] as const) {
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id)
					SELECT CAST(?2 + i AS TEXT), 'https://friend.example/objects/' || (?2 + i), ?3, 'direct',
						CASE WHEN ?5 IS NULL THEN '<p>psst</p>' ELSE '' END, ?4,
						CASE WHEN ?5 IS NULL THEN NULL ELSE CAST(?5 + i AS TEXT) END
					FROM n`,
					HIDDEN,
					String(base),
					FRIEND,
					at,
					reblogOf === null ? null : String(reblogOf)
				)
			}
			sql.exec(
				`INSERT INTO status_mentions (status_id, account_id, requires_mention, author_id)
				SELECT id, CASE WHEN reblog_of_id IS NULL THEN ?2 ELSE ?3 END, 1, ?1 FROM statuses
				WHERE account_id = ?1 AND visibility = 'direct'`,
				FRIEND,
				LOCAL,
				VIEWER
			)
		})
		const hidden = new Set<string>()
		await runInDurableObject(store, (_instance, state) => {
			for (const row of state.storage.sql
				.exec<{ id: string }>("SELECT id FROM statuses WHERE visibility IN ('private', 'direct')")
				.toArray()) {
				hidden.add(row.id)
			}
		})
		const statusesOf = (viewer: typeof credential | null) => ({
			credential: viewer,
			now: NOW,
			account: LOCAL,
			onlyMedia: false,
			excludeReplies: false,
			excludeReblogs: false,
			pinned: false,
			tagged: null,
			present: PRESENT,
		})
		const reads: [string, StoreOperation<never, unknown>, (page: PageQuery) => unknown][] = [
			['account statuses', accountStatuses, (page) => ({ ...statusesOf(credential), page })],
			['account statuses (anonymous)', accountStatuses, (page) => ({ ...statusesOf(null), page })],
			[
				'public',
				publicTimeline,
				(page) => ({ credential, now: NOW, page, local: false, remote: false, onlyMedia: false, present: PRESENT }),
			],
			['home', homeTimeline, (page) => ({ credential, page, present: PRESENT })],
			['list', listTimeline, (page) => ({ credential, id: LIST, page, present: PRESENT })],
			[
				'hashtag',
				tagTimeline,
				(page) => ({
					credential,
					now: NOW,
					page,
					tag: 'cats',
					any: [],
					all: [],
					none: [],
					local: false,
					remote: false,
					onlyMedia: false,
					present: PRESENT,
				}),
			],
			[
				'notifications',
				listNotifications,
				(page) => ({ credential, page, types: [], excludeTypes: [], accountId: null, present: PRESENT }),
			],
			['bookmarks', bookmarks, (page) => ({ credential, page, present: PRESENT })],
			['favourites', favourites, (page) => ({ credential, page, present: PRESENT })],
		]
		const leaked: string[] = []
		const check = (name: string, output: unknown) => {
			const text = JSON.stringify(answerOf(output))
			for (const statusId of text.match(/\d{18}/g) ?? []) {
				if (hidden.has(statusId)) {
					leaked.push(`${name}: ${statusId}`)
				}
			}
		}
		for (const [name, operation, input] of reads) {
			for (const page of [PAGE, { ...PAGE, minId: '1' }, { ...PAGE, maxId: '999999999999999999' }]) {
				check(
					name,
					await runInDurableObject(store, (_instance, state) => operation.run(state.storage.sql, input(page) as never))
				)
			}
		}
		check(
			'profile page',
			await runInDurableObject(store, (_instance, state) =>
				profilePage.run(state.storage.sql, { username: 'local', maxId: null, present: PRESENT, now: NOW } as never)
			)
		)
		check(
			'outbox',
			await runInDurableObject(store, (_instance, state) =>
				getOutbox.run(state.storage.sql, { username: 'local', before: '999999999999999999' } as never)
			)
		)
		expect(leaked).toEqual([])
		// The public posts below the hidden ones are still reached, and the next cursor is one of them.
		const profile = answerOf(
			await runInDurableObject(store, (_instance, state) =>
				profilePage.run(state.storage.sql, { username: 'local', maxId: null, present: PRESENT, now: NOW } as never)
			)
		) as { statuses: { id: string }[]; next: string | null }
		expect(profile.statuses.map((status) => status.id)).toEqual(range(LOCAL_OLDER, OLDER).slice(0, 20))
		expect(profile.next).toBe(id(LOCAL_OLDER, OLDER - 20))
	}, 120_000)

	it('answers no cursor of a follow or favourite by an account that blocks the viewer', async () => {
		const store = await world(0)
		const BLOCKERS = 200
		const blockerIds = new Set<string>()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://blockers.example/users/b' || i, 'b' || i, 'blockers.example' FROM n`,
				BLOCKERS,
				String(MUTED_ACCOUNT)
			)
			sql.exec(
				'INSERT INTO blocks (account_id, target_account_id) SELECT id, ? FROM accounts WHERE domain = ?',
				VIEWER,
				'blockers.example'
			)
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE domain = ?",
				FRIEND,
				'blockers.example'
			)
			sql.exec(
				'INSERT INTO favourites (account_id, status_id) SELECT id, ? FROM accounts WHERE domain = ?',
				id(FRIEND_OLDER, 0),
				'blockers.example'
			)
			for (const table of ['follows', 'favourites']) {
				for (const row of sql
					.exec<{ id: string }>(
						`SELECT CAST(e.id AS TEXT) AS id FROM ${table} e JOIN accounts a ON a.id = e.account_id WHERE a.domain = ?`,
						'blockers.example'
					)
					.toArray()) {
					blockerIds.add(`${table}:${row.id}`)
				}
			}
		})
		for (const [table, r] of [
			['follows', READS.find((x) => x.name === 'followers')],
			['favourites', READS.find((x) => x.name === 'favourited_by')],
		] as const) {
			if (r === undefined) {
				throw new Error('no such read')
			}
			const answer = await read(store, r, PAGE)
			for (const cursor of [answer.newest, answer.oldest]) {
				expect([r.name, blockerIds.has(`${table}:${cursor ?? ''}`)]).toEqual([r.name, false])
			}
			expect(answer.items.map((item) => item.id).filter((x) => BigInt(x) >= MUTED_ACCOUNT)).toEqual([])
		}
	}, 120_000)
})

// limit=0 on a list the viewer keeps reads its windows by id and builds the profiles of its answer only: a first window
// of 999 available and 2,001 unavailable members (by id, newest first), then 3,000 available ones, each with a 4 KiB
// bio. The answer is the cap, 1,000 accounts, and no more account rows than that are read.
describe('limit=0 builds the profiles of its answer only', () => {
	it('reads at most 1,000 account rows across windows of available and unavailable members', async () => {
		const store = await world(0)
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const bio = `<p>${'x'.repeat(4 * 1024)}</p>`
			// Ids from 980...: 3,000 available below; above them, 999 available and 2,001 being deleted, interleaved.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 6000 - 1)
				INSERT INTO accounts (id, uri, username, domain, note, deleted_at)
				SELECT CAST(980000000000000000 + i AS TEXT), 'https://big.example/users/b' || i, 'b' || i, 'big.example', ?1,
					CASE WHEN i >= 3000 AND ((i - 3000) % 3 <> 0 OR i >= 5997) THEN ?2 END
				FROM n`,
				bio,
				new Date(NOW).toISOString()
			)
			sql.exec(
				"INSERT INTO list_accounts (list_id, account_id) SELECT ?, id FROM accounts WHERE domain = 'big.example'",
				MEMBERS
			)
		})
		const input = { credential, id: MEMBERS, page: null, present: PRESENT }
		const counted = await runInDurableObject(store, (_instance, state) => {
			let profiles = 0
			const real = state.storage.sql
			const counting = {
				exec: (query: string, ...params: SqlStorageValue[]) => {
					const cursor = real.exec(query, ...params)
					return {
						toArray: () => {
							const rows = cursor.toArray()
							profiles += rows.filter((row) => 'note' in row && 'display_name' in row).length
							return rows
						},
						one: () => cursor.one(),
					}
				},
			} as unknown as SqlStorage
			const output = answerOf(listAccounts.run(counting, input as never)) as { items: { id: string }[] }
			return { profiles, answered: output.items.length }
		})
		expect(counted).toEqual({ answered: 1_000, profiles: 1_000 })
	}, 120_000)
})
