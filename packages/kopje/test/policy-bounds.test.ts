import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { PolicyModel } from './policy-model'
import { accountId, REMOTE_DOMAINS, statusId, type World, worldArb, writeWorld } from './policy-world'
import { rowsRead } from './read-helpers'
import { relationships } from '../src/domain/accounts'
import type { Visibility } from '../src/domain/audience'
import { listNotifications } from '../src/domain/notifications'
import { search } from '../src/domain/search'
import { interactors, statusContext } from '../src/domain/statuses'
import {
	accountStatuses,
	bookmarks,
	favourites,
	homeTimeline,
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
// and their favourites, bookmarks and notifications.

// The world, the same in every run: the first of fast-check's samples for a fixed seed in which every endpoint has
// something to show the viewer (the first available local account). The viewer then follows everyone, favourites and
// bookmarks every status, and has a notification from every account.
function viewerOf(world: World): number {
	return world.accounts.findIndex((account) => account.local && !account.suspended)
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
		publicListable.some((status) => status.replyTo === null) &&
		publicListable.some((status) => status.tagged)
	)
}

const WORLD = fc.sample(worldArb, { numRuns: 1000, seed: 20261015 }).find(rich) as World
const VIEWER = viewerOf(WORLD)
const TARGET = targetOf(WORLD)
// The account the account statuses endpoint reads: the author of the most statuses.
const AUTHOR = WORLD.accounts.map((_, x) => x).sort((a, b) => authored(b) - authored(a))[0] as number

function authored(x: number): number {
	return WORLD.statuses.filter((status) => status.author === x).length
}

const TOKEN_HASH = 'policy-bounds-token'
const PRESENT = { origin: 'https://kopje.test' }
const PAGE = { limit: 20 }

// Unrelated rows: per unrelated remote account, three statuses (a reply and a boost among them) and its edges; one
// unrelated local account per ten remote ones, with mutes, domain blocks, favourites, bookmarks and notifications. The
// viewer's own blocks and mutes of unrelated accounts and domain blocks of domains nobody lives on grow with them.
const UNRELATED_ACCOUNT_BASE = 300000000000000000n
const UNRELATED_STATUS_BASE = 400000000000000000n
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
		sql.exec('INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)', first, accountId(mentioned))
		const world = accountId(i % worldAccounts)
		sql.exec("INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", author, world)
		sql.exec(
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			author,
			account((i + 1) % remote)
		)
		sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', author, world)
	}
	for (let j = 0; j < locals; j++) {
		const owner = account(remote + j)
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
	['status search', search, { ...searchInput, query: 'status', types: ['statuses'] }],
	['hashtag search', search, { ...searchInput, query: 'cats', types: ['hashtags'] }],
]

// How many rows a read may add when the unrelated rows grow from none to UNRELATED: a few for a planner's choice, far
// fewer than reading the unrelated rows would add.
const ALLOWANCE = 10
const UNRELATED = 1000

// What an endpoint showed: the items of a page, the members of a context, the results of a search, or the entries of a
// list, through the operation's ok result.
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
