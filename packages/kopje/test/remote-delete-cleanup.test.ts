import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { mastodonActor } from './inbox-helpers'
import {
	accountId,
	ALICE,
	AS,
	DAVE,
	followed,
	localStatus,
	mastodonNote,
	create,
	remove,
	type Setup,
	setup,
	statusRow,
} from './inbox-status-helpers'
import { rowsRead, watchedCursor } from './read-helpers'
import { Db } from '../src/db/sql'
import { TARGET_CHUNK_SIZE } from '../src/domain/deliveries'
import { deleteStatusBatch, PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { MAX_PUSH_BACKLOG } from '../src/domain/notifications'
import { homeTimeline } from '../src/domain/timelines'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

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

describe('RES-6: hashtags of a deleted status past one batch', () => {
	it('takes them off the tag index over batches, every batch within PURGE_BATCH', async () => {
		const { t, bob, note, id } = await remoteStatus()
		// An imported status's hashtags, more than one batch writes, all on the public tag index.
		const tags = PURGE_BATCH + 100
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO status_tags (status_id, name, public) SELECT ?1, printf('tag%05d', i), 1 FROM n`,
			id,
			tags
		)
		await sql(
			t.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, ?)",
			id,
			bob.uri,
			NOW
		)
		const first = await batch(t.store, id)
		expect(first).toEqual({ wrote: PURGE_BATCH, more: true })
		// Hidden, and the hashtags past the batch's room still to go.
		expect(await statusRow(t.store, note.id)).toMatchObject({ visibility: 'direct' })
		expect(await count(t.store, 'SELECT 1 FROM status_tags WHERE status_id = ? AND public = 1', id)).toBeGreaterThan(0)
		const written = [first.wrote]
		for (let i = 0; i < 10; i++) {
			const { wrote, more } = await batch(t.store, id)
			written.push(wrote)
			if (!more) {
				break
			}
		}
		expect(Math.max(...written)).toBeLessThanOrEqual(PURGE_BATCH)
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', id)).toBe(0)
		expect(await count(t.store, 'SELECT 1 FROM status_tags')).toBe(0)
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

// bob's status boosted by alice and by dave, alice's boost with `receipts` receipts (more than one batch stages) and
// dave's with one, then its removal: bob's Delete of the status (`delete`) or of himself (`purge`). The first batch
// records the Undo of alice's boost and stages part of it; dave's boost is not reached yet.
async function boostedThenDeleted(receipts: number, mode: 'delete' | 'purge' = 'delete') {
	const world = await remoteStatus()
	const { t, bob, note, id } = world
	const boost = async (as: 'alice' | 'dave') => {
		const response = await t.request(`/api/v1/statuses/${id}/reblog`, {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens[as]}` },
		})
		expect(response.status).toBe(200)
		const { id: boostId } = await response.json<{ id: string }>()
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
	await sql(
		t.store,
		"INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, 'https://d.example/inbox', ?, ?)",
		dave.id,
		DAVE,
		NOW
	)
	await sql(t.store, 'DELETE FROM outbound_activities')
	await sql(t.store, 'DELETE FROM deliveries')
	if (mode === 'purge') {
		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)
	} else {
		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
	}
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
	it.each(['delete', 'purge'] as const)(
		'answers 404 to unreblog and to the boost’s DELETE, writing nothing; the removal withdraws each boost once (%s)',
		async (mode) => {
			const receipts = PURGE_BATCH * TARGET_CHUNK_SIZE + 1
			const { t, bob, id, boosts } = await boostedThenDeleted(receipts, mode)
			// The guarded state: the original's removal has begun (its Delete recorded, or its author's purge started),
			// alice's boost is staging its Undo, dave's is not reached yet.
			expect(
				await sql(
					t.store,
					`SELECT s.withdrawn, a.deleted_at IS NOT NULL AS purged FROM statuses s JOIN accounts a ON a.id = s.account_id
					WHERE s.id = ?`,
					id
				)
			).toEqual([mode === 'delete' ? { withdrawn: 1, purged: 0 } : { withdrawn: 0, purged: 1 }])
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
			if (mode === 'purge') {
				expect(await count(t.store, 'SELECT 1 FROM accounts WHERE uri = ?', bob.uri)).toBe(0)
			}
			// One Undo of each boost, to every inbox that received it.
			const aliceUndos = await undos(t.store, boosts.alice.uri)
			const daveUndos = await undos(t.store, boosts.dave.uri)
			expect(aliceUndos).toHaveLength(1)
			expect(daveUndos).toHaveLength(1)
			const aliceTargets = new Set(await targetsOf(t.store, aliceUndos[0]!.id))
			for (let i = 1; i <= receipts; i++) {
				expect(aliceTargets.has(`https://r${i}.example/inbox`)).toBe(true)
			}
			expect(await targetsOf(t.store, daveUndos[0]!.id)).toContain('https://d.example/inbox')
		},
		120_000
	)
})

describe('a local favourite or bookmark of a status whose removal runs', () => {
	// Only an unboost races the removal's own Undo (withdrawLocalBoosts): unfavourite and unbookmark remove the viewer's
	// own relation as at any other time.
	it.each(['delete', 'purge'] as const)('is removed by unfavourite and unbookmark (%s)', async (mode) => {
		const { t, bob, note, id } = await remoteStatus()
		// More favourites before alice's than a batch removes, so hers outlives the removal's first batch.
		await remoteAccounts(t, PURGE_BATCH * 2)
		await sql(
			t.store,
			"INSERT INTO favourites (account_id, status_id, created_at) SELECT id, ?, 'x' FROM accounts WHERE domain = 'many.example'",
			id
		)
		const call = (path: string) =>
			t.request(path, { method: 'POST', headers: { authorization: `Bearer ${t.tokens.alice}` } })
		expect((await call(`/api/v1/statuses/${id}/favourite`)).status).toBe(200)
		expect((await call(`/api/v1/statuses/${id}/bookmark`)).status).toBe(200)
		if (mode === 'purge') {
			t.web.fail(bob.uri, 410)
			const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
			expect(await t.post(bob, deletion)).toBe(202)
		} else {
			expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		}
		// The removal has begun and alice's relations are still there.
		expect(
			await sql(
				t.store,
				`SELECT s.withdrawn = 1 OR a.deleted_at IS NOT NULL AS begun FROM statuses s JOIN accounts a ON a.id = s.account_id
				WHERE s.id = ?`,
				id
			)
		).toEqual([{ begun: 1 }])
		const relations = async () => ({
			favourites: await count(t.store, 'SELECT 1 FROM favourites WHERE account_id = ? AND status_id = ?', ALICE, id),
			bookmarks: await count(t.store, 'SELECT 1 FROM bookmarks WHERE account_id = ? AND status_id = ?', ALICE, id),
		})
		expect(await relations()).toEqual({ favourites: 1, bookmarks: 1 })
		// The status itself is no longer shown to alice, so the answer is 404 either way.
		expect((await call(`/api/v1/statuses/${id}/unfavourite`)).status).toBe(404)
		expect((await call(`/api/v1/statuses/${id}/unbookmark`)).status).toBe(404)
		expect(await relations()).toEqual({ favourites: 0, bookmarks: 0 })
	})
})

describe('VIS-1: a hidden status whose hashtags are still on the index', () => {
	// bob's statuses hidden by their removals' first batches, `n` of them newer than anything else, each still holding a
	// public row of a hashtag alice follows (the rest of an imported status's hashtags waits for later batches).
	async function hiddenTagged(t: Setup, bobId: string, from: number, n: number) {
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT ?2 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 + ?3 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, withdrawn, published_at)
			SELECT printf('7%017d', i), 'https://remote.example/hidden/' || i, ?1, 'direct', '', 1, '2026-10-11T13:00:00.000Z'
			FROM n`,
			bobId,
			from,
			n
		)
		await sql(
			t.store,
			`INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses WHERE id GLOB '7*'
			ON CONFLICT DO NOTHING`
		)
	}

	it('is no home candidate: neither the page nor its Links name it, and the walk costs a probe each', async () => {
		const { t, bob, id } = await remoteStatus()
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(t.store, "INSERT INTO tag_follows (account_id, name) VALUES (?, 'cats')", ALICE)
		// Statistics taken before the hidden rows exist.
		await sql(t.store, 'ANALYZE')
		const hidden = 60
		await hiddenTagged(t, bobId, 1, hidden)
		const response = await t.request('/api/v1/timelines/home', {
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		expect(response.status).toBe(200)
		const shown = (await response.json<{ id: string }[]>()).map((s) => s.id)
		expect(shown).toEqual([id])
		expect(response.headers.get('link') ?? '').not.toMatch(/=7\d{17}\b/)

		const credential = { tokenHash: await sha256Hex(t.tokens.alice), scope: 'read', now: NOW } as const
		const read = () =>
			rowsRead(t, homeTimeline, { credential, page: { limit: 20 }, present: { origin: 'https://kopje.test' } })
		const few = await read()
		await hiddenTagged(t, bobId, hidden + 1, hidden)
		const many = await read()
		// Each hidden row costs its tag row and the probe of its status, whatever the statistics.
		expect(many - few).toBeLessThanOrEqual(3 * hidden)
	})
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
