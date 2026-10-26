import { env } from 'cloudflare:workers'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { bearer, json, settle, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY, signAsLegacy } from './federation-helpers'
import { BUILD, claimAndSettle } from './helpers'
import { mastodonActor } from './inbox-helpers'
import { ALICE, ALICE_URI, AS, DAVE_URI, localStatus, nextId, setup as inboxSetup } from './inbox-status-helpers'
import { deferred, deliveryDeps, gatedHost, quoting } from './quote-helpers'
import { plannedRun, rowsRead, scansOf, staleStatistics } from './read-helpers'
import { act, receive, toFollows, unsuspend, uriOf, world } from './remote-suspension-helpers'
import { post, remoteAccount, remoteFollows } from './status-helpers'
import {
	type DeliveryOutcome,
	FOLLOW_ANSWER_CHUNKS,
	FOLLOW_ANSWER_CHUNKS_SQL,
	FOLLOW_ANSWER_INTENTS,
	FOLLOW_ANSWER_INTENTS_SQL,
	FOLLOW_ANSWER_ROWS,
	FOLLOW_ANSWER_ROWS_SQL,
	followAnswersOf,
	LEASE_MS,
	MAX_ATTEMPTS,
} from '../src/domain/deliveries'
import { MAX_RETRACTIONS_PER_ACTOR } from '../src/domain/inbox'
import { readOperation } from '../src/domain/operation'
import { deliveryRound } from '../src/jobs/deliver'
import type { StoreStub } from '../src/platform/store-client'

// Stale follow answers (cancelFollowAnswers in deliveries.ts; NET-2, RES-4, RES-5, RES-6, ID-7 and the accepted risks
// in docs/threat-model.md). Kopje's own send sequence is the oracle: a peer's application of what it receives is not
// observable. Each case is driven deterministically through the Store's production operations (expand, claim,
// confirm, complete), with no Queue.

const REMOTE = 'https://remote.example'
const LATER = NOW + 24 * 60 * 60 * 1000

afterEach(() => {
	vi.restoreAllMocks()
})

const OK: DeliveryOutcome = { kind: 'delivered', status: 202 }
const FAIL: DeliveryOutcome = { kind: 'failed', status: 503, error: 'HTTP 503', permanent: false }
const FORBIDDEN: DeliveryOutcome = { kind: 'failed', status: 403, error: 'HTTP 403', permanent: true }
const missing = (status: number): DeliveryOutcome => ({
	kind: 'failed',
	status,
	error: `HTTP ${status}`,
	permanent: true,
})

const STALE_EVENT = 'kopje.delivery.stale_follow_answer'

type T = Awaited<ReturnType<typeof setup>>

// alice, and r on remote.example, which s (alice's follower there) shares a lane with.
async function setup(options: { locked?: boolean } = {}) {
	const w = await world()
	const r = await remoteAccount(w.h.store, 'r')
	const s = await remoteAccount(w.h.store, 's')
	await remoteFollows(w.h.store, s, w.alice.id)
	if (options.locked === true) {
		await sql(w.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', w.alice.id)
	}
	return { w, store: w.h.store, r, rUri: await uriOf(w.h.store, r), aliceUri: await uriOf(w.h.store, w.alice.id) }
}

let sequence = 0
const followId = () => `${REMOTE}/follows/${++sequence}`

async function followFrom(t: T, id = followId()) {
	return { id, result: await receive(t.store, t.rUri, { id, type: 'Follow', object: t.aliceUri }) }
}

async function undoFrom(t: T, id: string) {
	return receive(t.store, t.rUri, { type: 'Undo', object: { id, type: 'Follow', actor: t.rUri, object: t.aliceUri } })
}

async function api(t: T, path: string) {
	const response = await t.w.h.request(path, bearer(t.w.alice.token, json({})))
	expect(response.status, path).toBe(200)
}

let lease = 0

// One claim at `now`, every sent row completed with `outcome` (null: left leased); the sent rows' types.
async function claimOnce(t: T, outcome: DeliveryOutcome | null, now = NOW): Promise<string[]> {
	const { sent } = await claimAndSettle(t.store, { now, leaseToken: `once-${++lease}`, outcome })
	return sent.map(({ body }) => (JSON.parse(body) as { type: string }).type)
}

// The outage shape the cancellation covers: a claim took alice's lane head to remote.example and it failed, so every
// row behind it waits queued and is never claimed.
async function outage(t: T): Promise<void> {
	await post(t.w.h, t.w.alice, { status: 'head' })
	expect(await claimOnce(t, FAIL)).toEqual(['Create'])
}

type LaneRow = { id: string; type: string; object: string | null; state: string; exposed: number; superseded: number }

// alice's rows to remote.example in lane order: the activity type, what it answers (a Follow's id) or is about, its
// state and whether it was ever claimed.
async function lane(t: T): Promise<LaneRow[]> {
	return sql<LaneRow>(
		t.store,
		`SELECT CAST(d.id AS TEXT) AS id, json_extract(o.body, '$.activity.type') AS type,
			coalesce(json_extract(o.body, '$.activity.object.id'), json_extract(o.body, '$.activity.object')) AS object,
			d.state, d.exposed, o.superseded
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
		WHERE d.account_id = ? AND d.lane = ? ORDER BY d.id`,
		t.w.alice.id,
		REMOTE
	)
}

// Delivers everything due by LATER, in lane order; each POST as [type, the Follow it answers or the object].
async function drain(t: T): Promise<[string, string | null][]> {
	const sent: [string, string | null][] = []
	for (let round = 0; round < 1_000; round++) {
		const settled = await claimAndSettle(t.store, { now: LATER, leaseToken: `drain-${++lease}`, outcome: OK })
		for (const row of settled.sent) {
			const body = JSON.parse(row.body) as { type: string; object: unknown }
			const object = typeof body.object === 'string' ? body.object : (body.object as { id?: string }).id
			sent.push([body.type, object ?? null])
		}
		const { claim } = settled
		if (claim.deliveries.length === 0 && (claim.nextDueAt === null || claim.nextDueAt > LATER)) {
			return sent
		}
	}
	throw new Error('the deliveries did not drain')
}

// The answers among what was sent.
const answers = (sent: [string, string | null][]) => sent.filter(([type]) => type === 'Accept' || type === 'Reject')

// Every table a Follow writes, whole: a refusal must leave each as it was.
async function snapshot(store: StoreStub) {
	const tables = [
		'accounts',
		'follows',
		'notifications',
		'outbound_activities',
		'outbound_targets',
		'deliveries',
		'inbound_retractions',
	]
	return Promise.all(
		tables.map(async (table) => (await sql(store, `SELECT * FROM ${table}`)).map((row) => JSON.stringify(row)).sort())
	)
}

describe('each renewal path sends only its own answer when the stale ones were never claimed', () => {
	it('block, unblock, re-follow: the old Accept and the withdrawing Reject go, the new Accept is sent', async () => {
		const t = await setup()
		await outage(t)
		const first = await followFrom(t)
		await api(t, `/api/v1/accounts/${t.r}/block`)
		await api(t, `/api/v1/accounts/${t.r}/unblock`)
		expect((await lane(t)).map((row) => [row.type, row.object, row.state])).toEqual([
			['Create', expect.any(String), 'pending'],
			['Accept', first.id, 'queued'],
			['Reject', first.id, 'queued'],
			['Block', t.rUri, 'queued'],
			['Undo', expect.any(String), 'queued'],
		])
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true, reason: 'followed' })
		const sent = await drain(t)
		expect(answers(sent)).toEqual([['Accept', second.id]])
		expect(sent.map(([type]) => type)).toEqual(['Create', 'Block', 'Undo', 'Accept'])
	})

	it.each([
		['completed', true],
		['interrupted before its follows', false],
	])('remote suspension (%s), unsuspension, re-follow', async (_, completed) => {
		const t = await setup()
		await outage(t)
		await followFrom(t)
		expect(await act(t.w, t.r, { type: 'suspend' })).toMatchObject({ status: 200 })
		if (completed) {
			await settle(t.store)
		} else {
			await toFollows(t.store)
		}
		expect(await unsuspend(t.w, t.r)).toMatchObject({ status: 200 })
		await settle(t.store)
		const stale = (await lane(t)).filter((row) => row.type === 'Accept' || row.type === 'Reject')
		expect(stale.map((row) => [row.type, row.exposed])).toEqual(
			completed
				? [
						['Accept', 0],
						['Reject', 0],
					]
				: [['Accept', 0]]
		)
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true })
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	it('locked, authorized, then renewed: only the renewal’s Accept', async () => {
		const t = await setup({ locked: true })
		await outage(t)
		const first = await followFrom(t)
		expect(first.result).toMatchObject({ reason: 'follow-requested' })
		await api(t, `/api/v1/follow_requests/${t.r}/authorize`)
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ reason: 'follow-reaccepted' })
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	it('locked, rejected, then asked again: the Reject goes, and the new request waits for the owner', async () => {
		const t = await setup({ locked: true })
		await outage(t)
		const first = await followFrom(t)
		await api(t, `/api/v1/follow_requests/${t.r}/reject`)
		expect((await lane(t)).map((row) => [row.type, row.object])).toEqual([
			['Create', expect.any(String)],
			['Reject', first.id],
		])
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ reason: 'follow-requested' })
		expect(answers(await drain(t))).toEqual([])
		expect(await sql(t.store, 'SELECT state, uri FROM follows WHERE account_id = ?', t.r)).toEqual([
			{ state: 'pending', uri: second.id },
		])
		await api(t, `/api/v1/follow_requests/${t.r}/authorize`)
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	it('an unlock acceptance not yet claimed is cancelled by Undo then Follow, which is accepted at once', async () => {
		const t = await setup({ locked: true })
		await outage(t)
		const first = await followFrom(t)
		expect(first.result).toMatchObject({ applied: true })
		const unlocked = await t.w.h.request(
			'/api/v1/accounts/update_credentials',
			bearer(t.w.alice.token, { ...json({ locked: false }), method: 'PATCH' })
		)
		expect(unlocked.status).toBe(200)
		await t.store.runInboundJobs(BUILD, { now: NOW })
		expect((await lane(t)).map((row) => [row.type, row.object])).toContainEqual(['Accept', first.id])
		expect(await undoFrom(t, first.id)).toMatchObject({ applied: true })
		const second = await followFrom(t)
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	it('Undo Follow, then Follow: only the new Accept', async () => {
		const t = await setup()
		await outage(t)
		const first = await followFrom(t)
		expect(await undoFrom(t, first.id)).toMatchObject({ applied: true })
		const second = await followFrom(t)
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	// A request stored before this version (a converted or older row) with an answer of an earlier generation queued:
	// a renewal of the pending request cancels it too.
	it('a pending request renewed: the earlier generation’s Accept goes, and the request keeps waiting', async () => {
		const t = await setup()
		await outage(t)
		const first = await followFrom(t)
		const pending = followId()
		await sql(
			t.store,
			"UPDATE follows SET state = 'pending', uri = ? WHERE account_id = ? AND target_account_id = ?",
			pending,
			t.r,
			t.w.alice.id
		)
		expect((await lane(t)).map((row) => [row.type, row.object])).toContainEqual(['Accept', first.id])
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ reason: 'follow-request-updated' })
		expect(answers(await drain(t))).toEqual([])
		expect(await sql(t.store, 'SELECT state, uri FROM follows WHERE account_id = ?', t.r)).toEqual([
			{ state: 'pending', uri: second.id },
		])
	})
})

describe('lanes after a cancellation', () => {
	it('deletes queued rows on both sides of a surviving row behind a surviving head; no promotion', async () => {
		const t = await setup()
		await outage(t)
		const first = await followFrom(t)
		await post(t.w.h, t.w.alice, { status: 'between' })
		await api(t, `/api/v1/accounts/${t.r}/block`)
		await api(t, `/api/v1/accounts/${t.r}/unblock`)
		expect((await lane(t)).map((row) => [row.type, row.object === first.id, row.state])).toEqual([
			['Create', false, 'pending'],
			['Accept', true, 'queued'],
			['Create', false, 'queued'],
			['Reject', true, 'queued'],
			['Block', false, 'queued'],
			['Undo', false, 'queued'],
		])
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true })
		const after = await lane(t)
		expect(after.map((row) => [row.type, row.state, row.exposed])).toEqual([
			['Create', 'pending', 1],
			['Create', 'queued', 0],
			['Block', 'queued', 0],
			['Undo', 'queued', 0],
			['Accept', 'queued', 0],
		])
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	it('deletes a pending head never claimed and promotes the oldest row behind it; new work is admitted queued', async () => {
		const t = await setup()
		const first = await followFrom(t)
		await post(t.w.h, t.w.alice, { status: 'behind' })
		expect((await lane(t)).map((row) => [row.type, row.object, row.state])).toEqual([
			['Accept', first.id, 'pending'],
			['Create', expect.any(String), 'queued'],
		])
		const second = await followFrom(t)
		expect((await lane(t)).map((row) => [row.type, row.object, row.state])).toEqual([
			['Create', expect.any(String), 'pending'],
			['Accept', second.id, 'queued'],
		])
		expect(await claimOnce(t, OK)).toEqual(['Create'])
		expect(await claimOnce(t, OK)).toEqual(['Accept'])
		expect(await lane(t)).toEqual([])
	})

	it('removes an answer still in an unexpanded chunk; later expansion sends nothing older for the pair', async () => {
		const t = await setup()
		await wideFollow(t)
		// The Create's second chunk was expanded with the Accept's recording; the Accept's own chunk waits.
		const chunked = await sql<{ type: string }>(
			t.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type FROM outbound_targets c
			JOIN outbound_activities o ON o.id = c.activity_id ORDER BY c.id`
		)
		expect(chunked).toEqual([{ type: 'Accept' }])
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true })
		const sent = await drain(t)
		expect(answers(sent)).toEqual([['Accept', second.id]])
		expect(await sql(t.store, 'SELECT * FROM outbound_targets')).toEqual([])
		expect(await sql(t.store, 'SELECT * FROM outbound_activities')).toEqual([])
		expect(sent.filter(([type]) => type === 'Create')).toHaveLength(200)
	})
})

// `count` remote followers of alice, each on a server of its own (a lane each), whose names sort before remote.example.
async function manyFollowers(t: T, count: number): Promise<void> {
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		SELECT printf('%018d', 900000000000000000 + i), 'https://d' || printf('%03d', i) || '.example/u', 'u',
			'd' || printf('%03d', i) || '.example', 'https://d' || printf('%03d', i) || '.example/u/inbox',
			'https://d' || printf('%03d', i) || '.example/inbox'
		FROM n`,
		count
	)
	await sql(
		t.store,
		`INSERT INTO follows (account_id, target_account_id, state)
		SELECT id, ?, 'accepted' FROM accounts WHERE domain GLOB 'd[0-9][0-9][0-9].example'`,
		t.w.alice.id
	)
}

// 199 followers on lanes of their own and s: alice's Create has 200 targets, two chunks, the first expanded as it is
// recorded. r's Follow then records an Accept whose expansion budget the Create's second chunk uses up, so the Accept
// waits unexpanded, behind a Create to remote.example that no claim has taken.
async function wideFollow(t: T) {
	await manyFollowers(t, 199)
	await post(t.w.h, t.w.alice, { status: 'wide' })
	return followFrom(t)
}

describe('a renewal cancels every answer of the pair that is not leased, claimed before or not', () => {
	it.each<[string, (t: T) => Promise<void>]>([
		['failed and pending', async (t) => void (await claimOnce(t, FAIL))],
		['given up after a claim', async (t) => void (await claimOnce(t, FORBIDDEN))],
		[
			'retried by the operator',
			async (t) => {
				await claimOnce(t, FORBIDDEN)
				const [row] = await sql<{ id: string }>(t.store, 'SELECT CAST(id AS TEXT) AS id FROM deliveries')
				expect(await t.store.retryDeliveries(BUILD, { ids: [row!.id], now: NOW })).toMatchObject({ retried: 1 })
			},
		],
		[
			'moved to the personal inbox after the shared one answered 404',
			async (t) => {
				await claimOnce(t, missing(404))
				expect(await sql(t.store, 'SELECT inbox_url, state FROM deliveries')).toEqual([
					{ inbox_url: `${t.rUri}/inbox`, state: 'pending' },
				])
			},
		],
	])('%s', async (_, expose) => {
		const t = await setup()
		const first = await followFrom(t)
		await expose(t)
		const [old] = await lane(t)
		expect([old!.type, old!.object, old!.exposed, old!.superseded]).toEqual(['Accept', first.id, 1, 0])
		const warn = vi.spyOn(console, 'warn')
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true, reason: 'follow-reaccepted' })
		// Before any drain: the old row and its intent are gone, and the renewal's Accept is the lane's only row.
		expect((await lane(t)).map((row) => [row.object, row.exposed, row.superseded])).toEqual([[second.id, 0, 0]])
		expect(await sql(t.store, 'SELECT 1 FROM deliveries WHERE id = ?', old!.id)).toEqual([])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM outbound_activities WHERE follow_pair IS NOT NULL')).toEqual([
			{ n: 1 },
		])
		expect(warn).toHaveBeenCalledWith({ event: STALE_EVENT, type: 'Accept', at: 'cancel' })
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	it.each<[string, (t: T) => Promise<void>]>([
		['leased', async (t) => void (await claimOnce(t, null))],
		[
			'claimed again after its lease expired',
			async (t) => {
				await claimOnce(t, null)
				expect(await claimOnce(t, null, NOW + LEASE_MS + 1)).toEqual(['Accept'])
			},
		],
	])('keeps an answer %s, superseded, and the renewal’s Accept waits behind it', async (_, expose) => {
		const t = await setup()
		const first = await followFrom(t)
		await expose(t)
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true, reason: 'follow-reaccepted' })
		expect((await lane(t)).map((row) => [row.object, row.state, row.exposed, row.superseded])).toEqual([
			[first.id, 'leased', 1, 1],
			[second.id, 'queued', 0, 0],
		])
	})

	it('leaves the operator nothing to retry of a cancelled answer', async () => {
		const t = await setup()
		await outage(t)
		await followFrom(t)
		const [row] = await sql<{ id: string }>(
			t.store,
			'SELECT CAST(d.id AS TEXT) AS id FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE o.follow_pair IS NOT NULL'
		)
		await followFrom(t)
		expect(await sql(t.store, 'SELECT 1 FROM deliveries WHERE id = ?', row!.id)).toEqual([])
		expect(await t.store.retryDeliveries(BUILD, { ids: [row!.id], now: NOW })).toMatchObject({ ok: true, retried: 0 })
	})

	it('cancels an exposed Accept before a locked account’s new request, which waits for the owner', async () => {
		const t = await setup()
		const first = await followFrom(t)
		expect(await claimOnce(t, FAIL)).toEqual(['Accept'])
		expect(await undoFrom(t, first.id)).toMatchObject({ applied: true })
		await sql(t.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.w.alice.id)
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ reason: 'follow-requested' })
		// The exposed Accept, pending its retry, goes with the renewal; Kopje's edge waits for the owner.
		expect(answers(await drain(t))).toEqual([])
		expect(await sql(t.store, 'SELECT state FROM follows WHERE account_id = ?', t.r)).toEqual([{ state: 'pending' }])
		await api(t, `/api/v1/follow_requests/${t.r}/authorize`)
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	// Neither the exposed Accept nor the withdrawing Reject that would have countered it reaches the new request.
	it('cancels an exposed old Accept and an unexposed withdrawing Reject before a new locked request', async () => {
		const t = await setup()
		const first = await followFrom(t)
		expect(await claimOnce(t, FAIL)).toEqual(['Accept'])
		await api(t, `/api/v1/accounts/${t.r}/block`)
		await api(t, `/api/v1/accounts/${t.r}/unblock`)
		await sql(t.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', t.w.alice.id)
		expect((await lane(t)).map((row) => [row.type, row.object, row.exposed])).toEqual([
			['Accept', first.id, 1],
			['Reject', first.id, 0],
			['Block', t.rUri, 0],
			['Undo', expect.any(String), 0],
		])
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ reason: 'follow-requested' })
		expect((await drain(t)).map(([type, object]) => [type, object === first.id])).toEqual([
			['Block', false],
			['Undo', false],
		])
		expect(await sql(t.store, 'SELECT state FROM follows WHERE account_id = ?', t.r)).toEqual([{ state: 'pending' }])
	})
})

describe('bounds and refusals (RES-6)', () => {
	// A pair history an imported or upgraded store may hold (a Follow of this version cancels every given-up answer
	// before it records its own): `intents` superseded answers of alice's to r, each with a given-up row a claim took.
	async function history(t: T, intents: number) {
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO outbound_activities (id, account_id, body, object_uri, superseded, created_at, follow_pair)
			SELECT i, ?1, '{"activity":{"type":"Accept"},"audience":{"followers":false,"accounts":[]}}', 'x' || i, 1, 0, ?2
			FROM n`,
			t.w.alice.id,
			t.r,
			intents
		)
		await sql(
			t.store,
			`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, exposed)
			SELECT id, account_id, 'https://remote.example/inbox', 'https://remote.example', 'gave_up', 0, ?, 1
			FROM outbound_activities WHERE follow_pair IS NOT NULL`,
			NOW
		)
	}

	it(
		'answers 503 with nothing written over the intent bound; the sweep clears given-up superseded answers',
		{ timeout: 120_000 },
		async () => {
			const t = await setup()
			await history(t, FOLLOW_ANSWER_INTENTS + 1)
			const unsettled = await sql<{ superseded: number; state: string; exposed: number }>(
				t.store,
				`SELECT o.superseded, d.state, d.exposed FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id
				WHERE o.follow_pair = ?`,
				t.r
			)
			expect(unsettled).toHaveLength(FOLLOW_ANSWER_INTENTS + 1)
			expect(unsettled.every((row) => row.superseded === 1 && row.state === 'gave_up' && row.exposed === 1)).toBe(true)
			const before = await snapshot(t.store)
			const refused = await followFrom(t)
			expect(refused.result).toMatchObject({ applied: false, reason: 'follow-answer-backlog', retry: true })
			expect(await snapshot(t.store)).toEqual(before)
			// The 30-day retention does not hold a history over the cap: the next sweep deletes it, and the redelivered
			// Follow applies.
			expect(await t.store.sweepDeliveries(BUILD, { now: NOW })).toEqual({ swept: FOLLOW_ANSWER_INTENTS + 1 })
			expect(await sql(t.store, 'SELECT * FROM outbound_activities WHERE follow_pair IS NOT NULL')).toEqual([])
			const again = await receive(t.store, t.rUri, { id: refused.id, type: 'Follow', object: t.aliceUri })
			expect(again).toMatchObject({ applied: true, reason: 'followed' })
			expect(answers(await drain(t))).toEqual([['Accept', refused.id]])
		}
	)

	it('clears a given-up history within the intent bound at once: its rows and intents go with the Follow', async () => {
		const t = await setup()
		await history(t, FOLLOW_ANSWER_INTENTS)
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true, reason: 'followed' })
		// What is left is the renewal's Accept alone.
		expect((await lane(t)).map((row) => [row.object, row.state, row.superseded])).toEqual([[second.id, 'pending', 0]])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM deliveries')).toEqual([{ n: 1 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM outbound_activities')).toEqual([{ n: 1 }])
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
		expect(await t.store.sweepDeliveries(BUILD, { now: NOW })).toEqual({ swept: 0 })
	})

	// More candidates than one round's 500 rows: 300 given-up rows of superseded answers (an imported history) and 300
	// ordinary given-up rows past the retention. The answers go first, and the retention takes only what is left.
	it('shares the sweep budget with the 30-day retention, answers first', async () => {
		const t = await setup()
		const old = NOW - 31 * 24 * 60 * 60 * 1000
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
			INSERT INTO outbound_activities (id, account_id, body, object_uri, superseded, created_at, follow_pair)
			SELECT i, ?1, '{"activity":{"type":"Accept"},"audience":{"followers":false,"accounts":[]}}', 'x' || i,
				i <= 300, 0, CASE WHEN i <= 300 THEN ?2 END
			FROM n`,
			t.w.alice.id,
			t.r
		)
		await sql(
			t.store,
			`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, exposed)
			SELECT id, account_id, 'https://remote.example/inbox', 'https://remote.example', 'gave_up', 0,
				CASE WHEN id <= 300 THEN ?1 ELSE ?2 END, 1
			FROM outbound_activities`,
			NOW,
			old
		)
		const left = async () =>
			sql<{ answers: number; others: number }>(
				t.store,
				`SELECT count(*) FILTER (WHERE activity_id <= 300) AS answers,
					count(*) FILTER (WHERE activity_id > 300) AS others
				FROM deliveries`
			)
		expect(await t.store.sweepDeliveries(BUILD, { now: NOW })).toEqual({ swept: 500 })
		expect(await left()).toEqual([{ answers: 0, others: 100 }])
		expect(await t.store.sweepDeliveries(BUILD, { now: NOW })).toEqual({ swept: 100 })
		expect(await sql(t.store, 'SELECT * FROM outbound_activities')).toEqual([])
	})

	// Stored state no Follow of this version leaves (each answer has one target): an imported store's answer with more
	// rows (each exposed, pending a retry, its own lane's head) or chunks than the bounds.
	it.each([
		['rows', FOLLOW_ANSWER_ROWS + 1, 0],
		['unexpanded chunks', 0, FOLLOW_ANSWER_CHUNKS + 1],
	])('answers 503 with nothing written over the bound of %s', async (_, rows, chunks) => {
		const t = await setup()
		await sql(
			t.store,
			`INSERT INTO outbound_activities (id, account_id, body, object_uri, created_at, follow_pair)
			VALUES (77, ?, '{"activity":{"type":"Accept"},"audience":{"followers":false,"accounts":[]}}', 'x', 0, ?)`,
			t.w.alice.id,
			t.r
		)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, exposed)
			SELECT 77, ?1, 'https://e' || i || '.example/inbox', 'https://e' || i || '.example', 'pending', 0, 0, 1
			FROM n WHERE ?2 > 0`,
			t.w.alice.id,
			rows
		)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO outbound_targets (activity_id, targets) SELECT 77, '[]' FROM n WHERE ?1 > 0`,
			chunks
		)
		const before = await snapshot(t.store)
		expect((await followFrom(t)).result).toMatchObject({ reason: 'follow-answer-backlog', retry: true })
		expect(await snapshot(t.store)).toEqual(before)
		// One fewer fits.
		await sql(t.store, 'DELETE FROM deliveries WHERE id = (SELECT max(id) FROM deliveries)')
		await sql(t.store, 'DELETE FROM outbound_targets WHERE id = (SELECT max(id) FROM outbound_targets)')
		expect((await followFrom(t)).result).toMatchObject({ applied: true })
		// At the bound, every row (FOLLOW_ANSWER_ROWS exposed pending ones) and chunk is cancelled, and the intent goes.
		expect(await sql(t.store, 'SELECT count(*) AS n FROM deliveries WHERE activity_id = 77')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT * FROM outbound_targets WHERE activity_id = 77')).toEqual([])
		expect(await sql(t.store, 'SELECT * FROM outbound_activities WHERE id = 77')).toEqual([])
	})

	it('cancels nothing for a duplicate Follow or a renewal at the retraction cap', async () => {
		const t = await setup()
		await outage(t)
		const first = await followFrom(t)
		const before = await snapshot(t.store)
		expect((await followFrom(t, first.id)).result).toMatchObject({ applied: false, reason: 'duplicate' })
		expect(await snapshot(t.store)).toEqual(before)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?1, ?1 || '/gone/' || i, ?3 FROM n`,
			t.rUri,
			MAX_RETRACTIONS_PER_ACTOR,
			LATER
		)
		const capped = await snapshot(t.store)
		expect((await followFrom(t)).result).toMatchObject({ applied: false, reason: 'retraction-cap' })
		expect(await snapshot(t.store)).toEqual(capped)
		expect((await lane(t)).map((row) => [row.type, row.object])).toContainEqual(['Accept', first.id])
	})

	it('cancels nothing for a Follow the target refuses (it blocks the follower)', async () => {
		const t = await setup()
		await outage(t)
		const first = await followFrom(t)
		await api(t, `/api/v1/accounts/${t.r}/block`)
		const refused = await followFrom(t)
		expect(refused.result).toMatchObject({ applied: true, reason: 'follow-rejected' })
		expect((await lane(t)).map((row) => [row.type, row.object])).toEqual([
			['Create', expect.any(String)],
			['Accept', first.id],
			['Reject', first.id],
			['Block', t.rUri],
			['Reject', refused.id],
		])
	})

	it('seeks the pair’s answers through their indexes, in the statements the discovery runs', async () => {
		const t = await setup()
		const plan = async (query: string, ...params: SqlStorageValue[]) =>
			(await sql<{ detail: string }>(t.store, `EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => row.detail)
		expect(await plan(FOLLOW_ANSWER_INTENTS_SQL, '1', '2', 33)).toEqual([
			'SEARCH o USING COVERING INDEX outbound_activities_follow_pair (account_id=? AND follow_pair=?)',
		])
		for (const query of [FOLLOW_ANSWER_ROWS_SQL, FOLLOW_ANSWER_CHUNKS_SQL]) {
			const detail = await plan(query, '[1]', 65)
			expect(detail.join('\n')).toMatch(/USING (COVERING )?INDEX (deliveries|outbound_targets)_activity/)
			expect(detail.join('\n')).not.toContain('TEMP B-TREE')
		}
	})

	it("keeps those seeks with statistics taken before other activities' rows grew (RES-7)", async () => {
		const t = await setup()
		await outage(t)
		await followFrom(t)
		const discovery = readOperation<{ signer: string; follower: string }, unknown>((db, { signer, follower }) =>
			followAnswersOf(db, signer, follower)
		)
		const run = () =>
			plannedRun(t.w.h, /FROM (deliveries|outbound_targets)\b/, discovery, { signer: t.w.alice.id, follower: t.r })
		const { before, after } = await staleStatistics(t.w.h, {
			capture: () => run(),
			grow: async () => {
				// Other activities of alice's, each with rows and unexpanded targets.
				await sql(
					t.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
					INSERT INTO outbound_activities (id, account_id, body, object_uri, superseded, created_at)
					SELECT 1000000 + i, ?1, '{"activity":{"type":"Like"},"audience":{"followers":false,"accounts":[]}}', 'x', 0, 0
					FROM n`,
					t.w.alice.id
				)
				await sql(
					t.store,
					`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
					SELECT id, account_id, 'https://o' || id || '.example/inbox', 'https://o' || id || '.example', 'gave_up', 0, 0
					FROM outbound_activities WHERE id > 1000000`
				)
				await sql(
					t.store,
					`INSERT INTO outbound_targets (activity_id, targets) SELECT id, '[]' FROM outbound_activities WHERE id > 1000000`
				)
			},
		})
		expect(after.result).toEqual(before.result)
		expect(after.result).toMatchObject({ intents: [expect.any(String)], rows: [{ state: 'queued' }] })
		expect(after.plans.map((p) => p.plan)).toEqual([
			[
				'SEARCH deliveries USING INDEX deliveries_activity (activity_id=?)',
				'LIST SUBQUERY 1',
				'SCAN json_each VIRTUAL TABLE INDEX 1:',
			],
			[
				'SEARCH outbound_targets USING COVERING INDEX outbound_targets_activity (activity_id=?)',
				'LIST SUBQUERY 1',
				'SCAN json_each VIRTUAL TABLE INDEX 1:',
			],
		])
		for (const [i, { plan, rows }] of after.plans.entries()) {
			expect(scansOf(plan, ['deliveries', 'outbound_targets'])).toEqual([])
			// One entry past the activities' own in each index at most.
			expect(rows - before.plans[i]!.rows).toBeLessThanOrEqual(1)
		}
	}, 60_000)

	// An imported pair history far past the bound: the discovery reads the same rows as at the bound, then refuses.
	it('reads a bounded number of rows however long the pair’s history is, before its 503', async () => {
		const discovery = readOperation<{ signer: string; follower: string }, unknown>((db, { signer, follower }) =>
			followAnswersOf(db, signer, follower)
		)
		const read = async (intents: number) => {
			const t = await setup()
			await history(t, intents)
			const rows = await rowsRead(t.w.h, discovery, { signer: t.w.alice.id, follower: t.r })
			expect((await followFrom(t)).result).toMatchObject({ reason: 'follow-answer-backlog', retry: true })
			return rows
		}
		const atBound = await read(FOLLOW_ANSWER_INTENTS + 1)
		expect(await read(5_000)).toBe(atBound)
		expect(atBound).toBeLessThanOrEqual(2 * (FOLLOW_ANSWER_INTENTS + 1))
	}, 120_000)
})

describe('a refused Follow rolls back the whole request', () => {
	it('keeps the actor document and keys a 503 Follow refreshed as they were', async () => {
		const t = await inboxSetup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, {
			'@context': AS,
			id: `${bob.uri}#follows/dave`,
			type: 'Follow',
			actor: bob.uri,
			object: DAVE_URI,
		})
		const [stored] = await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri)
		// FOLLOW_ANSWER_INTENTS + 1 unsettled answers of alice's to bob (an imported history).
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO outbound_activities (account_id, body, object_uri, superseded, created_at, follow_pair)
			SELECT ?1, '{"activity":{"type":"Accept"},"audience":{"followers":false,"accounts":[]}}', 'x' || i, 1, 0, ?2
			FROM n`,
			ALICE,
			stored!.id,
			FOLLOW_ANSWER_INTENTS + 1
		)
		// The stored key is stale, so the Follow fetches the actor anew, whose document has changed.
		await sql(t.store, 'UPDATE remote_keys SET fetched_at = 0')
		const accountsBefore = await sql(t.store, 'SELECT * FROM accounts WHERE uri = ?', bob.uri)
		const keysBefore = await sql(t.store, 'SELECT * FROM remote_keys')
		bob.document.name = 'renamed'
		t.web.serve(bob.uri, bob.document)
		t.web.fetched.length = 0
		const refused = {
			'@context': AS,
			id: `${bob.uri}#follows/alice`,
			type: 'Follow',
			actor: bob.uri,
			object: ALICE_URI,
		}
		expect(await t.post(bob, refused)).toBe(503)
		expect(t.web.fetched).toContain(bob.uri)
		expect(await sql(t.store, 'SELECT * FROM accounts WHERE uri = ?', bob.uri)).toEqual(accountsBefore)
		expect(await sql(t.store, 'SELECT * FROM remote_keys')).toEqual(keysBefore)
		expect(await sql(t.store, 'SELECT 1 FROM follows WHERE target_account_id = ?', ALICE)).toEqual([])
	})
})

describe('cancellation against claims and expansion, in both serialized orders', () => {
	const testEnv = { ...env, USER_KEK: LEGACY.kek } as unknown as Env

	// alice signs with the legacy fixture key, so a delivery round can load her signer.
	async function signed(): Promise<T> {
		const t = await setup()
		await signAsLegacy(t.store, t.w.alice.id)
		return t
	}

	// A fetch that records each body sent to remote.example, then answers it with `answer`'s status (given how many
	// were sent there, this one included; 202 by default). Any other POST answers 202.
	function recording(answer: (count: number) => Promise<number> | number = () => 202) {
		const sent: { type: string; object: { id?: string } }[] = []
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			if (new URL(request.url).origin !== REMOTE) {
				return new Response(null, { status: 202 })
			}
			sent.push(JSON.parse(await request.text()) as (typeof sent)[number])
			return new Response(null, { status: await answer(sent.length) })
		}
		return { fetch, sent }
	}

	// A round held at a gate: before its claim (`claim`), or after it, at the host check before confirmation ('host').
	function heldRound(store: StoreStub, fetch: typeof globalThis.fetch, at: 'claim' | 'host') {
		const { checkHost: hold, reached, release } = gatedHost()
		const gated = new Proxy(store, {
			get(target, name) {
				if (name === 'claimDeliveries' && at === 'claim') {
					return async (...args: Parameters<StoreStub['claimDeliveries']>) => {
						await hold()
						return target.claimDeliveries(...args)
					}
				}
				if (typeof name !== 'string' || name === 'then') {
					return undefined
				}
				const methods = target as unknown as Record<string, (...a: unknown[]) => unknown>
				return (...args: unknown[]) => methods[name]!(...args)
			},
		})
		let hostHeld = false
		const round = deliveryRound(testEnv, {
			...deliveryDeps(
				() => gated,
				fetch,
				() => NOW
			),
			checkHost: async () => {
				if (at === 'host' && !hostHeld) {
					hostHeld = true
					await hold()
				}
			},
		})
		return { reached, release, round }
	}

	// A round for `t` after the held one, with its own recording fetch: what it POSTs to remote.example.
	async function nextRound(t: T): Promise<(string | undefined)[][]> {
		const { fetch, sent } = recording()
		await deliveryRound(
			testEnv,
			deliveryDeps(
				() => t.store,
				fetch,
				() => NOW,
				`next-${++lease}`
			)
		)
		return sent.map((body) => [body.type, body.object.id])
	}

	// Runs `body` while `held` waits at its gate, then releases it and awaits its round even when `body` throws, so a
	// failed assertion never leaves a round pending into a later test: what `body` returned, and the round's result.
	async function whileHeld<R, B>(
		held: { release: () => void; round: Promise<R> },
		body: () => Promise<B>
	): Promise<{ value: B; round: R }> {
		let value: B
		try {
			value = await body()
		} finally {
			held.release()
			await held.round.catch(() => undefined)
		}
		return { value, round: await held.round }
	}

	it('a claim that commits first leases the old Accept, which its confirmation drops unsent', async () => {
		const t = await signed()
		const first = await followFrom(t)
		const { fetch, sent } = recording()
		const held = heldRound(t.store, fetch, 'host')
		const warn = vi.spyOn(console, 'warn')
		const { value: second, round } = await whileHeld(held, async () => {
			await held.reached
			const [old] = await lane(t)
			expect([old!.object, old!.state, old!.exposed]).toEqual([first.id, 'leased', 1])
			const renewal = await followFrom(t)
			expect(renewal.result).toMatchObject({ applied: true })
			return renewal
		})
		expect(round.settled).toEqual(['dropped'])
		expect(sent).toEqual([])
		expect(warn).toHaveBeenCalledWith({ event: STALE_EVENT, type: 'Accept', at: 'confirm' })
		// The confirmation deleted the old row and promoted the renewal's Accept, which the next round sends.
		expect((await lane(t)).map((row) => [row.object, row.state])).toEqual([[second.id, 'pending']])
		expect(await nextRound(t)).toEqual([['Accept', second.id]])
	})

	// A recording fetch that holds the first POST to remote.example, once recorded, until released, then answers it
	// `status`; every later POST answers 202.
	function heldPost(status: number) {
		const reached = deferred()
		const release = deferred()
		const { fetch, sent } = recording(async (count) => {
			if (count > 1) {
				return 202
			}
			reached.resolve()
			await release.promise
			return status
		})
		return { fetch, sent, reached: reached.promise, release: release.resolve }
	}

	it.each([
		[202, 'delivered', 'sent_in_flight'],
		[500, 'dropped', 'failure'],
	])(
		'an answer confirmed before the renewal commits is POSTed once (answered %i), and the renewal waits for it',
		async (status, settled, at) => {
			const t = await signed()
			const first = await followFrom(t)
			const post = heldPost(status)
			const round = deliveryRound(
				testEnv,
				deliveryDeps(
					() => t.store,
					post.fetch,
					() => NOW
				)
			)
			const warn = vi.spyOn(console, 'warn')
			const { value: second, round: result } = await whileHeld({ release: post.release, round }, async () => {
				await post.reached
				const renewal = await followFrom(t)
				expect(renewal.result).toMatchObject({ applied: true })
				// While the POST is held, the old row keeps its lane and the renewal's Accept waits queued behind it.
				expect((await lane(t)).map((row) => [row.object, row.state, row.superseded])).toEqual([
					[first.id, 'leased', 1],
					[renewal.id, 'queued', 0],
				])
				return renewal
			})
			expect(result.settled).toEqual([settled])
			// Before another claim could settle it: the old row is gone (no retry, nothing given up), and the renewal's
			// Accept is the lane's head.
			expect((await lane(t)).map((row) => [row.object, row.state])).toEqual([[second.id, 'pending']])
			expect(warn).toHaveBeenCalledWith({ event: STALE_EVENT, type: 'Accept', at })
			await deliveryRound(
				testEnv,
				deliveryDeps(
					() => t.store,
					post.fetch,
					() => NOW,
					`after-${++lease}`
				)
			)
			expect(post.sent.map((body) => [body.type, body.object.id])).toEqual([
				['Accept', first.id],
				['Accept', second.id],
			])
		}
	)

	it('a cancellation that commits first leaves the claim nothing older to send', async () => {
		const t = await signed()
		const first = await followFrom(t)
		const { fetch, sent } = recording()
		const held = heldRound(t.store, fetch, 'claim')
		const { value: second } = await whileHeld(held, async () => {
			await held.reached
			const renewal = await followFrom(t)
			expect(renewal.result).toMatchObject({ applied: true })
			expect((await lane(t)).map((row) => row.object)).toEqual([renewal.id])
			return renewal
		})
		expect(sent.map((body) => [body.type, body.object.id])).toEqual([['Accept', second.id]])
		expect(sent.map((body) => body.object.id)).not.toContain(first.id)
	})

	it('an expansion that commits first leaves a queued row, which the cancellation deletes', async () => {
		const t = await signed()
		const first = await wideFollow(t)
		const { fetch, sent } = recording()
		const held = heldRound(t.store, fetch, 'host')
		const { value: second } = await whileHeld(held, async () => {
			await held.reached
			// The claim expanded the Accept behind the lane's Create, which it did not lease (16 earlier lanes were due).
			expect((await lane(t)).map((row) => [row.type, row.state, row.exposed])).toEqual([
				['Create', 'pending', 0],
				['Accept', 'queued', 0],
			])
			const renewal = await followFrom(t)
			expect(renewal.result).toMatchObject({ applied: true })
			expect((await lane(t)).map((row) => [row.type, row.object === first.id])).toEqual([
				['Create', false],
				['Accept', false],
			])
			return renewal
		})
		expect(sent).toEqual([])
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})

	it('a cancellation that commits first deletes the unexpanded chunk before the claim expands it', async () => {
		const t = await signed()
		await wideFollow(t)
		const { fetch, sent } = recording()
		const held = heldRound(t.store, fetch, 'claim')
		const { value: second } = await whileHeld(held, async () => {
			await held.reached
			const renewal = await followFrom(t)
			expect(renewal.result).toMatchObject({ applied: true })
			return renewal
		})
		expect(sent).toEqual([])
		expect(answers(await drain(t))).toEqual([['Accept', second.id]])
	})
})

// The Store's own steps for a lease the renewal superseded (STALE_ANSWER in deliveries.ts), each before any later
// confirmation could mask it: the claim after the lease expired, and a completion after a confirmation granted before
// the renewal committed.
describe('a superseded answer under lease gets no further attempt', () => {
	// alice's Accept of r's first Follow, leased by a claim under a token of its own.
	async function leased(t: T) {
		const first = await followFrom(t)
		const token = `held-${++lease}`
		const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: token })
		expect(claim.deliveries).toHaveLength(1)
		return { first, token, id: claim.deliveries[0]!.id }
	}

	it.each([
		['its lease expired', false],
		['its lease expired with its attempts used up', true],
	])('the claim drops it when %s, and the first lease is stale', async (_, exhausted) => {
		const t = await setup()
		const { token, id } = await leased(t)
		const second = await followFrom(t)
		if (exhausted) {
			await sql(t.store, 'UPDATE deliveries SET attempts = ? WHERE id = ?', MAX_ATTEMPTS, id)
		}
		const warn = vi.spyOn(console, 'warn')
		const later = NOW + LEASE_MS + 1
		const claim = await t.store.claimDeliveries(BUILD, { now: later, leaseToken: `held-${++lease}` })
		expect(claim.deliveries).toEqual([])
		expect(warn).toHaveBeenCalledWith({ event: STALE_EVENT, type: 'Accept', at: 'claim' })
		// Neither leased again (no attempt counted) nor given up: deleted, and the renewal's Accept promoted.
		expect(await sql(t.store, 'SELECT 1 FROM deliveries WHERE id = ?', id)).toEqual([])
		expect((await lane(t)).map((row) => [row.object, row.state])).toEqual([[second.id, 'pending']])
		expect(await t.store.confirmDelivery(BUILD, { id, leaseToken: token, now: later })).toEqual({ status: 'stale' })
		expect(await t.store.completeDelivery(BUILD, { id, leaseToken: token, now: later, outcome: FAIL })).toMatchObject({
			status: 'stale',
		})
	})

	it.each<[string, DeliveryOutcome, number]>([
		['a transient failure', FAIL, 0],
		['a permanent 403', FORBIDDEN, 0],
		['the shared inbox answering 404', missing(404), 0],
		['the shared inbox answering 405', missing(405), 0],
		['the shared inbox answering 410', missing(410), 0],
		['a transient failure of its last attempt', FAIL, MAX_ATTEMPTS - 1],
	])('a completion drops it on %s', async (_, outcome, attempts) => {
		const t = await setup()
		const first = await followFrom(t)
		await sql(t.store, 'UPDATE deliveries SET attempts = ?', attempts)
		const token = `held-${++lease}`
		const [delivery] = (await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: token })).deliveries
		const id = delivery!.id
		expect(await t.store.confirmDelivery(BUILD, { id, leaseToken: token, now: NOW })).toMatchObject({ status: 'send' })
		const second = await followFrom(t)
		expect((await lane(t)).map((row) => [row.object, row.state, row.superseded])).toEqual([
			[first.id, 'leased', 1],
			[second.id, 'queued', 0],
		])
		const warn = vi.spyOn(console, 'warn')
		expect(await t.store.completeDelivery(BUILD, { id, leaseToken: token, now: NOW, outcome })).toEqual({
			status: 'dropped',
			nextDueAt: NOW,
		})
		expect(warn).toHaveBeenCalledWith({ event: STALE_EVENT, type: 'Accept', at: 'failure' })
		// Not retried, moved to the personal inbox or given up: deleted with its intent, the renewal's Accept promoted.
		expect(await sql(t.store, 'SELECT 1 FROM deliveries WHERE id = ?', id)).toEqual([])
		expect((await lane(t)).map((row) => [row.object, row.state])).toEqual([[second.id, 'pending']])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM outbound_activities WHERE follow_pair IS NOT NULL')).toEqual([
			{ n: 1 },
		])
	})

	it('a block’s withdrawing Reject supersedes a leased Accept, which its confirmation drops; the Reject is sent', async () => {
		const t = await setup()
		const { first, token, id } = await leased(t)
		await api(t, `/api/v1/accounts/${t.r}/block`)
		// supersede() marked the Accept before any confirmation (no newer Follow is involved).
		expect((await lane(t)).map((row) => [row.type, row.object, row.state, row.superseded])).toEqual([
			['Accept', first.id, 'leased', 1],
			['Reject', first.id, 'queued', 0],
			['Block', t.rUri, 'queued', 0],
		])
		expect(await t.store.confirmDelivery(BUILD, { id, leaseToken: token, now: NOW })).toMatchObject({
			status: 'dropped',
		})
		expect(await drain(t)).toEqual([
			['Reject', first.id],
			['Block', t.rUri],
		])
	})

	it('a withdrawing Reject (a retraction) that a renewal superseded under its lease is dropped too', async () => {
		const t = await setup()
		const first = await followFrom(t)
		expect(await claimOnce(t, OK)).toEqual(['Accept'])
		await api(t, `/api/v1/accounts/${t.r}/block`)
		const token = `held-${++lease}`
		const [delivery] = (await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: token })).deliveries
		await api(t, `/api/v1/accounts/${t.r}/unblock`)
		const second = await followFrom(t)
		expect(second.result).toMatchObject({ applied: true, reason: 'followed' })
		const [reject] = await lane(t)
		expect([reject!.id, reject!.type, reject!.object, reject!.state, reject!.superseded]).toEqual([
			delivery!.id,
			'Reject',
			first.id,
			'leased',
			1,
		])
		expect(
			await sql(
				t.store,
				'SELECT o.retracts FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.id = ?',
				delivery!.id
			)
		).toEqual([{ retracts: 1 }])
		expect(await t.store.confirmDelivery(BUILD, { id: delivery!.id, leaseToken: token, now: NOW })).toMatchObject({
			status: 'dropped',
		})
		expect(await drain(t)).toEqual([
			['Block', t.rUri],
			['Undo', expect.any(String)],
			['Accept', second.id],
		])
	})
})

// A row leased under `token` at `now`, and one raw Store step on it: the claim once the lease has expired (it leases
// the row again, or drops it), the confirmation, or a failed completion (each answers its status).
type Leased = { store: StoreStub; id: string; token: string; now: number }
const STEPS = ['claim', 'confirm', 'failure'] as const

async function step(name: (typeof STEPS)[number], { store, id, token, now }: Leased): Promise<string> {
	switch (name) {
		case 'claim': {
			const claim = await store.claimDeliveries(BUILD, { now: now + LEASE_MS + 1, leaseToken: `held-${++lease}` })
			return claim.deliveries.some((d) => d.id === id) ? 'leased' : 'dropped'
		}
		case 'confirm':
			return (await store.confirmDelivery(BUILD, { id, leaseToken: token, now })).status
		case 'failure':
			return (await store.completeDelivery(BUILD, { id, leaseToken: token, now, outcome: FAIL })).status
	}
}

// An imported follow answer whose stored body has no activity type (missing, or null): the check rests on follow_pair
// and superseded alone, and the event names the type 'other'.
describe('a superseded imported answer without an activity type gets no further attempt', () => {
	const BODIES = {
		missing: { activity: { id: 'https://kopje.test/answers/1', object: { type: 'Follow' } } },
		null: { activity: { id: 'https://kopje.test/answers/1', type: null, object: { type: 'Follow' } } },
	}

	// The answer, leased at NOW, and a Create of alice's queued behind it in the lane.
	async function imported(body: unknown) {
		const t = await setup()
		await sql(
			t.store,
			`INSERT INTO outbound_activities (id, account_id, body, object_uri, superseded, created_at, follow_pair)
			VALUES (900, ?, json_set(?, '$.audience', json('{"followers":false,"accounts":[]}')), 'x', 1, 0, ?)`,
			t.w.alice.id,
			JSON.stringify(body),
			t.r
		)
		const token = `held-${++lease}`
		await sql(
			t.store,
			`INSERT INTO deliveries (id, activity_id, account_id, inbox_url, lane, state, lease_token, attempts,
				next_attempt_at, updated_at, exposed)
			VALUES (900, 900, ?, 'https://remote.example/inbox', 'https://remote.example', 'leased', ?, 1, ?, ?, 1)`,
			t.w.alice.id,
			token,
			NOW + LEASE_MS,
			NOW
		)
		await post(t.w.h, t.w.alice, { status: 'behind' })
		expect((await lane(t)).map((row) => [row.id, row.state])).toEqual([
			['900', 'leased'],
			[expect.any(String), 'queued'],
		])
		return { t, row: { store: t.store, id: '900', token, now: NOW } }
	}

	it.each((['missing', 'null'] as const).flatMap((type) => STEPS.map((name) => [type, name] as const)))(
		'type %s: dropped at the %s',
		async (type, name) => {
			const { t, row } = await imported(BODIES[type])
			const warn = vi.spyOn(console, 'warn')
			expect(await step(name, row)).toBe('dropped')
			expect(warn).toHaveBeenCalledWith({ event: STALE_EVENT, type: 'other', at: name })
			expect(await sql(t.store, 'SELECT 1 FROM deliveries WHERE id = 900')).toEqual([])
			expect((await lane(t)).map((row) => [row.type, row.state])).toEqual([['Create', 'pending']])
		}
	)
})

// A superseded activity that is not a follow answer (follow_pair NULL) is not refused by STALE_ANSWER. Each case
// runs a step on a real superseded row, leased and otherwise sendable; the control gives the same row a follow_pair,
// and the same step then drops it, so the step evaluated the predicate on that row.
describe('the follow-answer check leaves other superseded activities alone', () => {
	// alice's edit of a status s holds (its first Update), leased, then superseded by a second edit.
	async function supersededUpdate(): Promise<Leased> {
		const t = await setup()
		const status = await post(t.w.h, t.w.alice, { status: 'v1' })
		expect(answers(await drain(t))).toEqual([])
		const edit = async (text: string) => {
			const response = await t.w.h.request(
				`/api/v1/statuses/${status.id}`,
				bearer(t.w.alice.token, json({ status: text }, { method: 'PUT' }))
			)
			expect(response.status).toBe(200)
		}
		await edit('v2')
		const token = `held-${++lease}`
		const claim = await t.store.claimDeliveries(BUILD, { now: LATER, leaseToken: token })
		expect(claim.deliveries).toHaveLength(1)
		await edit('v3')
		const id = claim.deliveries[0]!.id
		expect(
			await sql(
				t.store,
				`SELECT json_extract(o.body, '$.activity.type') AS type, o.superseded, o.follow_pair
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.id = ?`,
				id
			)
		).toEqual([{ type: 'Update', superseded: 1, follow_pair: null }])
		return { store: t.store, id, token, now: LATER }
	}

	// alice's Accept of bob's QuoteRequest, leased, then superseded by her revoking the quote.
	async function supersededQuoteAccept(): Promise<Leased> {
		const t = await inboxSetup()
		const bob = await mastodonActor(t.web, 'bob')
		const mine = await localStatus(t, { status: 'quote me', visibility: 'public' })
		const note = quoting(bob, mine.uri, null)
		t.web.serve(note.id, { '@context': AS, ...note })
		const request = {
			'@context': [AS, { QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' }],
			id: `${bob.uri}/quote_requests/${nextId()}`,
			type: 'QuoteRequest',
			actor: bob.uri,
			object: mine.uri,
			instrument: note.id,
		}
		expect(await t.post(bob, request)).toBe(202)
		const token = `held-${++lease}`
		const claim = await t.store.claimDeliveries(BUILD, { now: LATER, leaseToken: token })
		const [accept] = await sql<{ id: string }>(
			t.store,
			`SELECT CAST(d.id AS TEXT) AS id FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
			WHERE json_extract(o.body, '$.activity.type') = 'Accept' AND d.state = 'leased'`
		)
		expect(claim.deliveries.map((d) => d.id)).toContain(accept!.id)
		const [quote] = await sql<{ id: string }>(t.store, 'SELECT id FROM statuses WHERE uri = ?', note.id)
		const revoked = await t.request(`/api/v1/statuses/${mine.id}/quotes/${quote!.id}/revoke`, {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		expect(revoked.status).toBe(200)
		expect(
			await sql(
				t.store,
				`SELECT json_extract(o.body, '$.activity.object.type') AS answers, o.superseded, o.follow_pair
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.id = ?`,
				accept!.id
			)
		).toEqual([{ answers: 'QuoteRequest', superseded: 1, follow_pair: null }])
		return { store: t.store, id: accept!.id, token, now: LATER }
	}

	const kept = { claim: 'leased', confirm: 'send', failure: 'retry' }

	it.each<[string, () => Promise<Leased>]>([
		['an Update', supersededUpdate],
		['an Accept of a QuoteRequest', supersededQuoteAccept],
	])(
		'%s is claimed again, confirmed and retried; with a follow_pair, each step drops it',
		async (_, make) => {
			for (const control of [false, true]) {
				for (const name of STEPS) {
					const row = await make()
					if (control) {
						await sql(
							row.store,
							`UPDATE outbound_activities SET follow_pair = 'pair'
						WHERE id = (SELECT activity_id FROM deliveries WHERE id = ?)`,
							row.id
						)
					}
					const label = `${name}, control ${control}`
					expect(await step(name, row), label).toBe(control ? 'dropped' : kept[name])
					expect(await sql(row.store, 'SELECT count(*) AS n FROM deliveries WHERE id = ?', row.id), label).toEqual([
						{ n: control ? 0 : 1 },
					])
				}
			}
		},
		60_000
	)
})
