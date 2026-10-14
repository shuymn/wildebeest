import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY } from './federation-helpers'
import { BUILD } from './helpers'
import { QueueSim } from './queue-sim'
import { act, community, post, remoteAccount, remoteFollows, seedStatus } from './status-helpers'
import * as deliveries from '../src/domain/deliveries'
import type { Claim, DeliveryOutcome } from '../src/domain/deliveries'
import { postActivity } from '../src/federation/delivery'
import { type DeliveryDeps, deliveryRound } from '../src/jobs/deliver'
import { handleQueue } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'
import { createKeyring } from '../src/security/keyring'

// Regressions from the B2 review: silent recipients on Misskey, lane order across a server's inboxes, wake-ups,
// retractions against outstanding deliveries, superseded retries, cascaded boost receipts, the delivery time budget,
// admission limits and the outbox count. Each case failed before its fix.

const OK: DeliveryOutcome = { kind: 'delivered', status: 202 }
// A permanent refusal: a 404, 405 or 410 from a shared inbox would move a Like to the personal inbox instead.
const REFUSED: DeliveryOutcome = { kind: 'failed', status: 403, error: 'HTTP 403', permanent: true }
const publicHost = () => Promise.resolve()

type Row = {
	id: string
	inbox_url: string
	state: string
	type: string
	last_error: string | null
}

function rows(store: StoreStub): Promise<Row[]> {
	return sql<Row>(
		store,
		`SELECT CAST(d.id AS TEXT) AS id, d.inbox_url, d.state, json_extract(o.body, '$.activity.type') AS type, d.last_error
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
	)
}

function claim(store: StoreStub, now: number, leaseToken: string): Promise<Claim> {
	return store.claimDeliveries(BUILD, { now, leaseToken })
}

function complete(store: StoreStub, id: string, leaseToken: string, now: number, outcome: DeliveryOutcome) {
	return store.completeDelivery(BUILD, { id, leaseToken, now, outcome })
}

// What Misskey's ApAudienceService makes of a Note's addressing: the persons named in to and cc, without Public and
// the followers collection, become visibleUsers of a `specified` note. The inbox it arrived at plays no part.
function misskeyVisibleUsers(note: { to?: string[]; cc?: string[] }): string[] {
	return [...(note.to ?? []), ...(note.cc ?? [])].filter(
		(uri) => !uri.endsWith('#Public') && !uri.endsWith('/followers')
	)
}

describe('silent recipients (VIS-2, VIS-3, VIS-7)', () => {
	it('sends each silent recipient a copy addressed to them alone, which Misskey can read', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteAccount(h.store, 'carol', 'carol.example')
		await remoteAccount(h.store, 'erin', 'misskey.example')
		const direct = await post(h, alice, {
			status: '@carol@carol.example @erin@misskey.example psst',
			visibility: 'direct',
		})
		// The Creates are in flight (one lane per server) when the edit removes both mentions; they stay addressed as
		// silent recipients.
		const claimed = await claim(h.store, NOW, 'a')
		await h.request(`/api/v1/statuses/${direct.id}`, bearer(alice.token, json({ status: 'edited' }, { method: 'PUT' })))
		// The Creates first (one lane per server); complete them to reach the Updates.
		for (const delivery of claimed.deliveries) {
			await complete(h.store, delivery.id, 'a', NOW, OK)
		}
		const updates = (await claim(h.store, NOW, 'b')).deliveries
		const byInbox = new Map(updates.map((d) => [d.inbox, JSON.parse(d.body) as Record<string, unknown>]))
		const carol = byInbox.get('https://carol.example/users/carol/inbox') as {
			to: string[]
			object: { to: string[]; tag: { href: string }[] }
		}
		const erin = byInbox.get('https://misskey.example/users/erin/inbox') as typeof carol
		expect(carol.to).toEqual(['https://carol.example/users/carol'])
		expect(misskeyVisibleUsers(carol.object)).toEqual(['https://carol.example/users/carol'])
		expect(misskeyVisibleUsers(erin.object)).toEqual(['https://misskey.example/users/erin'])
		// Each copy names only its own recipient, and never as a Mention.
		expect(JSON.stringify(carol)).not.toContain('erin')
		expect(JSON.stringify(erin)).not.toContain('carol')
		expect(carol.object.tag).toEqual([])
		expect(JSON.parse(JSON.stringify(carol))).toMatchObject({
			type: 'Update',
			object: { type: 'Note', updated: expect.any(String) },
		})
		// What Mastodon's Update handler needs: the same object id, attributed to the actor of the Update.
		expect(carol).toMatchObject({
			actor: 'https://kopje.test/ap/users/alice',
			object: { id: direct.uri, attributedTo: 'https://kopje.test/ap/users/alice' },
		})
	})

	it('never names a silent recipient in the copy for the followers', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'carol.example'), alice.id)
		const status = await post(h, alice, { status: '@carol@carol.example hi', visibility: 'private' })
		// The Create is in flight when the edit comes, so the server will have the object: the edit goes as an Update.
		await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'in-flight' })
		await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'no mention' }, { method: 'PUT' }))
		)
		const all = await sql<{ inbox_url: string; type: string; body: string }>(
			h.store,
			`SELECT d.inbox_url, json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity') AS body
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE type = 'Update' ORDER BY d.id`
		)
		expect(all.map((r) => r.inbox_url)).toEqual([
			'https://carol.example/users/carol/inbox',
			'https://carol.example/inbox',
		])
		expect(all[1]?.body).not.toContain('https://carol.example/users/carol"')
		expect(carol).toBeDefined()
	})
})

describe('lane order across a server (NET-2)', () => {
	it("keeps a Create to a server's shared inbox ahead of an Update to a personal inbox there", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteAccount(h.store, 'carol', 'carol.example')
		const direct = await post(h, alice, { status: '@carol@carol.example psst', visibility: 'direct' })
		// The Create is in flight when the edit comes, so the server will have the object: the edit goes as an Update.
		await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'in-flight' })
		await h.request(`/api/v1/statuses/${direct.id}`, bearer(alice.token, json({ status: 'edited' }, { method: 'PUT' })))
		expect((await rows(h.store)).map((r) => [r.type, r.inbox_url, r.state])).toEqual([
			['Create', 'https://carol.example/inbox', 'leased'],
			['Update', 'https://carol.example/users/carol/inbox', 'queued'],
		])
	})
})

function roundDeps(store: StoreStub, fetch: typeof globalThis.fetch, now = () => NOW): DeliveryDeps {
	let n = 0
	return {
		build: () => env.CF_VERSION_METADATA.id,
		store: () => store,
		now,
		fetch,
		checkHost: publicHost,
		leaseToken: () => `lease-${++n}`,
	}
}

function batchOf(count: number) {
	const messages = Array.from({ length: count }, (_, i) => ({
		id: `m${i}`,
		body: { kind: 'deliver' },
		timestamp: new Date(NOW),
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}))
	return { queue: 'kopje', messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch
}

async function signAsLegacy(store: StoreStub, accountId: string) {
	await sql(
		store,
		'UPDATE local_accounts SET privkey = ?, privkey_salt = ?, pubkey = ? WHERE account_id = ?',
		LEGACY.privkey.slice().buffer,
		LEGACY.salt.slice().buffer,
		LEGACY.pubkey,
		accountId
	)
}

describe('wake-ups', () => {
	it('drains a lane of many activities from its own doorbells, without the cron or more API traffic', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await signAsLegacy(h.store, alice.id)
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		for (let i = 0; i < 10; i++) {
			await post(h, alice, { status: `post ${i}` })
		}
		const queue = new QueueSim()
		const fetch = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 202 }))
		) as unknown as typeof globalThis.fetch
		const deps = roundDeps(h.store, fetch)
		const testEnv = { ...env, USER_KEK: LEGACY.kek, QUEUE: queue.queue } as unknown as Env
		await handleQueue(batchOf(1), testEnv, { build: deps.build, store: deps.store, delivery: deps })
		for (let i = 0; i < 20 && queue.pending.length > 0; i++) {
			const due = queue.pending.splice(0)
			expect(due.every((m) => m.delaySeconds === 0)).toBe(true)
			await handleQueue(batchOf(due.length), testEnv, { build: deps.build, store: deps.store, delivery: deps })
		}
		expect(fetch).toHaveBeenCalledTimes(10)
		expect(await rows(h.store)).toEqual([])
	})

	it('wakes again for work an expired lease gave up and promoted', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		await post(h, alice, { status: 'first' })
		await post(h, alice, { status: 'second' })
		await sql(
			h.store,
			`UPDATE deliveries SET attempts = ${deliveries.MAX_ATTEMPTS}, state = 'leased', lease_token = 'x' WHERE state = 'pending'`
		)
		const result = await claim(h.store, NOW, 'y')
		expect(result.deliveries).toEqual([])
		expect(result.nextDueAt).toBe(NOW)
	})
})

describe('retractions against outstanding deliveries (VIS-3)', () => {
	it('sends a Delete to inboxes whose Create is still leased, and keeps no receipt of it', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		const other = await remoteAccount(h.store, 'other', 'other.example')
		await remoteFollows(h.store, fan, alice.id)
		await remoteFollows(h.store, other, alice.id)
		const status = await post(h, alice, { status: 'soon gone', visibility: 'private' })
		const leased = await claim(h.store, NOW, 'a')
		expect(leased.deliveries).toHaveLength(2)
		// other leaves while its Create is in flight; then the status is deleted.
		await sql(h.store, 'DELETE FROM follows WHERE account_id = ?', other)
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect((await rows(h.store)).map((r) => [r.type, r.inbox_url, r.state])).toEqual([
			['Create', 'https://fans.example/inbox', 'leased'],
			['Create', 'https://other.example/inbox', 'leased'],
			['Delete', 'https://fans.example/inbox', 'queued'],
			['Delete', 'https://other.example/inbox', 'queued'],
		])
		// other's Create succeeds; fans' POST succeeds too but its completion is lost, and it is claimed again.
		const otherCreate = leased.deliveries.find((d) => d.inbox === 'https://other.example/inbox')
		await complete(h.store, otherCreate?.id ?? '', 'a', NOW, OK)
		const again = await claim(h.store, NOW + deliveries.LEASE_MS, 'b')
		expect(again.deliveries.map((d) => (JSON.parse(d.body) as { type: string }).type).sort()).toEqual([
			'Create',
			'Delete',
		])
		for (const delivery of again.deliveries) {
			await complete(h.store, delivery.id, 'b', NOW + deliveries.LEASE_MS, OK)
		}
		const last = await claim(h.store, NOW + deliveries.LEASE_MS, 'c')
		for (const delivery of last.deliveries) {
			await complete(h.store, delivery.id, 'c', NOW + deliveries.LEASE_MS, OK)
		}
		expect(await rows(h.store)).toEqual([])
		expect(await sql(h.store, 'SELECT status_id FROM outbound_receipts')).toEqual([])
	})

	it('retires the receipts of local boosts that go with a deleted original', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), bob.id)
		const original = await post(h, alice, { status: 'boost me' })
		await act(h, bob, `/api/v1/statuses/${original.id}/reblog`)
		const leased = await claim(h.store, NOW, 'a')
		for (const delivery of leased.deliveries) {
			await complete(h.store, delivery.id, 'a', NOW, OK)
		}
		expect(await sql(h.store, 'SELECT count(*) AS n FROM outbound_receipts')).toEqual([{ n: 1 }])
		await h.request(`/api/v1/statuses/${original.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect(await sql(h.store, 'SELECT status_id FROM outbound_receipts')).toEqual([])
	})
})

describe('operator retry of superseded activities (RES-5)', () => {
	it('refuses to retry a Like that its Undo has superseded, sent or not', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		const theirs = await seedStatus(h.store, {
			accountId: dave,
			visibility: 'public',
			uri: 'https://remote.example/n/1',
		})
		await act(h, alice, `/api/v1/statuses/${theirs}/favourite`)
		const like = await claim(h.store, NOW, 'a')
		await complete(h.store, like.deliveries[0]?.id ?? '', 'a', NOW, REFUSED)
		await act(h, alice, `/api/v1/statuses/${theirs}/unfavourite`)
		const likeId = like.deliveries[0]?.id ?? ''
		expect(await h.store.retryDeliveries(BUILD, { ids: [likeId], now: NOW })).toEqual({
			ok: false,
			code: 'superseded',
			ids: [likeId],
		})
		// The Undo is delivered and gone; the Like is still superseded.
		const undo = await claim(h.store, NOW, 'b')
		await complete(h.store, undo.deliveries[0]?.id ?? '', 'b', NOW, OK)
		expect(await h.store.retryDeliveries(BUILD, { ids: [likeId], now: NOW })).toMatchObject({ ok: false })
		expect(await h.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })).toEqual({
			ok: true,
			retried: 0,
			skipped: 1,
			refused: 0,
			more: false,
			next: null,
		})
		expect((await rows(h.store)).map((r) => [r.type, r.state])).toEqual([['Like', 'gave_up']])
	})
})

describe('delivery time budget (NET-2, RES-6)', () => {
	const sign = async () =>
		(
			await createKeyring(LEGACY.kek).signerFor({
				...LEGACY,
				keyId: new URL('https://kopje.test/ap/users/alice#main-key'),
			})
		).sign
	const body = JSON.stringify({ type: 'Like' })

	it('counts slow DNS and slow key loading against the budget, and never POSTs late', async () => {
		const fetch = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 202 }))
		) as unknown as typeof globalThis.fetch
		const slowDns = () => new Promise<void>((resolve) => setTimeout(resolve, 100))
		const deps = { fetch, checkHost: slowDns, userAgent: 'Kopje/test', timeoutMs: 20, now: () => Date.now() }
		const target = { inbox: 'https://slow.example/inbox', body, signer: sign, deadline: Date.now() + 60_000 }
		expect(await postActivity(deps, target)).toMatchObject({ kind: 'failed', permanent: false })
		const slowKey = () => new Promise<never>(() => {})
		expect(await postActivity({ ...deps, checkHost: publicHost }, { ...target, signer: slowKey })).toMatchObject({
			kind: 'failed',
			permanent: false,
		})
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(fetch).not.toHaveBeenCalled()
	})

	it('refuses to send once the lease budget has run out', async () => {
		const fetch = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 202 }))
		) as unknown as typeof globalThis.fetch
		const deps = { fetch, checkHost: publicHost, userAgent: 'Kopje/test', now: () => NOW }
		const target = { inbox: 'https://remote.example/inbox', body, signer: sign, deadline: NOW }
		expect(await postActivity(deps, target)).toMatchObject({ kind: 'failed', error: 'lease budget exhausted' })
		expect(fetch).not.toHaveBeenCalled()
	})

	it('a round sends nothing once its lease has run out', async () => {
		const h = await community(['alice'])
		await signAsLegacy(h.store, h.users.alice.id)
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), h.users.alice.id)
		await post(h, h.users.alice, { status: 'hello' })
		const fetch = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 202 }))
		) as unknown as typeof globalThis.fetch
		let calls = 0
		// The clock jumps past the lease right after the claim.
		const now = () => (calls++ === 0 ? NOW : NOW + deliveries.LEASE_MS)
		await deliveryRound({ ...env, USER_KEK: LEGACY.kek } as unknown as Env, roundDeps(h.store, fetch, now))
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe('admission limits (RES-4, RES-6)', () => {
	it('gives up new work for a lane over its cap, visibly', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		await post(h, alice, { status: 'first' })
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT (SELECT max(id) FROM outbound_activities), ?, 'https://fans.example/inbox', 'https://fans.example', 'queued', 0, 0
			FROM n`,
			deliveries.MAX_LANE_BACKLOG,
			alice.id
		)
		await post(h, alice, { status: 'one too many' })
		const last = (await rows(h.store)).at(-1)
		expect(last).toMatchObject({ state: 'gave_up', last_error: 'backlog full' })
		const report = await h.store.deliveriesReport(BUILD, {})
		expect(report.gaveUp[0]).toMatchObject({ lastError: 'backlog full' })
	})

	it('gives up new work once the whole backlog is at its cap', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		await post(h, alice, { status: 'first' })
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT (SELECT max(id) FROM outbound_activities), ?, 'https://s' || i || '.example/inbox', 'https://s' || i || '.example',
				'pending', 0, 0 FROM n`,
			deliveries.MAX_BACKLOG,
			alice.id
		)
		await post(h, alice, { status: 'over the total cap' })
		expect((await rows(h.store)).at(-1)).toMatchObject({ state: 'gave_up', last_error: 'backlog full' })
	})

	it('expands a large audience in bounded steps, in activity order', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const servers = deliveries.EXPANSION_STEP * 2 + 10
		for (let i = 0; i < servers; i++) {
			await remoteFollows(h.store, await remoteAccount(h.store, `f${i}`, `server${i}.example`), alice.id)
		}
		await post(h, alice, { status: 'to many servers' })
		expect(await rows(h.store)).toHaveLength(deliveries.EXPANSION_STEP)
		await post(h, alice, { status: 'second' })
		// The second post's transaction expands one more step, of the first post: nothing of the second is written
		// before the first is fully expanded.
		const afterSecond = await rows(h.store)
		expect(afterSecond).toHaveLength(deliveries.EXPANSION_STEP * 2)
		expect(new Set(afterSecond.map((r) => r.type))).toEqual(new Set(['Create']))
		expect(new Set(await sql(h.store, 'SELECT DISTINCT activity_id FROM deliveries')).size).toBe(1)
		const first = await claim(h.store, NOW, 'a')
		expect(first.nextDueAt).toBe(NOW)
		for (let i = 0; i < 6; i++) {
			await claim(h.store, NOW, `x${i}`)
		}
		const all = await rows(h.store)
		expect(all).toHaveLength(servers * 2)
		const lane0 = all.filter((r) => r.inbox_url === 'https://server0.example/inbox')
		const lastLane = all.filter((r) => r.inbox_url === `https://server${servers - 1}.example/inbox`)
		expect(lane0.map((r) => r.state)).toEqual(['leased', 'queued'])
		expect(Number(lastLane[0]?.id)).toBeLessThan(Number(lastLane[1]?.id))
	}, 30_000)
})

describe('outbox count', () => {
	it('counts only for the collection, not for every page', async () => {
		const h = await community(['alice'])
		await post(h, h.users.alice, { status: 'hello' })
		const page = await h.store.outbox(BUILD, { username: 'alice', before: '~' })
		expect(page?.total).toBeNull()
		expect(page?.items).toHaveLength(1)
		expect((await h.store.outbox(BUILD, { username: 'alice', before: null }))?.total).toBe(1)
	})
})
