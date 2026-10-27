import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, settle, settleDeliveries, sql } from './api-helpers'
import { harness, NOW } from './app-helpers'
import { batch, batches, remoteAccountsAt, retractionInboxes } from './delete-job-helpers'
import { BUILD } from './helpers'
import { MASTODON, mastodonActor } from './inbox-helpers'
import {
	ALICE,
	create,
	DAVE,
	followed,
	localStatus,
	mastodonNote,
	remove,
	type Setup,
	setup,
	statusRow,
	update,
} from './inbox-status-helpers'
import { deferred } from './quote-helpers'
import { type PlannedStatement, plannedSql, rowsRead, scansOf, staleStatistics } from './read-helpers'
import { seedReceipts } from './status-helpers'
import { Db } from '../src/db/sql'
import { claimDeliveries, completeDelivery, TARGET_CHUNK_SIZE } from '../src/domain/deliveries'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'
import { MAX_PUSH_BACKLOG } from '../src/domain/notifications'
import { LIBRARY_SOURCE_LIMIT, search } from '../src/domain/search'
import { DELETE_SUPERSEDES, deleteStatus, editStatus, getStatus, reblog, unreblog } from '../src/domain/statuses'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// RES-6, VIS-3, ID-7: an unboost (unreblog, or the DELETE of a boost; statuses.ts removeReblog) records the boost's
// Undo as an intent alone, hides the boost (statuses.withdrawn) and takes it off the counts and its notification,
// each within BOOST_REQUEST_ROWS, then its job (inbox.ts deleteStatusBatch, a local status's) stages the Undo's
// targets while the receipts are kept, then deletes them a batch at a time and the boost. Nobody sees the boost from
// the unboost on, and its booster may boost the original again at once.

const PRESENT = { origin: 'https://kopje.test' }

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
	(await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n

// The rows an unboost writes at most (RES-6), at every input's maximum: the streaming capture (an event, a tombstone
// and 256 viewers, R32), DELETE_SUPERSEDES earlier activities about the boost superseded (an update and a delete each,
// and the end of the staging of one still staging, which only an import holds), the Undo's intent, the hide and the
// booster's last status (its trigger), the two counts, the reblog notification's MAX_PUSH_BACKLOG pushes and the
// notification, and the job.
const BOOST_REQUEST_ROWS = 258 + 3 * DELETE_SUPERSEDES + 1 + 2 + 2 + MAX_PUSH_BACKLOG + 1 + 1

type As = 'alice' | 'dave'

async function credential(t: Setup, as: As = 'alice') {
	return { tokenHash: await sha256Hex(t.tokens[as]), scope: 'write:statuses' as const, now: NOW }
}

type How = 'unreblog' | 'delete'

// `as`'s unboost as a Store operation in its own transaction: by unreblog of `id` (an original, or a boost of it) or
// by the DELETE of the boost `id`. Its answer, the rows it wrote (total_changes()) and the answered status.
async function unboosted(t: Setup, how: How, id: string, as: As = 'alice') {
	const base = { credential: await credential(t, as), id, now: NOW, present: PRESENT }
	return runInDurableObject(t.store, (_instance, state) => {
		const db = new Db(state.storage.sql)
		const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
		const before = changes()
		const result = state.storage.transactionSync(() =>
			how === 'unreblog'
				? unreblog.run(state.storage.sql, base)
				: deleteStatus.run(state.storage.sql, { ...base, deleteMedia: false })
		)
		const answered = result.status === 'ok' && result.value.status === 'ok' ? result.value : null
		return {
			answer: result.status === 'ok' ? result.value.status : result.status,
			status: answered?.value ?? null,
			jobsPending: answered?.jobsPending ?? false,
			wrote: changes() - before,
		}
	})
}

// The accounts with ids `<digit>…` follow alice.
async function followAlice(store: StoreStub, digit: string): Promise<void> {
	await sql(
		store,
		`INSERT INTO follows (account_id, target_account_id, state)
		SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB ? || '*'`,
		ALICE,
		digit
	)
}

const undos = (store: StoreStub, uri: string) =>
	count(
		store,
		"SELECT 1 FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Undo'",
		uri
	)

// An API request as `as`, with a JSON body.
async function api(t: Setup, method: string, path: string, body?: unknown, as: As = 'alice') {
	const init = body === undefined ? { method } : json(body, { method })
	const response = await t.request(path, bearer(t.tokens[as], init))
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
		link: response.headers.get('link'),
	}
}

// `as`'s boost of `id` through the API: its id and uri.
async function boost(t: Setup, id: string, as: As = 'alice'): Promise<{ id: string; uri: string }> {
	const answer = await api(t, 'POST', `/api/v1/statuses/${id}/reblog`, undefined, as)
	expect(answer.status).toBe(200)
	return { id: answer.body.id as string, uri: answer.body.uri as string }
}

const row = (store: StoreStub, id: string) =>
	sql<{ withdrawn: number; visibility: string }>(store, 'SELECT withdrawn, visibility FROM statuses WHERE id = ?', id)

// dave's status, boosted by alice (the reblog notification to dave) and by dave himself (so its count outlives
// alice's boost), with five of alice's followers, the Announce's deliveries to them in flight, an inbox of an
// earlier Announce delivery in flight and `receipts` receipts of the boost.
async function boosted(t: Setup, receipts: number) {
	await remoteAccountsAt(t.store, '5', 'f', 5)
	await followAlice(t.store, '5')
	const original = await localStatus(t, { status: 'boost me' }, 'dave')
	await boost(t, original.id, 'dave')
	const b = await boost(t, original.id)
	await seedReceipts(t.store, b.id, ALICE, receipts)
	const [announce] = await sql<{ id: number }>(
		t.store,
		"SELECT id FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Announce'",
		b.uri
	)
	await sql(
		t.store,
		`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, lease_token)
		VALUES (?, ?, 'https://inflight.example/inbox', 'https://inflight.example', 'leased', 0, 0, 'held')`,
		announce!.id,
		ALICE
	)
	return { original, boost: b, announce: announce!.id }
}

describe('an unboost at every bound at once (RES-6)', () => {
	// The inputs at their cap: DELETE_SUPERSEDES + 1 earlier activities about the boost, the reblog notification with
	// MAX_PUSH_BACKLOG pushes, 256 accounts listening on `user` (the streaming capture's registry) who may view the
	// boost, receipts past what one staging call writes, and DELETE_SUPERSEDES - 1 retractions of the boost still
	// staging (an import's). The fill is three rows under the bound: the capture of a boost has no tombstone, and the
	// Announce in flight, the first of those superseded, keeps its row and has no staging.
	it.each(['unreblog', 'delete'] as const)(
		'by %s writes the request within BOOST_REQUEST_ROWS and the job within PURGE_BATCH, reaching every receiver',
		async (how) => {
			const t = await setup()
			const RECEIPTS = 50_000
			const { original, boost: b } = await boosted(t, RECEIPTS)
			// DELETE_SUPERSEDES - 1 retractions of it still staging, each with its staging (only an import holds them) and
			// no row, recorded before the Updates: the request supersedes them, three rows each
			// (outbound_activities_staging_ended).
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO outbound_activities (account_id, body, object_uri, retracts, staged, created_at)
				SELECT ?2, json_object('activity', json_object('type', 'Undo', 'id', 'x' || i), 'audience',
					json_object('followers', json('true'), 'accounts', json('[]'))), ?3, 1, '', 0 FROM n`,
				DELETE_SUPERSEDES - 1,
				ALICE,
				b.uri
			)
			await sql(
				t.store,
				`INSERT INTO retraction_stagings (activity_id, follow_bound, phase)
				SELECT id, 0, 'followers' FROM outbound_activities WHERE object_uri = ? AND retracts = 1 AND staged = ''`,
				b.uri
			)
			await sql(
				t.store,
				`UPDATE outbound_activities SET staged = (SELECT CAST(h.id AS TEXT) FROM retraction_stagings h
					WHERE h.activity_id = outbound_activities.id) WHERE object_uri = ? AND retracts = 1 AND staged = ''`,
				b.uri
			)
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
				SELECT ?2, json_object('activity', json_object('type', 'Update', 'id', 'u' || i), 'audience',
					json_object('followers', json('true'), 'accounts', json('[]'))), ?3, 0 FROM n`,
				DELETE_SUPERSEDES + 1,
				ALICE,
				b.uri
			)
			const [notification] = await sql<{ id: number }>(
				t.store,
				"SELECT id FROM notifications WHERE account_id = ? AND type = 'reblog' AND from_account_id = ?",
				DAVE,
				ALICE
			)
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
				SELECT 'push-' || i, 'access', (SELECT client_id FROM oauth_tokens LIMIT 1), ?2, 'push' FROM n`,
				MAX_PUSH_BACKLOG,
				DAVE
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
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 256)
				INSERT INTO stream_subscriptions (account_id, stream_key, sockets) SELECT printf('9%017d', i), 'user', 1 FROM n`
			)
			// The inboxes the Announce went or may go to, in every state, before the request supersedes it.
			const earlier = await sql<{ inbox: string }>(
				t.store,
				`SELECT DISTINCT d.inbox_url AS inbox FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id
				WHERE o.object_uri = ? AND o.retracts = 0`,
				b.uri
			)
			expect(earlier.map((r) => r.inbox)).toContain('https://inflight.example/inbox')

			const result = await unboosted(t, how, how === 'unreblog' ? original.id : b.id)
			expect([result.answer, result.jobsPending]).toEqual(['ok', true])
			expect(result.wrote).toBeLessThanOrEqual(BOOST_REQUEST_ROWS)
			console.info({ event: 'unboost.request', how, wrote: result.wrote, bound: BOOST_REQUEST_ROWS })
			if (how === 'unreblog') {
				expect(result.status).toMatchObject({ id: original.id, reblogged: false, reblogs_count: 1 })
			} else {
				expect(result.status).toMatchObject({ id: b.id, reblog: { id: original.id } })
			}
			// Hidden at once, its receipts all kept, its Undo an intent alone, and its notification and pushes gone.
			expect(await row(t.store, b.id)).toEqual([{ withdrawn: 1, visibility: 'direct' }])
			expect(await count(t.store, 'SELECT 1 FROM outbound_receipts WHERE status_id = ?', b.id)).toBe(RECEIPTS)
			const intent = () =>
				sql<{ id: number; staged: string | null }>(
					t.store,
					"SELECT id, staged FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Undo'",
					b.uri
				)
			const [undo] = await intent()
			expect(undo!.staged).toBe('')
			expect(await count(t.store, 'SELECT 1 FROM outbound_targets WHERE activity_id = ?', undo!.id)).toBe(0)
			expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE kind = 'delete' AND key = ?", b.id)).toBe(1)
			expect(await count(t.store, 'SELECT 1 FROM notifications WHERE id = ?', notification!.id)).toBe(0)
			expect(await count(t.store, 'SELECT 1 FROM push_deliveries')).toBe(0)
			expect(await sql(t.store, 'SELECT reblogs_count FROM statuses WHERE id = ?', original.id)).toEqual([
				{ reblogs_count: 1 },
			])

			// The job: each batch within PURGE_BATCH; staged over more than one call; the receipts deleted only once it is
			// staged, over many batches.
			let staging = 0
			const receipts: number[] = []
			const taken = await batches(t.store, b.id, async () => {
				const [now] = await intent()
				const left = await count(t.store, 'SELECT 1 FROM outbound_receipts WHERE status_id = ?', b.id)
				if (now !== undefined && now.staged !== null && now.staged !== '') {
					staging++
				}
				if (left < RECEIPTS) {
					expect(now?.staged ?? null, 'the receipts go only after the Undo is staged').toBeNull()
				}
				receipts.push(left)
			})
			console.info({ event: 'unboost.batches', how, batches: taken })
			expect(staging).toBeGreaterThan(0)
			expect(new Set(receipts.filter((n) => n > 0 && n < RECEIPTS)).size).toBeGreaterThan(1)
			expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', b.id)).toBe(0)
			expect(await count(t.store, 'SELECT 1 FROM outbound_receipts')).toBe(0)
			expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE kind = 'delete' AND done_at IS NULL")).toBe(0)
			// The job's recount agrees with the request's decrement.
			expect(await sql(t.store, 'SELECT reblogs_count FROM statuses WHERE id = ?', original.id)).toEqual([
				{ reblogs_count: 1 },
			])
			// The Undo reaches every receipt, the followers and every inbox the Announce went or may go to.
			const expected = new Set([
				...Array.from({ length: RECEIPTS }, (_, i) => `https://r${i + 1}.example/inbox`),
				...Array.from({ length: 5 }, (_, i) => `https://f${i + 1}.example/inbox`),
				...earlier.map((r) => r.inbox),
			])
			const targets = await retractionInboxes(t.store, b.uri, 'Undo')
			expect([...expected].filter((inbox) => !targets.has(inbox))).toEqual([])
			expect([...targets].filter((inbox) => !expected.has(inbox))).toEqual([])
			expect(await undos(t.store, b.uri)).toBe(1)
		},
		300_000
	)
})

describe('a boost again after an unboost, before its job (ID-7)', () => {
	it('keeps the new boost, refuses the old id, and the job removes the old one alone', async () => {
		const t = await setup()
		await remoteAccountsAt(t.store, '5', 'f', 2)
		await followAlice(t.store, '5')
		const original = await localStatus(t, { status: 'boost me again' }, 'dave')
		const b1 = await boost(t, original.id)
		await seedReceipts(t.store, b1.id, ALICE, 3)
		const unboost = await api(t, 'POST', `/api/v1/statuses/${original.id}/unreblog`)
		expect(unboost.body).toMatchObject({ reblogged: false, reblogs_count: 0 })
		// Its job is asked for.
		expect(t.send).toHaveBeenCalledWith({ kind: 'inbound-jobs' }, {})
		const again = await api(t, 'POST', `/api/v1/statuses/${original.id}/reblog`)
		expect(again.status).toBe(200)
		const b2 = { id: again.body.id as string, uri: again.body.uri as string }
		expect(b2.id).not.toBe(b1.id)
		expect(again.body).toMatchObject({ reblog: { id: original.id, reblogged: true, reblogs_count: 1 } })
		expect(await sql(t.store, 'SELECT id FROM statuses WHERE reblog_of_id = ? AND withdrawn = 0', original.id)).toEqual(
			[{ id: b2.id }]
		)
		const listed = await api(t, 'GET', `/api/v1/statuses/${original.id}/reblogged_by`, undefined, 'dave')
		expect((listed.body as unknown as { id: string }[]).map((a) => a.id)).toEqual([ALICE])
		await sql(
			t.store,
			"INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, 'https://k1.example/inbox', ?, 0)",
			b2.id,
			ALICE
		)
		// The old id is withdrawn, its row kept: a retry by it, and its DELETE, are not found and write nothing.
		expect(await row(t.store, b1.id)).toEqual([{ withdrawn: 1, visibility: 'direct' }])
		for (const how of ['unreblog', 'delete'] as const) {
			const retry = await unboosted(t, how, b1.id)
			expect([how, retry.answer, retry.wrote]).toEqual([how, 'not_found', 0])
		}
		expect((await api(t, 'POST', `/api/v1/statuses/${b1.id}/unreblog`)).status).toBe(404)
		expect(await row(t.store, b2.id)).toEqual([{ withdrawn: 0, visibility: 'public' }])
		expect(await undos(t.store, b2.uri)).toBe(0)
		// A second kept boost of the pair is refused by the schema.
		await expect(
			sql(
				t.store,
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
				VALUES ('999999999999999999', 'https://kopje.test/ap/o/third', ?, ?, 'public', '2026-10-12T00:00:00.000Z')`,
				ALICE,
				original.id
			)
		).rejects.toThrow(/UNIQUE/)

		await settleDeliveries(t.store)
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', b1.id)).toBe(0)
		expect(await count(t.store, 'SELECT 1 FROM outbound_receipts WHERE status_id = ?', b1.id)).toBe(0)
		expect(await count(t.store, 'SELECT 1 FROM outbound_receipts WHERE status_id = ?', b2.id)).toBe(1)
		expect(
			await sql(
				t.store,
				"SELECT superseded FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Announce'",
				b2.uri
			)
		).toEqual([{ superseded: 0 }])
		expect(await undos(t.store, b2.uri)).toBe(0)
		const undone = await retractionInboxes(t.store, b1.uri, 'Undo')
		expect([...undone].sort()).toEqual([
			'https://f1.example/inbox',
			'https://f2.example/inbox',
			'https://r1.example/inbox',
			'https://r2.example/inbox',
			'https://r3.example/inbox',
		])
		// Accepted (docs/threat-model.md, the re-boost ordering race): in a follower's lane the old boost's Undo, staged
		// by its job, comes after the new boost's Announce, as Mastodon's RemovalWorker may run after its
		// DistributionWorker.
		const lane = await sql<{ type: string; object: string }>(
			t.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type, o.object_uri AS object FROM deliveries d
			JOIN outbound_activities o ON o.id = d.activity_id WHERE d.inbox_url = 'https://f1.example/inbox' ORDER BY d.id`
		)
		expect(lane.slice(-2)).toEqual([
			{ type: 'Announce', object: b2.uri },
			{ type: 'Undo', object: b1.uri },
		])
	})

	// An action through a withdrawn boost's id is not found (Mastodon's kept scope), and the original keeps what
	// the viewer did to it.
	it('answers an unfavourite and an unbookmark through a withdrawn boost id 404, the original’s kept', async () => {
		const t = await setup()
		const original = await localStatus(t, { status: 'favourite me' }, 'dave')
		const b = await boost(t, original.id)
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/favourite`)).status).toBe(200)
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/bookmark`)).status).toBe(200)
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/unreblog`)).status).toBe(200)
		expect(await row(t.store, b.id)).toEqual([{ withdrawn: 1, visibility: 'direct' }])
		expect((await api(t, 'POST', `/api/v1/statuses/${b.id}/unfavourite`)).status).toBe(404)
		expect((await api(t, 'POST', `/api/v1/statuses/${b.id}/unbookmark`)).status).toBe(404)
		expect(await count(t.store, 'SELECT 1 FROM favourites WHERE status_id = ?', original.id)).toBe(1)
		expect(await count(t.store, 'SELECT 1 FROM bookmarks WHERE status_id = ?', original.id)).toBe(1)
		// By the original's id they apply.
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/unfavourite`)).status).toBe(200)
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/unbookmark`)).status).toBe(200)
		expect(await count(t.store, 'SELECT 1 FROM favourites UNION ALL SELECT 1 FROM bookmarks')).toBe(0)
	})
})

describe('concurrent unboosts (ID-7)', () => {
	it('records one Undo when an unboost meets its job staged in part', async () => {
		const t = await setup()
		const original = await localStatus(t, { status: 'staged in part' }, 'dave')
		const b = await boost(t, original.id)
		await seedReceipts(t.store, b.id, ALICE, PURGE_BATCH * TARGET_CHUNK_SIZE + 1)
		expect((await unboosted(t, 'unreblog', original.id)).answer).toBe('ok')
		await batch(t.store, b.id)
		const [intent] = await sql<{ staged: string | null }>(
			t.store,
			"SELECT staged FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Undo'",
			b.uri
		)
		expect(intent!.staged).not.toBe('')
		expect(intent!.staged).not.toBeNull()
		// Between the job's batches: a second unreblog answers the original without the boost and writes nothing; the
		// boost's DELETE is not found.
		const second = await unboosted(t, 'unreblog', original.id)
		expect([second.answer, second.wrote, second.jobsPending]).toEqual(['ok', 0, false])
		expect(second.status).toMatchObject({ reblogged: false, reblogs_count: 0 })
		expect((await unboosted(t, 'delete', b.id)).answer).toBe('not_found')
		expect(await undos(t.store, b.uri)).toBe(1)
		await batches(t.store, b.id)
		expect(await undos(t.store, b.uri)).toBe(1)
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', b.id)).toBe(0)
	})

	it('records one Undo for two Worker unreblogs, the first held at its Store call while the second commits', async () => {
		const t = await setup()
		const original = await localStatus(t, { status: 'twice' }, 'dave')
		const b = await boost(t, original.id)
		const reached = deferred()
		const release = deferred()
		let held = false
		const store = new Proxy(t.store, {
			get: (target, name) =>
				name === 'unreblog'
					? async (...args: Parameters<StoreStub['unreblog']>) => {
							if (!held) {
								held = true
								reached.resolve()
								await release.promise
							}
							return target.unreblog(...args)
						}
					: (Reflect.get(target, name) as unknown),
		})
		const h = harness(store)
		const request = () =>
			h.request(`/api/v1/statuses/${original.id}/unreblog`, bearer(t.tokens.alice, { method: 'POST' }))
		const first = request()
		// The held request is released and settled whatever an assertion does, so nothing of it outlives the test.
		let late: Response
		try {
			await reached.promise
			const second = await request()
			expect(second.status).toBe(200)
			expect(await row(t.store, b.id)).toEqual([{ withdrawn: 1, visibility: 'direct' }])
		} finally {
			release.resolve()
			late = await first
		}
		expect(late.status).toBe(200)
		expect(await late.json()).toMatchObject({ reblogged: false, reblogs_count: 0 })
		expect(await undos(t.store, b.uri)).toBe(1)
		expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE kind = 'delete' AND key = ?", b.id)).toBe(1)
		// The late one found no kept boost: it asked for no job round.
		const rings = h.send.mock.calls.filter(([body]) => (body as { kind?: string }).kind === 'inbound-jobs')
		expect(rings).toHaveLength(1)
	})
})

describe('the original removed after an unboost, before its job (ID-7, VIS-3)', () => {
	// Either job may reach the withdrawn boost first: the boost's own, or its original's (withdrawLocalBoosts, which
	// finds the Undo recorded and continues its staging). The removed original is never recounted.
	it.each(['boost first', 'original first'] as const)(
		'records and stages one Undo and deletes the boost once, local DELETE, %s',
		async (order) => {
			const t = await setup()
			await remoteAccountsAt(t.store, '5', 'f', 2)
			await followAlice(t.store, '5')
			const original = await localStatus(t, { status: 'removed after' }, 'dave')
			const b = await boost(t, original.id)
			await seedReceipts(t.store, b.id, ALICE, PURGE_BATCH * TARGET_CHUNK_SIZE + 1)
			expect((await unboosted(t, 'unreblog', original.id)).answer).toBe('ok')
			expect((await api(t, 'DELETE', `/api/v1/statuses/${original.id}`, undefined, 'dave')).status).toBe(200)
			// A count no recount would leave.
			await sql(t.store, 'UPDATE statuses SET reblogs_count = 77 WHERE id = ?', original.id)
			if (order === 'boost first') {
				await batches(t.store, b.id)
				expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', b.id)).toBe(0)
				expect(await sql(t.store, 'SELECT reblogs_count FROM statuses WHERE id = ?', original.id)).toEqual([
					{ reblogs_count: 77 },
				])
				await batches(t.store, original.id)
			} else {
				await batches(t.store, original.id)
				expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', b.id)).toBe(0)
				// The boost's own job finds it gone, and ends.
				expect(await batch(t.store, b.id)).toEqual({ wrote: 1, more: false })
			}
			expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id IN (?, ?)', b.id, original.id)).toBe(0)
			expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE kind = 'delete' AND done_at IS NULL")).toBe(0)
			expect(await undos(t.store, b.uri)).toBe(1)
			await settleDeliveries(t.store)
			// Staged once: every target once, the receipts and the followers.
			const [rows] = await sql<{ n: number; inboxes: number }>(
				t.store,
				`SELECT count(*) AS n, count(DISTINCT d.inbox_url) AS inboxes FROM outbound_activities o
				JOIN deliveries d ON d.activity_id = o.id
				WHERE o.object_uri = ? AND json_extract(o.body, '$.activity.type') = 'Undo'`,
				b.uri
			)
			expect(rows).toEqual({
				n: PURGE_BATCH * TARGET_CHUNK_SIZE + 1 + 2,
				inboxes: PURGE_BATCH * TARGET_CHUNK_SIZE + 1 + 2,
			})
		},
		120_000
	)

	it('records one Undo when the remote original is deleted after the unboost', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const original = (await statusRow(t.store, note.id))!.id
		const b = await boost(t, original)
		await seedReceipts(t.store, b.id, ALICE, 3)
		expect((await unboosted(t, 'unreblog', original)).answer).toBe('ok')
		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		await settle(t.store)
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id IN (?, ?)', b.id, original)).toBe(0)
		expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE kind = 'delete' AND done_at IS NULL")).toBe(0)
		expect(await undos(t.store, b.uri)).toBe(1)
		await settleDeliveries(t.store)
		expect([...(await retractionInboxes(t.store, b.uri, 'Undo'))].sort()).toEqual([
			`${MASTODON}/inbox`,
			'https://r1.example/inbox',
			'https://r2.example/inbox',
			'https://r3.example/inbox',
		])
	})
})

const AP = { headers: { accept: 'application/activity+json' } }

describe('a withdrawn boost before its job (VIS-1, R2)', () => {
	it('is gone from every read: by id, feeds, the boosters list, the outbox and the last status', async () => {
		const t = await setup()
		const earlier = await localStatus(t, { status: 'earlier' })
		const original = await localStatus(t, { status: 'shown' }, 'dave')
		const b = await boost(t, original.id)
		await sql(t.store, "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", DAVE)
		const reads = async () => {
			const home = await api(t, 'GET', '/api/v1/timelines/home')
			const profile = await api(t, 'GET', `/api/v1/accounts/${ALICE}/statuses`, undefined, 'dave')
			const boosters = await api(t, 'GET', `/api/v1/statuses/${original.id}/reblogged_by?limit=1`, undefined, 'dave')
			const outbox = (await (await t.request('/ap/users/alice/outbox', AP)).json()) as {
				totalItems: number
				first: string
			}
			const first = new URL(outbox.first)
			const page = (await (await t.request(`${first.pathname}${first.search}`, AP)).json()) as {
				orderedItems: { type: string }[]
			}
			const [last] = await sql<{ id: string | null }>(
				t.store,
				'SELECT last_status_id AS id FROM accounts WHERE id = ?',
				ALICE
			)
			return {
				shown: [
					(await api(t, 'GET', `/api/v1/statuses/${b.id}`)).status,
					(await api(t, 'GET', `/api/v1/statuses/${b.id}`, undefined, 'dave')).status,
				],
				home: (home.body as unknown as { id: string }[]).map((s) => s.id),
				profile: (profile.body as unknown as { id: string }[]).map((s) => s.id),
				boosters: (boosters.body as unknown as { id: string }[]).map((a) => a.id),
				boostersLink: (boosters.link ?? '').includes(b.id),
				outbox: [outbox.totalItems, page.orderedItems.map((item) => item.type)],
				last: last!.id,
			}
		}
		expect(await reads()).toEqual({
			shown: [200, 200],
			home: [b.id, earlier.id],
			profile: [b.id, earlier.id],
			boosters: [ALICE],
			boostersLink: true,
			outbox: [2, ['Announce', 'Create']],
			last: b.id,
		})
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/unreblog`)).status).toBe(200)
		expect(await row(t.store, b.id)).toEqual([{ withdrawn: 1, visibility: 'direct' }])
		expect(await reads()).toEqual({
			shown: [404, 404],
			home: [earlier.id],
			profile: [earlier.id],
			boosters: [],
			boostersLink: false,
			outbox: [1, ['Create']],
			last: earlier.id,
		})
		// R32: its streaming delete was captured for the listener who could see it.
		expect(
			await sql(
				t.store,
				`SELECT v.account_id FROM stream_events e JOIN stream_delete_viewers v ON v.event_id = e.id
				WHERE e.kind = 'delete' AND e.subject = ?`,
				b.id
			)
		).toEqual([{ account_id: DAVE }])
	})

	// Mastodon notifies the local accounts whose kept boost names an edited status (UpdateStatusService), so the
	// booster of a withdrawn boost hears of no edit, and a booster with a kept boost besides a withdrawn one hears once.
	it('notifies of an edit, local and remote, the kept booster once and the withdrawn one not at all', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const updates = (status: string) =>
			count(
				t.store,
				"SELECT 1 FROM notifications WHERE account_id = ? AND type = 'update' AND status_id = ?",
				ALICE,
				status
			)
		// Withdrawn only, and withdrawn with a kept boost after it.
		const local = [
			await localStatus(t, { status: 'withdrawn only' }, 'dave'),
			await localStatus(t, { status: 'boosted again' }, 'dave'),
		]
		const notes = [mastodonNote(bob), mastodonNote(bob)]
		const remote: string[] = []
		for (const note of notes) {
			expect(await t.post(bob, create(bob, note))).toBe(202)
			remote.push((await statusRow(t.store, note.id))!.id)
		}
		for (const [i, id] of [local[0]!.id, local[1]!.id, remote[0]!, remote[1]!].entries()) {
			await boost(t, id)
			expect((await api(t, 'POST', `/api/v1/statuses/${id}/unreblog`)).status).toBe(200)
			if (i % 2 === 1) {
				await boost(t, id)
			}
		}
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE account_id = ? AND withdrawn = 1', ALICE)).toBe(4)
		for (const status of local) {
			expect((await api(t, 'PUT', `/api/v1/statuses/${status.id}`, { status: 'edited' }, 'dave')).status).toBe(200)
		}
		for (const note of notes) {
			const edited = { ...note, content: '<p>edited</p>', contentMap: { en: '<p>edited</p>' } }
			expect(await t.post(bob, update(bob, edited, '2026-10-11T12:30:00Z'))).toBe(202)
		}
		expect([
			await updates(local[0]!.id),
			await updates(local[1]!.id),
			await updates(remote[0]!),
			await updates(remote[1]!),
		]).toEqual([0, 1, 0, 1])
	})

	// The library's boosted originals are read through the kept boosts: withdrawn generations newer than a kept boost,
	// past LIBRARY_SOURCE_LIMIT, leave its original a candidate.
	it('keeps an older kept boost a search candidate past LIBRARY_SOURCE_LIMIT withdrawn boosts', async () => {
		const t = await setup()
		const needle = await localStatus(t, { status: 'needle in the library' }, 'dave')
		await boost(t, needle.id)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, search_text)
			SELECT printf('9%017d', i), 'https://kopje.test/ap/o/h' || i, ?2, 'public', '', '2026-10-12T00:00:00.000Z', 'hay'
			FROM n`,
			LIBRARY_SOURCE_LIMIT + 1,
			DAVE
		)
		await sql(
			t.store,
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, withdrawn)
			SELECT '8' || substr(id, 2), uri || '/boost', ?, id, 'direct', '2026-10-12T00:00:00.000Z', 1
			FROM statuses WHERE id GLOB '9*'`,
			ALICE
		)
		expect(
			await count(
				t.store,
				'SELECT 1 FROM statuses WHERE account_id = ? AND withdrawn = 1 AND reblog_of_id > ?',
				ALICE,
				needle.id
			)
		).toBe(LIBRARY_SOURCE_LIMIT + 1)
		// Only the boost makes it alice's: it is no status of hers, favourite, bookmark or mention.
		const found = await api(t, 'GET', '/api/v2/search?q=needle&type=statuses')
		expect((found.body.statuses as { id: string }[]).map((s) => s.id)).toEqual([needle.id])
	})
})

describe('the counts of an unboost (RES-6)', () => {
	it('keeps reblogs_count lowered through a recount before its job, and statuses_count what a recount gives', async () => {
		const t = await setup()
		const original = await localStatus(t, { status: 'counted' }, 'dave')
		await boost(t, original.id, 'dave')
		const b = await boost(t, original.id)
		const counts = async () => ({
			reblogs: (
				await sql<{ n: number }>(t.store, 'SELECT reblogs_count AS n FROM statuses WHERE id = ?', original.id)
			)[0]!.n,
			statuses: (await sql<{ n: number }>(t.store, 'SELECT statuses_count AS n FROM accounts WHERE id = ?', ALICE))[0]!
				.n,
		})
		expect(await counts()).toEqual({ reblogs: 2, statuses: 1 })
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/unreblog`)).status).toBe(200)
		expect(await counts()).toEqual({ reblogs: 1, statuses: 0 })
		// A favourite of the original recounts it (recountStatus) while the boost is withdrawn.
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/favourite`, undefined, 'dave')).status).toBe(200)
		expect(await sql(t.store, 'SELECT favourites_count FROM statuses WHERE id = ?', original.id)).toEqual([
			{ favourites_count: 1 },
		])
		expect(await counts()).toEqual({ reblogs: 1, statuses: 0 })
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', b.id)).toBe(1)
		await settle(t.store)
		expect(await count(t.store, 'SELECT 1 FROM statuses WHERE id = ?', b.id)).toBe(0)
		expect(await counts()).toEqual({ reblogs: 1, statuses: 0 })
		const [recounted] = await sql<{ n: number }>(
			t.store,
			`SELECT count(*) AS n FROM statuses WHERE account_id = ? AND visibility IN ('public', 'unlisted', 'private')`,
			ALICE
		)
		expect(recounted!.n).toBe(0)
	})
})

describe('who the Undo reaches (VIS-3)', () => {
	// The Undo's targets are read when its job stages it: a follower who joined after the Announce's fan-out and left
	// before the staging, with no surviving delivery evidence, is not reached (an accepted gap, as for a local
	// status's Delete); one who stays is, and so is an inbox with a receipt or a retained given-up row.
	it('reaches the followers at staging, the receipts and the given-up rows, not a follower gone without evidence', async () => {
		const t = await setup()
		// One follower at the fan-out, the others after it.
		await remoteAccountsAt(t.store, '4', 'z', 1)
		await followAlice(t.store, '4')
		const original = await localStatus(t, { status: 'churn' }, 'dave')
		const b = await boost(t, original.id)
		expect(await sql(t.store, 'SELECT inbox_url FROM deliveries')).toEqual([{ inbox_url: 'https://z1.example/inbox' }])
		const [left, stays, received] = await remoteAccountsAt(t.store, '5', 'c', 3)
		await followAlice(t.store, '5')
		await sql(
			t.store,
			"INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, 'https://c3.example/inbox', ?, 0)",
			b.id,
			ALICE
		)
		const [announce] = await sql<{ id: number }>(
			t.store,
			"SELECT id FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Announce'",
			b.uri
		)
		await sql(
			t.store,
			`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			VALUES (?, ?, 'https://given-up.example/inbox', 'https://given-up.example', 'gave_up', 0, 0)`,
			announce!.id,
			ALICE
		)
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/unreblog`)).status).toBe(200)
		await sql(t.store, 'DELETE FROM follows WHERE account_id IN (?, ?)', left!, received!)
		expect(stays).toBeDefined()
		await settleDeliveries(t.store)
		expect([...(await retractionInboxes(t.store, b.uri, 'Undo'))].sort()).toEqual([
			'https://c2.example/inbox',
			'https://c3.example/inbox',
			'https://given-up.example/inbox',
			'https://z1.example/inbox',
		])
	})

	// Through the real delivery rounds: in each lane the Announce, pending or leased by a claim whose completion is lost
	// (its row leased until its lease ends), is sent before the Undo; one already delivered gets the Undo alone, and so
	// does one whose Announce was given up, its row kept as evidence.
	it('sends the Undo in each lane after the Announce, pending or leased, and alone after a delivered or given-up one', async () => {
		const t = await setup()
		await remoteAccountsAt(t.store, '5', 'f', 4)
		await followAlice(t.store, '5')
		const original = await localStatus(t, { status: 'order' }, 'dave')
		await boost(t, original.id)
		const claim = (leaseToken: string) =>
			runInDurableObject(t.store, (_instance, state) =>
				claimDeliveries.run(state.storage.sql, { now: NOW, leaseToken, limit: 1 })
			)
		const lost = (await claim('lost')).deliveries[0]!
		const done = (await claim('done')).deliveries[0]!
		expect(
			await runInDurableObject(t.store, (_instance, state) =>
				completeDelivery.run(state.storage.sql, {
					id: done.id,
					leaseToken: 'done',
					now: NOW,
					outcome: { kind: 'delivered', status: 202 },
				})
			)
		).toMatchObject({ status: 'delivered' })
		const [given] = await sql<{ inbox: string }>(
			t.store,
			`UPDATE deliveries SET state = 'gave_up' WHERE id = (SELECT min(id) FROM deliveries WHERE state = 'pending')
			RETURNING inbox_url AS inbox`
		)
		expect((await api(t, 'POST', `/api/v1/statuses/${original.id}/unreblog`)).status).toBe(200)
		await settle(t.store)
		// The delivery rounds' order, as sent: each claim, its rows confirmed, each delivered; the lost lease ends first.
		const sent = new Map<string, string[]>()
		for (let round = 0, now = NOW + 120_000; round < 50; round++) {
			const leaseToken = `round-${round}`
			const claimed = await t.store.claimDeliveries(BUILD, { now, leaseToken })
			if (claimed.deliveries.length === 0) {
				break
			}
			for (const delivery of claimed.deliveries) {
				const confirmed = await t.store.confirmDelivery(BUILD, { id: delivery.id, leaseToken, now })
				expect(confirmed.status).toBe('send')
				const type = (JSON.parse((confirmed as { body: string }).body) as { type: string }).type
				sent.set(delivery.inbox, [...(sent.get(delivery.inbox) ?? []), type])
				await t.store.completeDelivery(BUILD, {
					id: delivery.id,
					leaseToken,
					now,
					outcome: { kind: 'delivered', status: 202 },
				})
			}
		}
		const alone = new Set([done.inbox, given!.inbox])
		expect(Object.fromEntries(sent)).toEqual(
			Object.fromEntries(
				Array.from({ length: 4 }, (_, i) => `https://f${i + 1}.example/inbox`).map((inbox) => [
					inbox,
					alone.has(inbox) ? ['Undo'] : ['Announce', 'Undo'],
				])
			)
		)
		expect(alone.has(lost.inbox)).toBe(false)
	})
})

// Grows the Store after ANALYZE around dave's original `id` and alice's withdrawn generations of her boost of it:
// `boosts` remote boosts of it (each booster's reblog notification to dave), `generations` withdrawn boosts of it by
// alice, 20,000 statuses of another account and 20,000 pushes of another notification.
async function grow(t: Setup, id: string, digit: string, boosts: number, generations: number) {
	await remoteAccountsAt(t.store, digit, `g${digit}x`, boosts)
	await sql(
		t.store,
		`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
		SELECT '4' || substr(id, 2), uri || '/boost/' || ?2, id, ?2, 'public', '2026-10-12T00:00:00.000Z'
		FROM accounts WHERE id GLOB ?1 || '*'`,
		digit,
		id
	)
	await sql(
		t.store,
		`INSERT INTO notifications (account_id, type, from_account_id, status_id)
		SELECT ?3, 'reblog', id, ?2 FROM accounts WHERE id GLOB ?1 || '*'`,
		digit,
		id,
		DAVE
	)

	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, withdrawn)
		SELECT ?2 || printf('%016d', i), 'https://kopje.test/ap/o/gen' || ?2 || '-' || i, ?3, ?4, 'direct',
			'2026-10-12T00:00:00.000Z', 1 FROM n`,
		generations,
		`3${digit}`,
		ALICE,
		id
	)
}

async function growOthers(t: Setup) {
	const [other] = await remoteAccountsAt(t.store, '2', 'o', 1)
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT printf('7%017d', i), 'https://o.example/s/' || i, ?, 'public', '', '2026-10-12T00:00:00.000Z' FROM n`,
		other!
	)
	await sql(
		t.store,
		"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)",
		DAVE,
		other!
	)
	const [held] = await sql<{ id: number }>(t.store, "SELECT id FROM notifications WHERE type = 'follow'")
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
		INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
		SELECT 'grown-' || i, 'access', (SELECT client_id FROM oauth_tokens LIMIT 1), ?, 'push' FROM n`,
		DAVE
	)
	await sql(
		t.store,
		`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
		SELECT token_hash, 'https://push.example/' || token_hash, 'k', 'a' FROM oauth_tokens WHERE token_hash GLOB 'grown-*'`
	)
	await sql(
		t.store,
		`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
		SELECT id, ?, 0, 0 FROM push_subscriptions WHERE token_hash GLOB 'grown-*'`,
		held!.id
	)
	// The streaming journal, which the inserts filled, as its fan-out would have left it.
	await sql(t.store, 'DELETE FROM stream_events')
}

// The statements this change adds or changes, and the names their plans give the large tables they read (statuses,
// accounts, notifications, pushes): none may be scanned. The local accounts are walked by design (the edit's boosters,
// one seek each), and so are a compound subquery's own rows (deleteAudience's `b`, a window already bounded).
const CHANGED =
	/statuses_account_reblogs_kept|statuses_reblog\b|notifications_natural|push_deliveries WHERE notification_id|IFNULL\(reblog_of_id, id\)|NOT \(o\.withdrawn/
const LARGE = ['statuses', 'r', 'o', 's', 'accounts', 'a', 'notifications', 'push_deliveries']

describe('an unboost’s reads under stale statistics (RES-7)', () => {
	it('reads no more in the request past its pair’s withdrawn generations, its original’s boosts and the Store', async () => {
		const t = await setup()
		const credentials = await credential(t)
		const measure = async (digit: string, grown: boolean) => {
			const original = await localStatus(t, { status: `measured ${digit}` }, 'dave')
			if (grown) {
				await grow(t, original.id, digit, 3000, 1000)
			}
			await boost(t, original.id)
			return rowsRead(t, unreblog, { credential: credentials, id: original.id, now: NOW, present: PRESENT })
		}
		const { before, after } = await staleStatistics(t, {
			capture: (phase) => measure(phase === 'before' ? '5' : '6', phase === 'after'),
			grow: () => growOthers(t),
		})
		console.info({ event: 'unboost.stale-statistics', before, after })
		expect(after).toBeLessThanOrEqual(before + 20)
	}, 120_000)

	it('plans every statement of the request, the reads and the job without a scan of a large table', async () => {
		const t = await setup()
		const original = await localStatus(t, { status: 'planned needle' }, 'dave')
		await sql(t.store, "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", DAVE)
		await boost(t, original.id)
		await sql(t.store, 'ANALYZE')
		await grow(t, original.id, '6', 2500, 1000)
		await growOthers(t)
		const write = await credential(t)
		const read = { tokenHash: write.tokenHash, scope: 'read' as const, now: NOW }
		const dave = await credential(t, 'dave')
		const scans: string[] = []
		const seen = new Map<string, string[]>()
		const planned = async <I>(name: string, operation: { run: (sql: SqlStorage, input: I) => unknown }, input: I) =>
			runInDurableObject(t.store, (_instance, state) => {
				const plans: PlannedStatement[] = []
				state.storage.transactionSync(() => operation.run(plannedSql(state.storage.sql, CHANGED, plans), input))
				for (const { query, plan } of plans) {
					const flat = query.replace(/\s+/g, ' ')
					seen.set(flat, plan)
					for (const detail of scansOf(plan, LARGE)) {
						scans.push(`${name}: ${detail} :: ${flat.slice(0, 120)}`)
					}
				}
			})
		await planned('unreblog', unreblog, { credential: write, id: original.id, now: NOW, present: PRESENT })
		const [b] = await sql<{ id: string }>(
			t.store,
			"SELECT id FROM statuses WHERE account_id = ? AND reblog_of_id = ? AND withdrawn = 1 AND id NOT GLOB '36*'",
			ALICE,
			original.id
		)
		await planned('reblog', reblog, {
			credential: write,
			id: original.id,
			objectId: 'planned-again',
			now: NOW,
			present: PRESENT,
		})
		await planned('getStatus', getStatus, { credential: read, id: original.id, now: NOW, present: PRESENT })
		await planned('search', search, {
			credential: read,
			query: 'needle',
			types: ['statuses'],
			limit: 20,
			offset: 0,
			following: false,
			localDomain: 'kopje.test',
			present: PRESENT,
		})
		await planned('editStatus', editStatus, {
			credential: dave,
			id: original.id,
			text: 'planned needle edited',
			spoilerText: '',
			mediaIds: [],
			mediaAttributes: [],
			now: NOW,
			present: PRESENT,
		})
		await planned('job', { run: (sql: SqlStorage, id: string) => deleteStatusBatch(new Db(sql), id, NOW) }, b!.id)
		// The original's DELETE captures its streaming delete for dave, who listens, over more than CAPTURE_BOOST_SCAN
		// boosts of it (deleteAudience's walk of his follows).
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE id GLOB '6*' LIMIT 3",
			DAVE
		)
		await planned('delete', deleteStatus, {
			credential: dave,
			id: original.id,
			deleteMedia: false,
			now: NOW,
			present: PRESENT,
		})
		expect(scans).toEqual([])
		const planOf = (fragment: string) => [...seen].find(([query]) => query.includes(fragment))?.[1].join(' | ') ?? ''
		expect(planOf('INDEXED BY notifications_natural')).toContain(
			'notifications_natural (account_id=? AND type=? AND from_account_id=? AND <expr>=? AND <expr>=? AND <expr>=?)'
		)
		expect(planOf('DELETE FROM push_deliveries WHERE notification_id')).toContain(
			'push_deliveries_notification (notification_id=?)'
		)
		for (const kept of [
			'SELECT id FROM statuses INDEXED BY statuses_account_reblogs_kept',
			"SELECT 'r', reblog_of_id FROM statuses INDEXED BY statuses_account_reblogs_kept",
			'SELECT l.account_id FROM local_accounts l CROSS JOIN statuses r INDEXED BY statuses_account_reblogs_kept',
			'UNION SELECT r.id FROM main.follows f CROSS JOIN main.statuses r INDEXED BY statuses_account_reblogs_kept',
		]) {
			expect(planOf(kept), kept).toContain('statuses_account_reblogs_kept (account_id=? AND reblog_of_id=?)')
		}
		expect(planOf('SELECT reblog_of_id AS id FROM statuses INDEXED BY statuses_account_reblogs_kept')).toContain(
			'statuses_account_reblogs_kept (account_id=?'
		)
		// Each statement the witness names was planned.
		for (const fragment of [
			'INDEXED BY notifications_natural',
			'DELETE FROM push_deliveries WHERE notification_id',
			'IFNULL(reblog_of_id, id)',
			"SELECT 'r', reblog_of_id FROM statuses INDEXED BY statuses_account_reblogs_kept",
			'SELECT id FROM statuses INDEXED BY statuses_account_reblogs_kept',
			'SELECT reblog_of_id AS id FROM statuses INDEXED BY statuses_account_reblogs_kept',
			'SELECT l.account_id FROM local_accounts l CROSS JOIN statuses r INDEXED BY statuses_account_reblogs_kept',
			'UNION SELECT r.id FROM main.follows f CROSS JOIN main.statuses r INDEXED BY statuses_account_reblogs_kept',
			'CROSS JOIN statuses r INDEXED BY statuses_reblog ON r.reblog_of_id = o.id',
			'EXISTS (SELECT 1 FROM statuses INDEXED BY statuses_reblog WHERE reblog_of_id = ?1)',
			'reblogs_count = (SELECT COUNT(*) FROM statuses r INDEXED BY statuses_reblog',
		]) {
			expect(
				[...seen.keys()].some((query) => query.includes(fragment)),
				fragment
			).toBe(true)
		}
	}, 120_000)
})
