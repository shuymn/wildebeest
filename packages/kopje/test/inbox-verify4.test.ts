import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { harness, NOW } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD, runStoreJobs } from './helpers'
import { mastodonActor, RemoteWeb, signedInit, type TestActor } from './inbox-helpers'
import { community, seedReceipts, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import { EXPANSION_STEP, STAGING_READ, TARGET_CHUNK_BYTES, TARGET_CHUNK_SIZE } from '../src/domain/deliveries'
import { MAX_RETRACTIONS_PER_ACTOR, PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { ACTOR_URI_LIMIT, INBOX_URL_LIMIT } from '../src/federation/remote-actor'
import type { StoreStub } from '../src/platform/store-client'

// Regressions in inbound actor and relationship handling: delivery targets stored in bounded chunks and capped inbox
// URLs (RES-6), a Block undone by a pair-shaped id (ID-7), the deferred Undo resumed by the delivery rounds, and the
// Block id change at the retraction cap.

const AS = 'https://www.w3.org/ns/activitystreams'
const DAY = 24 * 60 * 60 * 1000

let sequence = 0
const nextId = (actor: TestActor) => `${new URL(actor.uri).origin}/activities/v${++sequence}`

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
	(await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n
const accountId = async (store: StoreStub, uri: string) =>
	(await sql<{ id: string }>(store, 'SELECT id FROM accounts WHERE uri = ?', uri))[0]?.id

async function together() {
	const h = await community(['alice'])
	const alice = h.users.alice
	const aliceUri = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', alice.id))[0]!.uri
	const web = new RemoteWeb()
	const inbox = harness(h.store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader })
	const post = async (actor: TestActor, activity: unknown) =>
		(await inbox.request('/inbox', await signedInit(actor, '/inbox', activity))).status
	const follow = (actor: TestActor, id = nextId(actor)) => ({
		'@context': AS,
		id,
		type: 'Follow',
		actor: actor.uri,
		object: aliceUri,
	})
	const block = (actor: TestActor, id: string) => ({
		'@context': AS,
		id,
		type: 'Block',
		actor: actor.uri,
		object: aliceUri,
	})
	const undo = (actor: TestActor, object: unknown) => ({
		'@context': AS,
		id: nextId(actor),
		type: 'Undo',
		actor: actor.uri,
		object,
	})
	return { h, alice, aliceUri, web, post, follow, block, undo }
}

// The deliveries rows of every intent, by inbox, and how many there are.
const deliveryRows = (store: StoreStub) => count(store, 'SELECT 1 FROM deliveries')

describe('RES-6: delivery targets are stored in bounded chunks', () => {
	it('enqueues and fully expands an audience whose targets exceed what one row can hold', async () => {
		const t = await together()
		const followers = 1200
		// Personal inboxes just under the cap, no shared inbox, one server each (no lane cap applies).
		const pad = 'x'.repeat(1900)
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			SELECT printf('6%017d', i), 'https://f' || i || '.example/users/u', 'u', 'f' || i || '.example',
				'https://f' || i || '.example/inbox/' || ?, '' FROM n`,
			followers,
			pad
		)
		await sql(
			t.h.store,
			"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '6*'",
			t.alice.id
		)
		const total = (
			await sql<{ n: number }>(t.h.store, "SELECT sum(length(inbox_url)) AS n FROM accounts WHERE id GLOB '6*'")
		)[0]!.n
		expect(total).toBeGreaterThan(2 * 1024 * 1024)

		const posted = await t.h.request(
			'/api/v1/statuses',
			bearer(t.alice.token, json({ status: 'hello', visibility: 'public' }))
		)
		expect(posted.status).toBe(200)
		const largest = (
			await sql<{ n: number | null }>(t.h.store, 'SELECT max(length(targets)) AS n FROM outbound_targets')
		)[0]!.n
		expect(largest).toBeLessThanOrEqual(TARGET_CHUNK_BYTES)

		let rows = await deliveryRows(t.h.store)
		expect(rows).toBeLessThanOrEqual(EXPANSION_STEP)
		let rounds = 0
		while ((await count(t.h.store, 'SELECT 1 FROM outbound_targets')) > 0) {
			const claim = await t.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: `r${rounds}` })
			const next = await deliveryRows(t.h.store)
			expect(next - rows).toBeLessThanOrEqual(EXPANSION_STEP)
			rows = next
			if ((await count(t.h.store, 'SELECT 1 FROM outbound_targets')) > 0) {
				expect(claim.nextDueAt).toBe(NOW)
			}
			expect(++rounds).toBeLessThan(50)
		}
		expect(rounds).toBeGreaterThan(1)
		expect(
			await count(
				t.h.store,
				`SELECT 1 FROM accounts a WHERE a.id GLOB '6*'
				AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.inbox_url = a.inbox_url AND d.state <> 'gave_up')`
			)
		).toBe(0)
		expect(await count(t.h.store, 'SELECT DISTINCT inbox_url FROM deliveries')).toBe(followers)
	})

	it('refuses an actor whose inbox URL is over the cap, and ignores an over-long shared inbox', async () => {
		const t = await together()
		const long = (base: string) => `${base}/${'x'.repeat(INBOX_URL_LIMIT)}`
		const bob = await mastodonActor(t.web, 'bob')
		await mastodonActor(t.web, 'bob', { extra: { inbox: long(`${bob.uri}/inbox`) } })
		await t.post(bob, t.follow(bob))
		expect(await accountId(t.h.store, bob.uri)).toBeUndefined()
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(0)

		const carol = await mastodonActor(t.web, 'carol', {
			extra: { endpoints: { sharedInbox: long('https://mastodon.example/inbox') } },
		})
		expect(await t.post(carol, t.follow(carol))).toBe(202)
		expect(await sql(t.h.store, 'SELECT inbox_url, shared_inbox_url FROM accounts WHERE uri = ?', carol.uri)).toEqual([
			{ inbox_url: `${carol.uri}/inbox`, shared_inbox_url: null },
		])
	})

	it('refuses an actor whose id is over the cap', async () => {
		const t = await together()
		const base = await mastodonActor(t.web, 'bob')
		const uri = `${base.uri}/${'x'.repeat(ACTOR_URI_LIMIT)}`
		const document = {
			...base.document,
			id: uri,
			inbox: `${base.uri}/inbox`,
			publicKey: { id: `${uri}#main-key`, owner: uri, publicKeyPem: base.pem },
		}
		t.web.serve(uri, document)
		const bob: TestActor = { ...base, uri, keyId: `${uri}#main-key`, document }
		await t.post(bob, t.follow(bob))
		expect(await accountId(t.h.store, uri)).toBeUndefined()
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(0)
	})
})

describe('ID-7: an Undo records a Block whatever the shape of its id', () => {
	it('keeps a Block with a pair-shaped id undone when it is delivered again', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		const b = t.block(bob, 'https://mastodon.example/follows/a/b')
		await t.post(bob, b)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(1)
		await t.post(bob, t.undo(bob, { id: b.id, type: 'Block', actor: bob.uri, object: t.aliceUri }))
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
		expect(await t.post(bob, b)).toBe(202)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
	})

	it('keeps an untyped Undo of a stored pair-shaped Block from letting it come back', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		const b = t.block(bob, 'https://mastodon.example/follows/a/b')
		await t.post(bob, b)
		await t.post(bob, t.undo(bob, b.id))
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
		await t.post(bob, b)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
	})

	// Coverage: the old code already refused this change; nothing pinned it.
	it('changes nothing when a Block takes a new id at the retraction cap', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const b1 = t.block(bob, `${bob.uri}#blocks/1`)
		await t.post(bob, b1)
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/seeded/' || i, ? FROM n`,
			MAX_RETRACTIONS_PER_ACTOR,
			bob.uri,
			bob.uri,
			NOW + DAY
		)
		const snapshot = async () => ({
			blocks: await sql(t.h.store, 'SELECT account_id, target_account_id, uri FROM blocks ORDER BY id'),
			follows: await sql(t.h.store, 'SELECT account_id, target_account_id, state, uri FROM follows ORDER BY id'),
			deliveries: await sql(t.h.store, 'SELECT id, inbox_url, state FROM deliveries ORDER BY id'),
			intents: await sql(t.h.store, 'SELECT id FROM outbound_activities ORDER BY id'),
		})
		const before = await snapshot()
		expect(before.blocks).toEqual([expect.objectContaining({ uri: b1.id })])
		expect(await t.post(bob, t.block(bob, `${bob.uri}#blocks/2`))).toBe(202)
		expect(await snapshot()).toEqual(before)
	})
})

// Coverage: the old code already resumed the deferred Undo in the delivery rounds; nothing pinned it.
// A local boost by alice of a status of bob, with `receipts` receipts at distinct servers, and bob's purge job.
async function boostWithReceipts(receipts: number) {
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
	const boostId = (await sql<{ id: string }>(t.h.store, 'SELECT id FROM statuses WHERE reblog_of_id = ?', statusId))[0]!
		.id
	await seedReceipts(t.h.store, boostId, t.alice.id, receipts)
	await sql(t.h.store, 'DELETE FROM outbound_activities')
	await sql(t.h.store, 'DELETE FROM deliveries')
	await sql(
		t.h.store,
		"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, ?2)",
		bob.uri,
		NOW
	)
	return { t, bob, boostId }
}

describe('RES-6: a purge stages a large Undo over several batches', () => {
	it('writes the targets of a withdrawal that needs more than a batch of rows, every batch within the budget', async () => {
		const receipts = PURGE_BATCH * TARGET_CHUNK_SIZE + 1
		const { t, bob } = await boostWithReceipts(receipts)
		const batch = () =>
			runInDurableObject(t.h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				state.storage.transactionSync(() => purgeBatch(db, bob.uri, NOW))
				return changes() - before
			})
		const staging = () =>
			count(
				t.h.store,
				"SELECT 1 FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Undo' AND staged IS NOT NULL"
			)
		// A batch gathers at most STAGING_READ receipts and writes about as many out (RES-6).
		let batches = 0
		do {
			expect(await batch()).toBeLessThanOrEqual(PURGE_BATCH)
			expect(++batches).toBeLessThanOrEqual(3 * Math.ceil(receipts / STAGING_READ))
		} while ((await staging()) > 0)
		expect(batches).toBeGreaterThan(1)
		const undo = await sql<{ id: string }>(
			t.h.store,
			`SELECT CAST(id AS TEXT) AS id FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Undo'`
		)
		expect(undo).toHaveLength(1)
		expect(
			await count(t.h.store, 'SELECT 1 FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)', undo[0]!.id)
		).toBeGreaterThan(PURGE_BATCH)
		const staged = await sql<{ n: number; distinct: number }>(
			t.h.store,
			`SELECT count(*) AS n, count(DISTINCT json_extract(t.value, '$.inbox')) AS "distinct"
			FROM outbound_targets c, json_each(c.targets) t
			WHERE c.activity_id = CAST(? AS INTEGER) AND json_extract(t.value, '$.inbox') GLOB 'https://r*.example/inbox'`,
			undo[0]!.id
		)
		expect(staged).toEqual([{ n: receipts, distinct: receipts }])
	}, 600_000)
})

describe('RES-6: a purge’s deferred Undo is expanded by the delivery rounds', () => {
	const receipts = PURGE_BATCH + 101

	async function boostedAndDeleted() {
		const { t, boostId } = await boostWithReceipts(receipts)
		let rows = 0
		let rang = false
		let claims = 0
		// One round of inbound jobs: the purge never expands the deferred Undo itself.
		const jobs = async () => {
			const result = await runStoreJobs(t.h.store, BUILD, { now: NOW })
			rang ||= result.delivers
			const next = await deliveryRows(t.h.store)
			expect(next).toBe(rows)
			return result.pending
		}
		// One delivery round: it expands at most EXPANSION_STEP targets, and asks for another while any remain.
		const claim = async () => {
			const result = await t.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: `c${++claims}` })
			const next = await deliveryRows(t.h.store)
			expect(next - rows).toBeLessThanOrEqual(EXPANSION_STEP)
			rows = next
			if ((await count(t.h.store, 'SELECT 1 FROM outbound_targets')) > 0) {
				expect(result.nextDueAt).toBe(NOW)
			}
		}
		const expanding = async () => (await count(t.h.store, 'SELECT 1 FROM outbound_targets')) > 0
		const settled = async () => {
			expect(rang).toBe(true)
			const undo = await sql<{ id: string }>(
				t.h.store,
				`SELECT CAST(id AS TEXT) AS id FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Undo'`
			)
			expect(undo).toHaveLength(1)
			const inboxes = (
				await sql<{ inbox_url: string }>(
					t.h.store,
					'SELECT inbox_url FROM deliveries WHERE activity_id = CAST(? AS INTEGER)',
					undo[0]!.id
				)
			).map((d) => d.inbox_url)
			expect(new Set(inboxes).size).toBe(inboxes.length)
			for (let i = 1; i <= receipts; i++) {
				expect(inboxes).toContain(`https://r${i}.example/inbox`)
			}
			expect(await count(t.h.store, 'SELECT 1 FROM outbound_receipts')).toBe(0)
			expect(await count(t.h.store, 'SELECT 1 FROM statuses WHERE id = ?', boostId)).toBe(0)
			expect(claims).toBeGreaterThanOrEqual(Math.ceil(receipts / EXPANSION_STEP))
		}
		return { jobs, claim, expanding, settled }
	}

	it('reaches every target when purge batches and delivery claims interleave', async () => {
		const t = await boostedAndDeleted()
		let pending = true
		for (let round = 0; round < 40 && (pending || (await t.expanding())); round++) {
			if (pending) {
				pending = await t.jobs()
			}
			await t.claim()
		}
		expect(pending).toBe(false)
		expect(await t.expanding()).toBe(false)
		await t.settled()
	})

	it('reaches every target when the purge completes before any expansion', async () => {
		const t = await boostedAndDeleted()
		for (let round = 0; round < 20 && (await t.jobs()); round++) {
			// The purge runs to its end first.
		}
		expect(await t.expanding()).toBe(true)
		for (let round = 0; round < 40 && (await t.expanding()); round++) {
			await t.claim()
		}
		expect(await t.expanding()).toBe(false)
		await t.settled()
	})
})
