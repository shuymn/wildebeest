import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { bearer, sql } from './api-helpers'
import { harness, inboxDeps, NOW } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD } from './helpers'
import { MASTODON, mastodonActor, RemoteWeb, signedInit, type TestActor } from './inbox-helpers'
import { community, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import { recordOutbound } from '../src/domain/activities'
import { MAX_BACKLOG, MAX_LANE_BACKLOG } from '../src/domain/deliveries'
import { PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { runScheduledJobs } from '../src/jobs/queue'
import { handleScheduled } from '../src/jobs/scheduled'
import { mediaKeys } from '../src/platform/media-files'
import type { StoreStub } from '../src/platform/store-client'

// Regressions from the third verification of B1b-1: Block generations, Misskey pair ids on every Follow retraction
// path (ID-7), the purge's whole-batch write budget with B2's boost withdrawal and B4b's media sweep (RES-6), and
// Reject admission per caller (RES-4).

const AS = 'https://www.w3.org/ns/activitystreams'

let sequence = 0
const nextId = (actor: TestActor) => `${new URL(actor.uri).origin}/activities/w${++sequence}`

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
	const undo = (actor: TestActor, object: unknown) => ({
		'@context': AS,
		id: nextId(actor),
		type: 'Undo',
		actor: actor.uri,
		object,
	})
	const deps = inboxDeps(() => h.store, web.loader)
	const runEnv = { ...inbox.env, MAINTENANCE: 'off' } as Env
	const drain = async () => {
		for (let round = 0; round < 30; round++) {
			await runScheduledJobs(runEnv, deps)
		}
	}
	return { h, alice, aliceUri, web, inbox, post, follow, undo, deps, runEnv, drain }
}

const deleteSelf = (actor: TestActor) => ({
	'@context': AS,
	id: `${actor.uri}#delete`,
	type: 'Delete',
	actor: actor.uri,
	object: actor.uri,
})

describe('ID-7: Block generations and Misskey pair ids', () => {
	it('keeps a block undone when its superseded id is delivered again', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		const block = (id: string) => ({ '@context': AS, id, type: 'Block', actor: bob.uri, object: t.aliceUri })
		const b1 = block(`${bob.uri}#blocks/1`)
		const b2 = block(`${bob.uri}#blocks/2`)
		await t.post(bob, b1)
		await t.post(bob, b2)
		await t.post(bob, t.undo(bob, { id: b2.id, type: 'Block', actor: bob.uri, object: t.aliceUri }))
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
		expect(await t.post(bob, b1)).toBe(202)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
	})

	it('records no pair id when a request is rejected, so the pair Undo ends the next generation', async () => {
		const t = await together()
		await sql(t.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.alice.id)
		const bob = await mastodonActor(t.web, 'bob')
		const pair = `${MASTODON}/follows/9abc/9def`
		await t.post(bob, t.follow(bob, pair))
		const bobId = (await accountId(t.h.store, bob.uri))!
		const rejected = await t.h.request(
			`/api/v1/follow_requests/${bobId}/reject`,
			bearer(t.alice.token, { method: 'POST' })
		)
		expect(rejected.status).toBe(200)
		await t.post(bob, t.follow(bob))
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(1)
		await t.post(bob, t.undo(bob, { id: pair, type: 'Follow', actor: bob.uri, object: t.aliceUri }))
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM inbound_retractions WHERE target_uri = ?', pair)).toBe(0)
	})

	it('records no pair id when a blocked Follow is refused', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		await sql(t.h.store, 'DELETE FROM follows')
		await sql(t.h.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', t.alice.id, bobId)
		const pair = `${MASTODON}/follows/9abc/9def`
		await t.post(bob, t.follow(bob, pair))
		expect(await count(t.h.store, 'SELECT 1 FROM inbound_retractions WHERE target_uri = ?', pair)).toBe(0)
		await sql(t.h.store, 'DELETE FROM blocks')
		await t.post(bob, t.follow(bob))
		await t.post(bob, t.undo(bob, { id: pair, type: 'Follow', actor: bob.uri, object: t.aliceUri }))
		expect(await count(t.h.store, 'SELECT 1 FROM follows')).toBe(0)
	})
})

describe('RES-6: a purge batch writes at most PURGE_BATCH rows in all', () => {
	// Runs one purge batch inside the Store and returns how many rows it wrote (SQLite's total_changes()).
	async function batch(store: StoreStub, uri: string): Promise<{ wrote: number; remaining: boolean }> {
		return runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
			const before = changes()
			const remaining = state.storage.transactionSync(() => purgeBatch(db, uri, NOW))
			return { wrote: changes() - before, remaining }
		})
	}

	it('withdraws a local boost with more receipts than a batch once, across resumed and repeated batches', async () => {
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
		const boostId = (
			await sql<{ id: string }>(t.h.store, 'SELECT id FROM statuses WHERE reblog_of_id = ?', statusId)
		)[0]!.id
		const receipts = PURGE_BATCH + 101
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT ?, 'https://r' || i || '.example/inbox', ?, 0 FROM n`,
			receipts,
			boostId,
			t.alice.id
		)
		await sql(t.h.store, 'DELETE FROM outbound_activities')
		await sql(t.h.store, 'DELETE FROM deliveries')
		await sql(
			t.h.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, ?2)",
			bob.uri,
			NOW
		)

		const first = await batch(t.h.store, bob.uri)
		expect(first.remaining).toBe(true)
		expect(first.wrote).toBeLessThanOrEqual(PURGE_BATCH)
		expect(await count(t.h.store, 'SELECT 1 FROM outbound_receipts')).toBeGreaterThan(0)
		// Resumed, and the job delivered twice.
		for (let i = 0; i < 6; i++) {
			const next = await batch(t.h.store, bob.uri)
			expect(next.wrote).toBeLessThanOrEqual(PURGE_BATCH)
		}
		const undo = await sql<{ targets: string | null; id: string }>(
			t.h.store,
			`SELECT pending_targets AS targets, CAST(id AS TEXT) AS id FROM outbound_activities
			WHERE json_extract(body, '$.activity.type') = 'Undo'`
		)
		expect(undo).toHaveLength(1)
		const delivered = await sql<{ inbox_url: string }>(
			t.h.store,
			'SELECT inbox_url FROM deliveries WHERE activity_id = CAST(? AS INTEGER)',
			undo[0]!.id
		)
		const reached = new Set([
			...delivered.map((d) => d.inbox_url),
			...((JSON.parse(undo[0]!.targets ?? '[]') as { inbox: string }[]).map((target) => target.inbox) ?? []),
		])
		expect(reached.has('https://r1.example/inbox')).toBe(true)
		expect(reached.has(`https://r${receipts}.example/inbox`)).toBe(true)
		expect(await count(t.h.store, 'SELECT 1 FROM outbound_receipts')).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM statuses WHERE id = ?', boostId)).toBe(0)
		expect(
			(await sql<{ n: number }>(t.h.store, 'SELECT statuses_count AS n FROM accounts WHERE id = ?', t.alice.id))[0]!.n
		).toBe(0)
	})

	it('keeps every batch within the budget over relationships and every status child table', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		const statusId = await seedStatus(t.h.store, {
			accountId: bobId,
			visibility: 'public',
			uri: `${bob.uri}/statuses/1`,
		})
		const n = 120
		const many = (sqlText: string, ...params: SqlStorageValue[]) =>
			sql(
				t.h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) ${sqlText}`,
				...params
			)
		await many(
			`INSERT INTO accounts (id, uri, username, domain) SELECT printf('5%017d', i), 'https://kopje.test/ap/users/m' || i, 'm' || i, NULL FROM n`
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
		await sql(
			t.h.store,
			"INSERT INTO mutes (account_id, target_account_id) SELECT id, ? FROM accounts WHERE id GLOB '5*'",
			bobId
		)
		await many(`INSERT INTO lists (id, account_id, title) SELECT printf('8%017d', i), ?, 'l' FROM n`, t.alice.id)
		await sql(
			t.h.store,
			"INSERT INTO list_accounts (list_id, account_id) SELECT id, ? FROM lists WHERE id GLOB '8*'",
			bobId
		)
		await many(
			'INSERT INTO status_edits (status_id, created_at) SELECT ?, ? FROM n',
			statusId,
			'2026-10-01T00:00:00.000Z'
		)
		await many(
			`INSERT INTO media_attachments (id, account_id, status_id, type, url) SELECT printf('9%017d', i), ?, ?, 'image', 'https://x/' || i FROM n`,
			bobId,
			statusId
		)
		await sql(
			t.h.store,
			"INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB '5*'",
			statusId
		)
		await many("INSERT INTO status_tags (status_id, name) SELECT ?, 't' || i FROM n", statusId)
		await sql(
			t.h.store,
			"INSERT INTO favourites (account_id, status_id) SELECT id, ? FROM accounts WHERE id GLOB '5*'",
			statusId
		)
		await sql(
			t.h.store,
			"INSERT INTO bookmarks (account_id, status_id) SELECT id, ? FROM accounts WHERE id GLOB '5*'",
			statusId
		)
		await sql(
			t.h.store,
			"INSERT INTO notifications (account_id, type, from_account_id, status_id) SELECT id, 'favourite', ?, ? FROM accounts WHERE id GLOB '5*'",
			bobId,
			statusId
		)
		await many(
			"INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) SELECT ?, 'https://r' || i || '.example/inbox', ?, 0 FROM n",
			statusId,
			t.alice.id
		)
		await many(
			`INSERT INTO statuses (id, uri, account_id, visibility, published_at, in_reply_to_uri, in_reply_to_id)
			SELECT printf('7%017d', i), 'https://kopje.test/r/' || i, ?, 'public', '2026-10-01T00:00:00.000Z', ?, ? FROM n`,
			t.alice.id,
			`${bob.uri}/statuses/1`,
			statusId
		)
		await sql(
			t.h.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, ?2)",
			bob.uri,
			NOW
		)
		const tables = [
			'follows',
			'mutes',
			'list_accounts',
			'status_edits',
			'media_attachments',
			'status_mentions',
			'status_tags',
			'favourites',
			'bookmarks',
			'notifications',
			'outbound_receipts',
		]
		const total = async () => {
			let sum = 0
			for (const table of tables) {
				sum += await count(t.h.store, `SELECT 1 FROM ${table}`)
			}
			return sum
		}
		const start = await total()
		let previous = start
		for (let i = 0; i < 10; i++) {
			const result = await batch(t.h.store, bob.uri)
			expect(result.wrote).toBeLessThanOrEqual(PURGE_BATCH)
			const now = await total()
			expect(now).toBeLessThanOrEqual(previous)
			previous = now
			if (!result.remaining) {
				break
			}
		}
		expect(start).toBeGreaterThan(PURGE_BATCH)
		expect(previous).toBe(0)
		expect(await count(t.h.store, 'SELECT 1 FROM statuses WHERE in_reply_to_id IS NOT NULL')).toBe(0)
		expect(await accountId(t.h.store, bob.uri)).toBeUndefined()
	})

	it('leaves a local upload of a purged status, and its R2 object, to the media sweep', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		const statusId = await seedStatus(t.h.store, {
			accountId: bobId,
			visibility: 'public',
			uri: `${bob.uri}/statuses/1`,
		})
		const mediaId = '900000000000000001'
		const token = 'A'.repeat(43)
		await sql(
			t.h.store,
			`INSERT INTO media_attachments (id, account_id, status_id, type, url, file_token, processed)
			VALUES (?, ?, ?, 'image', 'https://kopje.test/media/x', ?, 1)`,
			mediaId,
			t.alice.id,
			statusId,
			token
		)
		const keys = mediaKeys(mediaId, token)
		for (const key of keys) {
			await env.MEDIA.put(key, 'bytes')
		}
		t.web.fail(bob.uri, 410)
		expect(await t.post(bob, deleteSelf(bob))).toBe(202)
		await t.drain()
		expect(await accountId(t.h.store, bob.uri)).toBeUndefined()
		expect(
			await sql(t.h.store, 'SELECT status_id, gc_at IS NOT NULL AS doomed FROM media_attachments WHERE id = ?', mediaId)
		).toEqual([{ status_id: null, doomed: 1 }])
		expect(await env.MEDIA.head(keys[0]!)).not.toBeNull()

		await handleScheduled(t.runEnv, { build: () => BUILD, now: () => NOW, store: () => t.h.store })
		expect(await count(t.h.store, 'SELECT 1 FROM media_attachments WHERE id = ?', mediaId)).toBe(0)
		for (const key of keys) {
			expect(await env.MEDIA.head(key)).toBeNull()
		}
	})
})

describe('RES-4: Reject admission by caller', () => {
	async function lockedWithRequest() {
		const t = await together()
		await sql(t.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.alice.id)
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const bobId = (await accountId(t.h.store, bob.uri))!
		return { ...t, bob, bobId }
	}
	const fill = (
		store: StoreStub,
		accountId: string,
		rows: number,
		inbox: (i: string) => string,
		lane: (i: string) => string
	) =>
		sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT (SELECT max(id) FROM outbound_activities), ?, ${inbox('i')}, ${lane('i')}, 'queued', 0, 0 FROM n`,
			rows,
			accountId
		)
	const rejectState = async (store: StoreStub) =>
		(
			await sql<{ state: string; last_error: string | null }>(
				store,
				`SELECT d.state, d.last_error FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE json_extract(o.body, '$.activity.type') = 'Reject'`
			)
		)[0]

	it('gives up the Reject of a rejected request when its lane is full', async () => {
		const t = await lockedWithRequest()
		await sql(
			t.h.store,
			"INSERT INTO outbound_activities (account_id, body, created_at) VALUES (?, '{}', 0)",
			t.alice.id
		)
		await fill(
			t.h.store,
			t.alice.id,
			MAX_LANE_BACKLOG,
			() => `'${t.bob.uri}/inbox'`,
			() => `'${MASTODON}'`
		)
		await t.h.request(`/api/v1/follow_requests/${t.bobId}/reject`, bearer(t.alice.token, { method: 'POST' }))
		expect(await rejectState(t.h.store)).toEqual({ state: 'gave_up', last_error: 'backlog full' })
	})

	it('gives up the Reject of a rejected request when the whole backlog is full', async () => {
		const t = await lockedWithRequest()
		await sql(
			t.h.store,
			"INSERT INTO outbound_activities (account_id, body, created_at) VALUES (?, '{}', 0)",
			t.alice.id
		)
		await fill(
			t.h.store,
			t.alice.id,
			MAX_BACKLOG,
			(i) => `'https://s' || ${i} || '.example/inbox'`,
			(i) => `'https://s' || ${i} || '.example'`
		)
		await t.h.request(`/api/v1/follow_requests/${t.bobId}/reject`, bearer(t.alice.token, { method: 'POST' }))
		expect(await rejectState(t.h.store)).toEqual({ state: 'gave_up', last_error: 'backlog full' })
	})

	it('treats a Reject passed withdraws: true as a withdrawal even when full', async () => {
		const t = await lockedWithRequest()
		await sql(
			t.h.store,
			"INSERT INTO outbound_activities (account_id, body, created_at) VALUES (?, '{}', 0)",
			t.alice.id
		)
		await fill(
			t.h.store,
			t.alice.id,
			MAX_LANE_BACKLOG,
			() => `'${t.bob.uri}/inbox'`,
			() => `'${MASTODON}'`
		)
		await runInDurableObject(t.h.store, (_instance, state) => {
			state.storage.transactionSync(() =>
				recordOutbound(
					new Db(state.storage.sql),
					t.alice.id,
					{
						activity: {
							'@context': AS,
							id: `${t.aliceUri}#rejects/follows/x`,
							type: 'Reject',
							actor: t.aliceUri,
							object: { id: `${t.bob.uri}#f`, type: 'Follow', actor: t.bob.uri, object: t.aliceUri },
						},
						audience: { followers: false, accounts: [t.bobId] },
					},
					NOW,
					{ withdraws: true }
				)
			)
		})
		const state = await rejectState(t.h.store)
		expect(state?.state).not.toBe('gave_up')
	})
})
