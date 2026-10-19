import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, form, registerApp, sql } from './api-helpers'
import { harness } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD } from './helpers'
import { mastodonActor, RemoteWeb, signedInit } from './inbox-helpers'
import { appToken, scopedToken } from './read-helpers'
import { block, community, domainBlock, follow, getJson, mute, type User } from './status-helpers'
import { SUGGESTION_EDGES, SUGGESTION_EDGES_PER_SOURCE, SUGGESTION_SOURCES } from '../src/domain/suggestions'
import type { StoreStub } from '../src/platform/store-client'

// Follow suggestions (Mastodon 4.5's friends-of-friends source; R39, docs/visibility.md "Suggestions"): the shapes,
// the access rules, each exclusion, the sources R13 hides, the parameters, dismissals, and witnesses at each window's
// real bound.

// Remote accounts by index: ids BASE + i, in the order they are made.
const BASE = 500_000_000_000_000_000n
const id = (i: number) => String(BASE + BigInt(i))
const newestFirst = (ids: readonly string[]) => [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))

// `count` remote accounts from index `from` (discoverable unless said otherwise) on `domain`; their ids.
async function remotes(
	store: StoreStub,
	from: number,
	count: number,
	options: { discoverable?: 0 | 1 | null; domain?: string } = {}
): Promise<string[]> {
	const domain = options.domain ?? 'remote.example'
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain, discoverable)
		SELECT CAST(?2 + i AS TEXT), 'https://' || ?3 || '/users/r' || (CAST(?4 AS INTEGER) + i),
			'r' || (CAST(?4 AS INTEGER) + i), ?3, ?5 FROM n`,
		count,
		id(from),
		domain,
		from,
		options.discoverable === undefined ? 1 : options.discoverable
	)
	return Array.from({ length: count }, (_, i) => id(from + i))
}

// Accepted follows, inserted in order, so their ids follow it.
async function follows(store: StoreStub, pairs: readonly (readonly [string, string])[]): Promise<void> {
	await sql(
		store,
		`INSERT INTO follows (account_id, target_account_id, state)
		SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), 'accepted' FROM json_each(?) ORDER BY key`,
		JSON.stringify(pairs)
	)
}

// `source` follows each of `targets`, in order.
const fan = (store: StoreStub, source: string, targets: readonly string[]) =>
	follows(
		store,
		targets.map((target) => [source, target] as const)
	)

const unfollow = (store: StoreStub, from: string, to: string) =>
	sql(store, 'DELETE FROM follows WHERE account_id = ? AND target_account_id = ?', from, to)

// An app token (no user) with the given scope.
async function appTokenWith(h: ApiHarness, scope: string): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	const response = await h.request(
		'/oauth/token',
		form({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret, scope })
	)
	return (await response.json<{ access_token: string }>()).access_token
}

type Listed = { id: string }
type Wrapped = { source: string; sources: string[]; account: Listed }

// The ids v1 suggests to `user`, after checking that v2 suggests the same, wrapped.
async function suggested(h: ApiHarness, user: User, query = ''): Promise<string[]> {
	const v1 = await getJson<Listed[]>(h, `/api/v1/suggestions${query}`, user.token)
	const v2 = await getJson<Wrapped[]>(h, `/api/v2/suggestions${query}`, user.token)
	expect([v1.status, v2.status]).toEqual([200, 200])
	const ids = v1.body.map((account) => account.id)
	expect(v2.body.map((item) => item.account.id)).toEqual(ids)
	return ids
}

// alice follows bob and carol (local, through the API). bob follows r0, r1 and dave (local, discoverable); carol
// follows r0 and r2. r0 lives on zero.example under an actor host of its own; r1 and r2 on remote.example.
async function world() {
	const h = await community(['alice', 'bob', 'carol', 'dave'])
	const { alice, bob, carol, dave } = h.users
	const [r0 = ''] = await remotes(h.store, 0, 1, { domain: 'zero.example' })
	await sql(h.store, "UPDATE accounts SET uri = 'https://social.zero-host.example/users/r0' WHERE id = ?", r0)
	const [r1 = '', r2 = ''] = await remotes(h.store, 1, 2)
	await sql(h.store, 'UPDATE accounts SET discoverable = 1 WHERE id = ?', dave.id)
	await follow(h, alice, bob.id)
	await follow(h, alice, carol.id)
	await follow(h, bob, dave.id)
	await fan(h.store, bob.id, [r0, r1])
	await fan(h.store, carol.id, [r0, r2])
	return { h, alice, bob, carol, dave, r0, r1, r2 }
}

describe('suggestions', () => {
	it('ranks by how many of the viewer’s follows follow each account, then by follower count, then newest', async () => {
		const { h, alice, dave, r0, r1, r2 } = await world()
		// r0 by two; r1, r2 and dave by one: the remote ones (no follower count is known of them, so 0) first, newest
		// first, then dave, whom bob's follow gives a follower.
		expect(await suggested(h, alice)).toEqual([r0, r2, r1, dave.id])
		const v1 = await getJson<Record<string, unknown>[]>(h, '/api/v1/suggestions', alice.token)
		const v2 = await getJson<Wrapped[]>(h, '/api/v2/suggestions', alice.token)
		expect(v1.body[0]).toMatchObject({ id: r0, username: 'r0' })
		expect(v2.body).toEqual(
			v1.body.map((account) => ({ source: 'past_interactions', sources: ['friends_of_friends'], account }))
		)
		expect(v1.body.map((account) => account.discoverable)).toEqual([true, true, true, true])
	})

	it('leaves out an account the viewer follows, requests, blocks, mutes or blocks the domain of', async () => {
		const { h, alice, dave, r0, r1, r2 } = await world()
		const without = [r2, r1, dave.id]
		const all = [r0, ...without]
		const cases: [string, string, string][] = [
			['followed', "INSERT INTO follows (account_id, target_account_id, state) VALUES (?1, ?2, 'accepted')", 'follows'],
			['requested', "INSERT INTO follows (account_id, target_account_id, state) VALUES (?1, ?2, 'pending')", 'follows'],
			['blocked', 'INSERT INTO blocks (account_id, target_account_id) VALUES (?1, ?2)', 'blocks'],
			['blocking', 'INSERT INTO blocks (account_id, target_account_id) VALUES (?2, ?1)', 'blocks'],
			['muted', 'INSERT INTO mutes (account_id, target_account_id) VALUES (?1, ?2)', 'mutes'],
			[
				'muted until later',
				"INSERT INTO mutes (account_id, target_account_id, expires_at) VALUES (?1, ?2, '2026-10-13T00:00:00.000Z')",
				'mutes',
			],
		]
		for (const [name, insert, table] of cases) {
			await sql(h.store, insert, alice.id, r0)
			expect([name, await suggested(h, alice)]).toEqual([name, without])
			await sql(
				h.store,
				`DELETE FROM ${table} WHERE (account_id = ?1 AND target_account_id = ?2) OR (account_id = ?2 AND target_account_id = ?1)`,
				alice.id,
				r0
			)
			expect([name, await suggested(h, alice)]).toEqual([name, all])
		}
		// A mute that has expired hides nothing.
		await sql(
			h.store,
			"INSERT INTO mutes (account_id, target_account_id, expires_at) VALUES (?, ?, '2026-10-11T00:00:00.000Z')",
			alice.id,
			r0
		)
		expect(await suggested(h, alice)).toEqual(all)
		await sql(h.store, 'DELETE FROM mutes')
		// A domain block, by the stored domain or by the actor id's host.
		for (const domain of ['zero.example', 'social.zero-host.example']) {
			await domainBlock(h.store, alice.id, domain)
			expect([domain, await suggested(h, alice)]).toEqual([domain, without])
			await sql(h.store, 'DELETE FROM domain_blocks')
		}
		expect(await suggested(h, alice)).toEqual(all)
	})

	it('leaves out unavailable, undiscoverable and dismissed accounts, and the viewer', async () => {
		const { h, alice, bob, dave, r0, r1, r2 } = await world()
		const without = [r2, r1, dave.id]
		const all = [r0, ...without]
		const changes: [string, string, string][] = [
			[
				'suspended by the instance',
				"UPDATE accounts SET suspended_at = '2026-10-01T00:00:00.000Z', suspension_source = 'account' WHERE id = ?",
				'UPDATE accounts SET suspended_at = NULL, suspension_source = NULL WHERE id = ?',
			],
			[
				'being deleted',
				"UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?",
				'UPDATE accounts SET deleted_at = NULL WHERE id = ?',
			],
			[
				'not discoverable',
				'UPDATE accounts SET discoverable = 0 WHERE id = ?',
				'UPDATE accounts SET discoverable = 1 WHERE id = ?',
			],
			[
				'unset',
				'UPDATE accounts SET discoverable = NULL WHERE id = ?',
				'UPDATE accounts SET discoverable = 1 WHERE id = ?',
			],
		]
		for (const [name, change, undo] of changes) {
			await sql(h.store, change, r0)
			expect([name, await suggested(h, alice)]).toEqual([name, without])
			await sql(h.store, undo, r0)
		}
		// An instance domain block that suspends the account's domain.
		await sql(
			h.store,
			"INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES ('zero.example', 'suspend', 'x', 'x')"
		)
		expect(await suggested(h, alice)).toEqual(without)
		await sql(h.store, 'DELETE FROM instance_domain_blocks')
		// A suspended local account.
		await sql(
			h.store,
			"UPDATE local_accounts SET suspended_at = '2026-10-01T00:00:00.000Z' WHERE account_id = ?",
			dave.id
		)
		expect(await suggested(h, alice)).toEqual([r0, r2, r1])
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?', dave.id)
		// The viewer, though bob follows her and she is discoverable.
		await sql(h.store, 'UPDATE accounts SET discoverable = 1 WHERE id = ?', alice.id)
		await fan(h.store, bob.id, [alice.id])
		expect(await suggested(h, alice)).toEqual(all)
		// Dismissed: {} and nothing else, each time.
		const dismiss = async (target: string, user = alice) => {
			const response = await h.request(`/api/v1/suggestions/${target}`, bearer(user.token, { method: 'DELETE' }))
			return { status: response.status, body: await response.json() }
		}
		expect(await dismiss(r0)).toEqual({ status: 200, body: {} })
		expect(await suggested(h, alice)).toEqual(without)
		expect(await dismiss(r0)).toEqual({ status: 200, body: {} })
		// Another viewer's dismissal is theirs only.
		expect(await dismiss(r1, bob)).toEqual({ status: 200, body: {} })
		expect(await suggested(h, alice)).toEqual(without)
		expect(
			await sql(h.store, 'SELECT account_id, target_account_id FROM follow_recommendation_mutes ORDER BY account_id')
		).toEqual([
			{ account_id: alice.id, target_account_id: r0 },
			{ account_id: bob.id, target_account_id: r1 },
		])
	})

	it('takes nothing from a source R13 hides from the viewer, local or remote', async () => {
		const { h, alice, bob, dave, r0, r1, r2 } = await world()
		// Without bob: r0 by carol alone.
		const withoutBob = [r2, r0]
		const changes: [string, string, string][] = [
			[
				'hiding its network',
				'UPDATE local_accounts SET hide_collections = 1 WHERE account_id = ?1 AND ?2 IS NOT NULL',
				'UPDATE local_accounts SET hide_collections = 0 WHERE account_id = ?1 AND ?2 IS NOT NULL',
			],
			[
				'suspended',
				"UPDATE local_accounts SET suspended_at = '2026-10-01T00:00:00.000Z' WHERE account_id = ?1 AND ?2 IS NOT NULL",
				'UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?1 AND ?2 IS NOT NULL',
			],
			[
				'blocking the viewer',
				'INSERT INTO blocks (account_id, target_account_id) VALUES (?1, ?2)',
				'DELETE FROM blocks WHERE account_id = ?1 AND target_account_id = ?2',
			],
		]
		for (const [name, change, undo] of changes) {
			await sql(h.store, change, bob.id, alice.id)
			expect([name, await suggested(h, alice)]).toEqual([name, withoutBob])
			await sql(h.store, undo, bob.id, alice.id)
		}
		expect(await suggested(h, alice)).toEqual([r0, r2, r1, dave.id])
		// A remote source: shown until Kopje learns it hides its network.
		const [source = '', r3 = ''] = await remotes(h.store, 3, 2)
		await follows(h.store, [
			[alice.id, source],
			[source, r3],
		])
		expect(await suggested(h, alice)).toEqual([r0, r3, r2, r1, dave.id])
		await sql(h.store, 'UPDATE accounts SET hide_collections = 1 WHERE id = ?', source)
		expect(await suggested(h, alice)).toEqual([r0, r2, r1, dave.id])
		// A pending follow is no source.
		await sql(
			h.store,
			"UPDATE follows SET state = 'pending' WHERE account_id = ? AND target_account_id = ?",
			alice.id,
			bob.id
		)
		expect(await suggested(h, alice)).toEqual(withoutBob)
	})

	it('reads limit and offset as the directory does, the answer ending at its 40th account', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const [source = '', ...candidates] = await remotes(h.store, 0, 42)
		await follows(h.store, [[alice.id, source]])
		await fan(h.store, source, candidates)
		const kept = newestFirst(candidates).slice(0, 40)
		expect(candidates).toHaveLength(41)
		expect(await suggested(h, alice)).toEqual(kept)
		expect(await suggested(h, alice, '?limit=80')).toEqual(kept)
		expect(await suggested(h, alice, '?limit=200')).toEqual(kept)
		expect(await suggested(h, alice, '?limit=2')).toEqual(kept.slice(0, 2))
		expect(await suggested(h, alice, '?limit=-2&offset=3')).toEqual(kept.slice(3, 5))
		expect(await suggested(h, alice, '?offset=-3')).toEqual(kept)
		expect(await suggested(h, alice, '?offset=39&limit=80')).toEqual(kept.slice(39))
		for (const query of ['?limit=0', '?limit=many', '?offset=40', '?offset=1000']) {
			expect([query, await suggested(h, alice, query)]).toEqual([query, []])
		}
	})

	it('stores a dismissal of a known account only, by its id or its legacy id, and drops it at its purge', async () => {
		const { h, alice, r0 } = await world()
		const dismiss = (target: string) =>
			h.request(`/api/v1/suggestions/${target}`, bearer(alice.token, { method: 'DELETE' }))
		const stored = () => sql(h.store, 'SELECT target_account_id AS id FROM follow_recommendation_mutes')
		expect(await (await dismiss('123')).json()).toEqual({})
		expect(await (await dismiss('not-an-id')).json()).toEqual({})
		expect(await stored()).toEqual([])
		await sql(h.store, "UPDATE accounts SET legacy_id = 'b2f5c9d0-0000-4000-8000-000000000001' WHERE id = ?", r0)
		expect((await dismiss('b2f5c9d0-0000-4000-8000-000000000001')).status).toBe(200)
		expect(await stored()).toEqual([{ id: r0 }])
	})

	it('answers each version to a user token of read:accounts, and dismisses under write:accounts (AUTH-2)', async () => {
		const { h, alice } = await world()
		for (const route of ['/api/v1/suggestions', '/api/v2/suggestions']) {
			expect((await h.request(route, bearer(await scopedToken(h, 'read:accounts')))).status).toBe(200)
			expect((await h.request(route)).status).toBe(401)
			expect((await h.request(route, bearer('nope'))).status).toBe(401)
			expect((await h.request(route, bearer(await scopedToken(h, 'write')))).status).toBe(403)
			expect((await h.request(route, bearer(await appToken(h)))).status).toBe(422)
		}
		const route = '/api/v1/suggestions/123'
		const del = (token?: string) =>
			h.request(route, token === undefined ? { method: 'DELETE' } : bearer(token, { method: 'DELETE' }))
		expect((await del(await scopedToken(h, 'write:accounts'))).status).toBe(200)
		expect((await del()).status).toBe(401)
		expect((await del(await scopedToken(h, 'read'))).status).toBe(403)
		expect((await del(await appTokenWith(h, 'write:accounts'))).status).toBe(422)
		const token = await scopedToken(h, 'read')
		await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01' WHERE account_id = ?", alice.id)
		expect((await h.request('/api/v1/suggestions', bearer(token))).status).toBe(403)
	})

	it('ranks remote accounts Kopje stored from their actors as having no followers', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const web = new RemoteWeb()
		const inbox = harness(h.store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader })
		const AS = 'https://www.w3.org/ns/activitystreams'
		const stored: string[] = []
		// Two Mastodon accounts follow bob, each publishing a large followers collection; Kopje stores the accounts and
		// not their totals.
		for (const [n, name] of ['erin', 'frank'].entries()) {
			const actor = await mastodonActor(web, name, { extra: { discoverable: true } })
			web.serve(`${actor.uri}/followers`, {
				'@context': AS,
				id: `${actor.uri}/followers`,
				type: 'OrderedCollection',
				totalItems: 50_000,
			})
			const activity = {
				'@context': AS,
				id: `${actor.uri}#follows/${n}`,
				type: 'Follow',
				actor: actor.uri,
				object: 'https://kopje.test/ap/users/bob',
			}
			expect((await inbox.request('/inbox', await signedInit(actor, '/inbox', activity))).status).toBe(202)
			const [row] = await sql<{ id: string; followers_count: number }>(
				h.store,
				'SELECT id, followers_count FROM accounts WHERE uri = ?',
				actor.uri
			)
			expect(row?.followers_count).toBe(0)
			stored.push(row?.id ?? '')
		}
		// bob follows both and carol, who has a follower; alice follows bob.
		await sql(h.store, 'UPDATE accounts SET discoverable = 1 WHERE id = ?', carol.id)
		await follow(h, bob, carol.id)
		await fan(h.store, bob.id, stored)
		await follow(h, alice, bob.id)
		expect(await suggested(h, alice)).toEqual([...newestFirst(stored), carol.id])
	})
})

describe('suggestion windows at their bounds', () => {
	it(`counts a source's ${SUGGESTION_EDGES_PER_SOURCE} newest edges, whatever their targets`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const [source = '', x = ''] = await remotes(h.store, 0, 2)
		const hidden = await remotes(h.store, 2, SUGGESTION_EDGES_PER_SOURCE, { discoverable: 0 })
		await follows(h.store, [[alice.id, source]])
		// x is the 101st newest edge.
		await fan(h.store, source, [x, ...hidden])
		expect(await suggested(h, alice)).toEqual([])
		await unfollow(h.store, source, hidden[0] ?? '')
		expect(await suggested(h, alice)).toEqual([x])
	})

	it('lets followed and dismissed accounts take edge slots', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const [source = '', x = ''] = await remotes(h.store, 0, 2)
		const crowd = await remotes(h.store, 2, SUGGESTION_EDGES_PER_SOURCE - 1)
		const [y = ''] = await remotes(h.store, 2 + crowd.length, 1)
		// alice follows half of the crowd and dismisses the rest; the source follows x, the crowd, then y.
		const half = Math.floor(crowd.length / 2)
		await follows(h.store, [[alice.id, source], ...crowd.slice(0, half).map((c) => [alice.id, c] as const)])
		for (const c of crowd.slice(half)) {
			await h.request(`/api/v1/suggestions/${c}`, bearer(alice.token, { method: 'DELETE' }))
		}
		await fan(h.store, source, [x, ...crowd, y])
		expect(await suggested(h, alice)).toEqual([y])
		await unfollow(h.store, source, crowd[0] ?? '')
		expect(await suggested(h, alice)).toEqual([y, x])
	})

	it(`reads the viewer's ${SUGGESTION_SOURCES} newest follows, a hidden one taking its slot`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// The oldest source follows x; among the newer ones, hider follows z and hides its network.
		const sources = await remotes(h.store, 0, SUGGESTION_SOURCES + 1)
		const [x = '', z = ''] = await remotes(h.store, sources.length, 2)
		const [oldest = '', hider = '', other = ''] = [sources[0], sources[500], sources[700]]
		await fan(h.store, alice.id, sources)
		await follows(h.store, [
			[oldest, x],
			[hider, z],
		])
		await sql(h.store, 'UPDATE accounts SET hide_collections = 1 WHERE id = ?', hider)
		expect(await suggested(h, alice)).toEqual([])
		await sql(h.store, 'UPDATE accounts SET hide_collections = NULL WHERE id = ?', hider)
		expect(await suggested(h, alice)).toEqual([z])
		await unfollow(h.store, alice.id, other)
		expect(await suggested(h, alice)).toEqual([z, x])
	}, 60_000)

	it(`keeps the first ${SUGGESTION_EDGES} edges, sources newest first`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const saturated = SUGGESTION_EDGES / SUGGESTION_EDGES_PER_SOURCE
		const sources = await remotes(h.store, 0, saturated + 1)
		const hidden = await remotes(h.store, sources.length, SUGGESTION_EDGES_PER_SOURCE, { discoverable: 0 })
		const [y = '', x = ''] = await remotes(h.store, sources.length + hidden.length, 2)
		const [oldest = '', ...newer] = sources
		await fan(h.store, alice.id, sources)
		// The oldest source's newest edges are x, then y; each newer source's 100 edges fill the cutoff.
		await fan(h.store, oldest, [...hidden.slice(2), y, x])
		for (const source of newer) {
			await fan(h.store, source, hidden)
		}
		expect(await suggested(h, alice)).toEqual([])
		// One edge less in the newest source: exactly the oldest source's newest edge comes in.
		await unfollow(h.store, newer.at(-1) ?? '', hidden[0] ?? '')
		expect(await suggested(h, alice)).toEqual([x])
	}, 60_000)

	it('judges every candidate before the ranking: a hidden account takes no place in it', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const [a = '', b = '', c = '', d = ''] = await remotes(h.store, 0, 4)
		// 199 muted accounts, each followed by two sources: a and b follow the first 100, c and d the other 99, then y
		// (by c) and h (by d) in their hundredth slot. h is h0, not discoverable, or h1, discoverable and newer than y;
		// both block alice. So every edge is in its source's window, and before R12 the candidates are 200 (h0) or 201
		// (h1): the 199 muted ones at two edges each, then h1 above y at one.
		const muted = await remotes(h.store, 4, 199)
		const [y = '', h0 = '', h1 = ''] = await remotes(h.store, 203, 3)
		await sql(h.store, 'UPDATE accounts SET discoverable = 0 WHERE id = ?', h0)
		await fan(h.store, alice.id, [a, b, c, d])
		for (const source of [a, b]) {
			await fan(h.store, source, muted.slice(0, 100))
		}
		await fan(h.store, c, [...muted.slice(100), y])
		await fan(h.store, d, [...muted.slice(100), h0])
		for (const m of muted) {
			await mute(h.store, alice.id, m)
		}
		for (const blocker of [h0, h1]) {
			await block(h.store, blocker, alice.id)
		}
		// The discoverable targets of the four sources' windows, every one of their follows here.
		const groups = async () =>
			(
				await sql<{ n: number }>(
					h.store,
					`SELECT count(DISTINCT f.target_account_id) AS n FROM follows f JOIN accounts a ON a.id = f.target_account_id
					WHERE f.account_id IN (?, ?, ?, ?) AND a.discoverable = 1`,
					a,
					b,
					c,
					d
				)
			)[0]?.n
		for (const source of [a, b, c, d]) {
			expect(await sql(h.store, 'SELECT 1 FROM follows WHERE account_id = ?', source)).toHaveLength(
				SUGGESTION_EDGES_PER_SOURCE
			)
		}
		expect(await groups()).toBe(200)
		expect(await suggested(h, alice)).toEqual([y])
		// The same edge to h1 instead: h1 ranks above y and is hidden; what alice is shown does not change.
		await sql(
			h.store,
			'UPDATE follows SET target_account_id = ? WHERE account_id = ? AND target_account_id = ?',
			h1,
			d,
			h0
		)
		expect(await groups()).toBe(201)
		expect(await suggested(h, alice)).toEqual([y])
	}, 60_000)

	it('ranks over the windowed graph: an edge outside a window does not count', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const [a = '', b = '', c = '', d = '', e = '', x = '', y = ''] = await remotes(h.store, 0, 7)
		const hidden = await remotes(h.store, 7, SUGGESTION_EDGES_PER_SOURCE, { discoverable: 0 })
		await fan(h.store, alice.id, [a, b, c, d, e])
		// x is followed by a, b and c, y by d and e; a's and b's follows of x are older than their 100 newest.
		await fan(h.store, a, [x, ...hidden])
		await fan(h.store, b, [x, ...hidden])
		await follows(h.store, [
			[c, x],
			[d, y],
			[e, y],
		])
		// Mastodon counts every edge and answers [x, y]; Kopje counts x once.
		expect(await suggested(h, alice)).toEqual([y, x])
	})
})
