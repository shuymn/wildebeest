import { runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { mastodonActor } from './inbox-helpers'
import { ALICE, announce, DAVE, followed, localStatus, remove, type Setup, setup, undo } from './inbox-status-helpers'
import { remoteAccount, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'
import { CAPTURE_LIMITS } from '../src/domain/streaming'

// R32 (docs/visibility.md; design "Kopje streaming API" §4.3): a streaming `delete` is captured once, before the first
// change to the status's audience, as a journal row and one row per account listening on `user` that could view the
// status (R3), with the boosts of it the account could view. The sockets' side is test/streaming/home.test.ts; here the
// capture itself: when it is taken, whom it names, and its bounds.

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
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', status.id)).toEqual([{ n: 0 }])
		const [alice] = await captures(t)
		expect(alice!.boosts).toEqual(ids.slice(0, alice!.boosts.length))
		expect(alice!.boosts.length).toBeLessThan(ids.length)
		const sizes = await sql<{ size: number }>(
			t.store,
			'SELECT length(lists) + length(boosts) AS size FROM stream_delete_viewers'
		)
		expect(sizes.every((row) => row.size <= 120)).toBe(true)
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
