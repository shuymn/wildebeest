import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD, claimSent, type SentClaim } from './helpers'
import { act, community, post, remoteAccount, remoteFollows, seedStatus } from './status-helpers'
import { followAnswerActivity, followActivity, followUri, undoFollowActivity } from '../src/domain/activities'
import {
	type DeliveryOutcome,
	GAVE_UP_RETENTION_MS,
	LEASE_MS,
	MAX_ATTEMPTS,
	retryDelay,
} from '../src/domain/deliveries'
import { sha256Hex } from '../src/platform/sha256'
import type { StoreStub } from '../src/platform/store-client'

// B2 delivery in the Store (domain/deliveries.ts): expansion of outbound intents into inboxes (NET-2, VIS-3), lanes,
// claims and leases (NET-2, OPS-3), retries and giving up (RES-5), and the operator's view.

type Row = {
	id: string
	activity_id: string
	inbox_url: string
	state: string
	attempts: number
	next_attempt_at: number
	lease_token: string | null
	last_status: number | null
	type: string
	body: string
}

function rows(store: StoreStub): Promise<Row[]> {
	return sql<Row>(
		store,
		`SELECT CAST(d.id AS TEXT) AS id, CAST(d.activity_id AS TEXT) AS activity_id, d.inbox_url, d.state, d.attempts,
			d.next_attempt_at, d.lease_token, d.last_status, json_extract(o.body, '$.activity.type') AS type,
			json_extract(o.body, '$.activity') AS body
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
	)
}

function claim(store: StoreStub, now: number, leaseToken: string): Promise<SentClaim> {
	return claimSent(store, { now, leaseToken })
}

function complete(store: StoreStub, id: string, leaseToken: string, now: number, outcome: DeliveryOutcome) {
	return store.completeDelivery(BUILD, { id, leaseToken, now, outcome })
}

const OK: DeliveryOutcome = { kind: 'delivered', status: 202 }
const FAIL: DeliveryOutcome = { kind: 'failed', status: 503, error: 'HTTP 503', permanent: false }
const GONE: DeliveryOutcome = { kind: 'failed', status: 410, error: 'HTTP 410', permanent: true }
const MISSING: DeliveryOutcome = { kind: 'failed', status: 404, error: 'HTTP 404', permanent: true }

// Followers on two servers (two sharing fans.example's shared inbox), plus accounts that must not receive anything.
async function audience() {
	const h = await community(['alice', 'bob'])
	const { alice, bob } = h.users
	const fan1 = await remoteAccount(h.store, 'fan1', 'fans.example')
	const fan2 = await remoteAccount(h.store, 'fan2', 'fans.example')
	const other = await remoteAccount(h.store, 'other', 'other.example')
	const pending = await remoteAccount(h.store, 'pending', 'pending.example')
	const followed = await remoteAccount(h.store, 'followed', 'followed.example')
	for (const follower of [fan1, fan2, other]) {
		await remoteFollows(h.store, follower, alice.id)
	}
	// A local follower reads the Store; a pending one is not a follower; one alice follows is not her audience.
	await act(h, bob, `/api/v1/accounts/${alice.id}/follow`)
	await sql(
		h.store,
		"INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'pending', '2026-10-12T00:00:00Z')",
		pending,
		alice.id
	)
	await sql(
		h.store,
		"INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', '2026-10-12T00:00:00Z')",
		alice.id,
		followed
	)
	await sql(h.store, 'DELETE FROM outbound_activities')
	return { h, alice, bob, fan1, other, pending, followed }
}

describe('expansion (NET-2, VIS-3)', () => {
	it('NET-2: delivers a public status once per shared inbox of the accepted remote followers', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'hello' })
		const delivered = await rows(h.store)
		// Duplicate inboxes: fan1 and fan2 share https://fans.example/inbox, so it gets one row.
		expect(delivered.map((r) => [r.type, r.inbox_url, r.state])).toEqual([
			['Create', 'https://fans.example/inbox', 'pending'],
			['Create', 'https://other.example/inbox', 'pending'],
		])
	})

	it('NET-2: a recipient outside the audience gets nothing', async () => {
		const { h, alice } = await audience()
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		await post(h, alice, { status: 'followers only', visibility: 'private' })
		await post(h, alice, { status: '@carol@carol.example just you', visibility: 'direct' })
		const delivered = await rows(h.store)
		expect(delivered.map((r) => [r.type, r.inbox_url])).toEqual([
			['Create', 'https://fans.example/inbox'],
			['Create', 'https://other.example/inbox'],
			// The direct status goes to carol only: no follower, pending follower or followed account.
			['Create', 'https://carol.example/inbox'],
		])
		const inboxes = delivered.map((r) => r.inbox_url).join(' ')
		expect(inboxes).not.toContain('pending.example')
		expect(inboxes).not.toContain('followed.example')
		expect(carol).toBeDefined()
	})

	it('VIS-3, VIS-7: a silent recipient receives the activity at its personal inbox and is never named', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteAccount(h.store, 'carol', 'carol.example')
		const direct = await post(h, alice, { status: '@carol@carol.example psst', visibility: 'direct' })
		// The Create is in flight when the edit comes: it may give up, so the server gets the current Create and the
		// Update after it (the edit fan-out pair), each a copy of its own at the personal inbox.
		await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'in-flight' })
		// The edit removes the mention; carol stays addressed as a silent recipient (VIS-11).
		await h.request(`/api/v1/statuses/${direct.id}`, bearer(alice.token, json({ status: 'edited' }, { method: 'PUT' })))
		const [create, current, update] = await rows(h.store)
		expect(create?.inbox_url).toBe('https://carol.example/inbox')
		expect(current?.type).toBe('Create')
		expect(current?.inbox_url).toBe('https://carol.example/users/carol/inbox')
		expect(update?.type).toBe('Update')
		expect(update?.inbox_url).toBe('https://carol.example/users/carol/inbox')
		const activity = JSON.parse(update?.body ?? '{}') as { to: string[]; cc: string[]; object: { tag: unknown[] } }
		expect(activity.to).toEqual([])
		expect(activity.cc).toEqual([])
		expect(JSON.stringify(activity)).not.toContain('https://carol.example/users/carol')
	})

	it('NET-2: delivers once to a follower who is also mentioned, and falls back to a personal inbox', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		const lone = await remoteAccount(h.store, 'lone', 'lone.example')
		await sql(h.store, 'UPDATE accounts SET shared_inbox_url = NULL WHERE id = ?', lone)
		await remoteFollows(h.store, lone, alice.id)
		await post(h, alice, { status: '@fan@fans.example hello' })
		expect((await rows(h.store)).map((r) => r.inbox_url)).toEqual([
			'https://fans.example/inbox',
			'https://lone.example/users/lone/inbox',
		])
	})

	it('records no intent when no remote inbox needs it, and refuses inboxes that are not https', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const plain = await remoteAccount(h.store, 'plain', 'plain.example')
		await sql(
			h.store,
			"UPDATE accounts SET inbox_url = 'http://plain.example/inbox', shared_inbox_url = 'https://user:pw@plain.example/inbox' WHERE id = ?",
			plain
		)
		await remoteFollows(h.store, plain, alice.id)
		await post(h, alice, { status: 'nobody remote' })
		expect(await rows(h.store)).toEqual([])
		expect(await sql(h.store, 'SELECT id FROM outbound_activities')).toEqual([])
	})

	it('VIS-3: a Delete reaches the inboxes that received the status, even after they stopped following', async () => {
		const { h, alice, other } = await audience()
		const status = await post(h, alice, { status: 'soon gone', visibility: 'private' })
		const leased = await claim(h.store, NOW, 'lease-1')
		for (const delivery of leased.deliveries) {
			expect(await complete(h.store, delivery.id, 'lease-1', NOW, OK)).toMatchObject({ status: 'delivered' })
		}
		expect(await rows(h.store)).toEqual([])
		expect(await sql(h.store, 'SELECT id FROM outbound_activities')).toEqual([])
		expect(await sql(h.store, 'SELECT status_id, inbox_url FROM outbound_receipts ORDER BY inbox_url')).toEqual([
			{ status_id: status.id, inbox_url: 'https://fans.example/inbox' },
			{ status_id: status.id, inbox_url: 'https://other.example/inbox' },
		])
		await sql(h.store, 'DELETE FROM follows WHERE account_id = ?', other)
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: 'DELETE' }))
		const deleted = await rows(h.store)
		expect(deleted.map((r) => [r.type, r.inbox_url])).toEqual([
			['Delete', 'https://fans.example/inbox'],
			['Delete', 'https://other.example/inbox'],
		])
		expect(JSON.parse(deleted[0]?.body ?? '{}')).toMatchObject({ object: { type: 'Tombstone', id: status.uri } })
		// The evidence now lives in the Delete's own rows.
		expect(await sql(h.store, 'SELECT status_id FROM outbound_receipts')).toEqual([])
	})
})

describe('lanes, claims and leases (NET-2, OPS-3)', () => {
	it('delivers a lane in order: the second activity waits until the first settles', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'first' })
		await post(h, alice, { status: 'second' })
		const before = await rows(h.store)
		expect(before.map((r) => [r.inbox_url, r.state])).toEqual([
			['https://fans.example/inbox', 'pending'],
			['https://other.example/inbox', 'pending'],
			['https://fans.example/inbox', 'queued'],
			['https://other.example/inbox', 'queued'],
		])
		const first = await claim(h.store, NOW, 'a')
		expect(first.deliveries.map((d) => d.id)).toEqual([before[0]?.id, before[1]?.id])
		// Nothing else is due while the heads are leased.
		expect((await claim(h.store, NOW, 'b')).deliveries).toEqual([])
		await complete(h.store, before[0]?.id ?? '', 'a', NOW + 1, OK)
		const next = await claim(h.store, NOW + 1, 'c')
		expect(next.deliveries.map((d) => [d.id, d.inbox])).toEqual([[before[2]?.id, 'https://fans.example/inbox']])
		expect(JSON.parse(next.deliveries[0]?.body ?? '{}')).toMatchObject({ type: 'Create' })
		expect(Object.keys(next.signers)).toEqual([alice.id])
	})

	it('NET-2: an expired lease is claimed again with a fresh token, and the stale completion settles nothing', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'hello' })
		const first = await claim(h.store, NOW, 'old')
		const id = first.deliveries[0]?.id ?? ''
		expect(first.leaseUntil).toBe(NOW + LEASE_MS)
		// Before the lease ends, nobody else gets the row.
		expect((await claim(h.store, NOW + LEASE_MS - 1, 'early')).deliveries).toEqual([])
		const second = await claim(h.store, NOW + LEASE_MS, 'new')
		expect(second.deliveries.map((d) => d.id)).toContain(id)
		// The completion of the first claim arrives late: it may not acknowledge the second claim.
		expect(await complete(h.store, id, 'old', NOW + LEASE_MS + 1, OK)).toMatchObject({ status: 'stale' })
		expect(await complete(h.store, id, 'old', NOW + LEASE_MS + 1, GONE)).toMatchObject({ status: 'stale' })
		const row = (await rows(h.store)).find((r) => r.id === id)
		expect(row).toMatchObject({ state: 'leased', lease_token: 'new', attempts: 2 })
		expect(await complete(h.store, id, 'new', NOW + LEASE_MS + 2, OK)).toMatchObject({ status: 'delivered' })
	})

	it('OPS-3: a claim or completion whose response is lost is reconciled, not repeated', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'hello' })
		// The claim committed but its response never reached the Worker: the rows stay leased until the lease ends.
		await claim(h.store, NOW, 'lost')
		expect((await claim(h.store, NOW + 1, 'other')).deliveries).toEqual([])
		const again = await claim(h.store, NOW + LEASE_MS, 'again')
		expect(again.deliveries).toHaveLength(2)
		// The completion committed, its response was lost, and the Worker sends it again: the second is stale and
		// records nothing twice.
		const id = again.deliveries[0]?.id ?? ''
		expect(await complete(h.store, id, 'again', NOW + LEASE_MS, OK)).toMatchObject({ status: 'delivered' })
		expect(await complete(h.store, id, 'again', NOW + LEASE_MS, OK)).toMatchObject({ status: 'stale' })
		expect(await sql(h.store, 'SELECT count(*) AS n FROM outbound_receipts')).toEqual([{ n: 1 }])
		expect((await rows(h.store)).map((r) => r.id)).not.toContain(id)
	})

	it('bounds a claim to its limit', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		for (let i = 0; i < 20; i++) {
			const follower = await remoteAccount(h.store, `f${i}`, `server${i}.example`)
			await remoteFollows(h.store, follower, alice.id)
		}
		await post(h, alice, { status: 'to twenty servers' })
		expect((await claim(h.store, NOW, 'x')).deliveries).toHaveLength(16)
		expect((await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'y', limit: 3 })).deliveries).toHaveLength(3)
	})
})

describe('retries and giving up (RES-5)', () => {
	it('retries after min(30 s·2^n, 12 h) and gives up after 15 attempts', async () => {
		expect([1, 2, 3, 10, 11, 14].map(retryDelay)).toEqual([
			60_000, 120_000, 240_000, 30_720_000, 43_200_000, 43_200_000,
		])
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		await post(h, alice, { status: 'unlucky' })
		let now = NOW
		let total = 0
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const claimed = await claim(h.store, now, `t${attempt}`)
			expect(claimed.deliveries).toHaveLength(1)
			const result = await complete(h.store, claimed.deliveries[0]?.id ?? '', `t${attempt}`, now, FAIL)
			if (attempt < MAX_ATTEMPTS) {
				expect(result).toMatchObject({ status: 'retry', retryAt: now + retryDelay(attempt) })
				expect((await claim(h.store, now + retryDelay(attempt) - 1, 'early')).deliveries).toEqual([])
				total += retryDelay(attempt)
				now += retryDelay(attempt)
			} else {
				expect(result).toMatchObject({ status: 'gave_up' })
			}
		}
		// About 2.7 days in all (DECISIONS: 15 attempts).
		expect(total / 86_400_000).toBeCloseTo(2.71, 1)
		expect(await rows(h.store)).toMatchObject([{ state: 'gave_up', attempts: MAX_ATTEMPTS, last_status: 503 }])
	})

	it('gives up at once on a permanent failure and moves the lane on', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'first' })
		await post(h, alice, { status: 'second' })
		const leased = await claim(h.store, NOW, 'a')
		const fans = leased.deliveries.find((d) => d.inbox === 'https://fans.example/inbox')
		expect(await complete(h.store, fans?.id ?? '', 'a', NOW, GONE)).toMatchObject({ status: 'gave_up' })
		const after = await rows(h.store)
		expect(after.filter((r) => r.inbox_url === 'https://fans.example/inbox').map((r) => r.state)).toEqual([
			'gave_up',
			'pending',
		])
	})

	it('gives up an expired lease that has used its attempts', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'hello' })
		await sql(h.store, `UPDATE deliveries SET attempts = ${MAX_ATTEMPTS}, state = 'leased', lease_token = 'x'`)
		expect((await claim(h.store, NOW, 'y')).deliveries).toEqual([])
		expect((await rows(h.store)).map((r) => r.state)).toEqual(['gave_up', 'gave_up'])
	})

	it('lists given-up deliveries for the operator, retries them, and sweeps them after 30 days', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'first' })
		await post(h, alice, { status: 'second' })
		const leased = await claim(h.store, NOW, 'a')
		for (const delivery of leased.deliveries) {
			await complete(h.store, delivery.id, 'a', NOW, GONE)
		}
		const report = await h.store.deliveriesReport(BUILD, {})
		expect(report.backlog).toMatchObject({ queued: 0, pending: 2, leased: 0, gaveUp: 2 })
		expect(report.gaveUp.map((d) => [d.account, d.inbox, d.activityType, d.lastStatus])).toEqual([
			['alice', 'https://other.example/inbox', 'Create', 410],
			['alice', 'https://fans.example/inbox', 'Create', 410],
		])
		const fans = report.gaveUp[1]?.id ?? ''
		// The lane already has a pending row, so the retried one queues behind it... and goes first, being older.
		expect(await h.store.retryDeliveries(BUILD, { ids: [fans], now: NOW + 1 })).toEqual({
			ok: true,
			retried: 1,
			skipped: 0,
			refused: 0,
			more: false,
			next: null,
		})
		const fansRows = (await rows(h.store)).filter((r) => r.inbox_url === 'https://fans.example/inbox')
		expect(fansRows.map((r) => [r.id, r.state, r.attempts])).toEqual([
			[fans, 'queued', 0],
			[expect.any(String), 'pending', 0],
		])
		const pending = await claim(h.store, NOW + 2, 'b')
		for (const delivery of pending.deliveries) {
			await complete(h.store, delivery.id, 'b', NOW + 2, OK)
		}
		expect((await rows(h.store)).find((r) => r.id === fans)?.state).toBe('pending')

		const swept = await h.store.sweepDeliveries(BUILD, { now: NOW + GAVE_UP_RETENTION_MS + 1 })
		expect(swept).toEqual({ swept: 1 })
		expect((await rows(h.store)).map((r) => r.state)).toEqual(['pending'])
		expect(await h.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })).toEqual({
			ok: true,
			retried: 0,
			skipped: 0,
			refused: 0,
			more: false,
			next: null,
		})
	})
})

describe('follows toward remote accounts', () => {
	it('sends a Follow, keeps the follow pending, and undoes it with the same id (VIS-8)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		const followed = await act(h, alice, `/api/v1/accounts/${dave}/follow`)
		expect(await followed.json()).toMatchObject({ following: false, requested: true })
		const [edge] = await sql<{ id: string; state: string; uri: string }>(
			h.store,
			'SELECT CAST(id AS TEXT) AS id, state, uri FROM follows WHERE account_id = ?',
			alice.id
		)
		const actor = 'https://kopje.test/ap/users/alice'
		expect(edge).toEqual({ id: expect.any(String), state: 'pending', uri: followUri(actor, edge?.id ?? '') })
		// Following again changes options only: no second Follow.
		await act(h, alice, `/api/v1/accounts/${dave}/follow`, { reblogs: false })
		await act(h, alice, `/api/v1/accounts/${dave}/unfollow`)
		const sent = await rows(h.store)
		// Neither has to: both go to dave's shared inbox, in one lane, in order.
		expect(sent.map((r) => [r.type, r.inbox_url, r.state])).toEqual([
			['Follow', 'https://remote.example/inbox', 'pending'],
			['Undo', 'https://remote.example/inbox', 'queued'],
		])
		expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: edge?.uri,
			type: 'Follow',
			actor,
			object: 'https://remote.example/users/dave',
		})
		expect(JSON.parse(sent[1]?.body ?? '{}')).toMatchObject({
			id: `${edge?.uri}/undo`,
			type: 'Undo',
			actor,
			object: { id: edge?.uri, type: 'Follow', actor, object: 'https://remote.example/users/dave' },
		})
		expect(h.doorbell).toHaveBeenCalled()
	})

	it('sends an activity without to to the personal inbox of a recipient without a shared inbox', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		await sql(h.store, 'UPDATE accounts SET shared_inbox_url = NULL WHERE id = ?', dave)
		const theirs = await seedStatus(h.store, {
			accountId: dave,
			visibility: 'public',
			uri: 'https://remote.example/n/1',
		})
		await act(h, alice, `/api/v1/accounts/${dave}/follow`)
		await act(h, alice, `/api/v1/statuses/${theirs}/favourite`)
		expect(
			await sql(
				h.store,
				`SELECT json_extract(o.body, '$.activity.type') AS type, d.inbox_url, d.addressee
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
			)
		).toEqual([
			{ type: 'Follow', inbox_url: 'https://remote.example/users/dave/inbox', addressee: null },
			{ type: 'Like', inbox_url: 'https://remote.example/users/dave/inbox', addressee: null },
		])
	})

	it('sends a Like to the shared inbox, and a silent recipient its copy at its personal inbox (VIS-3)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		await remoteAccount(h.store, 'carol', 'carol.example')
		const theirs = await seedStatus(h.store, {
			accountId: dave,
			visibility: 'public',
			uri: 'https://remote.example/n/1',
		})
		await act(h, alice, `/api/v1/statuses/${theirs}/favourite`)
		const direct = await post(h, alice, { status: '@carol@carol.example psst', visibility: 'direct' })
		await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'in-flight' })
		await h.request(`/api/v1/statuses/${direct.id}`, bearer(alice.token, json({ status: 'edited' }, { method: 'PUT' })))
		expect(
			await sql(
				h.store,
				`SELECT json_extract(o.body, '$.activity.type') AS type, d.inbox_url, d.addressee
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
			)
		).toEqual([
			{ type: 'Like', inbox_url: 'https://remote.example/inbox', addressee: null },
			{ type: 'Create', inbox_url: 'https://carol.example/inbox', addressee: null },
			{
				type: 'Create',
				inbox_url: 'https://carol.example/users/carol/inbox',
				addressee: 'https://carol.example/users/carol',
			},
			{
				type: 'Update',
				inbox_url: 'https://carol.example/users/carol/inbox',
				addressee: 'https://carol.example/users/carol',
			},
		])
	})

	it('moves a Follow and its Undo to the personal inbox once when the shared inbox answers 404', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		const shared = 'https://remote.example/inbox'
		const personal = 'https://remote.example/users/dave/inbox'
		await act(h, alice, `/api/v1/accounts/${dave}/follow`)
		const follow = await claim(h.store, NOW, 'a')
		expect(follow.deliveries.map((d) => d.inbox)).toEqual([shared])
		await act(h, alice, `/api/v1/accounts/${dave}/unfollow`)
		expect(await complete(h.store, follow.deliveries[0]?.id ?? '', 'a', NOW, MISSING)).toMatchObject({
			status: 'retry',
			retryAt: NOW,
		})
		// The same row, still first in the lane, its failed attempt counted, with the shared inbox's answer recorded.
		expect((await rows(h.store)).map((r) => [r.id, r.type, r.inbox_url, r.state, r.attempts, r.last_status])).toEqual([
			[follow.deliveries[0]?.id, 'Follow', personal, 'pending', 1, 404],
			[expect.any(String), 'Undo', shared, 'queued', 0, null],
		])
		const sent: [string, string][] = []
		for (const [token, outcome] of [
			['b', OK],
			['c', MISSING],
			['d', OK],
		] as const) {
			const round = await claim(h.store, NOW, token)
			expect(round.deliveries).toHaveLength(1)
			const [delivery] = round.deliveries
			sent.push([JSON.parse(delivery?.body ?? '{}').type, delivery?.inbox ?? ''])
			await complete(h.store, delivery?.id ?? '', token, NOW, outcome)
		}
		expect(sent).toEqual([
			['Follow', personal],
			['Undo', shared],
			['Undo', personal],
		])
		expect(await rows(h.store)).toEqual([])
	})

	it('gives up without a fallback when no distinct personal inbox exists, or the personal inbox answers 404', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const same = await remoteAccount(h.store, 'same', 'same.example')
		await sql(h.store, 'UPDATE accounts SET inbox_url = shared_inbox_url WHERE id = ?', same)
		const lone = await remoteAccount(h.store, 'lone', 'lone.example')
		await sql(h.store, 'UPDATE accounts SET shared_inbox_url = NULL WHERE id = ?', lone)
		await act(h, alice, `/api/v1/accounts/${same}/follow`)
		await act(h, alice, `/api/v1/accounts/${lone}/follow`)
		const round = await claim(h.store, NOW, 'a')
		for (const delivery of round.deliveries) {
			expect(await complete(h.store, delivery.id, 'a', NOW, MISSING)).toMatchObject({ status: 'gave_up' })
		}
		expect((await rows(h.store)).map((r) => [r.type, r.inbox_url, r.state])).toEqual([
			['Follow', 'https://same.example/inbox', 'gave_up'],
			['Follow', 'https://lone.example/users/lone/inbox', 'gave_up'],
		])
	})

	it('gives up without a fallback when the personal inbox is on another origin', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		await sql(
			h.store,
			"UPDATE accounts SET inbox_url = 'https://elsewhere.example/users/dave/inbox' WHERE id = ?",
			dave
		)
		await act(h, alice, `/api/v1/accounts/${dave}/follow`)
		const round = await claim(h.store, NOW, 'a')
		expect(round.deliveries.map((d) => d.inbox)).toEqual(['https://remote.example/inbox'])
		expect(await complete(h.store, round.deliveries[0]?.id ?? '', 'a', NOW, MISSING)).toMatchObject({
			status: 'gave_up',
		})
		expect((await rows(h.store)).map((r) => [r.inbox_url, r.state])).toEqual([
			['https://remote.example/inbox', 'gave_up'],
		])
	})

	it('bounds a recipient that swaps its inboxes between attempts by the attempt budget', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		await act(h, alice, `/api/v1/accounts/${dave}/follow`)
		let completion: { status: string } = { status: 'retry' }
		let posts = 0
		while (completion.status === 'retry') {
			const round = await claim(h.store, NOW, `t${posts}`)
			expect(round.deliveries).toHaveLength(1)
			posts++
			completion = await complete(h.store, round.deliveries[0]?.id ?? '', `t${posts - 1}`, NOW, MISSING)
			// An actor Update makes the inbox just tried its shared inbox again.
			await sql(
				h.store,
				'UPDATE accounts SET inbox_url = shared_inbox_url, shared_inbox_url = inbox_url WHERE id = ?',
				dave
			)
		}
		expect(completion.status).toBe('gave_up')
		expect(posts).toBe(MAX_ATTEMPTS)
		expect((await rows(h.store)).map((r) => [r.state, r.attempts])).toEqual([['gave_up', MAX_ATTEMPTS]])
	})

	it('never moves an addressed activity to a personal inbox when the shared inbox answers 404', async () => {
		const { h, alice } = await audience()
		await post(h, alice, { status: 'hello @other@other.example' })
		const round = await claim(h.store, NOW, 'a')
		expect(round.deliveries.map((d) => d.inbox)).toEqual(['https://fans.example/inbox', 'https://other.example/inbox'])
		for (const delivery of round.deliveries) {
			expect(await complete(h.store, delivery.id, 'a', NOW, MISSING)).toMatchObject({ status: 'gave_up' })
		}
		expect((await rows(h.store)).map((r) => [r.inbox_url, r.state])).toEqual([
			['https://fans.example/inbox', 'gave_up'],
			['https://other.example/inbox', 'gave_up'],
		])
	})

	it('builds Follow, Undo, Accept and Reject in the intent format', () => {
		const input = {
			followUri: 'https://kopje.test/ap/users/alice#follows/7',
			actorUri: 'https://kopje.test/ap/users/alice',
			targetUri: 'https://remote.example/users/dave',
			targetId: '100000000000000002',
		}
		expect(followActivity(input).audience).toEqual({ followers: false, accounts: [input.targetId] })
		expect(undoFollowActivity(input).activity.object).toMatchObject({ id: input.followUri, type: 'Follow' })
		const answer = {
			localActorUri: 'https://kopje.test/ap/users/alice',
			followerUri: 'https://remote.example/users/dave',
			followerId: '100000000000000002',
			followUri: 'https://remote.example/follows/1',
			edgeId: '9',
		}
		expect(followAnswerActivity('Accept', answer)).toEqual({
			activity: {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `https://kopje.test/ap/users/alice#accepts/follows/${sha256Hex(answer.followUri)}`,
				type: 'Accept',
				actor: answer.localActorUri,
				object: {
					id: answer.followUri,
					type: 'Follow',
					actor: answer.followerUri,
					object: answer.localActorUri,
				},
			},
			audience: { followers: false, accounts: [answer.followerId] },
			followPair: answer.followerId,
		})
		expect(followAnswerActivity('Reject', { ...answer, followUri: null }).activity).toMatchObject({
			id: 'https://kopje.test/ap/users/alice#rejects/follows/9',
			type: 'Reject',
			object: { type: 'Follow', actor: answer.followerUri },
		})
	})
})
