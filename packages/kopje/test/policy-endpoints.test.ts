import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migratedStore } from './helpers'
import { NOTIFICATION_TYPES, PolicyModel, type Viewer } from './policy-model'
import { accountId, listId, runs, statusId, type World, worldArb, writeWorld } from './policy-world'
import { type Account, listFollows, type Page, type PageQuery } from '../src/domain/accounts'
import { backfillConversations } from '../src/domain/conversation-rows'
import { type Conversation, listConversations, markConversation } from '../src/domain/conversations'
import { listGroupedNotifications, unreadCount, unreadGroupCount } from '../src/domain/notification-groups'
import type { NotificationType } from '../src/domain/notifications'
import { listNotifications } from '../src/domain/notifications'
import { resolveSearch } from '../src/domain/remote-statuses'
import { search } from '../src/domain/search'
import type { Status } from '../src/domain/status-presenter'
import { getStatus, interactors, statusContext } from '../src/domain/statuses'
import {
	accountStatuses,
	bookmarks,
	favourites,
	homeTimeline,
	listTimeline,
	publicTimeline,
	tagTimeline,
} from '../src/domain/timelines'
import type { StoreStub } from '../src/platform/store-client'
import type { StoreOperation } from '../src/platform/store-kernel'

// The endpoint oracle (docs/visibility.md, "The oracle and the bounds harness"): the status read endpoints, the
// follower and following lists, account search and search resolution run on generated worlds (test/policy-world.ts)
// for every available local viewer and, where the endpoint allows it, the anonymous one. No endpoint may show a status
// (or a boosted original) or an account the model of its rule (test/policy-model.ts) does not allow the viewer. The
// lists (home with exclusive lists, a list's timeline, public, tag, account statuses, favourites, bookmarks,
// followers, following, account search) must also show exactly what the model allows of their members, in order, page
// after page; search resolution must answer an account exactly when account search finds it, and a status exactly when
// the single-status read shows it, unless the viewer blocks its author's domain.

// Cases per property: each writes a world and runs every endpoint for every viewer.
const CASES = 60
// A small page, so the lists are read over several pages.
const LIMIT = 3
const PRESENT = { origin: 'https://kopje.test' }

// What a world adds for the endpoints: favourites (by any account), bookmarks (by local accounts) and notifications
// (to local accounts), all of originals, by index into the world.
type Edges = {
	favourites: { account: number; status: number }[]
	bookmarks: { account: number; status: number }[]
	notifications: { recipient: number; type: NotificationType; from: number; status: number | null }[]
}

type Case = { world: World; edges: Edges }

const caseArb: fc.Arbitrary<Case> = fc
	.record({
		world: worldArb,
		favourites: fc.array(fc.record({ account: fc.nat(), status: fc.nat() }), { maxLength: 16, size: 'max' }),
		bookmarks: fc.array(fc.record({ account: fc.nat(), status: fc.nat() }), { maxLength: 10, size: 'max' }),
		notifications: fc.array(
			fc.record({
				recipient: fc.nat(),
				type: fc.constantFrom(...NOTIFICATION_TYPES),
				from: fc.nat(),
				status: fc.option(fc.nat()),
			}),
			{ maxLength: 16, size: 'max' }
		),
	})
	.map(({ world, favourites, bookmarks, notifications }): Case => {
		const locals = world.accounts.flatMap((account, x) => (account.local ? [x] : []))
		const originals = world.statuses.flatMap((status, s) => (status.reblogOf === null ? [s] : []))
		const pick = <T>(items: readonly T[], n: number): T | undefined => items[n % Math.max(items.length, 1)]
		const unique = <T>(items: T[], key: (item: T) => string) =>
			items.filter((item, i) => items.findIndex((other) => key(other) === key(item)) === i)
		const edge = (accounts: readonly number[]) => (e: { account: number; status: number }) => {
			const account = pick(accounts, e.account)
			const status = pick(originals, e.status)
			return account === undefined || status === undefined ? [] : [{ account, status }]
		}
		const key = (e: { account: number; status: number }) => `${e.account}:${e.status}`
		return {
			world,
			edges: {
				favourites: unique(favourites.flatMap(edge(world.accounts.map((_, x) => x))), key),
				bookmarks: unique(bookmarks.flatMap(edge(locals)), key),
				notifications: unique(
					notifications.flatMap((n) => {
						const recipient = pick(locals, n.recipient)
						const from = n.from % world.accounts.length
						const status = n.status === null ? null : (pick(originals, n.status) ?? null)
						return recipient === undefined ? [] : [{ recipient, type: n.type, from, status }]
					}),
					(n) => `${n.recipient}:${n.type}:${n.from}:${n.status}`
				),
			},
		}
	})

const tokenOf = (x: number) => `policy-endpoints-${x}`

type SeededNotification = Edges['notifications'][number]

// The group notify gives a seeded notification, all in one hour: a favourite or boost by status, a follow.
function groupKeyOf(n: SeededNotification): string | null {
	if (n.type === 'follow') {
		return 'follow-1'
	}
	return (n.type === 'favourite' || n.type === 'reblog') && n.status !== null
		? `${n.type}-${statusId(n.status)}-1`
		: null
}

// Writes the case and returns the notifications it seeded, by id.
function writeCase(sql: SqlStorage, { world, edges }: Case): Map<string, SeededNotification> {
	sql.exec('DELETE FROM oauth_tokens')
	writeWorld(sql, world)
	world.accounts.forEach((account, x) => {
		if (account.local) {
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'endpoints', ?, 'read')",
				tokenOf(x),
				accountId(x)
			)
		}
	})
	// Inserted in order, so the edge ids follow the order of the lists.
	for (const f of edges.favourites) {
		sql.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', accountId(f.account), statusId(f.status))
	}
	for (const b of edges.bookmarks) {
		sql.exec('INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', accountId(b.account), statusId(b.status))
	}
	const notifications = new Map<string, SeededNotification>()
	for (const n of edges.notifications) {
		const { id } = sql
			.exec<{ id: string }>(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key) VALUES (?, ?, ?, ?, ?)
				RETURNING CAST(id AS TEXT) AS id`,
				accountId(n.recipient),
				n.type,
				accountId(n.from),
				n.status === null ? null : statusId(n.status),
				groupKeyOf(n)
			)
			.one()
		notifications.set(id, n)
	}
	// The conversations of the world's direct statuses and the mentions seeded, as migration 0009 makes them.
	backfillConversations({ exec: (query: string) => sql.exec(query) })
	return notifications
}

type Authorized<T> = { status: string; value?: T }

function ok<T>(result: unknown, what: string): T {
	const authorized = result as Authorized<T>
	if (authorized.status !== 'ok') {
		throw new Error(`${what}: ${authorized.status}`)
	}
	return authorized.value as T
}

// The ok value of a Viewed result, or null for not_found.
function found<T>(result: unknown, what: string): T | null {
	const viewed = ok<{ status: string; value?: T }>(result, what)
	return viewed.status === 'ok' ? (viewed.value as T) : null
}

// The endpoints that showed something, over every case, so a property cannot pass by showing nothing.
const shown = new Set<string>()

describe('the status read endpoints agree with the model of their rules', () => {
	let store: StoreStub
	beforeAll(async () => {
		store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('endpoints', 'secret', 'endpoints', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
		})
	})

	afterAll(() => {
		expect([...shown].sort()).toEqual(
			[
				'account search',
				'account statuses',
				'bookmarks',
				'context',
				'conversation without its last status',
				'conversations',
				'favourited_by',
				'favourites',
				'followers',
				'grouped notifications',
				'following',
				'home',
				'list',
				'notifications',
				'public',
				'reblogged_by',
				'resolve account',
				'resolve status',
				'status',
				'status search',
				'tag',
			].sort()
		)
	})

	it('shows no viewer a status the model does not allow, and lists exactly what it allows', async () => {
		await fc.assert(
			fc.asyncProperty(caseArb, async (c) => {
				const problems = await runInDurableObject(store, (_instance, state) => check(state.storage.sql, c))
				expect(problems).toEqual([])
			}),
			runs(CASES)
		)
	}, 60_000)
})

// Runs every endpoint for every viewer of the case and returns what disagrees with the model.
function check(sql: SqlStorage, c: Case): string[] {
	const seeded = writeCase(sql, c)
	const { world, edges } = c
	const m = new PolicyModel(world)
	const now = Date.parse(world.now)
	const problems: string[] = []
	const indexOf = new Map(world.statuses.map((_, s) => [statusId(s), s]))
	const accountIndex = new Map(world.accounts.map((_, x) => [accountId(x), x]))
	const nameOf = (viewer: Viewer) => (viewer === null ? 'anonymous' : (world.accounts[viewer]?.name ?? ''))
	const statusName = (s: number) => m.status(s).name
	const run = <T>(operation: StoreOperation<never, unknown>, input: unknown) => operation.run(sql, input as never) as T
	const credentialOf = (viewer: number) => ({ tokenHash: tokenOf(viewer), scope: 'read', now }) as const
	const optional = (viewer: Viewer) => ({ credential: viewer === null ? null : credentialOf(viewer), now })

	// A shown status: the model allows it to the viewer by the endpoint's rule, and a boost shows its own original,
	// which the viewer may see (a read never shows a boost without it).
	const status = (endpoint: string, viewer: Viewer, value: Status, allowed: (s: number) => boolean): number => {
		shown.add(endpoint)
		const s = indexOf.get(value.id)
		if (s === undefined) {
			problems.push(`${endpoint} ${nameOf(viewer)}: unknown status ${value.id}`)
			return -1
		}
		if (!allowed(s)) {
			problems.push(`${endpoint} ${nameOf(viewer)}: ${statusName(s)} is not allowed`)
		}
		const { reblogOf } = m.status(s)
		const original = value.reblog === null ? null : (indexOf.get(value.reblog.id) ?? -1)
		if (original !== reblogOf || (original !== null && !m.visible(original, viewer))) {
			problems.push(`${endpoint} ${nameOf(viewer)}: ${statusName(s)} shows original ${value.reblog?.id ?? 'none'}`)
		}
		return s
	}

	// Every page of a list, LIMIT at a time, older pages by the oldest cursor.
	const pages = <T>(read: (page: PageQuery) => Page<T> | null): T[] => {
		const items: T[] = []
		let maxId: string | undefined
		for (let i = 0; i < 64; i++) {
			const page = read(maxId === undefined ? { limit: LIMIT } : { limit: LIMIT, maxId })
			if (page === null || page.items.length === 0 || page.oldest === null) {
				break
			}
			items.push(...page.items)
			maxId = page.oldest
		}
		return items
	}

	// A list shows exactly `expected`, in order.
	const equal = (endpoint: string, viewer: Viewer, actual: number[], expected: number[]) => {
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			problems.push(
				`${endpoint} ${nameOf(viewer)}: shows [${actual.map(statusName).join(' ')}], the model [${expected.map(statusName).join(' ')}]`
			)
		}
	}

	const newestFirst = (statuses: number[]) => [...statuses].sort((a, b) => b - a)
	// A timeline paged every way (home, a list's): older pages by max_id, LIMIT at a time, and newer pages by min_id
	// from the oldest, two at a time, each page exactly the next of `expected` (newest first), so no page comes back
	// short while statuses remain; and the newest page (since_id) and the next page (min_id) above the middle status.
	const paged = (
		endpoint: string,
		label: string,
		viewer: Viewer,
		read: (page: PageQuery) => Page<Status> | null,
		expected: number[]
	) => {
		const items = (query: PageQuery) =>
			(read(query)?.items ?? []).map((value) => status(endpoint, viewer, value, () => true))
		const walk = (first: PageQuery, next: (shown: number[]) => PageQuery) => {
			const shownPages: number[][] = []
			let query = first
			for (let i = 0; i < 64; i++) {
				const page = items(query)
				if (page.length === 0) {
					break
				}
				shownPages.push(page)
				query = next(page)
			}
			return shownPages
		}
		const chunks = (list: number[], limit: number) =>
			list.flatMap((_, n) => (n % limit === 0 ? [list.slice(n, n + limit)] : []))
		const compare = (name: string, actual: number[][], wanted: number[][]) => {
			if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
				const pagesOf = (list: number[][]) => list.map((page) => page.map(statusName).join(' ')).join(' | ')
				problems.push(
					`${label} (${name}) ${nameOf(viewer)}: pages [${pagesOf(actual)}], the model [${pagesOf(wanted)}]`
				)
			}
		}
		compare(
			'max_id',
			walk({ limit: LIMIT }, (page) => ({ limit: LIMIT, maxId: statusId(page.at(-1) ?? 0) })),
			chunks(expected, LIMIT)
		)
		compare(
			'min_id',
			walk({ limit: 2, minId: '0' }, (page) => ({ limit: 2, minId: statusId(page[0] ?? 0) })),
			chunks([...expected].reverse(), 2).map((page) => page.reverse())
		)
		const middle = expected[Math.floor(expected.length / 2)]
		if (middle !== undefined) {
			const above = expected.filter((s) => s > middle)
			compare('since_id', [items({ limit: LIMIT, sinceId: statusId(middle) })], [above.slice(0, LIMIT)])
			compare('min_id cursor', [items({ limit: LIMIT, minId: statusId(middle) })], [above.slice(-LIMIT)])
		}
	}

	const all = world.statuses.map((_, s) => s)
	const locals = world.accounts.flatMap((account, x) => (account.local && !account.suspended ? [x] : []))
	const viewers: Viewer[] = [null, ...locals]
	const timeline = { local: false, remote: false, onlyMedia: false, present: PRESENT }
	// Public: public originals that are not replies to others (a reply in the author's own conversation is not one).
	// Tag (Mastodon's TagFeed): public originals with the tag, replies included.
	const publicFeed = (s: number) => {
		const status = m.status(s)
		return (
			status.visibility === 'public' && status.reblogOf === null && (!m.isReply(s) || m.partner(s) === status.author)
		)
	}

	for (const viewer of viewers) {
		const user = viewer === null ? null : { credential: credentialOf(viewer) }

		// Single status, context and who favourited or boosted it: only what the viewer may view.
		for (const s of all) {
			const id = statusId(s)
			const single = found<Status>(run(getStatus, { ...optional(viewer), id, present: PRESENT }), 'status')
			if (single !== null) {
				status('status', viewer, single, (x) => x === s && m.viewable(x, viewer))
			}
			const context = found<{ ancestors: Status[]; descendants: Status[] }>(
				run(statusContext, { ...optional(viewer), id, present: PRESENT }),
				'context'
			)
			if (context !== null) {
				if (!m.viewable(s, viewer)) {
					problems.push(`context ${nameOf(viewer)}: answers for ${statusName(s)}`)
				}
				for (const member of [...context.ancestors, ...context.descendants]) {
					status('context', viewer, member, (x) => m.listable(x, viewer))
				}
			}
			const original = m.status(s).reblogOf ?? s
			for (const kind of ['favourited_by', 'reblogged_by'] as const) {
				const accounts = found<Page<Account>>(
					run(interactors, { ...optional(viewer), id, kind, page: { limit: 40 }, present: PRESENT }),
					kind
				)
				if (accounts === null) {
					continue
				}
				if (!m.viewable(s, viewer)) {
					problems.push(`${kind} ${nameOf(viewer)}: answers for ${statusName(s)}`)
				}
				for (const account of accounts.items) {
					shown.add(kind)
					const x = accountIndex.get(account.id)
					const member =
						x !== undefined &&
						(kind === 'favourited_by'
							? edges.favourites.some((f) => f.account === x && f.status === original)
							: world.statuses.some(
									(b) =>
										b.author === x &&
										b.reblogOf === original &&
										(b.visibility === 'public' || b.visibility === 'unlisted')
								))
					if (x === undefined || !member || !m.listedFor(x, viewer)) {
						problems.push(`${kind} ${nameOf(viewer)} ${statusName(s)}: lists ${account.id}`)
					}
				}
			}
		}

		// Public and tag feeds, and every account's statuses: exactly what the model allows of their members.
		const feed = (endpoint: string, operation: StoreOperation<never, unknown>, input: object) =>
			pages((page) => ok<Page<Status>>(run(operation, { ...optional(viewer), ...input, page }), endpoint)).map(
				(value) => status(endpoint, viewer, value, () => true)
			)
		equal(
			'public',
			viewer,
			feed('public', publicTimeline, timeline),
			newestFirst(all.filter((s) => publicFeed(s) && m.listable(s, viewer)))
		)
		equal(
			'tag',
			viewer,
			feed('tag', tagTimeline, { ...timeline, tag: 'cats', any: [], all: [], none: [] }),
			newestFirst(
				all.filter((s) => {
					const { visibility, reblogOf, tagged } = m.status(s)
					return visibility === 'public' && reblogOf === null && tagged && m.listable(s, viewer)
				})
			)
		)
		world.accounts.forEach((_, a) => {
			const actual = pages((page) =>
				ok<Page<Status> | null>(
					run(accountStatuses, {
						...optional(viewer),
						account: accountId(a),
						page,
						onlyMedia: false,
						excludeReplies: false,
						excludeReblogs: false,
						pinned: false,
						tagged: null,
						present: PRESENT,
					}),
					'account statuses'
				)
			).map((value) => status('account statuses', viewer, value, () => true))
			// Status.permitted_for: visible, the viewer does not block the account, and a boost's original is visible
			// and its author not filtered.
			const expected = all.filter((s) => {
				const { author, reblogOf } = m.status(s)
				return (
					author === a &&
					m.visible(s, viewer) &&
					!m.blocks(viewer, a) &&
					(reblogOf === null || (m.visible(reblogOf, viewer) && !m.filteredFor(m.status(reblogOf).author, viewer)))
				)
			})
			equal(`account statuses of ${world.accounts[a]?.name}`, viewer, actual, newestFirst(expected))
		})

		// Followers and following of every account: exactly the accepted follows the list rule (R13) shows the viewer,
		// newest follow first.
		world.accounts.forEach((_, owner) => {
			for (const direction of ['followers', 'following'] as const) {
				const actual = pages((page) =>
					ok<Page<Account> | null>(
						run(listFollows, { ...optional(viewer), account: accountId(owner), direction, page, present: PRESENT }),
						direction
					)
				).map((account) => {
					shown.add(direction)
					return accountIndex.get(account.id) ?? -1
				})
				const members = world.follows
					.filter((f) => f.accepted && (direction === 'followers' ? f.to : f.from) === owner)
					.map((f) => (direction === 'followers' ? f.from : f.to))
				const expected = m.followListsShown(owner, viewer)
					? members.filter((x) => m.followListed(x, owner, viewer)).reverse()
					: []
				if (JSON.stringify(actual) !== JSON.stringify(expected)) {
					problems.push(
						`${direction} of ${nameOf(owner)} ${nameOf(viewer)}: lists [${actual.map(nameOf).join(' ')}], the model [${expected.map(nameOf).join(' ')}]`
					)
				}
			}
		})

		if (viewer === null || user === null) {
			continue
		}

		// Favourites and bookmarks: the viewer's, newest edge first, that the list rule allows.
		for (const [endpoint, operation, list] of [
			['favourites', favourites, edges.favourites],
			['bookmarks', bookmarks, edges.bookmarks],
		] as const) {
			const actual = pages((page) =>
				ok<Page<Status>>(run(operation, { ...user, page, present: PRESENT }), endpoint)
			).map((value) => status(endpoint, viewer, value, () => true))
			const expected = list
				.filter((e) => e.account === viewer && m.listable(e.status, viewer))
				.map((e) => e.status)
				.reverse()
			equal(endpoint, viewer, actual, expected)
		}

		// Home: exactly what the home rule allows the viewer, newest first.
		paged(
			'home',
			'home',
			viewer,
			(page) => ok<Page<Status>>(run(homeTimeline, { ...user, page, present: PRESENT }), 'home'),
			newestFirst(all.filter((s) => m.home(s, viewer)))
		)

		// Each list's timeline: exactly what the model allows of the list's members to its owner, newest first; another
		// account's list is not found.
		world.lists.forEach((list, l) => {
			const read = (page: PageQuery) =>
				ok<Page<Status> | null>(run(listTimeline, { ...user, id: listId(l), page, present: PRESENT }), 'list')
			if (list.owner !== viewer) {
				if (read({ limit: LIMIT }) !== null) {
					problems.push(`list ${l} ${nameOf(viewer)}: answers for another account's list`)
				}
				return
			}
			paged('list', `list ${l}`, viewer, read, newestFirst(all.filter((s) => m.listTimeline(l, s))))
		})

		// Status search over the viewer's library: only what the list rule allows.
		const results = ok<{ statuses: Status[] }>(
			run(search, {
				...user,
				query: 'status',
				types: ['statuses'],
				limit: 40,
				offset: 0,
				following: false,
				localDomain: 'kopje.test',
				present: PRESENT,
			}),
			'status search'
		)
		for (const value of results.statuses) {
			status('status search', viewer, value, (s) => m.listable(s, viewer))
		}

		// Account search (every account's search text matches): exactly the accounts the viewer may find (R14).
		const searched = ok<{ accounts: Account[] }>(
			run(search, {
				...user,
				query: 'account',
				types: ['accounts'],
				limit: 40,
				offset: 0,
				following: false,
				localDomain: 'kopje.test',
				present: PRESENT,
			}),
			'account search'
		).accounts.map((account) => {
			shown.add('account search')
			return accountIndex.get(account.id) ?? -1
		})
		const findable = world.accounts.flatMap((_, x) => (m.findableBy(x, viewer) ? [x] : []))
		if (JSON.stringify([...searched].sort((a, b) => a - b)) !== JSON.stringify(findable)) {
			problems.push(
				`account search ${nameOf(viewer)}: finds [${searched.map(nameOf).join(' ')}], the model [${findable.map(nameOf).join(' ')}]`
			)
		}

		// Search resolution of what is stored, by its uri: an account exactly when account search finds it (R14), a
		// status exactly when the single-status read shows it (R3) and the viewer does not block its author's domain,
		// and never a boost.
		const resolve = (query: string) =>
			ok<{ accounts: Account[]; statuses: Status[] }>(
				run(resolveSearch, {
					...user,
					query,
					resolved: { kind: 'none' },
					now,
					origin: 'https://kopje.test',
					present: PRESENT,
				}),
				'resolve'
			)
		world.accounts.forEach((account, x) => {
			const answered = resolve(account.uri)
			const ids = answered.accounts.map((found) => accountIndex.get(found.id) ?? -1)
			if (ids.length > 0) {
				shown.add('resolve account')
			}
			if (answered.statuses.length > 0 || JSON.stringify(ids) !== JSON.stringify(searched.includes(x) ? [x] : [])) {
				problems.push(`resolve ${nameOf(viewer)}: ${account.name} answers [${ids.map(nameOf).join(' ')}]`)
			}
		})
		for (const s of all) {
			const answered = resolve(`https://kopje.test/ap/o/${s}`)
			const ids = answered.statuses.map((value) =>
				status('resolve status', viewer, value, (x) => x === s && m.viewable(x, viewer))
			)
			const single = found<Status>(run(getStatus, { ...optional(viewer), id: statusId(s), present: PRESENT }), 'status')
			const { author, reblogOf } = m.status(s)
			const expected = reblogOf === null && single !== null && !m.domainBlocks(viewer, author) ? [s] : []
			if (answered.accounts.length > 0 || JSON.stringify(ids) !== JSON.stringify(expected)) {
				problems.push(`resolve ${nameOf(viewer)}: ${statusName(s)} answers [${ids.map(statusName).join(' ')}]`)
			}
		}

		// Notifications: only the viewer's, as seeded, that the notification rule shows, with statuses the viewer may
		// view.
		const notifications = pages((page) =>
			ok<Page<{ id: string; type: NotificationType; group_key: string; account: Account; status?: Status }>>(
				run(listNotifications, { ...user, page, types: [], excludeTypes: [], accountId: null, present: PRESENT }),
				'notifications'
			)
		)
		for (const notification of notifications) {
			shown.add('notifications')
			const from = accountIndex.get(notification.account.id)
			const s =
				notification.status === undefined
					? null
					: status('notifications', viewer, notification.status, (x) => m.viewable(x, viewer))
			const row = seeded.get(notification.id)
			if (
				row === undefined ||
				row.recipient !== viewer ||
				row.type !== notification.type ||
				row.from !== from ||
				row.status !== s
			) {
				problems.push(`notifications ${nameOf(viewer)}: ${notification.id} is not a notification seeded for them`)
			}
			if (from === undefined || !m.shown(viewer, notification.type, from, s)) {
				problems.push(`notifications ${nameOf(viewer)}: ${notification.type} from ${notification.account.id}`)
			}
		}

		// Grouped notifications: the groups of exactly the notifications v1 shows (checked above), newest first by each
		// group's newest, each counting and sampling its own (newest first); the unread counts count them.
		const expectedGroups: { key: string; count: number; samples: string[] }[] = []
		for (const notification of notifications) {
			const group = expectedGroups.find((g) => g.key === notification.group_key)
			if (group === undefined) {
				expectedGroups.push({ key: notification.group_key, count: 1, samples: [notification.account.id] })
			} else {
				group.count += 1
				if (group.samples.length < 8) {
					group.samples.push(notification.account.id)
				}
			}
		}
		const grouped = ok<{
			statuses: Status[]
			notification_groups: { group_key: string; notifications_count: number; sample_account_ids: string[] }[]
		}>(
			run(listGroupedNotifications, {
				...user,
				page: { limit: 80 },
				types: [],
				excludeTypes: [],
				groupedTypes: null,
				expandAccounts: 'full',
				present: PRESENT,
			}),
			'grouped notifications'
		)
		const actualGroups = grouped.notification_groups.map((g) => ({
			key: g.group_key,
			count: g.notifications_count,
			samples: g.sample_account_ids,
		}))
		if (JSON.stringify(actualGroups) !== JSON.stringify(expectedGroups)) {
			problems.push(
				`grouped notifications ${nameOf(viewer)}: ${JSON.stringify(actualGroups)}, v1 ${JSON.stringify(expectedGroups)}`
			)
		}
		for (const value of grouped.statuses) {
			status('grouped notifications', viewer, value, (x) => m.viewable(x, viewer))
		}
		const counts = { ...user, limit: 1000, types: [], excludeTypes: [], accountId: null, groupedTypes: null }
		const unread = [
			ok<{ count: number }>(run(unreadCount, counts), 'unread count').count,
			ok<{ count: number }>(run(unreadGroupCount, counts), 'unread group count').count,
		]
		if (JSON.stringify(unread) !== JSON.stringify([notifications.length, expectedGroups.length])) {
			problems.push(`unread counts ${nameOf(viewer)}: ${JSON.stringify(unread)}`)
		}

		// Conversations: exactly the viewer's the model makes of the world's direct statuses and the mentions seeded, by
		// newest last status, each with the viewer's own account when nobody else is in it, and its last status only if
		// the viewer may see it (R2); page by page both ways. Another account's conversation is not found.
		const seededMention = (r: number, s: number) =>
			edges.notifications.some((n) => n.recipient === r && n.type === 'mention' && n.status === s)
		const expected = m
			.conversations(seededMention)
			.filter((c) => c.owner === viewer)
			.map((c) => ({ ...c, last: Math.max(...c.statuses) }))
			.sort((a, b) => b.last - a.last)
			.map((c) => ({
				accounts: (c.participants.length > 0 ? c.participants : [viewer]).map(accountId),
				last_status: m.visible(c.last, viewer) ? statusId(c.last) : null,
				unread: c.unread,
			}))
		const conversationsOf = (page: PageQuery) =>
			ok<Page<Conversation>>(run(listConversations, { ...user, page, present: PRESENT }), 'conversations')
		const shownConversation = (c: Conversation) => {
			shown.add('conversations')
			if (c.last_status === null) {
				shown.add('conversation without its last status')
			} else {
				status('conversations', viewer, c.last_status, (x) => m.visible(x, viewer))
			}
			return { accounts: c.accounts.map((a) => a.id), last_status: c.last_status?.id ?? null, unread: c.unread }
		}
		const older = pages(conversationsOf).map(shownConversation)
		const newer: ReturnType<typeof shownConversation>[] = []
		for (let i = 0, minId = '0'; i < 64; i++) {
			const page = conversationsOf({ limit: 2, minId })
			if (page.items.length === 0 || page.newest === null) {
				break
			}
			newer.unshift(...page.items.map(shownConversation))
			minId = page.newest
		}
		for (const [way, actual] of [
			['max_id', older],
			['min_id', newer],
		] as const) {
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				problems.push(
					`conversations (${way}) ${nameOf(viewer)}: shows ${JSON.stringify(actual)}, the model ${JSON.stringify(expected)}`
				)
			}
		}
		for (const other of sql
			.exec<{ id: string }>('SELECT CAST(id AS TEXT) AS id FROM conversations WHERE account_id <> ?', accountId(viewer))
			.toArray()) {
			const marked = ok<Conversation | null>(
				run(markConversation, { ...user, id: other.id, unread: false, present: PRESENT }),
				'mark conversation'
			)
			if (marked !== null) {
				problems.push(`conversations ${nameOf(viewer)}: marks another account's conversation ${other.id}`)
			}
		}
	}
	return problems
}
