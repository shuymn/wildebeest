import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { PolicyModel } from './policy-model'
import { accountId, REMOTE_DOMAINS, statusId, type World, worldArb, writeWorld } from './policy-world'
import { rowsRead } from './read-helpers'
import { Db } from '../src/db/sql'
import { listFollows, relationships } from '../src/domain/accounts'
import { canView, visibleSql, type Visibility } from '../src/domain/audience'
import { getMarkers, MARKER_TIMELINES } from '../src/domain/markers'
import { listNotifications } from '../src/domain/notifications'
import { search } from '../src/domain/search'
import { interactors, statusContext } from '../src/domain/statuses'
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

// The bounds harness (docs/visibility.md, "The oracle and the bounds harness"): each read endpoint that takes a viewer
// runs over a generated world twice, once alone and once with many unrelated rows, and must read about the same number
// of rows (RES-7). Unrelated rows are what no viewer's read of the world should touch: other accounts with their
// statuses (never public, so no public or tag feed would list them, though they carry the tag the tag feed reads),
// replies and boosts among them, their follows, blocks, mutes and domain blocks of the world's accounts and domains,
// their favourites, bookmarks and notifications, their exclusive lists holding world accounts and their own, and their
// timeline markers.

// The world, the same in every run: the first of fast-check's samples for a fixed seed in which every endpoint has
// something to show the viewer (the first available local account). The viewer then follows everyone, favourites and
// bookmarks every status, has a notification from every account, has a list (VIEWER_LIST) of every account and a
// marker on each timeline; LISTED follows the viewer.
function viewerOf(world: World): number {
	return world.accounts.findIndex((account) => account.local && !account.suspended)
}

// The account whose followers and following the lists read: another account whose lists the viewer is shown. The
// viewer follows it (as everyone) and it follows the viewer, so each list shows the viewer something.
function listedOf(world: World): number {
	const model = new PolicyModel(world)
	const viewer = viewerOf(world)
	return world.accounts.findIndex((_, owner) => owner !== viewer && model.followListsShown(owner, viewer))
}

// The status the status endpoints read: a listable original with a listable reply and a listable public boost.
function targetOf(world: World): number {
	const model = new PolicyModel(world)
	const viewer = viewerOf(world)
	const listable = (s: number) => model.listable(s, viewer)
	return world.statuses.findIndex(
		(status, s) =>
			status.reblogOf === null &&
			listable(s) &&
			world.statuses.some((reply, r) => reply.replyTo === s && listable(r)) &&
			world.statuses.some((boost, b) => boost.reblogOf === s && boost.visibility === 'public' && listable(b))
	)
}

function rich(world: World): boolean {
	const model = new PolicyModel(world)
	const viewer = viewerOf(world)
	const publicListable = world.statuses.filter(
		(status, s) => status.visibility === 'public' && status.reblogOf === null && model.listable(s, viewer)
	)
	return (
		world.statuses.length >= 18 &&
		viewer >= 0 &&
		targetOf(world) >= 0 &&
		listedOf(world) >= 0 &&
		publicListable.some((status) => status.replyTo === null) &&
		publicListable.some((status) => status.tagged)
	)
}

const WORLD = fc.sample(worldArb, { numRuns: 1000, seed: 20261015 }).find(rich) as World
const VIEWER = viewerOf(WORLD)
const TARGET = targetOf(WORLD)
const LISTED = listedOf(WORLD)
// The account the account statuses endpoint reads: the author of the most statuses.
const AUTHOR = WORLD.accounts.map((_, x) => x).sort((a, b) => authored(b) - authored(a))[0] as number

function authored(x: number): number {
	return WORLD.statuses.filter((status) => status.author === x).length
}

const VIEWER_LIST = '700000000000000001'
const TOKEN_HASH = 'policy-bounds-token'
const PRESENT = { origin: 'https://kopje.test' }
const PAGE = { limit: 20 }

// Unrelated rows: per unrelated remote account, three statuses (a reply and a boost among them) and its edges (a
// follow of a world account other than LISTED, whose followers are listed); one unrelated local account per ten remote
// ones, with mutes, domain blocks, favourites, bookmarks and notifications. The viewer's own blocks and mutes of
// unrelated accounts and domain blocks of domains nobody lives on grow with them.
const UNRELATED_ACCOUNT_BASE = 300000000000000000n
const UNRELATED_STATUS_BASE = 400000000000000000n
const UNRELATED_LIST_BASE = 710000000000000000n
const HIDDEN: readonly Visibility[] = ['unlisted', 'private', 'direct', 'limited']

function writeViewer(sql: SqlStorage): void {
	const viewer = accountId(VIEWER)
	sql.exec(
		"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('bounds', 'secret', 'bounds', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
	)
	sql.exec(
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'bounds', ?, 'read')",
		TOKEN_HASH,
		viewer
	)
	WORLD.accounts.forEach((_, x) => {
		if (x === VIEWER) {
			return
		}
		sql.exec(
			`INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')
			ON CONFLICT (account_id, target_account_id) DO UPDATE SET state = 'accepted'`,
			viewer,
			accountId(x)
		)
		sql.exec(
			"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)",
			viewer,
			accountId(x)
		)
	})
	sql.exec(
		`INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')
		ON CONFLICT (account_id, target_account_id) DO UPDATE SET state = 'accepted'`,
		accountId(LISTED),
		viewer
	)
	sql.exec("INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'everyone')", VIEWER_LIST, viewer)
	WORLD.accounts.forEach((_, x) => {
		sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', VIEWER_LIST, accountId(x))
	})
	writeMarkers(sql, viewer)
	WORLD.statuses.forEach((status, s) => {
		sql.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', viewer, statusId(s))
		sql.exec('INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', viewer, statusId(s))
		if (status.author !== VIEWER) {
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
				viewer,
				accountId(status.author),
				statusId(s)
			)
		}
	})
}

function writeMarkers(sql: SqlStorage, account: string): void {
	for (const timeline of MARKER_TIMELINES) {
		sql.exec(
			"INSERT INTO markers (account_id, timeline, last_read_id, version, updated_at) VALUES (?, ?, ?, 1, '2026-01-01T00:00:00.000Z')",
			account,
			timeline,
			account
		)
	}
}

function writeUnrelated(sql: SqlStorage, remote: number): void {
	const worldAccounts = WORLD.accounts.length
	const account = (i: number) => String(UNRELATED_ACCOUNT_BASE + BigInt(i))
	const status = (i: number) => String(UNRELATED_STATUS_BASE + BigInt(i))
	const locals = Math.floor(remote / 10)
	for (let i = 0; i < remote + locals; i++) {
		const local = i >= remote
		const domain = local ? null : `far${i % 10}.example`
		sql.exec(
			'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
			account(i),
			local ? `https://kopje.test/ap/users/u${i}` : `https://${domain}/users/u${i}`,
			`u${i}`,
			domain
		)
		if (local) {
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
				account(i),
				`u${i}@example.com`
			)
			writeMarkers(sql, account(i))
		}
	}
	for (let i = 0; i < remote; i++) {
		const author = account(i)
		const [first, reply, boost] = [status(3 * i), status(3 * i + 1), status(3 * i + 2)]
		const insert = (id: string, visibility: Visibility, extra: { replyTo?: string; reblogOf?: string } = {}) =>
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
					visibility, content, published_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				`https://far.example/objects/${id}`,
				author,
				extra.reblogOf ?? null,
				extra.replyTo === undefined ? null : `https://far.example/objects/${extra.replyTo}`,
				extra.replyTo ?? null,
				extra.replyTo === undefined ? null : author,
				visibility,
				extra.reblogOf === undefined ? `<p>status ${id}</p>` : '',
				new Date(NOW).toISOString()
			)
		insert(first, HIDDEN[i % HIDDEN.length] ?? 'private')
		insert(reply, HIDDEN[(i + 1) % HIDDEN.length] ?? 'private', { replyTo: first })
		insert(boost, 'public', { reblogOf: first })
		// The world's tag on statuses no tag feed lists, as the writers record it (not public).
		sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, 'cats', 0), (?, 'cats', 0)", first, reply)
		// The viewer's own choices about accounts and domains the world never shows them.
		const viewer = accountId(VIEWER)
		if (i % 3 === 0) {
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', viewer, author)
		} else if (i % 3 === 1) {
			sql.exec(
				'INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES (?, ?, ?, ?)',
				viewer,
				author,
				i % 2,
				i % 4 === 1 ? null : new Date(NOW + 3_600_000).toISOString()
			)
		}
		if (i % 10 === 0) {
			sql.exec('INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', viewer, `unused${i}.example`)
		}
		// A world account other than the viewer is mentioned; the viewer never is.
		const mentioned = (VIEWER + 1 + (i % (worldAccounts - 1))) % worldAccounts
		sql.exec('INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)', first, accountId(mentioned))
		const world = accountId(i % worldAccounts)
		const followed = i % worldAccounts === LISTED ? accountId((LISTED + 1) % worldAccounts) : world
		sql.exec("INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", author, followed)
		sql.exec(
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			author,
			account((i + 1) % remote)
		)
		sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', author, world)
	}
	for (let j = 0; j < locals; j++) {
		const owner = account(remote + j)
		// An exclusive list of the owner's, with a world account (other than LISTED, whose followers are listed) and an
		// unrelated one it follows.
		const list = String(UNRELATED_LIST_BASE + BigInt(j))
		const followed = [
			accountId(j % worldAccounts === LISTED ? (LISTED + 1) % worldAccounts : j % worldAccounts),
			account(j),
		]
		sql.exec("INSERT INTO lists (id, account_id, title, exclusive) VALUES (?, ?, 'l', 1)", list, owner)
		sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', list, owner)
		for (const member of followed) {
			sql.exec("INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", owner, member)
			sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', list, member)
		}
		sql.exec(
			'INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES (?, ?, ?, ?)',
			owner,
			accountId(j % worldAccounts),
			j % 2,
			j % 3 === 0 ? null : new Date(NOW + (j % 3 === 1 ? -1 : 1) * 3_600_000).toISOString()
		)
		sql.exec('INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', owner, REMOTE_DOMAINS[j % 2] ?? '')
		for (let k = 0; k < 10; k++) {
			const target = status(3 * (j * 10 + k))
			sql.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', owner, target)
			sql.exec('INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', owner, target)
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
				owner,
				accountId(k % worldAccounts),
				target
			)
		}
	}
}

async function worldWith(unrelated: number): Promise<StoreStub> {
	const store = await migratedStore()
	await runInDurableObject(store, (_instance, state) => {
		writeWorld(state.storage.sql, WORLD)
		writeViewer(state.storage.sql)
		writeUnrelated(state.storage.sql, unrelated)
	})
	return store
}

const credential = { tokenHash: TOKEN_HASH, scope: 'read', now: NOW } as const
const target = { credential, now: NOW, id: statusId(TARGET), present: PRESENT }
const searchInput = { credential, limit: 20, offset: 0, following: false, localDomain: 'kopje.test', present: PRESENT }
const timeline = { credential, now: NOW, page: PAGE, local: false, remote: false, onlyMedia: false, present: PRESENT }

// Each endpoint with its input, as the routes call them.
const ENDPOINTS: [string, StoreOperation<never, unknown>, unknown][] = [
	['home', homeTimeline, { credential, page: PAGE, present: PRESENT }],
	['list', listTimeline, { credential, id: VIEWER_LIST, page: PAGE, present: PRESENT }],
	['public', publicTimeline, timeline],
	['tag', tagTimeline, { ...timeline, tag: 'cats', any: [], all: [], none: [] }],
	[
		'account statuses',
		accountStatuses,
		{
			credential,
			now: NOW,
			account: accountId(AUTHOR),
			page: PAGE,
			onlyMedia: false,
			excludeReplies: false,
			excludeReblogs: false,
			pinned: false,
			tagged: null,
			present: PRESENT,
		},
	],
	[
		'notifications',
		listNotifications,
		{ credential, page: PAGE, types: [], excludeTypes: [], accountId: null, present: PRESENT },
	],
	['context', statusContext, target],
	['favourites', favourites, { credential, page: PAGE, present: PRESENT }],
	['bookmarks', bookmarks, { credential, page: PAGE, present: PRESENT }],
	['favourited_by', interactors, { ...target, kind: 'favourited_by', page: PAGE }],
	['reblogged_by', interactors, { ...target, kind: 'reblogged_by', page: PAGE }],
	['relationships', relationships, { credential, ids: WORLD.accounts.map((_, x) => accountId(x)) }],
	[
		'followers',
		listFollows,
		{ credential, now: NOW, account: accountId(LISTED), direction: 'followers', page: PAGE, present: PRESENT },
	],
	[
		'following',
		listFollows,
		{ credential, now: NOW, account: accountId(LISTED), direction: 'following', page: PAGE, present: PRESENT },
	],
	// Among the viewer's follows: a search of every account reads the newest accounts the instance knows, a window
	// that grows with them up to its limit (ACCOUNT_RECENT_LIMIT).
	['account search', search, { ...searchInput, query: 'account', types: ['accounts'], following: true }],
	['status search', search, { ...searchInput, query: 'status', types: ['statuses'] }],
	['hashtag search', search, { ...searchInput, query: 'cats', types: ['hashtags'] }],
	['markers', getMarkers, { credential, timelines: [...MARKER_TIMELINES] }],
]

// How many rows a read may add when the unrelated rows grow from none to UNRELATED: a few for a planner's choice, far
// fewer than reading the unrelated rows would add.
const ALLOWANCE = 10
const UNRELATED = 1000

// What an endpoint showed: the items of a page, the members of a context, the results of a search, the entries of a
// list, or the timelines of markers, through the operation's ok result.
function shown(output: unknown): number {
	if (Array.isArray(output)) {
		return output.length
	}
	const value = output as Record<string, unknown>
	if (value.status === 'ok') {
		return shown(value.value)
	}
	if (Array.isArray(value.items)) {
		return value.items.length
	}
	if (Array.isArray(value.descendants) && Array.isArray(value.ancestors)) {
		return value.ancestors.length + value.descendants.length
	}
	if (Array.isArray(value.accounts) && Array.isArray(value.statuses) && Array.isArray(value.hashtags)) {
		return value.accounts.length + value.statuses.length + value.hashtags.length
	}
	return MARKER_TIMELINES.filter((timeline) => timeline in value).length
}

type Entity = Record<string, unknown>

// What an endpoint showed, by identity and in order: statuses by id (and a boost's original), accounts by id,
// notifications by id, type, sender and status, hashtags by name, and relationships by their flags. Other objects
// (pages, contexts, search results, ok results) keep their shape.
function identities(output: unknown): unknown {
	if (Array.isArray(output)) {
		return output.map(identities)
	}
	if (output === null || typeof output !== 'object') {
		return output
	}
	const value = output as Entity
	if ('blocking' in value) {
		const {
			id,
			following,
			followed_by,
			requested,
			blocking,
			blocked_by,
			muting,
			muting_notifications,
			domain_blocking,
		} = value
		return {
			id,
			following,
			followed_by,
			requested,
			blocking,
			blocked_by,
			muting,
			muting_notifications,
			domain_blocking,
		}
	}
	if ('type' in value && 'account' in value) {
		return {
			id: value.id,
			type: value.type,
			account: (value.account as Entity).id,
			status: (value.status as Entity | null | undefined)?.id ?? null,
		}
	}
	if ('visibility' in value && 'account' in value) {
		return { id: value.id, reblog: (value.reblog as Entity | null)?.id ?? null }
	}
	if ('acct' in value) {
		return value.id
	}
	if ('history' in value && 'name' in value) {
		return value.name
	}
	return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, identities(field)]))
}

describe('read endpoints do not read more rows as unrelated data grows (RES-7)', () => {
	it('reads the same rows with or without unrelated accounts, statuses and edges', async () => {
		const alone = await worldWith(0)
		const crowded = await worldWith(UNRELATED)
		// Every endpoint shows the viewer something, so a refused credential or an empty read cannot pass, and shows the
		// same with the unrelated rows as without.
		const outputs = async (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) =>
				ENDPOINTS.map(([name, operation, input]) => [name, operation.run(state.storage.sql, input as never)] as const)
			)
		const withoutUnrelated = await outputs(alone)
		expect(withoutUnrelated.filter(([, output]) => shown(output) === 0).map(([name]) => name)).toEqual([])
		const named = (results: (readonly [string, unknown])[]) =>
			Object.fromEntries(results.map(([name, output]) => [name, identities(output)]))
		expect(named(await outputs(crowded))).toEqual(named(withoutUnrelated))
		const grown: string[] = []
		for (const [name, operation, input] of ENDPOINTS) {
			const few = await rowsRead({ store: alone }, operation, input as never)
			const many = await rowsRead({ store: crowded }, operation, input as never)
			if (many > few + ALLOWANCE) {
				grown.push(`${name}: ${few} -> ${many}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// R2's domain term is looked up only for a remote viewer: a local or anonymous viewer reads the same rows however many
// public statuses of other authors (remote, on several domains) the rule passes, and a remote viewer on a domain the
// author blocks sees none.
describe("the author's domain block costs a local viewer nothing per status (R2, RES-7)", () => {
	const LOCAL_VIEWER = '500000000000000001'
	const BLOCKING_AUTHOR = '500000000000000002'
	const REMOTE_VIEWER = '500000000000000003'
	const OTHER_VIEWER = '500000000000000004'
	const author = (i: number) => String(510000000000000000n + BigInt(i))
	const status = (i: number) => String(520000000000000000n + BigInt(i))
	const BLOCKED_STATUS = '529999999999999999'
	const PUBLIC_TOKEN = 'public-statuses-token'
	const AUTHORS = 20

	async function publicStatuses(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const account = (id: string, uri: string, username: string, domain: string | null) =>
				sql.exec('INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)', id, uri, username, domain)
			const local = (id: string, username: string) => {
				account(id, `https://kopje.test/ap/users/${username}`, username, null)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${username}@example.com`
				)
			}
			const insertStatus = (id: string, by: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', '<p>hello</p>', ?)`,
					id,
					`https://kopje.test/objects/${id}`,
					by,
					new Date(NOW).toISOString()
				)
			local(LOCAL_VIEWER, 'viewer')
			local(BLOCKING_AUTHOR, 'author')
			account(REMOTE_VIEWER, 'https://blocked.example/users/r', 'r', 'blocked.example')
			account(OTHER_VIEWER, 'https://open.example/users/o', 'o', 'open.example')
			sql.exec("INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", BLOCKING_AUTHOR)
			insertStatus(BLOCKED_STATUS, BLOCKING_AUTHOR)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('rows', 'secret', 'rows', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'rows', ?, 'read')",
				PUBLIC_TOKEN,
				LOCAL_VIEWER
			)
			// The same authors whatever the count.
			for (let a = 0; a < AUTHORS; a++) {
				account(author(a), `https://far${a % 10}.example/users/a${a}`, `a${a}`, `far${a % 10}.example`)
			}
			for (let i = 0; i < count; i++) {
				insertStatus(status(i), author(i % AUTHORS))
			}
		})
		return store
	}

	// Every status the read rule passes for the viewer, so the rule is judged once per stored status.
	const visibleCount = (viewer: string | null): StoreOperation<null, unknown> => ({
		kind: 'read',
		run: (sql) =>
			sql.exec(`SELECT count(*) AS n FROM main.statuses s WHERE ${visibleSql('s', '?1')}`, viewer).toArray(),
	})

	it('reads the same rows for a local viewer with 20 or 200 visible public statuses', async () => {
		const few = await publicStatuses(20)
		const many = await publicStatuses(200)
		const credential = { tokenHash: PUBLIC_TOKEN, scope: 'read', now: NOW } as const
		const input = { credential, now: NOW, page: PAGE, present: PRESENT, local: false, remote: false, onlyMedia: false }
		const page = async (store: StoreStub) => rowsRead({ store }, publicTimeline, input as never)
		expect(await page(many)).toBeLessThanOrEqual((await page(few)) + ALLOWANCE)
		// Over every stored status, a local viewer reads at most one row more than the anonymous viewer: the check that
		// it is not remote, once per query.
		for (const store of [few, many]) {
			const local = await rowsRead({ store }, visibleCount(LOCAL_VIEWER), null)
			const anonymous = await rowsRead({ store }, visibleCount(null), null)
			expect(local - anonymous).toBeLessThanOrEqual(1)
		}
	})

	it('hides a public status from a remote viewer on a domain its author blocks, and from no one else', async () => {
		const store = await publicStatuses(1)
		await runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			expect(canView(db, REMOTE_VIEWER, BLOCKED_STATUS)).toBe(false)
			expect(canView(db, OTHER_VIEWER, BLOCKED_STATUS)).toBe(true)
			expect(canView(db, LOCAL_VIEWER, BLOCKED_STATUS)).toBe(true)
			expect(canView(db, null, BLOCKED_STATUS)).toBe(true)
		})
	})
})

// Home and a list's timeline read each author's own window (AuthorWindows in audience.ts): a page reads about a page of
// statuses per followed account or member, however many statuses each has, and wherever the page's cursor is. The
// viewer follows every author and has a list of them all; each author, and the viewer, has a history of public,
// unlisted and private statuses, some of them replies in their own thread, every one of which home and the list show;
// one more followed account and member has only direct statuses, addressed to someone else, which neither shows nor
// reads.
describe("home and list timelines read a page per author, not each author's history (RES-7)", () => {
	const VIEWER_ID = '600000000000000001'
	const LIST_ID = '600000000000000002'
	const HISTORY_TOKEN = 'history-token'
	const AUTHORS = 6
	const WHISPERER_ID = '600000000000000003'
	const ADDRESSEE_ID = '600000000000000004'
	const author = (i: number) => String(610000000000000000n + BigInt(i))
	const status = (i: number) => String(620000000000000000n + BigInt(i))
	const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private']

	async function histories(perAuthor: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/viewer', 'viewer')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('history', 'secret', 'history', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'history', ?, 'read')",
				HISTORY_TOKEN,
				VIEWER_ID
			)
			sql.exec("INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'authors')", LIST_ID, VIEWER_ID)
			const authors = [VIEWER_ID]
			for (let a = 0; a < AUTHORS; a++) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
					author(a),
					`https://far${a}.example/users/a${a}`,
					`a${a}`,
					`far${a}.example`
				)
				sql.exec(
					"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
					VIEWER_ID,
					author(a)
				)
				sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', LIST_ID, author(a))
				authors.push(author(a))
			}
			// A followed account (in the list too) whose statuses are all direct, addressed to another local account.
			for (const [id, username] of [
				[WHISPERER_ID, 'whisperer'],
				[ADDRESSEE_ID, 'addressee'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${username}`,
					username
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
					id,
					`${username}@example.com`
				)
			}
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				VIEWER_ID,
				WHISPERER_ID
			)
			sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', LIST_ID, WHISPERER_ID)
			authors.push(WHISPERER_ID)
			// The authors' statuses interleave, oldest first; every fourth is a reply in its author's own thread.
			for (let i = 0; i < perAuthor * authors.length; i++) {
				const by = authors[i % authors.length] ?? VIEWER_ID
				if (by === WHISPERER_ID) {
					sql.exec(
						`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
						VALUES (?, ?, ?, 'direct', '<p>psst</p>', ?)`,
						status(i),
						`https://kopje.test/objects/${status(i)}`,
						by,
						new Date(NOW).toISOString()
					)
					sql.exec('INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)', status(i), ADDRESSEE_ID)
					continue
				}
				const parent = i >= authors.length && i % 4 === 0 ? status(i - authors.length) : null
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
						visibility, content, published_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, '<p>hello</p>', ?)`,
					status(i),
					`https://kopje.test/objects/${status(i)}`,
					by,
					parent === null ? null : `https://kopje.test/objects/${parent}`,
					parent,
					parent === null ? null : by,
					VISIBILITIES[i % VISIBILITIES.length] ?? 'public',
					new Date(NOW).toISOString()
				)
			}
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 statuses per author, on the newest, a middle and the oldest page', async () => {
		const few = await histories(20)
		const many = await histories(2000)
		const credential = { tokenHash: HISTORY_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		// The newest page; a page from the middle of the longer histories (above every status of the shorter ones, so
		// their newest page); the oldest page.
		const middle = status((2000 * (AUTHORS + 2)) / 2)
		for (const page of [PAGE, { ...PAGE, maxId: middle }, { ...PAGE, minId: '1' }]) {
			for (const [name, operation, input] of [
				['home', homeTimeline, { credential, page, present: PRESENT }],
				['list', listTimeline, { credential, id: LIST_ID, page, present: PRESENT }],
			] as const) {
				// A full page from either store.
				const shownBy = async (store: StoreStub) =>
					runInDurableObject(store, (_instance, state) => shown(operation.run(state.storage.sql, input as never)))
				expect([await shownBy(few), await shownBy(many)]).toEqual([PAGE.limit, PAGE.limit])
				const fewRows = await rowsRead({ store: few }, operation as StoreOperation<never, unknown>, input as never)
				const manyRows = await rowsRead({ store: many }, operation as StoreOperation<never, unknown>, input as never)
				if (manyRows > fewRows + ALLOWANCE) {
					grown.push(`${name} ${JSON.stringify(page)}: ${fewRows} -> ${manyRows}`)
				}
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// Markers read the viewer's own rows through the (account_id, timeline) key: at most one per timeline, however many
// accounts have markers.
describe("markers read the viewer's rows, not every account's (RES-7)", () => {
	const VIEWER_ID = '630000000000000000'
	const MARKERS_TOKEN = 'markers-token'

	async function accountsWithMarkers(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username)
				SELECT CAST(630000000000000000 + i AS TEXT), 'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
				count
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts`
			)
			for (const timeline of MARKER_TIMELINES) {
				sql.exec(
					`INSERT INTO markers (account_id, timeline, last_read_id, version, updated_at)
					SELECT account_id, ?, account_id, 1, '2026-01-01T00:00:00.000Z' FROM local_accounts`,
					timeline
				)
			}
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('markers', 'secret', 'markers', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'markers', ?, 'read')",
				MARKERS_TOKEN,
				VIEWER_ID
			)
		})
		return store
	}

	it('reads the same rows with 10 or 2,000 accounts that have markers', async () => {
		const credential = { tokenHash: MARKERS_TOKEN, scope: 'read', now: NOW } as const
		const input = { credential, timelines: [...MARKER_TIMELINES] }
		const few = await accountsWithMarkers(10)
		const many = await accountsWithMarkers(2000)
		const shownBy = async (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) => shown(getMarkers.run(state.storage.sql, input)))
		expect([await shownBy(few), await shownBy(many)]).toEqual([2, 2])
		const fewRows = await rowsRead({ store: few }, getMarkers, input)
		expect(await rowsRead({ store: many }, getMarkers, input)).toBeLessThanOrEqual(fewRows + ALLOWANCE)
	})
})
