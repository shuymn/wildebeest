import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { PolicyModel } from './policy-model'
import { accountId, REMOTE_DOMAINS, statusId, type World, worldArb, writeWorld } from './policy-world'
import { rowsRead } from './read-helpers'
import { Db } from '../src/db/sql'
import { listFollows, relationships, userinfo } from '../src/domain/accounts'
import { canView, visibleSql, type Visibility } from '../src/domain/audience'
import { backfillConversations } from '../src/domain/conversation-rows'
import { listConversations } from '../src/domain/conversations'
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
// their favourites, bookmarks and notifications, and their exclusive lists holding world accounts and their own.

// The world, the same in every run: the first of fast-check's samples for a fixed seed in which every endpoint has
// something to show the viewer (the first available local account). The viewer then follows everyone, favourites and
// bookmarks every status, has a notification from every account, and has a list (VIEWER_LIST) of every account;
// LISTED follows the viewer.
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
		"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('bounds', 'secret', 'bounds', 'urn:ietf:wg:oauth:2.0:oob', 'read profile')"
	)
	sql.exec(
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'bounds', ?, 'read profile')",
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
		sql.exec(
			'INSERT INTO status_mentions (status_id, account_id, requires_mention, author_id) VALUES (?, ?, ?, ?)',
			first,
			accountId(mentioned),
			HIDDEN[i % HIDDEN.length] === 'direct' || HIDDEN[i % HIDDEN.length] === 'limited' ? 1 : 0,
			author
		)
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
		// The conversations of the direct statuses and mentions written, as migration 0009 makes them: the viewer's,
		// and the unrelated local accounts'.
		backfillConversations({ exec: (query: string) => state.storage.sql.exec(query) })
	})
	return store
}

// The world's history replicated: every status of the world `factor` times over, each copy older than every original
// (so the newest page is the world's), with its original's author, visibility, content, mentions and tag, a reply to
// the copy of its parent in the same replica and a boost of the copy of its original, and the viewer's favourite,
// bookmark and notification of it as the viewer has of the original. Replica 1 is the newest; within a replica the
// copies keep the world's order. A copy's id, and its edges' ids, depend only on its replica and its original, so the
// newest copies are the same whatever the factor. Accounts and the edges between them are not replicated.
const COPY_BASE = 190000000000000000n
const MAX_REPLICAS = 10_000
// The first id of the viewer's favourites, bookmarks and notifications of the world's own statuses, above every copy's.
const ORIGINAL_EDGE_BASE = 1_000_000_000

function copyId(replica: number, index: number): string {
	return String(COPY_BASE + BigInt((MAX_REPLICAS - replica) * WORLD.statuses.length + index))
}

function writeCopies(sql: SqlStorage, factor: number): void {
	const viewer = accountId(VIEWER)
	const replicas = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ?1)'
	const statuses = WORLD.statuses.length
	// The copy in replica n of the status with id x (NULL for NULL), as copyId.
	const copy = (x: string) =>
		`CAST(${COPY_BASE} + (${MAX_REPLICAS} - n) * ${statuses} + (CAST(${x} AS INTEGER) - ${statusId(0)}) AS TEXT)`
	const params = [factor] as const
	sql.exec(
		`${replicas}
		INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
			visibility, content, search_text, published_at)
		SELECT ${copy('s.id')}, s.uri || '/r' || n, s.account_id, ${copy('s.reblog_of_id')},
			CASE WHEN s.in_reply_to_id IS NULL THEN s.in_reply_to_uri ELSE s.in_reply_to_uri || '/r' || n END,
			${copy('s.in_reply_to_id')}, s.in_reply_to_account_id, s.visibility, s.content, s.search_text,
			strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at, '-' || (n * ${statuses}) || ' minutes')
		FROM statuses s, r`,
		...params
	)
	sql.exec(
		`${replicas}
		INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
		SELECT ${copy('m.status_id')}, m.account_id, m.silent, m.requires_mention, m.author_id FROM status_mentions m, r`,
		...params
	)
	sql.exec(
		`${replicas}
		INSERT INTO status_tags (status_id, name, public) SELECT ${copy('t.status_id')}, t.name, t.public FROM status_tags t, r`,
		...params
	)
	// The viewer's edges of the copies, in the copies' order and below those writeViewer then writes of the world's
	// statuses: the edge of a copy has the copy's offset from COPY_BASE, plus one.
	const edge = `CAST(id AS INTEGER) - ${COPY_BASE} + 1`
	const copies = 'FROM statuses WHERE id < ?2'
	sql.exec(`INSERT INTO favourites (id, account_id, status_id) SELECT ${edge}, ?1, id ${copies}`, viewer, statusId(0))
	sql.exec(`INSERT INTO bookmarks (id, account_id, status_id) SELECT ${edge}, ?1, id ${copies}`, viewer, statusId(0))
	sql.exec(
		`INSERT INTO notifications (id, account_id, type, from_account_id, status_id)
		SELECT ${edge}, ?1, 'mention', account_id, id ${copies} AND account_id <> ?1`,
		viewer,
		statusId(0)
	)
	// AUTOINCREMENT never reuses an id: a row just below ORIGINAL_EDGE_BASE, deleted, makes it the next id.
	const mark = ORIGINAL_EDGE_BASE - 1
	sql.exec('INSERT INTO favourites (id, account_id, status_id) VALUES (?, ?, ?)', mark, viewer, statusId(0))
	sql.exec('INSERT INTO bookmarks (id, account_id, status_id) VALUES (?, ?, ?)', mark, viewer, statusId(0))
	sql.exec(
		"INSERT INTO notifications (id, account_id, type, from_account_id) VALUES (?, ?, 'mark', ?)",
		mark,
		viewer,
		viewer
	)
	for (const table of ['favourites', 'bookmarks', 'notifications']) {
		sql.exec(`DELETE FROM ${table} WHERE id = ?`, mark)
	}
}

async function replicated(factor: number): Promise<StoreStub> {
	const store = await migratedStore()
	await runInDurableObject(store, (_instance, state) => {
		writeWorld(state.storage.sql, WORLD)
		writeCopies(state.storage.sql, factor)
		writeViewer(state.storage.sql)
	})
	return store
}

const credential = { tokenHash: TOKEN_HASH, scope: 'read', now: NOW } as const
const target = { credential, now: NOW, id: statusId(TARGET), present: PRESENT }
const searchInput = { credential, limit: 20, offset: 0, following: false, localDomain: 'kopje.test', present: PRESENT }
const timeline = { credential, now: NOW, page: PAGE, local: false, remote: false, onlyMedia: false, present: PRESENT }

// What an endpoint that pages a viewer's history pages by: statuses (by status id), the viewer's notifications,
// favourites or bookmarks (by their ids), or a status's interactors (accounts, which are not replicated).
type Paging = 'statuses' | 'notifications' | 'favourites' | 'bookmarks' | 'interactors'

// Each endpoint with its input, as the routes call them, and for one that pages the history, what it pages by.
const ENDPOINTS: [string, StoreOperation<never, unknown>, unknown, Paging?][] = [
	['home', homeTimeline, { credential, page: PAGE, present: PRESENT }, 'statuses'],
	['list', listTimeline, { credential, id: VIEWER_LIST, page: PAGE, present: PRESENT }, 'statuses'],
	['public', publicTimeline, timeline, 'statuses'],
	['tag', tagTimeline, { ...timeline, tag: 'cats', any: [], all: [], none: [] }, 'statuses'],
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
		'statuses',
	],
	[
		'notifications',
		listNotifications,
		{ credential, page: PAGE, types: [], excludeTypes: [], accountId: null, present: PRESENT },
		'notifications',
	],
	['context', statusContext, target],
	['conversations', listConversations, { credential, page: PAGE, present: PRESENT }, 'statuses'],
	['favourites', favourites, { credential, page: PAGE, present: PRESENT }, 'favourites'],
	['bookmarks', bookmarks, { credential, page: PAGE, present: PRESENT }, 'bookmarks'],
	['favourited_by', interactors, { ...target, kind: 'favourited_by', page: PAGE }, 'interactors'],
	['reblogged_by', interactors, { ...target, kind: 'reblogged_by', page: PAGE }, 'interactors'],
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
	['userinfo', userinfo, { credential: { ...credential, scope: 'profile' }, present: PRESENT }],
]

// How many rows a read may add when the unrelated rows grow from none to UNRELATED: a few for a planner's choice, far
// fewer than reading the unrelated rows would add.
const ALLOWANCE = 10
const UNRELATED = 1000

// What an endpoint showed: the items of a page, the members of a context, the results of a search, the entries of a
// list, or the account userinfo claims, through the operation's ok result.
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
	if (typeof value.sub === 'string') {
		return 1
	}
	if (Array.isArray(value.descendants) && Array.isArray(value.ancestors)) {
		return value.ancestors.length + value.descendants.length
	}
	if (Array.isArray(value.accounts) && Array.isArray(value.statuses) && Array.isArray(value.hashtags)) {
		return value.accounts.length + value.statuses.length + value.hashtags.length
	}
	return 0
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

// The world's history grown by replicating it (writeCopies): its composition stays, so a read that walks past what it
// hides or filters reads a constant multiple of a page, while one that walks or sorts a whole history grows with the
// factor. Both factors are past the point where each author's history holds more than a page of what it shows. The
// author set is not grown (no follow cap bounds it yet), nor are skewed histories built.
describe("read endpoints read the same rows however long the world's history (RES-7)", () => {
	const FEW = 40
	const MANY = 400

	// Endpoints whose reads grow with the history, left out of the comparison.
	const GROWING = new Set([
		// Search reads windows of the viewer's library (LIBRARY_SOURCE_LIMIT per source) and, for hashtags, of their own
		// entries and the newest public statuses (HASHTAG_LIBRARY_LIMIT, HASHTAG_PUBLIC_WINDOW): they grow with the
		// history up to those limits.
		'status search',
		'hashtag search',
	])

	type Measured = { endpoint: string; page: string; rows: number; shown: number; output: unknown }

	// Each endpoint's newest page, a page from the middle of the replicated history and the oldest page, or its one read
	// if it does not page the history.
	async function measure(factor: number): Promise<Measured[]> {
		const store = await replicated(factor)
		const viewer = accountId(VIEWER)
		const middle = await runInDurableObject(store, (_instance, state) => {
			// The viewer's edge halfway through those of the copies.
			const edge = (table: string) =>
				String(
					state.storage.sql
						.exec<{ id: number }>(
							`SELECT id FROM ${table} WHERE account_id = ?1 AND id < ?2 ORDER BY id
							LIMIT 1 OFFSET (SELECT count(*) / 2 FROM ${table} WHERE account_id = ?1 AND id < ?2)`,
							viewer,
							ORIGINAL_EDGE_BASE
						)
						.one().id
				)
			const cursors: Record<Paging, string | undefined> = {
				statuses: copyId(Math.floor(factor / 2), 0),
				notifications: edge('notifications'),
				favourites: edge('favourites'),
				bookmarks: edge('bookmarks'),
				// The target's interactors are accounts, which are not replicated: their newest page stands for the middle.
				interactors: undefined,
			}
			return cursors
		})
		const measured: Measured[] = []
		for (const [endpoint, operation, input, paging] of ENDPOINTS) {
			const maxId = paging === undefined ? undefined : middle[paging]
			const pages: [string, unknown][] =
				paging === undefined
					? [['once', input]]
					: [
							['newest', input],
							['middle', { ...(input as object), page: maxId === undefined ? PAGE : { ...PAGE, maxId } }],
							['oldest', { ...(input as object), page: { ...PAGE, minId: '1' } }],
						]
			for (const [page, paged] of pages) {
				const output = await runInDurableObject(store, (_instance, state) =>
					operation.run(state.storage.sql, paged as never)
				)
				const rows = await rowsRead({ store }, operation, paged as never)
				measured.push({ endpoint, page, rows, shown: shown(output), output })
			}
		}
		return measured
	}

	it(`reads the same rows with the world's history replicated ${FEW} or ${MANY} times`, async () => {
		const few = await measure(FEW)
		const many = await measure(MANY)
		// Every endpoint shows the viewer something on every page at either factor, and the same newest page (or one read).
		const empty = [...few, ...many].flatMap(({ endpoint, page, shown }) => (shown === 0 ? [`${endpoint} ${page}`] : []))
		expect(empty).toEqual([])
		const newest = (measured: Measured[]) =>
			Object.fromEntries(
				measured
					.filter(({ page }) => page === 'newest' || page === 'once')
					.map(({ endpoint, output }) => [endpoint, identities(output)])
			)
		expect(newest(many)).toEqual(newest(few))
		const grown = few.flatMap(({ endpoint, page, rows }, i) => {
			const manyRows = many[i]?.rows ?? Infinity
			return GROWING.has(endpoint) || manyRows <= rows + ALLOWANCE
				? []
				: [`${endpoint} ${page}: ${rows} -> ${manyRows}`]
		})
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
					sql.exec(
						'INSERT INTO status_mentions (status_id, account_id, requires_mention, author_id) VALUES (?, ?, 1, ?)',
						status(i),
						ADDRESSEE_ID,
						by
					)
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

// The conversation list reads a page of the viewer's conversations through the (account, last status) index, and each
// one's last status and participants, however many conversations the viewer has and however long each is: the viewer
// has 20 or 2,000 conversations, each a thread of three direct statuses with one of ten remote accounts.
describe('the conversation list reads a page, not the history (RES-7)', () => {
	const VIEWER_ID = '800000000000000001'
	const HISTORY_TOKEN = 'conversations-token'
	const PARTNERS = 10
	const partner = (i: number) => String(810000000000000000n + BigInt(i))
	const status = (i: number) => String(820000000000000000n + BigInt(i))

	async function conversations(count: number): Promise<StoreStub> {
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
			for (let p = 0; p < PARTNERS; p++) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
					partner(p),
					`https://far${p}.example/users/p${p}`,
					`p${p}`,
					`far${p}.example`
				)
			}
			// Each conversation: the partner writes, the viewer answers, the partner answers again.
			for (let c = 0; c < count; c++) {
				const with_ = partner(c % PARTNERS)
				for (let k = 0; k < 3; k++) {
					const id = status(3 * c + k)
					const author = k === 1 ? VIEWER_ID : with_
					const parent = k === 0 ? null : status(3 * c + k - 1)
					sql.exec(
						`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
							visibility, content, published_at)
						VALUES (?, ?, ?, ?, ?, ?, 'direct', '<p>psst</p>', ?)`,
						id,
						`https://kopje.test/objects/${id}`,
						author,
						parent === null ? null : `https://kopje.test/objects/${parent}`,
						parent,
						parent === null ? null : k === 1 ? with_ : VIEWER_ID,
						new Date(NOW).toISOString()
					)
					sql.exec(
						'INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)',
						id,
						author === VIEWER_ID ? with_ : VIEWER_ID
					)
					if (author !== VIEWER_ID) {
						sql.exec(
							"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
							VIEWER_ID,
							author,
							id
						)
					}
				}
			}
			backfillConversations({ exec: (query: string) => sql.exec(query) })
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 conversations, on the newest, a middle and the oldest page', async () => {
		const few = await conversations(20)
		const many = await conversations(2000)
		const credential = { tokenHash: HISTORY_TOKEN, scope: 'read', now: NOW } as const
		const grown: string[] = []
		// A page from the middle of the longer history is above every conversation of the shorter one.
		const middle = status(3 * 1000 + 2)
		for (const page of [PAGE, { ...PAGE, maxId: middle }, { ...PAGE, minId: '1' }]) {
			const input = { credential, page, present: PRESENT }
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => shown(listConversations.run(state.storage.sql, input)))
			expect([await shownBy(few), await shownBy(many)]).toEqual([PAGE.limit, PAGE.limit])
			const fewRows = await rowsRead({ store: few }, listConversations, input)
			const manyRows = await rowsRead({ store: many }, listConversations, input)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${JSON.stringify(page)}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// What the viewer never sees of an author costs nothing, however long the author's history. Home reads the viewer's
// mentions per followed account (status_mentions_requires_mention), so an account the viewer does not follow, sending
// them direct statuses, is never read; and an account's statuses are not read when the viewer may see none of them:
// the account blocks the viewer, the viewer blocks it, or it is suspended or being deleted.
describe("reads skip an author's history the viewer never sees (RES-7)", () => {
	const VIEWER_ID = '640000000000000001'
	const FRIEND_ID = '640000000000000002'
	const STRANGER_ID = '640000000000000003'
	const BLOCKER_ID = '640000000000000004'
	const BLOCKED_ID = '640000000000000005'
	const SUSPENDED_ID = '640000000000000006'
	const DELETING_ID = '640000000000000007'
	const HIDDEN_AUTHORS = { blocker: BLOCKER_ID, blocked: BLOCKED_ID, suspended: SUSPENDED_ID, deleting: DELETING_ID }
	const SKIP_TOKEN = 'skip-token'
	const status = (i: number) => String(650000000000000000n + BigInt(i))

	async function histories(perAuthor: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const local = (id: string, username: string, suspended = false) => {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${username}`,
					username
				)
				sql.exec(
					`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at)
					VALUES (?, ?, X'00', X'00', 'test', ?)`,
					id,
					`${username}@example.com`,
					suspended ? '2026-01-01T00:00:00.000Z' : null
				)
			}
			const remote = (id: string, username: string, deleting = false) =>
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain, deleted_at) VALUES (?, ?, ?, ?, ?)',
					id,
					`https://far.example/users/${username}`,
					username,
					'far.example',
					deleting ? '2026-01-01T00:00:00.000Z' : null
				)
			local(VIEWER_ID, 'viewer')
			local(SUSPENDED_ID, 'suspended', true)
			remote(FRIEND_ID, 'friend')
			remote(STRANGER_ID, 'stranger')
			remote(BLOCKER_ID, 'blocker')
			remote(BLOCKED_ID, 'blocked')
			remote(DELETING_ID, 'deleting', true)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('skip', 'secret', 'skip', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'skip', ?, 'read')",
				SKIP_TOKEN,
				VIEWER_ID
			)
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				VIEWER_ID,
				FRIEND_ID
			)
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', BLOCKER_ID, VIEWER_ID)
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER_ID, BLOCKED_ID)
			// The friend's public statuses fill home; the stranger's direct statuses to the viewer interleave with them,
			// and each hidden author posts publicly, all newer than the friend's.
			const authors = [FRIEND_ID, STRANGER_ID, ...Object.values(HIDDEN_AUTHORS)]
			for (let i = 0; i < perAuthor * authors.length; i++) {
				const by = authors[i % authors.length] ?? FRIEND_ID
				const direct = by === STRANGER_ID
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, ?, '<p>hello</p>', ?)`,
					status(i),
					`https://far.example/objects/${status(i)}`,
					by,
					direct ? 'direct' : 'public',
					new Date(NOW).toISOString()
				)
				if (direct) {
					sql.exec(
						'INSERT INTO status_mentions (status_id, account_id, requires_mention, author_id) VALUES (?, ?, 1, ?)',
						status(i),
						VIEWER_ID,
						by
					)
				}
			}
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 statuses per author', async () => {
		const few = await histories(20)
		const many = await histories(2000)
		const credential = { tokenHash: SKIP_TOKEN, scope: 'read', now: NOW } as const
		const reads: [string, StoreOperation<never, unknown>, unknown, number][] = [
			// A full page of the friend's statuses, none of the stranger's.
			['home', homeTimeline, { credential, page: PAGE, present: PRESENT }, PAGE.limit],
			...Object.entries(HIDDEN_AUTHORS).map(
				([name, account]) =>
					[
						`account statuses of ${name}`,
						accountStatuses,
						{
							credential,
							now: NOW,
							account,
							page: PAGE,
							onlyMedia: false,
							excludeReplies: false,
							excludeReblogs: false,
							pinned: false,
							tagged: null,
							present: PRESENT,
						},
						0,
					] as [string, StoreOperation<never, unknown>, unknown, number]
			),
		]
		const grown: string[] = []
		for (const [name, operation, input, expected] of reads) {
			const shownBy = async (store: StoreStub) =>
				runInDurableObject(store, (_instance, state) => shown(operation.run(state.storage.sql, input as never)))
			expect([name, await shownBy(few), await shownBy(many)]).toEqual([name, expected, expected])
			const fewRows = await rowsRead({ store: few }, operation, input as never)
			const manyRows = await rowsRead({ store: many }, operation, input as never)
			if (manyRows > fewRows + ALLOWANCE) {
				grown.push(`${name}: ${fewRows} -> ${manyRows}`)
			}
		}
		expect(grown).toEqual([])
	}, 60_000)
})

// Userinfo reads the token's own account: its newest public, unlisted or private status (last_status_at) comes from the
// partial index statuses_feed, so the rows read do not grow with the account's history, nor with its direct statuses,
// which are its newest here.
describe("userinfo reads the account, not the account's history (RES-7)", () => {
	const OWNER_ID = '800000000000000001'
	const OWNER_TOKEN = 'userinfo-token'
	const status = (i: number) => String(810000000000000000n + BigInt(i))

	async function history(count: number): Promise<StoreStub> {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/owner', 'owner')",
				OWNER_ID
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'owner@example.com', X'00', X'00', 'test')",
				OWNER_ID
			)
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('userinfo', 'secret', 'userinfo', 'urn:ietf:wg:oauth:2.0:oob', 'profile')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'userinfo', ?, 'profile')",
				OWNER_TOKEN,
				OWNER_ID
			)
			// The oldest quarter is public, every later status direct.
			for (let i = 0; i < count; i++) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, ?, '<p>hello</p>', ?)`,
					status(i),
					`https://kopje.test/objects/${status(i)}`,
					OWNER_ID,
					i < count / 4 ? 'public' : 'direct',
					new Date(NOW).toISOString()
				)
			}
		})
		return store
	}

	it('reads the same rows with 20 or 2,000 statuses', async () => {
		const input = { credential: { tokenHash: OWNER_TOKEN, scope: 'profile', now: NOW }, present: PRESENT } as const
		const counts: number[] = []
		for (const store of [await history(20), await history(2000)]) {
			const output = await runInDurableObject(store, (_instance, state) => userinfo.run(state.storage.sql, input))
			expect(output).toMatchObject({ status: 'ok', value: { sub: 'https://kopje.test/ap/users/owner' } })
			counts.push(await rowsRead({ store }, userinfo, input))
		}
		const [few = 0, many = 0] = counts
		expect(many).toBeLessThanOrEqual(few + ALLOWANCE)
	}, 60_000)
})
