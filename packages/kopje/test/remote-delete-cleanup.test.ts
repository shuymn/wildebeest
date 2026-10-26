import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { mastodonActor } from './inbox-helpers'
import {
	accountId,
	ALICE,
	followed,
	localStatus,
	mastodonNote,
	create,
	remove,
	type Setup,
	setup,
	statusRow,
} from './inbox-status-helpers'
import { watchedCursor } from './read-helpers'
import { Db } from '../src/db/sql'
import { TARGET_CHUNK_SIZE } from '../src/domain/deliveries'
import { deleteStatusBatch, PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { MAX_PUSH_BACKLOG } from '../src/domain/notifications'
import type { StoreStub } from '../src/platform/store-client'

// RES-6, ID-7, VIS-27/28: a remote status's removal in batches (deleteStatusBatch) and a purge (purgeBatch) delete a
// notification's pushes before it, recount no original that is being removed itself, mark the status withdrawn so no
// local unboost of it races the removal's own Undo, retire its accepted quote at once, and the job rounds ring the
// doorbell for the target chunks they stage.

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
	(await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n

async function remoteAccounts(t: Setup, n: number, host = 'many.example'): Promise<void> {
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO accounts (id, uri, username, domain) SELECT printf('4%017d', i), 'https://' || ? || '/u/' || i,
			'u' || i, ? FROM n`,
		n,
		host,
		host
	)
}

// bob's public status, which alice follows him for.
async function remoteStatus() {
	const t = await setup()
	const bob = await mastodonActor(t.web, 'bob')
	await followed(t, bob)
	const note = mastodonNote(bob)
	expect(await t.post(bob, create(bob, note))).toBe(202)
	const row = (await statusRow(t.store, note.id))!
	return { t, bob, note, id: row.id }
}

// One batch of the status's removal in its own transaction, with the rows it wrote.
async function batch(store: StoreStub, statusId: string): Promise<{ wrote: number; more: boolean }> {
	return runInDurableObject(store, (_instance, state) => {
		const db = new Db(state.storage.sql)
		const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
		const before = changes()
		const more = state.storage.transactionSync(() => deleteStatusBatch(db, statusId, NOW))
		return { wrote: changes() - before, more }
	})
}

describe('RES-6: pushes of a deleted status’s notification', () => {
	it('deletes a notification’s pushes before it, every batch within PURGE_BATCH', async () => {
		const { t, bob, id } = await remoteStatus()
		const bobId = (await accountId(t.store, bob.uri))!
		const [notification] = await sql<{ id: number }>(
			t.store,
			"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?) RETURNING id",
			ALICE,
			bobId,
			id
		)
		// All MAX_PUSH_BACKLOG pushes wait on the one notification, one subscription each.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
			SELECT 'push-' || i, 'access', (SELECT client_id FROM oauth_tokens LIMIT 1), ?2, 'push' FROM n`,
			MAX_PUSH_BACKLOG,
			ALICE
		)
		await sql(
			t.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
			SELECT token_hash, 'https://push.example/' || token_hash, 'k', 'a' FROM oauth_tokens WHERE token_hash GLOB 'push-*'`
		)
		await sql(
			t.store,
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT id, ?, ?, ? FROM push_subscriptions WHERE token_hash GLOB 'push-*'`,
			notification!.id,
			NOW,
			NOW
		)
		expect(await count(t.store, 'SELECT 1 FROM push_deliveries')).toBe(MAX_PUSH_BACKLOG)
		// The mentions the first batch deletes first leave it little of its budget: the hide, then the notification.
		await remoteAccounts(t, PURGE_BATCH - 10)
		await sql(
			t.store,
			"INSERT INTO status_mentions (status_id, account_id, silent) SELECT ?, id, 1 FROM accounts WHERE domain = 'many.example'",
			id
		)
		await sql(
			t.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, ?)",
			id,
			bob.uri,
			NOW
		)
		const written: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, more } = await batch(t.store, id)
			written.push(wrote)
			if (!more) {
				break
			}
		}
		expect(written.length).toBeGreaterThan(2)
		expect(Math.max(...written)).toBeLessThanOrEqual(PURGE_BATCH)
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', id)).toBe(0)
		expect(await count(t.store, 'SELECT 1 FROM notifications WHERE status_id = ?', id)).toBe(0)
		expect(await count(t.store, 'SELECT 1 FROM push_deliveries')).toBe(0)
	})
})

describe('RES-6: no recount of an original being removed', () => {
	// The rows the status recounts read (recountStatus) in every batch until the removal ends, with `boosts` remote boosts
	// and `favourites` remote favourites of bob's status, removed by its Delete (`delete`) or by bob's purge (`purge`).
	async function recountRows(mode: 'delete' | 'purge', boosts: number, favourites: number): Promise<number> {
		const { t, bob, note, id } = await remoteStatus()
		await remoteAccounts(t, Math.max(boosts, favourites))
		await sql(
			t.store,
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			SELECT printf('5%017d', CAST(substr(id, 2) AS INTEGER)), uri || '/boost', id, ?, 'public', '2026-10-11T13:00:00.000Z'
			FROM accounts WHERE domain = 'many.example' ORDER BY id LIMIT ?`,
			id,
			boosts
		)
		await sql(
			t.store,
			`INSERT INTO favourites (account_id, status_id, created_at)
			SELECT id, ?, 'x' FROM accounts WHERE domain = 'many.example' ORDER BY id LIMIT ?`,
			id,
			favourites
		)
		if (mode === 'purge') {
			await sql(t.store, "UPDATE accounts SET deleted_at = '2026-10-11T13:00:00.000Z' WHERE uri = ?", bob.uri)
			await sql(
				t.store,
				"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, ?2)",
				bob.uri,
				NOW
			)
		} else {
			// The Delete itself runs the first batch.
			expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		}
		let read = 0
		for (let i = 0; i < 100; i++) {
			const more = await runInDurableObject(t.store, (_instance, state) => {
				const real = state.storage.sql
				const counting = {
					exec: (query: string, ...params: SqlStorageValue[]) => {
						const cursor = real.exec(query, ...params)
						return watchedCursor(cursor, () => {
							if (query.includes('reblogs_count = (SELECT COUNT(*)')) {
								read += cursor.rowsRead
							}
						})
					},
				} as unknown as SqlStorage
				const db = new Db(counting)
				return state.storage.transactionSync(() =>
					mode === 'purge' ? purgeBatch(db, bob.uri, NOW) : deleteStatusBatch(db, id, NOW)
				)
			})
			if (!more) {
				break
			}
		}
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ? OR reblog_of_id = ?', id, id)).toBe(0)
		return read
	}

	// A recount of the original per boost deleted would read the boosts left and every favourite each time, their
	// product in all (here about 750,000 rows).
	it.each(['delete', 'purge'] as const)(
		'reads recount rows linear in the boosts and favourites (%s)',
		async (mode) => {
			const boosts = PURGE_BATCH + 1
			const favourites = 2 * PURGE_BATCH
			expect(await recountRows(mode, boosts, favourites)).toBeLessThanOrEqual(boosts + favourites)
		},
		60_000
	)
})

// bob's status boosted by alice and by dave, alice's boost with `receipts` receipts (more than one batch stages), then
// bob's Delete of the status: its first batch hides it, records the Undo of alice's boost and stages part of it.
async function boostedThenDeleted(receipts: number) {
	const world = await remoteStatus()
	const { t, bob, note, id } = world
	const boost = async (as: 'alice' | 'dave') => {
		const response = await t.request(`/api/v1/statuses/${id}/reblog`, {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens[as]}` },
		})
		expect(response.status).toBe(200)
		const { id: boostId } = (await response.json()) as { id: string }
		return (await sql<{ id: string; uri: string }>(t.store, 'SELECT id, uri FROM statuses WHERE id = ?', boostId))[0]!
	}
	const alice = await boost('alice')
	const dave = await boost('dave')
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
		SELECT ?, 'https://r' || i || '.example/inbox', ?, ? FROM n`,
		receipts,
		alice.id,
		ALICE,
		NOW
	)
	await sql(t.store, 'DELETE FROM outbound_activities')
	await sql(t.store, 'DELETE FROM deliveries')
	expect(await t.post(bob, remove(bob, note.id))).toBe(202)
	return { ...world, boosts: { alice, dave } }
}

// The Undo intents of the boost `uri`.
const undos = (store: StoreStub, uri: string) =>
	sql<{ id: string; staged: string | null }>(
		store,
		'SELECT CAST(id AS TEXT) AS id, staged FROM outbound_activities WHERE object_uri = ? AND retracts = 1',
		uri
	)

// The inboxes an intent targets: its chunks' targets and its deliveries.
const targetsOf = async (store: StoreStub, intent: string) =>
	(
		await sql<{ inbox: string }>(
			store,
			`SELECT json_extract(t.value, '$.inbox') AS inbox FROM outbound_targets c, json_each(c.targets) t
			WHERE c.activity_id = CAST(?1 AS INTEGER)
			UNION ALL SELECT inbox_url FROM deliveries WHERE activity_id = CAST(?1 AS INTEGER)`,
			intent
		)
	).map((row) => row.inbox)

describe('ID-7: no local unboost of a status whose removal runs', () => {
	it('answers 404 to unreblog and to the boost’s DELETE, writing nothing; the removal withdraws each boost once', async () => {
		const receipts = PURGE_BATCH * TARGET_CHUNK_SIZE + 1
		const { t, bob, id, boosts } = await boostedThenDeleted(receipts)
		// The guarded state: the original is withdrawn, alice's boost is staging its Undo, dave's is not reached yet.
		expect(await sql(t.store, 'SELECT withdrawn FROM statuses WHERE id = ?', id)).toEqual([{ withdrawn: 1 }])
		expect(await undos(t.store, boosts.alice.uri)).toEqual([{ id: expect.any(String), staged: expect.any(String) }])
		expect(await undos(t.store, boosts.dave.uri)).toEqual([])
		expect(await sql(t.store, 'SELECT id, withdrawn FROM statuses WHERE reblog_of_id = ? ORDER BY id', id)).toEqual([
			{ id: boosts.alice.id, withdrawn: 1 },
			{ id: boosts.dave.id, withdrawn: 0 },
		])
		const snapshot = () =>
			sql(
				t.store,
				`SELECT (SELECT count(*) FROM outbound_activities) AS intents, (SELECT max(id) FROM outbound_activities) AS last,
						(SELECT count(*) FROM outbound_targets) AS chunks, (SELECT count(*) FROM deliveries) AS deliveries,
						(SELECT count(*) FROM outbound_receipts) AS receipts, (SELECT count(*) FROM statuses) AS statuses,
						(SELECT count(*) FROM stream_events) AS events`
			)
		const before = await snapshot()
		const call = (as: 'alice' | 'dave', path: string, method: string) =>
			t.request(path, { method, headers: { authorization: `Bearer ${t.tokens[as]}` } })
		for (const as of ['alice', 'dave'] as const) {
			expect((await call(as, `/api/v1/statuses/${id}/unreblog`, 'POST')).status).toBe(404)
			expect((await call(as, `/api/v1/statuses/${boosts[as].id}/unreblog`, 'POST')).status).toBe(404)
			expect((await call(as, `/api/v1/statuses/${boosts[as].id}`, 'DELETE')).status).toBe(404)
		}
		expect(await snapshot()).toEqual(before)

		for (let round = 0; round < 200; round++) {
			if (!(await t.store.runInboundJobs(BUILD, { now: NOW })).pending) {
				break
			}
		}
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ? OR reblog_of_id = ?', id, id)).toBe(0)
		// One Undo of each boost, to every inbox that received it (alice's receipts) or follows its booster (bob follows
		// dave).
		const aliceUndos = await undos(t.store, boosts.alice.uri)
		const daveUndos = await undos(t.store, boosts.dave.uri)
		expect(aliceUndos).toHaveLength(1)
		expect(daveUndos).toHaveLength(1)
		const aliceTargets = new Set(await targetsOf(t.store, aliceUndos[0]!.id))
		for (let i = 1; i <= receipts; i++) {
			expect(aliceTargets.has(`https://r${i}.example/inbox`)).toBe(true)
		}
		const [{ inbox }] = (await sql<{ inbox: string }>(
			t.store,
			'SELECT IFNULL(shared_inbox_url, inbox_url) AS inbox FROM accounts WHERE uri = ?',
			bob.uri
		)) as [{ inbox: string }]
		expect(await targetsOf(t.store, daveUndos[0]!.id)).toContain(inbox)
	}, 120_000)
})

describe('VIS-27: the accepted quote of a remote status being removed', () => {
	it('leaves the quoted status’s quotes list and count at once, even without an authorization', async () => {
		const { t, bob, note, id } = await remoteStatus()
		const quoted = await localStatus(t, { status: 'quoted', visibility: 'public' })
		// An imported accepted quote, which holds no authorization of Kopje's.
		await sql(
			t.store,
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			VALUES (?1, ?2, ?3, ?4, 'accepted', '2026-10-12T00:00:00.000Z')`,
			id,
			quoted.uri,
			quoted.id,
			ALICE
		)
		// More favourites than a batch removes, so the removal spans batches.
		await remoteAccounts(t, PURGE_BATCH * 2)
		await sql(
			t.store,
			"INSERT INTO favourites (account_id, status_id, created_at) SELECT id, ?, 'x' FROM accounts WHERE domain = 'many.example'",
			id
		)
		const read = async () => ({
			count: (await t.api<{ quotes_count: number }>(`/api/v1/statuses/${quoted.id}`)).body.quotes_count,
			list: (await t.api<{ id: string }[]>(`/api/v1/statuses/${quoted.id}/quotes`)).body.map((s) => s.id),
		})
		expect(await read()).toEqual({ count: 1, list: [id] })

		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', id)).toBe(1)
		expect(await sql(t.store, 'SELECT state, authorization_id FROM quotes WHERE status_id = ?', id)).toEqual([
			{ state: 'revoked', authorization_id: null },
		])
		expect(await read()).toEqual({ count: 0, list: [] })

		for (let round = 0; round < 20; round++) {
			if (!(await t.store.runInboundJobs(BUILD, { now: NOW })).pending) {
				break
			}
		}
		expect(await count(t.store, 'SELECT 1 FROM quotes')).toBe(0)
		expect(await read()).toEqual({ count: 0, list: [] })
	})
})

describe('RES-6: a job round that stages target chunks rings the doorbell', () => {
	it('reports delivers when it writes chunks of an intent recorded earlier, and nothing else', async () => {
		const { t, boosts } = await boostedThenDeleted(PURGE_BATCH * TARGET_CHUNK_SIZE + 1)
		const [undo] = await undos(t.store, boosts.alice.uri)
		expect(undo!.staged).not.toBeNull()
		const marks = async () =>
			(
				await sql<{ last: number; deliveries: number; chunks: number }>(
					t.store,
					`SELECT (SELECT max(id) FROM outbound_activities) AS last,
						IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'deliveries'), 0) AS deliveries,
						(SELECT count(*) FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)) AS chunks`,
					undo!.id
				)
			)[0]!
		const before = await marks()
		const result = await t.store.runInboundJobs(BUILD, { now: NOW })
		const after = await marks()
		// Only chunks of the earlier intent were written: no intent, no delivery.
		expect(after.chunks).toBeGreaterThan(before.chunks)
		expect({ last: after.last, deliveries: after.deliveries }).toEqual({
			last: before.last,
			deliveries: before.deliveries,
		})
		expect(result.delivers).toBe(true)
	})
})
