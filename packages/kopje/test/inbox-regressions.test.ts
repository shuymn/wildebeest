import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { harness, inboxDeps, NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from './federation-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import {
	LOCAL,
	MASTODON,
	mastodonActor,
	RemoteWeb,
	type SignOptions,
	signedInit,
	type TestActor,
} from './inbox-helpers'
import { MAX_RETRACTIONS_PER_ACTOR, PURGE_BATCH } from '../src/domain/inbox'
import { createSafeLoader } from '../src/federation/loader'
import { handleQueue, runScheduledJobs } from '../src/jobs/queue'
import { sha256Hex } from '../src/platform/sha256'
import type { StoreStub } from '../src/platform/store-client'

// Regressions from the review of B1b-1, one per finding: durable purges, key rotation and key ownership (ID-1),
// Follow generations, Block against a replayed Follow, Move progress and replays (ID-4, ID-7), transient JSON-LD
// contexts, the per-request fetch budget (RES-6), and deletion independent of the retraction cap (ID-7, RES-4).

const AS = 'https://www.w3.org/ns/activitystreams'
const ALICE = '111111111111111111'
const ALICE_URI = `${LOCAL}/ap/users/alice`
const DAVE_URI = `${LOCAL}/ap/users/dave`
const DAY = 24 * 60 * 60 * 1000

async function setup(options: { queue?: 'failing' } = {}) {
	const store = await migratedStore()
	await completeSetup(store)
	await seedLocalAccount(store, 'kopje.test', { id: ALICE, username: 'alice', key: LEGACY_EMPTY_KEK })
	await seedLocalAccount(store, 'kopje.test', { id: '222222222222222222', username: 'dave', key: LEGACY_EMPTY_KEK })
	const web = new RemoteWeb()
	const overrides =
		options.queue === 'failing' ? { QUEUE: { send: () => Promise.reject(new Error('queue down')) } } : {}
	const h = harness(store, overrides, BUILD, { keygen: fixtureKeyGen, loader: web.loader })
	const post = async (actor: TestActor, activity: unknown, sign: SignOptions = {}) =>
		(await h.request('/inbox', await signedInit(actor, '/inbox', activity, sign))).status
	const deps = inboxDeps(() => store, web.loader)
	return { store, web, post, deps, ...h }
}

let sequence = 0
const nextId = (actor: TestActor) => `${new URL(actor.uri).origin}/activities/r${++sequence}`
const follow = (actor: TestActor, id = nextId(actor), object = ALICE_URI) => ({
	'@context': AS,
	id,
	type: 'Follow',
	actor: actor.uri,
	object,
})
const embedded = (activity: Record<string, unknown>) => ({ ...activity, '@context': undefined })

const edges = (store: StoreStub) =>
	sql<{ account_id: string; target_account_id: string; state: string; uri: string | null }>(
		store,
		'SELECT account_id, target_account_id, state, uri FROM follows ORDER BY id'
	)
const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
	(await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n
const accountId = async (store: StoreStub, uri: string) =>
	(await sql<{ id: string }>(store, 'SELECT id FROM accounts WHERE uri = ?', uri))[0]?.id

async function seedStatuses(store: StoreStub, accountUri: string, n: number): Promise<void> {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT printf('3%017d', i), ? || '/statuses/' || i, (SELECT id FROM accounts WHERE uri = ?), 'public',
			'2026-10-01T00:00:00.000Z' FROM n`,
		n,
		accountUri,
		accountUri
	)
}

const deleteSelf = (actor: TestActor) => ({
	'@context': AS,
	id: `${actor.uri}#delete`,
	type: 'Delete',
	actor: actor.uri,
	object: actor.uri,
})

describe('durable purge of a deleted actor (OPS-1, RES-6)', () => {
	async function deleted(options: { queue?: 'failing' } = {}) {
		const t = await setup(options)
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		await seedStatuses(t.store, bob.uri, PURGE_BATCH * 2 + 1)
		t.web.fail(bob.uri, 410)
		expect(await t.post(bob, deleteSelf(bob))).toBe(202)
		expect(await count(t.store, 'SELECT 1 FROM statuses')).toBe(PURGE_BATCH + 1)
		return { ...t, bob }
	}
	const env = (t: { env: Env }, mode = 'off') => ({ ...t.env, MAINTENANCE: mode }) as Env

	it('finishes from cron when the Queue send failed', async () => {
		const t = await deleted({ queue: 'failing' })
		await runScheduledJobs(env(t), t.deps)
		expect(await count(t.store, 'SELECT 1 FROM statuses')).toBe(0)
		expect(await accountId(t.store, t.bob.uri)).toBeUndefined()
	})

	it('spends no retry in maintenance and finishes afterwards', async () => {
		const t = await deleted()
		await t.queue.deliver((batch) => handleQueue(batch, env(t, 'readonly'), t.deps))
		await runScheduledJobs(env(t, 'readonly'), t.deps)
		expect(t.queue.retries).toBe(0)
		expect(await count(t.store, 'SELECT 1 FROM statuses')).toBe(PURGE_BATCH + 1)

		await runScheduledJobs(env(t), t.deps)
		expect(await count(t.store, 'SELECT 1 FROM statuses')).toBe(0)
	})

	it('handles a duplicate Queue message, and ignores the actor’s live activity meanwhile', async () => {
		const t = await deleted()
		t.queue.pending.push({ ...t.queue.pending[0]!, id: 'duplicate' })
		t.web.serve(t.bob.uri, t.bob.document)
		expect(await t.post(t.bob, follow(t.bob))).toBe(202)
		await t.queue.deliver((batch) => handleQueue(batch, env(t), t.deps))
		await t.queue.deliver((batch) => handleQueue(batch, env(t), t.deps))
		expect(t.queue.retries).toBe(0)
		expect(t.queue.pending).toEqual([])
		expect(await count(t.store, 'SELECT 1 FROM statuses')).toBe(0)
		expect(await edges(t.store)).toEqual([])
		expect(await t.post(t.bob, follow(t.bob))).toBe(202)
		expect(await edges(t.store)).toEqual([])
	})
})

describe('ID-1: stored keys, rotation and ownership', () => {
	it('verifies a key on a separate path without a fragment, and a later Delete with it', async () => {
		const t = await setup()
		const uri = `${MASTODON}/users/gts`
		const keyId = `${uri}/main-key`
		const gts = await mastodonActor(t.web, 'gts', { extra: {} })
		const document = { ...gts.document, publicKey: { id: keyId, owner: uri, publicKeyPem: gts.pem } }
		t.web.serve(uri, document)
		t.web.serve(keyId, document)
		expect(await t.post(gts, follow(gts), { keyId })).toBe(202)
		expect((await edges(t.store)).length).toBe(1)

		t.web.fail(uri, 410)
		t.web.fail(keyId, 410)
		// Any cached copy of the documents has expired by the time the actor is deleted.
		await sql(t.store, 'DELETE FROM fedify_kv')
		expect(await t.post(gts, deleteSelf(gts), { keyId })).toBe(202)
		expect(await accountId(t.store, uri)).toBeUndefined()
		expect(await edges(t.store)).toEqual([])
	})

	it('refuses a key the actor lists but that names another owner, cold and warm', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const second = `${bob.uri}#second`
		t.web.serve(bob.uri, {
			...bob.document,
			publicKey: [bob.document.publicKey, { id: second, owner: carol.uri, publicKeyPem: carol.pem }],
		})
		expect(await t.post(bob, follow(bob), { keyId: second, privateKey: carol.privateKey })).toBe(401)
		expect(await t.post(bob, follow(bob, nextId(bob), DAVE_URI))).toBe(202)
		expect(await sql(t.store, 'SELECT key_id FROM remote_keys')).toEqual([{ key_id: bob.keyId }])
		expect(await t.post(bob, follow(bob), { keyId: second, privateKey: carol.privateKey })).toBe(401)
	})

	it('accepts any of several keys the actor owns', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const spare = await mastodonActor(t.web, 'spare', { key: 3 })
		const second = `${bob.uri}#second`
		t.web.serve(bob.uri, {
			...bob.document,
			publicKey: [bob.document.publicKey, { id: second, owner: bob.uri, publicKeyPem: spare.pem }],
		})
		expect(await t.post(bob, follow(bob), { keyId: second, privateKey: spare.privateKey })).toBe(202)
		expect(await t.post(bob, follow(bob, nextId(bob), DAVE_URI))).toBe(202)
		expect((await edges(t.store)).length).toBe(2)
	})

	it('trusts a stored key for 24 hours and fetches the actor again at the boundary', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob, nextId(bob), DAVE_URI))
		const fetches = () => t.web.fetched.filter((url) => url === bob.uri).length
		await sql(t.store, 'UPDATE remote_keys SET fetched_at = ?', NOW - DAY + 1)
		const before = fetches()
		expect(await t.post(bob, follow(bob))).toBe(202)
		expect(fetches()).toBe(before)
		await sql(t.store, 'UPDATE remote_keys SET fetched_at = ?', NOW - DAY)
		expect(await t.post(bob, follow(bob))).toBe(202)
		expect(fetches()).toBeGreaterThan(before)
	})

	it('refuses the old key material after a rotation under the same id, and takes the new one', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const next = await mastodonActor(t.web, 'next', { key: 3 })
		await t.post(bob, follow(bob, nextId(bob), DAVE_URI))
		const rotated = { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: next.pem } }
		t.web.serve(bob.uri, rotated)

		// Within 24 hours the new key verifies after Fedify refetches it, and replaces the stored one.
		expect(await t.post(bob, follow(bob), { privateKey: next.privateKey })).toBe(202)
		expect(await sql(t.store, 'SELECT pem FROM remote_keys')).toEqual([{ pem: next.pem }])

		// The old key is refused once its document is stale, even though its id is still listed.
		await sql(t.store, 'UPDATE remote_keys SET pem = ?, fetched_at = ?', bob.pem, NOW - DAY - 1)
		expect(await t.post(bob, follow(bob, nextId(bob), DAVE_URI + 'x'))).toBe(401)
	})

	it('refuses a stale stored key whose actor document now lists other material, even if cached', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob, nextId(bob), DAVE_URI))
		const next = await mastodonActor(t.web, 'next', { key: 3 })
		t.web.serve(bob.uri, { ...bob.document, publicKey: { id: bob.keyId, owner: bob.uri, publicKeyPem: next.pem } })
		await sql(t.store, 'UPDATE remote_keys SET fetched_at = ?', NOW - DAY - 1)
		expect(await t.post(bob, follow(bob))).toBe(401)
		expect((await edges(t.store)).filter((e) => e.target_account_id === ALICE)).toEqual([])
	})
})

describe('Follow generations (ID-6, ID-7)', () => {
	it('keeps the current generation when an Undo of the superseded Follow arrives late', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const f1 = follow(bob)
		const f2 = follow(bob)
		await t.post(bob, f1)
		await t.post(bob, f2)
		const undo = { '@context': AS, id: nextId(bob), type: 'Undo', actor: bob.uri, object: embedded(f1) }
		expect(await t.post(bob, undo)).toBe(202)
		expect((await edges(t.store)).map((e) => e.uri)).toEqual([f2.id])
		expect(await count(t.store, 'SELECT 1 FROM notifications')).toBe(1)
	})

	it('answers two generations with two Accepts', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const f1 = follow(bob)
		const f2 = follow(bob)
		await t.post(bob, f1)
		await t.post(bob, f2)
		const ids = (
			await sql<{ id: string }>(t.store, "SELECT json_extract(body, '$.activity.id') AS id FROM outbound_activities")
		).map((r) => r.id)
		expect(ids).toEqual([
			`${ALICE_URI}#accepts/follows/${sha256Hex(f1.id)}`,
			`${ALICE_URI}#accepts/follows/${sha256Hex(f2.id)}`,
		])
	})

	it('accepts or rejects our follow only for its current id; a string Accept names it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob, nextId(bob), DAVE_URI))
		const bobId = (await accountId(t.store, bob.uri))!
		const f1 = `${LOCAL}/follows/1`
		const f2 = `${LOCAL}/follows/2`
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
			ALICE,
			bobId,
			f2
		)
		const ours = async () => (await edges(t.store)).find((e) => e.account_id === ALICE)
		const answer = (type: string, object: unknown) => ({
			'@context': AS,
			id: nextId(bob),
			type,
			actor: bob.uri,
			object,
		})

		expect(await t.post(bob, answer('Accept', { id: f1, type: 'Follow', actor: ALICE_URI, object: bob.uri }))).toBe(202)
		expect(await t.post(bob, answer('Reject', { id: f1, type: 'Follow', actor: ALICE_URI, object: bob.uri }))).toBe(202)
		expect((await ours())?.state).toBe('pending')
		expect(await t.post(bob, answer('Accept', f2))).toBe(202)
		expect((await ours())?.state).toBe('accepted')
	})

	it('keeps Misskey’s pair-shaped Undo working', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		const pair = { id: `${MASTODON}/follows/9abc/9def`, type: 'Follow', actor: bob.uri, object: ALICE_URI }
		expect(await t.post(bob, { '@context': AS, id: nextId(bob), type: 'Undo', actor: bob.uri, object: pair })).toBe(202)
		expect(await edges(t.store)).toEqual([])
	})
})

describe('Block against a replayed Follow (ID-7)', () => {
	it('does not restore the follow, notify, or accept again', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const f = follow(bob)
		await t.post(bob, f)
		await t.post(bob, { '@context': AS, id: `${bob.uri}#blocks/1`, type: 'Block', actor: bob.uri, object: ALICE_URI })
		await sql(t.store, 'DELETE FROM notifications')
		expect(await t.post(bob, f)).toBe(202)
		expect(await t.post(bob, follow(bob))).toBe(202)
		expect(await edges(t.store)).toEqual([])
		expect(await count(t.store, 'SELECT 1 FROM notifications')).toBe(0)
		expect(await count(t.store, 'SELECT 1 FROM outbound_activities')).toBe(1)
	})
})

describe('Move progress and replays (ID-4, ID-7, RES-6)', () => {
	async function moving(followers: number) {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2 })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		await t.post(bob, follow(bob, nextId(bob), DAVE_URI))
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('5%017d', i), ? || i, 'u' || i, NULL FROM n`,
			followers,
			`${LOCAL}/ap/users/u`
		)
		await sql(
			t.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`
		)
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*' ORDER BY id",
			bobId
		)
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		const moved = async () =>
			count(t.store, 'SELECT 1 FROM follows f JOIN accounts a ON a.id = f.target_account_id WHERE a.uri = ?', bob2.uri)
		return { ...t, bob, bob2, bobId, move, moved }
	}

	it('moves 100 followers in one batch', async () => {
		const t = await moving(100)
		expect(await t.post(t.bob, t.move)).toBe(202)
		expect(await t.moved()).toBe(100)
		expect(await count(t.store, 'SELECT 1 FROM inbound_jobs WHERE done_at IS NULL')).toBe(0)
	})

	it('moves the 101st from the stored progress, and a replay moves nothing more', async () => {
		const t = await moving(101)
		expect(await t.post(t.bob, t.move)).toBe(202)
		expect(await t.moved()).toBe(100)
		await t.queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: 'off' } as Env, t.deps))
		expect(await t.moved()).toBe(101)
		expect(await t.post(t.bob, t.move)).toBe(202)
		expect(await t.moved()).toBe(101)
	})

	it('does not move a follow made after the Move when the Move is delivered again', async () => {
		const t = await moving(1)
		expect(await t.post(t.bob, t.move)).toBe(202)
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			t.bobId
		)
		expect(await t.post(t.bob, t.move)).toBe(202)
		expect((await edges(t.store)).filter((e) => e.account_id === ALICE)).toEqual([
			{ account_id: ALICE, target_account_id: t.bobId, state: 'accepted', uri: null },
		])
	})

	it('never stores a deleted actor again as a Move target (ID-7)', async () => {
		const t = await moving(1)
		await t.post(t.bob2, follow(t.bob2))
		t.web.fail(t.bob2.uri, 410)
		expect(await t.post(t.bob2, deleteSelf(t.bob2))).toBe(202)
		t.web.serve(t.bob2.uri, { ...t.bob2.document, alsoKnownAs: [t.bob.uri] })
		expect(await t.post(t.bob, t.move)).toBe(202)
		expect(await accountId(t.store, t.bob2.uri)).toBeUndefined()
	})
})

describe('the retraction cap does not stop a deletion (ID-7, RES-4)', () => {
	it('records the 10,000th retraction of a known actor, not the 10,001st, and still deletes the actor', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/seeded/' || i, ? FROM n`,
			MAX_RETRACTIONS_PER_ACTOR - 1,
			bob.uri,
			bob.uri,
			NOW + DAY
		)
		const deletion = (n: number) => ({
			'@context': AS,
			id: nextId(bob),
			type: 'Delete',
			actor: bob.uri,
			object: `${bob.uri}/statuses/${n}`,
		})
		await t.post(bob, deletion(1))
		expect(await count(t.store, 'SELECT 1 FROM inbound_retractions WHERE actor_uri = ?', bob.uri)).toBe(
			MAX_RETRACTIONS_PER_ACTOR
		)
		await t.post(bob, deletion(2))
		expect(await count(t.store, 'SELECT 1 FROM inbound_retractions WHERE actor_uri = ?', bob.uri)).toBe(
			MAX_RETRACTIONS_PER_ACTOR
		)

		await seedStatuses(t.store, bob.uri, PURGE_BATCH + 1)
		t.web.fail(bob.uri, 410)
		expect(await t.post(bob, deleteSelf(bob))).toBe(202)
		await runScheduledJobs({ ...t.env, MAINTENANCE: 'off' } as Env, t.deps)
		expect(await accountId(t.store, bob.uri)).toBeUndefined()
		expect(await count(t.store, 'SELECT 1 FROM statuses')).toBe(0)

		t.web.serve(bob.uri, bob.document)
		expect(await t.post(bob, follow(bob))).toBe(202)
		expect(await edges(t.store)).toEqual([])
	})
})

describe('remote fetches: transient contexts and the request budget (RES-6)', () => {
	it('answers 503 while a JSON-LD context of the actor fails transiently, then applies the Update', async () => {
		const t = await setup()
		const context = 'https://ctx.example/ns'
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		// The key is verified from the Store; only the actor's fresh document needs the context.
		const updated = {
			...bob.document,
			name: 'Bob 2',
			'@context': [...(bob.document['@context'] as unknown[]), context],
		}
		t.web.serve(bob.uri, updated)
		t.web.fail(context, 503)
		const update = { '@context': AS, id: nextId(bob), type: 'Update', actor: bob.uri, object: updated }
		expect(await t.post(bob, update)).toBe(503)
		t.web.serve(context, { '@context': { extra: 'https://ctx.example/ns#extra' } }, 'application/ld+json')
		expect(await t.post(bob, update)).toBe(202)
		expect(await sql(t.store, 'SELECT display_name FROM accounts WHERE uri = ?', bob.uri)).toEqual([
			{ display_name: 'Bob 2' },
		])
	})

	it('stops at the shared fetch budget, contexts included', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const contexts = Array.from({ length: 20 }, (_, i) => `https://ctx.example/c${i}`)
		for (const url of contexts) {
			t.web.serve(url, { '@context': { [`x${url.at(-1)}`]: `${url}#x` } }, 'application/ld+json')
		}
		t.web.serve(bob.uri, { ...bob.document, '@context': [...(bob.document['@context'] as unknown[]), ...contexts] })
		expect(await t.post(bob, follow(bob))).not.toBe(202)
		expect(t.web.fetched.length).toBeLessThanOrEqual(8)
		expect(await edges(t.store)).toEqual([])
	})

	it('counts fetches (each redirect hop is one) and bytes against the budget, and enforces its deadline', async () => {
		const web = new RemoteWeb()
		const bob = await mastodonActor(web, 'bob')
		const deps = { ...web.loader, userAgent: 'test' }
		const fetchCount = { fetches: 1, bytes: 1024 * 1024, deadline: Date.now() + 10_000 }
		const loader = createSafeLoader({ ...deps, budget: fetchCount })
		await loader(bob.uri)
		await expect(loader(bob.uri)).rejects.toThrow('budget exhausted')

		const bytes = { fetches: 5, bytes: 100, deadline: Date.now() + 10_000 }
		await expect(createSafeLoader({ ...deps, budget: bytes })(bob.uri)).rejects.toThrow('exceeds 100 bytes')

		const late = { fetches: 5, bytes: 1024 * 1024, deadline: Date.now() - 1 }
		await expect(createSafeLoader({ ...deps, budget: late })(bob.uri)).rejects.toThrow('deadline exhausted')
	})
})
