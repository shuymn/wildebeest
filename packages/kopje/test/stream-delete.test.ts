import { runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { mastodonActor } from './inbox-helpers'
import { ALICE, announce, DAVE, followed, localStatus, remove, type Setup, setup, undo } from './inbox-status-helpers'
import { remoteAccount, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'
import { CAPTURE_LIMITS, PRUNE_BATCH as STREAM_PRUNE_BATCH, streamDelete, streamPrune } from '../src/domain/streaming'

// R32 (docs/visibility.md; design "Kopje streaming API" §4.3): a streaming `delete` is captured once, before the first
// change to the status's audience, as a journal row and one row per listening account that could view the status (R3),
// with the boosts of it the account could view (for `user` and list listeners), and, for a public status that is not a
// boost, a tombstone of the facts the `public*` and `hashtag*` streams match. The sockets' side is
// test/streaming/home.test.ts and public.test.ts; here the capture itself: when it is taken, whom it names, and its
// bounds.

const LIMITS = { ...CAPTURE_LIMITS }

afterEach(() => {
	Object.assign(CAPTURE_LIMITS, LIMITS)
})

// Accounts listening on `user`, as the registry records open sockets (no socket is needed for the capture).
async function listen(t: Setup, ...accounts: string[]): Promise<void> {
	for (const account of accounts) {
		await sql(
			t.store,
			"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)",
			account
		)
	}
}

// The delete events and their viewer rows, by the deleted id.
async function captures(t: Setup): Promise<{ subject: string; account_id: string; boosts: string[] }[]> {
	const rows = await sql<{ subject: string; account_id: string; boosts: string }>(
		t.store,
		`SELECT e.subject, v.account_id, v.boosts FROM stream_events e JOIN stream_delete_viewers v ON v.event_id = e.id
		WHERE e.kind = 'delete' ORDER BY e.id, v.account_id`
	)
	return rows.map((row) => ({
		subject: row.subject,
		account_id: row.account_id,
		boosts: (JSON.parse(row.boosts) as [string, string[]][]).map(([id]) => id),
	}))
}

async function deleteEvents(t: Setup): Promise<unknown> {
	return sql(t.store, "SELECT subject FROM stream_events WHERE kind = 'delete' ORDER BY id")
}

describe('R32: a remote Delete is captured when its job is created', () => {
	it('names the viewers a mention authorized, once, through every batch and a redelivery', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		// alice follows bob; dave does not.
		const bobId = await followed(t, bob)
		await listen(t, ALICE, DAVE)
		const direct = `${bob.uri}/statuses/direct`
		const priv = `${bob.uri}/statuses/private`
		const directId = await seedStatus(t.store, {
			accountId: bobId,
			visibility: 'direct',
			mentions: [{ accountId: ALICE }],
			uri: direct,
		})
		const privateId = await seedStatus(t.store, {
			accountId: bobId,
			visibility: 'private',
			mentions: [{ accountId: DAVE }],
			uri: priv,
		})
		// More mentions than a batch removes, so each removal takes several batches.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
			PURGE_BATCH
		)
		for (const status of [directId, privateId]) {
			await sql(
				t.store,
				"INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB '6*'",
				status
			)
		}

		for (const [uri, id] of [
			[direct, directId],
			[priv, privateId],
		] as const) {
			expect(await t.post(bob, remove(bob, uri))).toBe(202)
			// The first batch ran: the status is still there, its audience mid-removal.
			expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', id)).toEqual([{ n: 1 }])
			// Delivered again, and the rest of the batches: nothing more is captured.
			expect(await t.post(bob, remove(bob, uri))).toBe(202)
			for (let more = true; more;) {
				more = await runInDurableObject(t.store, (_instance, state) =>
					state.storage.transactionSync(() => deleteStatusBatch(new Db(state.storage.sql), id, NOW))
				)
			}
			expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', id)).toEqual([{ n: 0 }])
		}
		expect(await captures(t)).toEqual([
			// The direct status: alice, whom it mentions.
			{ subject: directId, account_id: ALICE, boosts: [] },
			// The private status: alice, a follower, and dave, whom it mentions.
			{ subject: privateId, account_id: ALICE, boosts: [] },
			{ subject: privateId, account_id: DAVE, boosts: [] },
		])
	})

	it('captures a remote boost removed by Delete or Undo, by its own id', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		await listen(t, ALICE)
		const first = await localStatus(t, { status: 'boosted twice', visibility: 'public' }, 'dave')
		const second = await localStatus(t, { status: 'boosted again', visibility: 'public' }, 'dave')
		const deleted = announce(bob, first.uri)
		const undone = announce(bob, second.uri)
		expect(await t.post(bob, deleted)).toBe(202)
		expect(await t.post(bob, undone)).toBe(202)
		const boosts = await sql<{ id: string; uri: string }>(
			t.store,
			'SELECT id, uri FROM statuses WHERE reblog_of_id IS NOT NULL ORDER BY uri'
		)
		const idOf = (uri: string) => boosts.find((boost) => boost.uri === uri)!.id
		expect(await t.post(bob, remove(bob, deleted.id))).toBe(202)
		expect(await t.post(bob, undo(bob, { id: undone.id, type: 'Announce', actor: bob.uri, object: second.uri }))).toBe(
			202
		)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE reblog_of_id IS NOT NULL')).toEqual([{ n: 0 }])
		expect(await captures(t)).toEqual([
			{ subject: idOf(deleted.id), account_id: ALICE, boosts: [] },
			{ subject: idOf(undone.id), account_id: ALICE, boosts: [] },
		])
	})
})

describe("R32: a status's boosts in its capture", () => {
	// dave's public status, boosted by `followed` remote accounts alice follows, one she follows whose purge has begun,
	// and one she does not follow; alice and dave listen.
	async function boosted(followedBoosters: number): Promise<{ t: Setup; status: { id: string }; ids: string[] }> {
		const t = await setup()
		await listen(t, ALICE, DAVE)
		const status = await localStatus(t, { status: 'boosted', visibility: 'public' }, 'dave')
		const ids: string[] = []
		for (let i = 0; i < followedBoosters; i++) {
			const booster = await remoteAccount(t.store, `booster${i}`)
			await sql(
				t.store,
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				ALICE,
				booster
			)
			ids.push(await seedStatus(t.store, { accountId: booster, visibility: 'public', reblogOfId: status.id }))
		}
		const purged = await remoteAccount(t.store, 'purged')
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			purged
		)
		await seedStatus(t.store, { accountId: purged, visibility: 'public', reblogOfId: status.id })
		await sql(t.store, "UPDATE accounts SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", purged)
		const stranger = await remoteAccount(t.store, 'stranger')
		await seedStatus(t.store, { accountId: stranger, visibility: 'public', reblogOfId: status.id })
		return { t, status, ids: ids.sort() }
	}

	async function deleteAsDave(t: Setup, id: string): Promise<void> {
		const response = await t.request(`/api/v1/statuses/${id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${t.tokens.dave}` },
		})
		expect(response.status).toBe(200)
	}

	it('holds the boosts a viewer could view by accounts they follow, at most 40, the oldest first', async () => {
		const { t, status, ids } = await boosted(45)
		await deleteAsDave(t, status.id)
		// Not the booster whose purge has begun, nor the account alice does not follow; dave follows none of them.
		expect(await captures(t)).toEqual([
			{ subject: status.id, account_id: ALICE, boosts: ids.slice(0, 40) },
			{ subject: status.id, account_id: DAVE, boosts: [] },
		])
		const [row] = await sql<{ size: number }>(
			t.store,
			'SELECT length(lists) + length(boosts) AS size FROM stream_delete_viewers WHERE account_id = ?',
			ALICE
		)
		expect(row!.size).toBeLessThanOrEqual(LIMITS.viewerBytes)
	})

	it('truncates a row over its bound, newest boosts first, and still deletes', async () => {
		const { t, status, ids } = await boosted(10)
		CAPTURE_LIMITS.viewerBytes = 120
		await deleteAsDave(t, status.id)
		expect(await sql(t.store, 'SELECT withdrawn FROM statuses WHERE id = ?', status.id)).toEqual([{ withdrawn: 1 }])
		const [alice] = await captures(t)
		expect(alice!.boosts).toEqual(ids.slice(0, alice!.boosts.length))
		expect(alice!.boosts.length).toBeLessThan(ids.length)
		const sizes = await sql<{ size: number }>(
			t.store,
			'SELECT length(lists) + length(boosts) AS size FROM stream_delete_viewers'
		)
		expect(sizes.every((row) => row.size <= 120)).toBe(true)
	})

	// alice's 16 lists (her every key), each holding dave and every booster: the status and each boost are in all.
	async function listed(t: Setup): Promise<string[]> {
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			DAVE
		)
		const lists = Array.from({ length: 16 }, (_, i) => String(900000000000000000n + BigInt(i)))
		for (const list of lists) {
			await sql(t.store, "INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'l')", list, ALICE)
			await sql(
				t.store,
				`INSERT INTO list_accounts (list_id, account_id) SELECT ?1, target_account_id FROM follows
				WHERE account_id = ?2 AND state = 'accepted'`,
				list,
				ALICE
			)
			await sql(
				t.store,
				'INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, ?, 1)',
				ALICE,
				`list:${list}`
			)
		}
		await sql(t.store, "DELETE FROM stream_subscriptions WHERE account_id = ? AND stream_key = 'user'", ALICE)
		return lists
	}

	it('holds, at its maxima, the lists whose read held the status and each boost, within the row bound', async () => {
		const { t, status, ids } = await boosted(45)
		const lists = await listed(t)
		await deleteAsDave(t, status.id)
		const [row] = await sql<{ lists: string; boosts: string }>(
			t.store,
			'SELECT lists, boosts FROM stream_delete_viewers WHERE account_id = ?',
			ALICE
		)
		expect(JSON.parse(row!.lists)).toEqual(lists)
		expect(JSON.parse(row!.boosts)).toEqual(ids.slice(0, 40).map((id) => [id, lists]))
		expect(row!.lists.length + row!.boosts.length).toBeLessThanOrEqual(LIMITS.viewerBytes)
	})

	it('truncates the boosts, then the lists, of a row over its bound, and still deletes', async () => {
		const { t, status } = await boosted(10)
		const lists = await listed(t)
		CAPTURE_LIMITS.viewerBytes = 200
		await deleteAsDave(t, status.id)
		expect(await sql(t.store, 'SELECT withdrawn FROM statuses WHERE id = ?', status.id)).toEqual([{ withdrawn: 1 }])
		const [row] = await sql<{ lists: string; boosts: string }>(
			t.store,
			'SELECT lists, boosts FROM stream_delete_viewers WHERE account_id = ?',
			ALICE
		)
		expect(JSON.parse(row!.boosts)).toEqual([])
		const kept = JSON.parse(row!.lists) as string[]
		expect(kept).toEqual(lists.slice(0, kept.length))
		expect(kept.length).toBeLessThan(lists.length)
		expect(row!.lists.length + row!.boosts.length).toBeLessThanOrEqual(200)
	})

	it('captures nothing while nobody listening may view the status', async () => {
		const t = await setup()
		const status = await localStatus(t, { status: 'unheard', visibility: 'public' }, 'dave')
		await deleteAsDave(t, status.id)
		await listen(t, ALICE)
		const hidden = await localStatus(t, { status: '@dave only', visibility: 'direct' }, 'dave')
		await deleteAsDave(t, hidden.id)
		expect(await deleteEvents(t)).toEqual([])
	})
})

describe('R32: captures are pruned in bounded chunks', () => {
	it('writes at most PRUNE_BATCH rows a call at the densest captures, and leaves the newest event', async () => {
		const t = await setup()
		// Three finished delete events, each with a row for each of the registry's 256 accounts, and a newer event.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4)
			INSERT INTO stream_events (id, kind, subject, created_at)
			SELECT i, 'delete', '100000000000000000', '2026-10-12T00:00:00.000Z' FROM n`
		)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 256)
			INSERT INTO stream_delete_viewers (event_id, account_id, lists, boosts)
			SELECT e.id, printf('7%017d', n.i), '[]', '[]' FROM stream_events e, n`
		)
		const calls: { wrote: number; pruned: number; more: boolean }[] = []
		for (let i = 0; i < 10; i++) {
			const call = await runInDurableObject(t.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const done = state.storage.transactionSync(() => streamPrune.run(state.storage.sql, { upTo: 3 }))
				return { wrote: changes() - before, ...done }
			})
			calls.push(call)
			if (!call.more) {
				break
			}
		}
		expect(calls.length).toBeGreaterThan(1)
		expect(calls.every((call) => call.wrote <= STREAM_PRUNE_BATCH)).toBe(true)
		// The finished journal rows go in the first call, so the span shrinks at once; their captures follow.
		expect(calls[0]).toEqual({ wrote: STREAM_PRUNE_BATCH, pruned: 3, more: true })
		expect(calls.at(-1)!.more).toBe(false)
		expect(await sql(t.store, 'SELECT id FROM stream_events')).toEqual([{ id: 4 }])
		expect(await sql(t.store, 'SELECT DISTINCT event_id FROM stream_delete_viewers')).toEqual([{ event_id: 4 }])
	})
})

describe('R32: the tombstone of a public status', () => {
	// Registry rows (no socket is needed for the capture).
	async function keys(t: Setup, account: string, ...streamKeys: string[]): Promise<void> {
		for (const key of streamKeys) {
			await sql(
				t.store,
				'INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, ?, 1)',
				account,
				key
			)
		}
	}

	async function capture(t: Setup, statusId: string): Promise<void> {
		await runInDurableObject(t.store, (_instance, state) => {
			state.storage.transactionSync(() => streamDelete(new Db(state.storage.sql), statusId, NOW))
		})
	}

	async function tombstones(t: Setup): Promise<unknown> {
		return sql(
			t.store,
			`SELECT e.subject, t.local, t.media, t.tags FROM stream_delete_tombstones t JOIN stream_events e ON e.id = t.event_id
			ORDER BY e.id`
		)
	}

	it('holds local, media and the subscribed hashtags of a public status, for a listener on feeds alone', async () => {
		const t = await setup()
		const erin = await remoteAccount(t.store, 'erin')
		await keys(t, ALICE, 'public:remote:media', 'hashtag:cats', 'hashtag:local:dogs')
		const local = await seedStatus(t.store, { accountId: DAVE, visibility: 'public', tags: ['cats', 'dogs', 'birds'] })
		const remote = await seedStatus(t.store, { accountId: erin, visibility: 'public', tags: ['dogs'] })
		await sql(
			t.store,
			"INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES ('400000000000000001', ?, ?, 'image', 'https://remote.example/m')",
			erin,
			remote
		)
		await capture(t, local)
		await capture(t, remote)
		expect(await tombstones(t)).toEqual([
			{ subject: local, local: 1, media: 0, tags: '["cats","dogs"]' },
			{ subject: remote, local: 0, media: 1, tags: '["dogs"]' },
		])
		// The feed's listener is named without boosts.
		expect(await captures(t)).toEqual([
			{ subject: local, account_id: ALICE, boosts: [] },
			{ subject: remote, account_id: ALICE, boosts: [] },
		])
	})

	it('captures nothing for feed listeners of a boost, a non-public status, or feeds the status would not reach', async () => {
		const t = await setup()
		await keys(t, ALICE, 'public:remote', 'hashtag:dogs', 'public:local:media')
		const status = await seedStatus(t.store, { accountId: DAVE, visibility: 'public', tags: ['cats'] })
		const unlisted = await seedStatus(t.store, { accountId: DAVE, visibility: 'unlisted', tags: ['dogs'] })
		const boost = await seedStatus(t.store, { accountId: ALICE, visibility: 'public', reblogOfId: status })
		for (const id of [status, unlisted, boost]) {
			await capture(t, id)
		}
		expect(await deleteEvents(t)).toEqual([])
		expect(await tombstones(t)).toEqual([])
		// A `user` listener has its capture, and still no tombstone for a feed nobody would be sent.
		await listen(t, DAVE)
		await capture(t, status)
		expect(await captures(t)).toEqual([{ subject: status, account_id: DAVE, boosts: [] }])
		expect(await tombstones(t)).toEqual([])
	})

	// The maxima: 16 listening accounts, each on `user` and 15 hashtags of 256 bytes (240 in all), a status carrying 100
	// of them and boosted by 40 accounts each account follows.
	async function atMaxima(t: Setup): Promise<{ status: string; tags: string[] }> {
		const tag = (i: number) => `${String(i).padStart(3, '0')}${'x'.repeat(253)}`
		const viewers = Array.from({ length: 16 }, (_, i) => String(600000000000000000n + BigInt(i)))
		for (const [v, viewer] of viewers.entries()) {
			await sql(
				t.store,
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/v' || ?2, 'v' || ?2)",
				viewer,
				v
			)
			await keys(t, viewer, 'user', ...Array.from({ length: 15 }, (_, k) => `hashtag:${tag(v * 15 + k)}`))
		}
		const tags = Array.from({ length: 100 }, (_, i) => tag(i * 2))
		const status = await seedStatus(t.store, { accountId: DAVE, visibility: 'public', tags })
		for (let i = 0; i < 40; i++) {
			const booster = await remoteAccount(t.store, `booster${i}`)
			await seedStatus(t.store, { accountId: booster, visibility: 'public', reblogOfId: status })
			for (const viewer of viewers) {
				await sql(
					t.store,
					"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
					viewer,
					booster
				)
			}
		}
		return { status, tags: [...tags].sort() }
	}

	it('stays within its bounds at the maxima: one tombstone of 100 hashtags, 16 rows of 40 boosts', async () => {
		const t = await setup()
		const { status, tags } = await atMaxima(t)
		await capture(t, status)
		const [tombstone] = await sql<{ tags: string; size: number }>(
			t.store,
			'SELECT tags, length(CAST(tags AS BLOB)) AS size FROM stream_delete_tombstones'
		)
		expect(JSON.parse(tombstone!.tags)).toEqual(tags)
		expect(tombstone!.size).toBeLessThanOrEqual(LIMITS.tombstoneBytes)
		const rows = await sql<{ boosts: string; size: number }>(
			t.store,
			'SELECT boosts, length(CAST(lists AS BLOB)) + length(CAST(boosts AS BLOB)) AS size FROM stream_delete_viewers'
		)
		expect(rows).toHaveLength(16)
		expect(rows.every((row) => (JSON.parse(row.boosts) as unknown[]).length === 40)).toBe(true)
		expect(rows.every((row) => row.size <= LIMITS.viewerBytes)).toBe(true)
	})

	it('truncates a tombstone over its bound, its last hashtags first, and still deletes', async () => {
		const t = await setup()
		const { status, tags } = await atMaxima(t)
		CAPTURE_LIMITS.tombstoneBytes = 2000
		const response = await t.request(`/api/v1/statuses/${status}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${t.tokens.dave}` },
		})
		expect(response.status).toBe(200)
		expect(await sql(t.store, 'SELECT withdrawn FROM statuses WHERE id = ?', status)).toEqual([{ withdrawn: 1 }])
		const [tombstone] = await sql<{ tags: string; size: number }>(
			t.store,
			'SELECT tags, length(CAST(tags AS BLOB)) AS size FROM stream_delete_tombstones'
		)
		const kept = JSON.parse(tombstone!.tags) as string[]
		expect(kept).toEqual(tags.slice(0, kept.length))
		expect(kept.length).toBeGreaterThan(0)
		expect(kept.length).toBeLessThan(tags.length)
		expect(tombstone!.size).toBeLessThanOrEqual(2000)
	})
})
