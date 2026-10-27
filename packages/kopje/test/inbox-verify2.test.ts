import { describe, expect, it } from 'vitest'

import { bearer, login, registerApp, sql } from './api-helpers'
import { harness, inboxDeps, NOW } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD } from './helpers'
import { MASTODON, mastodonActor, RemoteWeb, type SignOptions, signedInit, type TestActor } from './inbox-helpers'
import { community, seedStatus } from './status-helpers'
import { MAX_LANE_BACKLOG } from '../src/domain/deliveries'
import { MAX_RETRACTIONS_PER_ACTOR, PURGE_BATCH } from '../src/domain/inbox'
import { handleQueue, runScheduledJobs } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'

// Regressions in inbound actor and relationship handling: admission of Rejects (RES-4), retraction before a Follow
// generation changes (ID-7), the purge's boost withdrawal and bounded cascades (RES-6), the stored-key fallback (ID-1),
// Misskey's pair ids, the Relationship fields, and the follow request endpoints.

const AS = 'https://www.w3.org/ns/activitystreams'
const DAY = 24 * 60 * 60 * 1000

let sequence = 0
const nextId = (actor: TestActor) => `${new URL(actor.uri).origin}/activities/v${++sequence}`

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
	(await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n
const accountId = async (store: StoreStub, uri: string) =>
	(await sql<{ id: string }>(store, 'SELECT id FROM accounts WHERE uri = ?', uri))[0]?.id

// Signed-in local users (the API) and remote servers (the inbox) over one Store.
async function together(names: readonly string[] = ['alice']) {
	const h = await community(names)
	const uriOf = async (id: string) =>
		(await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', id))[0]!.uri
	const alice = h.users.alice!
	const aliceUri = await uriOf(alice.id)
	const web = new RemoteWeb()
	const inbox = harness(h.store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader })
	const post = async (actor: TestActor, activity: unknown, options: SignOptions = {}) =>
		(await inbox.request('/inbox', await signedInit(actor, '/inbox', activity, options))).status
	const follow = (actor: TestActor, id = nextId(actor), object = aliceUri) => ({
		'@context': AS,
		id,
		type: 'Follow',
		actor: actor.uri,
		object,
	})
	const deps = inboxDeps(() => h.store, web.loader)
	const env = { ...inbox.env, MAINTENANCE: 'off' } as Env
	const drain = async () => {
		for (let round = 0; round < 20; round++) {
			await runScheduledJobs(env, deps)
		}
	}
	return { h, alice, aliceUri, uriOf, web, inbox, post, follow, deps, env, drain }
}

const deleteSelf = (actor: TestActor) => ({
	'@context': AS,
	id: `${actor.uri}#delete`,
	type: 'Delete',
	actor: actor.uri,
	object: actor.uri,
})

describe('RES-4: a Reject of a Follow never accepted is admitted like other work', () => {
	it('gives up the Reject of a blocked Follow when the lane is full', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT (SELECT max(id) FROM outbound_activities), ?, ?, ?, 'queued', 0, 0 FROM n`,
			MAX_LANE_BACKLOG,
			t.alice.id,
			`${bob.uri}/inbox`,
			MASTODON
		)
		await sql(t.h.store, 'DELETE FROM follows')
		await sql(t.h.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', t.alice.id, bobId)
		expect(await t.post(bob, t.follow(bob))).toBe(202)
		const [reject] = await sql<{ state: string; last_error: string | null }>(
			t.h.store,
			`SELECT d.state, d.last_error FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
			WHERE json_extract(o.body, '$.activity.type') = 'Reject'`
		)
		expect(reject).toEqual({ state: 'gave_up', last_error: 'backlog full' })
	})
})

describe('ID-7: a Follow generation changes only with its retraction recorded', () => {
	it('keeps a rejected request rejected when the Follow is delivered again', async () => {
		const t = await together()
		await sql(t.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.alice.id)
		const bob = await mastodonActor(t.web, 'bob')
		const f = t.follow(bob)
		await t.post(bob, f)
		const bobId = (await accountId(t.h.store, bob.uri))!
		const rejected = await t.h.request(
			`/api/v1/follow_requests/${bobId}/reject`,
			bearer(t.alice.token, { method: 'POST' })
		)
		expect(rejected.status).toBe(200)
		expect(await t.post(bob, f)).toBe(202)
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM notifications')).toBe(0)
		expect(
			await count(t.h.store, "SELECT 1 FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Reject'")
		).toBe(1)
	})

	it('answers 503 to a reject it cannot record, and changes nothing', async () => {
		const t = await together()
		await sql(t.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.alice.id)
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		await fillRetractions(t.h.store, bob.uri)
		const rejected = await t.h.request(
			`/api/v1/follow_requests/${bobId}/reject`,
			bearer(t.alice.token, { method: 'POST' })
		)
		expect(rejected.status).toBe(503)
		expect(await count(t.h.store, "SELECT 1 FROM follows WHERE state = 'pending'")).toBe(1)
	})

	it('applies no Block whose removed Follow cannot be recorded', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		await fillRetractions(t.h.store, bob.uri)
		const block = { '@context': AS, id: `${bob.uri}#blocks/1`, type: 'Block', actor: bob.uri, object: t.aliceUri }
		expect(await t.post(bob, block)).toBe(202)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(1)
	})

	it('undoes a second generation when the stored Follow id is itself a Misskey pair id', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		const pair = `${MASTODON}/follows/9abc/9def`
		const undo = () => ({
			'@context': AS,
			id: nextId(bob),
			type: 'Undo',
			actor: bob.uri,
			object: { id: pair, type: 'Follow', actor: bob.uri, object: t.aliceUri },
		})
		await t.post(bob, t.follow(bob, pair))
		await t.post(bob, undo())
		await t.post(bob, t.follow(bob))
		await t.post(bob, undo())
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM inbound_retractions WHERE target_uri = ?', pair)).toBe(0)
	})
})

async function fillRetractions(store: StoreStub, actorUri: string): Promise<void> {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT OR IGNORE INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/seeded/' || i, ? FROM n`,
		MAX_RETRACTIONS_PER_ACTOR,
		actorUri,
		actorUri,
		NOW + DAY
	)
}

describe('Misskey pair Reject', () => {
	it('ends our accepted follow when Misskey rejects it with the pair id', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		await t.h.request(`/api/v1/accounts/${bobId}/follow`, bearer(t.alice.token, { method: 'POST' }))
		await sql(t.h.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", t.alice.id)
		const reject = {
			'@context': AS,
			id: nextId(bob),
			type: 'Reject',
			actor: bob.uri,
			object: { id: `${MASTODON}/follows/${t.alice.id}/${bobId}`, type: 'Follow', actor: t.aliceUri, object: bob.uri },
		}
		expect(await t.post(bob, reject)).toBe(202)
		expect(await count(t.h.store, 'SELECT 1 FROM follows WHERE account_id = ?', t.alice.id)).toBe(0)
	})
})

describe('purge through B2 and in bounded cascades (RES-6)', () => {
	it('withdraws local boosts of the deleted actor’s statuses and recounts the booster', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		const statusId = await seedStatus(t.h.store, {
			accountId: bobId,
			visibility: 'public',
			uri: `${bob.uri}/statuses/1`,
		})
		const boosted = await t.h.request(`/api/v1/statuses/${statusId}/reblog`, bearer(t.alice.token, { method: 'POST' }))
		expect(boosted.status).toBe(200)
		expect(
			(await sql<{ n: number }>(t.h.store, 'SELECT statuses_count AS n FROM accounts WHERE id = ?', t.alice.id))[0]!.n
		).toBe(1)

		t.web.fail(bob.uri, 410)
		expect(await t.post(bob, deleteSelf(bob))).toBe(202)
		await t.drain()
		const undo = await sql<{ object: string }>(
			t.h.store,
			`SELECT json_extract(body, '$.activity.object.type') AS object FROM outbound_activities
			WHERE json_extract(body, '$.activity.type') = 'Undo'`
		)
		expect(undo).toEqual([{ object: 'Announce' }])
		expect(
			(await sql<{ n: number }>(t.h.store, 'SELECT statuses_count AS n FROM accounts WHERE id = ?', t.alice.id))[0]!.n
		).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM statuses')).toBe(0)
	})

	it('deletes a status with more children than a batch only after its children, a batch at a time', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		const statusId = await seedStatus(t.h.store, {
			accountId: bobId,
			visibility: 'public',
			uri: `${bob.uri}/statuses/1`,
		})
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('6%017d', i), 'https://fans.example/u/' || i, 'u' || i, 'fans.example' FROM n`,
			PURGE_BATCH * 2
		)
		await sql(
			t.h.store,
			"INSERT INTO favourites (account_id, status_id) SELECT id, ? FROM accounts WHERE id GLOB '6*'",
			statusId
		)
		t.web.fail(bob.uri, 410)
		expect(await t.post(bob, deleteSelf(bob))).toBe(202)
		expect(await count(t.h.store, 'SELECT 1 FROM statuses WHERE id = ?', statusId)).toBe(1)
		expect(await count(t.h.store, 'SELECT 1 FROM favourites')).toBeGreaterThan(PURGE_BATCH / 2)
		await t.drain()
		expect(await count(t.h.store, 'SELECT 1 FROM favourites')).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM statuses')).toBe(0)
		expect(await accountId(t.h.store, bob.uri)).toBeUndefined()
	})

	const tables: [string, string][] = [
		[
			'follows',
			"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?1, 'accepted' FROM accounts WHERE id GLOB '6*' AND ?2 IS NOT NULL",
		],
		[
			'blocks',
			"INSERT INTO blocks (account_id, target_account_id) SELECT id, ?1 FROM accounts WHERE id GLOB '6*' AND ?2 IS NOT NULL",
		],
		[
			'notifications',
			"INSERT INTO notifications (account_id, type, from_account_id, status_id) SELECT ?2, 'favourite', ?1, id FROM statuses WHERE id GLOB '7*'",
		],
		[
			'status_mentions',
			"INSERT INTO status_mentions (status_id, account_id) SELECT id, ?1 FROM statuses WHERE id GLOB '7*' AND ?2 IS NOT NULL",
		],
	]

	it.each(tables)('purges %s past one batch (501 rows) and finishes', async (table, insert) => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('6%017d', i), 'https://fans.example/u/' || i, 'u' || i, 'fans.example' FROM n`,
			PURGE_BATCH + 1
		)
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT printf('7%017d', i), 'https://kopje.test/s/' || i, ?, 'public', '2026-10-01T00:00:00.000Z' FROM n`,
			PURGE_BATCH + 1,
			t.alice.id
		)
		await sql(t.h.store, `DELETE FROM ${table}`)
		await sql(t.h.store, insert, bobId, t.alice.id)
		expect(await count(t.h.store, `SELECT 1 FROM ${table}`)).toBe(PURGE_BATCH + 1)
		t.web.fail(bob.uri, 410)
		expect(await t.post(bob, deleteSelf(bob))).toBe(202)
		expect(await count(t.h.store, `SELECT 1 FROM ${table}`)).toBeGreaterThan(0)
		await t.drain()
		expect(await count(t.h.store, `SELECT 1 FROM ${table}`)).toBe(0)
		expect(await accountId(t.h.store, bob.uri)).toBeUndefined()
	})
})

describe('ID-1: the stored key stands in only for a key that is gone', () => {
	it('refuses a self-Delete with a stale key when the key answers 403 and the actor 410', async () => {
		const t = await together()
		const uri = `${MASTODON}/users/gts`
		const keyId = `${uri}/main-key`
		const gts = await mastodonActor(t.web, 'gts')
		const document = { ...gts.document, publicKey: { id: keyId, owner: uri, publicKeyPem: gts.pem } }
		t.web.serve(uri, document)
		t.web.serve(keyId, document)
		await t.post(gts, t.follow(gts), { keyId })
		await sql(t.h.store, 'UPDATE remote_keys SET fetched_at = ?', NOW - DAY - 1)
		t.web.fail(keyId, 403)
		t.web.fail(uri, 410)
		expect(await t.post(gts, deleteSelf(gts), { keyId })).toBe(401)
		expect(await accountId(t.h.store, uri)).toBeDefined()
	})
})

describe('follow requests and relationships', () => {
	it('shows requested_by and muting_expires_at on every relationship', async () => {
		const t = await together()
		await sql(t.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.alice.id)
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		const response = await t.h.request(`/api/v1/accounts/relationships?id[]=${bobId}`, bearer(t.alice.token))
		expect(await response.json()).toEqual([
			expect.objectContaining({ id: bobId, followed_by: false, requested_by: true, muting_expires_at: null }),
		])
	})

	it('refuses a wrong scope, a revoked token, someone else’s request and an unknown one', async () => {
		const t = await together(['alice', 'dave'])
		await sql(t.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.alice.id)
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		const authorize = (token: string, id = bobId) =>
			t.h.request(`/api/v1/follow_requests/${id}/authorize`, bearer(token, { method: 'POST' }))

		const app = await registerApp(t.h, { scopes: 'read' })
		const { token: readOnly } = await login(t.h, { app, email: 'alice@example.com', scope: 'read' })
		expect((await authorize(readOnly)).status).toBe(403)
		expect((await authorize(t.h.users.dave!.token)).status).toBe(404)
		expect((await authorize(t.alice.token, '999999999999999999')).status).toBe(404)
		await sql(t.h.store, 'DELETE FROM oauth_tokens WHERE kind = ? AND account_id = ?', 'access', t.h.users.dave!.id)
		expect((await authorize(t.h.users.dave!.token)).status).toBe(401)
		expect(await count(t.h.store, "SELECT 1 FROM follows WHERE state = 'pending'")).toBe(1)
	})

	it('pages follow requests with Link headers', async () => {
		const t = await together()
		await sql(t.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.alice.id)
		const ids: string[] = []
		for (const name of ['b1', 'b2', 'b3']) {
			const actor = await mastodonActor(t.web, name, { key: 0 })
			await t.post(actor, t.follow(actor))
			ids.push((await accountId(t.h.store, actor.uri))!)
		}
		const first = await t.h.request('/api/v1/follow_requests?limit=2', bearer(t.alice.token))
		expect(((await first.json()) as { id: string }[]).map((a) => a.id)).toEqual([ids[2], ids[1]])
		const next = /<([^>]+)>; rel="next"/.exec(first.headers.get('link') ?? '')?.[1]
		expect(next).toBeDefined()
		const second = await t.h.request(new URL(next!).pathname + new URL(next!).search, bearer(t.alice.token))
		expect(((await second.json()) as { id: string }[]).map((a) => a.id)).toEqual([ids[0]])
	})
})

describe('a Move of more than one batch through B2', () => {
	it('records an Undo and a Follow per moved follower over two batches, ringing the doorbell', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2 })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('5%017d', i), 'https://kopje.test/ap/users/m' || i, 'm' || i, NULL FROM n`
		)
		await sql(
			t.h.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`
		)
		await sql(
			t.h.store,
			"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*'",
			bobId
		)
		await sql(t.h.store, 'DELETE FROM outbound_activities')
		t.inbox.queue.pending.splice(0)
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)
		const kinds = () => t.inbox.queue.pending.map((m) => (m.body as { kind: string }).kind)
		expect(kinds()).toContain('deliver')
		expect(kinds()).toContain('inbound-jobs')
		await t.inbox.queue.deliver((batch) => handleQueue(batch, t.env, t.deps))
		const types = await sql<{ type: string; n: number }>(
			t.h.store,
			`SELECT json_extract(body, '$.activity.type') AS type, count(*) AS n FROM outbound_activities GROUP BY type ORDER BY type`
		)
		expect(types).toEqual([
			{ type: 'Follow', n: 101 },
			{ type: 'Undo', n: 101 },
		])
	})
})
