import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY } from './federation-helpers'
import { BUILD, claimSent, type SentClaim } from './helpers'
import { act, community, post, remoteAccount, remoteFollows } from './status-helpers'
import { getOutbox } from '../src/domain/activities'
import * as deliveries from '../src/domain/deliveries'
import type { DeliveryOutcome } from '../src/domain/deliveries'
import { postActivity } from '../src/federation/delivery'
import { type DeliveryDeps, deliveryRound } from '../src/jobs/deliver'
import type { StoreStub } from '../src/platform/store-client'
import { createKeyring } from '../src/security/keyring'

// Regressions from the verification of the B2 fixes: retractions at the admission caps, Undo of boosts that cascade
// with their original, Creates for destinations that never received one, silent copies only at personal inboxes,
// retries through admission, `retry --all` past superseded rows, the absolute POST deadline, cross-origin lane
// promotion, retraction targets in every state, copies as sent on the wire, and outbox pages without a count.

const OK: DeliveryOutcome = { kind: 'delivered', status: 202 }
const GONE: DeliveryOutcome = { kind: 'failed', status: 410, error: 'HTTP 410', permanent: true }
const publicHost = () => Promise.resolve()

type Row = {
	id: string
	activity_id: string
	inbox_url: string
	state: string
	type: string
	last_error: string | null
	body: string
}

function rows(store: StoreStub): Promise<Row[]> {
	return sql<Row>(
		store,
		`SELECT CAST(d.id AS TEXT) AS id, CAST(d.activity_id AS TEXT) AS activity_id, d.inbox_url, d.state,
			json_extract(o.body, '$.activity.type') AS type, d.last_error, json_extract(o.body, '$.activity') AS body
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
	)
}

function claim(store: StoreStub, now: number, leaseToken: string): Promise<SentClaim> {
	return claimSent(store, { now, leaseToken })
}

function complete(store: StoreStub, id: string, leaseToken: string, now: number, outcome: DeliveryOutcome) {
	return store.completeDelivery(BUILD, { id, leaseToken, now, outcome })
}

// Claims and settles every due row with `outcome` until nothing is due.
async function settleAll(store: StoreStub, outcome: (inbox: string) => DeliveryOutcome = () => OK) {
	for (let i = 0; i < 50; i++) {
		const claimed = await claim(store, NOW, `settle-${i}`)
		if (claimed.deliveries.length === 0) {
			return
		}
		for (const delivery of claimed.deliveries) {
			await complete(store, delivery.id, `settle-${i}`, NOW, outcome(delivery.inbox))
		}
	}
}

async function unfollow(store: StoreStub, followerId: string) {
	await sql(store, 'DELETE FROM follows WHERE account_id = ?', followerId)
}

// Filler rows that occupy a lane or the whole backlog, attached to a placeholder activity.
async function fill(store: StoreStub, accountId: string, count: number, lane: (i: string) => string) {
	await sql(
		store,
		`INSERT INTO outbound_activities (id, account_id, body, created_at) VALUES (999999, ?, '{"activity":{},"audience":{}}', 0)
		ON CONFLICT DO NOTHING`,
		accountId
	)
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
		SELECT 999999, ?, ${lane('i')} || '/inbox', ${lane('i')}, 'queued', 0, 0 FROM n`,
		count,
		accountId
	)
}

describe('retractions at the admission caps (RES-4, VIS-3)', () => {
	it('admits up to the lane cap exactly, refuses after it, and never refuses a Delete', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		const delivered = await post(h, alice, { status: 'delivered, then deleted' })
		await settleAll(h.store)
		await fill(h.store, alice.id, deliveries.MAX_LANE_BACKLOG - 1, () => "'https://fans.example'")
		await post(h, alice, { status: 'the last one that fits' })
		expect((await rows(h.store)).at(-1)).toMatchObject({ type: 'Create', state: 'queued' })
		await post(h, alice, { status: 'one too many' })
		expect((await rows(h.store)).at(-1)).toMatchObject({ state: 'gave_up', last_error: 'backlog full' })
		await h.request(`/api/v1/statuses/${delivered.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect((await rows(h.store)).at(-1)).toMatchObject({ type: 'Delete', state: 'queued', last_error: null })
	})

	it('admits up to the total cap exactly, refuses after it, and never refuses an Undo', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const dave = await remoteAccount(h.store, 'dave', 'remote.example')
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		const theirs = await post(h, alice, { status: 'mine' })
		await act(h, alice, `/api/v1/statuses/${theirs.id}/reblog`)
		await settleAll(h.store)
		await fill(h.store, alice.id, deliveries.MAX_BACKLOG - 1, (i) => `'https://s' || ${i} || '.example'`)
		await post(h, alice, { status: 'the last one that fits' })
		expect((await rows(h.store)).at(-1)).toMatchObject({ type: 'Create', state: 'pending' })
		await post(h, alice, { status: 'one too many' })
		expect((await rows(h.store)).at(-1)).toMatchObject({ state: 'gave_up', last_error: 'backlog full' })
		await act(h, alice, `/api/v1/statuses/${theirs.id}/unreblog`)
		expect((await rows(h.store)).at(-1)).toMatchObject({ type: 'Undo', last_error: null })
		expect((await rows(h.store)).at(-1)?.state).not.toBe('gave_up')
		expect(dave).toBeDefined()
	})
})

describe('boosts that cascade with their original (VIS-3)', () => {
	// Alice has no remote followers; Bob boosts her post to his. Deleting her post must undo his boost everywhere it
	// went or may still go, whatever state its delivery is in.
	async function boosted() {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const original = await post(h, alice, { status: 'boost me' })
		return { h, alice, bob, original }
	}

	async function undoTargets(store: StoreStub) {
		return (await rows(store)).filter((r) => r.type === 'Undo').map((r) => r.inbox_url)
	}

	it('undoes a delivered boost', async () => {
		const { h, alice, bob, original } = await boosted()
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, bob.id)
		await act(h, bob, `/api/v1/statuses/${original.id}/reblog`)
		await settleAll(h.store)
		await unfollow(h.store, fan)
		await h.request(`/api/v1/statuses/${original.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect(await undoTargets(h.store)).toEqual(['https://fans.example/inbox'])
		const undo = JSON.parse((await rows(h.store)).find((r) => r.type === 'Undo')?.body ?? '{}') as {
			actor: string
			object: { type: string }
		}
		expect(undo).toMatchObject({ actor: 'https://kopje.test/ap/users/bob', object: { type: 'Announce' } })
		expect(await sql(h.store, 'SELECT status_id FROM outbound_receipts')).toEqual([])
	})

	it('undoes a leased and a queued boost', async () => {
		const { h, alice, bob, original } = await boosted()
		const leased = await remoteAccount(h.store, 'leased', 'leased.example')
		const queued = await remoteAccount(h.store, 'queued', 'queued.example')
		await remoteFollows(h.store, leased, bob.id)
		await post(h, bob, { status: 'ahead in queued.example only' })
		await sql(h.store, "DELETE FROM deliveries WHERE inbox_url = 'https://leased.example/inbox'")
		await remoteFollows(h.store, queued, bob.id)
		await act(h, bob, `/api/v1/statuses/${original.id}/reblog`)
		await claim(h.store, NOW, 'in-flight')
		await unfollow(h.store, leased)
		await unfollow(h.store, queued)
		await h.request(`/api/v1/statuses/${original.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect((await undoTargets(h.store)).sort()).toEqual([
			'https://leased.example/inbox',
			'https://queued.example/inbox',
		])
	})

	it('undoes a boost whose targets are not expanded yet', async () => {
		const { h, alice, bob, original } = await boosted()
		const servers = deliveries.EXPANSION_STEP + 5
		const followers: string[] = []
		for (let i = 0; i < servers; i++) {
			followers.push(await remoteAccount(h.store, `f${i}`, `server${i}.example`))
			await remoteFollows(h.store, followers[i] ?? '', bob.id)
		}
		await act(h, bob, `/api/v1/statuses/${original.id}/reblog`)
		for (const follower of followers) {
			await unfollow(h.store, follower)
		}
		await h.request(`/api/v1/statuses/${original.id}`, bearer(alice.token, { method: 'DELETE' }))
		await claim(h.store, NOW, 'expand-1')
		await claim(h.store, NOW, 'expand-2')
		await claim(h.store, NOW, 'expand-3')
		expect(new Set(await undoTargets(h.store)).size).toBe(servers)
	})
})

describe('a destination that never received the Create (VIS-3)', () => {
	it('gets a Create of the current version and then the Update after a failed Create and an edit', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		await remoteFollows(h.store, await remoteAccount(h.store, 'ok', 'ok.example'), alice.id)
		const status = await post(h, alice, { status: 'first version' })
		await settleAll(h.store, (inbox) => (new URL(inbox).origin === 'https://fans.example' ? GONE : OK))
		await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'second version' }, { method: 'PUT' }))
		)
		const after = await rows(h.store)
		expect(after.map((r) => [r.type, r.inbox_url, r.state])).toEqual([
			['Create', 'https://fans.example/inbox', 'pending'],
			['Update', 'https://fans.example/inbox', 'queued'],
			['Update', 'https://ok.example/inbox', 'pending'],
		])
		const create = JSON.parse(after[0]?.body ?? '{}') as { id: string; object: { id: string; content: string } }
		expect(create).toMatchObject({ id: `${status.uri}/activity`, object: { id: status.uri } })
		expect(create.object.content).toContain('second version')
	})

	it('replaces a Create still queued for it with the current version, followed by the Update', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		const status = await post(h, alice, { status: 'first version' })
		await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'second version' }, { method: 'PUT' }))
		)
		const after = await rows(h.store)
		expect(after.map((r) => [r.type, r.inbox_url])).toEqual([
			['Create', 'https://fans.example/inbox'],
			['Update', 'https://fans.example/inbox'],
		])
		expect(after[0]?.body).toContain('second version')
	})
})

describe('silent copies only at personal inboxes (VIS-2, VIS-3)', () => {
	it('sends nothing to a silent recipient without a personal inbox, visibly, and keeps the shared copy neutral', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		await sql(h.store, 'UPDATE accounts SET inbox_url = NULL WHERE id = ?', carol)
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'carol.example'), alice.id)
		const status = await post(h, alice, { status: '@carol@carol.example hi', visibility: 'private' })
		await settleAll(h.store)
		await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'no mention' }, { method: 'PUT' }))
		)
		const updates = (await rows(h.store)).filter((r) => r.type === 'Update')
		expect(updates.map((r) => [r.inbox_url, r.state, r.last_error])).toEqual([
			['', 'gave_up', 'no personal inbox'],
			['https://carol.example/inbox', 'pending', null],
		])
		const shared = (await claim(h.store, NOW, 'x')).deliveries.find((d) => d.inbox === 'https://carol.example/inbox')
		expect(shared?.body).not.toContain('https://carol.example/users/carol"')
		const report = await h.store.deliveriesReport(BUILD, {})
		expect(report.gaveUp[0]).toMatchObject({
			lastError: 'no personal inbox',
			addressee: 'https://carol.example/users/carol',
		})
		expect(await h.store.retryDeliveries(BUILD, { ids: [updates[0]?.id ?? ''], now: NOW })).toMatchObject({ ok: false })
	})
})

describe('operator retries (RES-4, RES-5)', () => {
	it('go through admission: a retry over the lane cap stays given up', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		await fill(h.store, alice.id, deliveries.MAX_LANE_BACKLOG, () => "'https://fans.example'")
		await post(h, alice, { status: 'refused' })
		const refused = (await rows(h.store)).at(-1)
		expect(refused).toMatchObject({ state: 'gave_up', last_error: 'backlog full' })
		expect(await h.store.retryDeliveries(BUILD, { ids: [refused?.id ?? ''], now: NOW })).toMatchObject({
			ok: true,
			retried: 0,
			refused: 1,
		})
		expect((await rows(h.store)).at(-1)).toMatchObject({ state: 'gave_up' })
		await sql(h.store, 'DELETE FROM deliveries WHERE activity_id = 999999')
		expect(await h.store.retryDeliveries(BUILD, { ids: [refused?.id ?? ''], now: NOW })).toMatchObject({ retried: 1 })
	})

	it('`all` reaches eligible rows behind a full batch of superseded ones', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const batch = (deliveries as { RETRY_BATCH?: number }).RETRY_BATCH ?? 1000
		await sql(
			h.store,
			`INSERT INTO outbound_activities (id, account_id, body, superseded, created_at)
			VALUES (1, ?1, '{"activity":{"type":"Like"},"audience":{}}', 1, 0),
				(2, ?1, '{"activity":{"type":"Create"},"audience":{}}', 0, 0)`,
			alice.id
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT 1, ?, 'https://s' || i || '.example/inbox', 'https://s' || i || '.example', 'gave_up', 0, 0 FROM n`,
			batch,
			alice.id
		)
		await sql(
			h.store,
			`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			VALUES (2, ?, 'https://late.example/inbox', 'https://late.example', 'gave_up', 0, 0)`,
			alice.id
		)
		expect(await h.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })).toMatchObject({ ok: true, retried: 1 })
	})
})

describe('the `all` cursor (RES-5)', () => {
	it('continues past a full batch from the cursor it returns', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(
			h.store,
			`INSERT INTO outbound_activities (id, account_id, body, created_at) VALUES (1, ?, '{"activity":{"type":"Create"},"audience":{}}', 0)`,
			alice.id
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT 1, ?, 'https://s' || i || '.example/inbox', 'https://s' || i || '.example', 'gave_up', 0, 0 FROM n`,
			deliveries.RETRY_BATCH + 1,
			alice.id
		)
		const first = await h.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })
		expect(first).toMatchObject({ ok: true, retried: deliveries.RETRY_BATCH, more: true })
		const next = first.ok ? (first.next ?? undefined) : undefined
		expect(await h.store.retryDeliveries(BUILD, { ids: 'all', now: NOW, after: next })).toMatchObject({
			retried: 1,
			more: false,
		})
	})
})

describe('the absolute POST deadline (NET-2)', () => {
	it('sends nothing once the clock passes the timeout, even before the abort timer fires', async () => {
		const fetch = vi.fn(() =>
			Promise.resolve(new Response(null, { status: 202 }))
		) as unknown as typeof globalThis.fetch
		let clock = NOW
		const sign = (await createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: new URL('https://kopje.test/a#k') }))
			.sign
		const signer = () => {
			// Key loading took longer than the 30 s timeout; the timer callback has not run yet.
			clock = NOW + 31_000
			return Promise.resolve(sign)
		}
		const result = await postActivity(
			{ fetch, checkHost: publicHost, userAgent: 'Kopje/test', timeoutMs: 30_000, now: () => clock },
			{ inbox: 'https://remote.example/inbox', body: '{}', signer, deadline: NOW + 50_000 }
		)
		expect(result).toMatchObject({ kind: 'failed', error: 'lease budget exhausted' })
		expect(fetch).not.toHaveBeenCalled()
	})
})

describe('lane promotion across a server (NET-2)', () => {
	// A Create at carol.example's shared inbox, then an Update to carol's personal inbox (her mention was removed),
	// and another server's lane alongside.
	async function lanes() {
		const h = await community(['alice'])
		const { alice } = h.users
		await remoteAccount(h.store, 'carol', 'carol.example')
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'fans.example'), alice.id)
		const status = await post(h, alice, { status: '@carol@carol.example hi', visibility: 'private' })
		// The Creates are in flight when the edit comes, and their servers are recorded as having the status (as a
		// delivered Create's receipt does), so the edit goes as Updates queued behind them.
		const leased = await claim(h.store, NOW, 'a')
		await sql(
			h.store,
			`INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT ?, value, ?, 0 FROM json_each(?)`,
			status.id,
			alice.id,
			JSON.stringify(leased.deliveries.map((d) => d.inbox))
		)
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, json({ status: 'edited' }, { method: 'PUT' })))
		const head = leased.deliveries.find((d) => d.inbox === 'https://carol.example/inbox')
		return { h, head }
	}

	const states = async (store: StoreStub) =>
		Object.fromEntries(
			(await rows(store)).filter((r) => r.state !== 'gave_up').map((r) => [`${r.type} ${r.inbox_url}`, r.state])
		)

	it.each([
		['completion', OK],
		['permanent failure', GONE],
	] as const)('promotes the personal successor after %s, and leaves other servers alone', async (_name, outcome) => {
		const { h, head } = await lanes()
		expect(await states(h.store)).toMatchObject({
			'Update https://carol.example/users/carol/inbox': 'queued',
			'Create https://fans.example/inbox': 'leased',
			'Update https://fans.example/inbox': 'queued',
		})
		await complete(h.store, head?.id ?? '', 'a', NOW, outcome)
		expect(await states(h.store)).toMatchObject({
			'Update https://carol.example/users/carol/inbox': 'pending',
			'Create https://fans.example/inbox': 'leased',
			'Update https://fans.example/inbox': 'queued',
		})
	})

	it('promotes the personal successor when an expired lease gives up', async () => {
		const { h, head } = await lanes()
		await sql(h.store, `UPDATE deliveries SET attempts = ${deliveries.MAX_ATTEMPTS} WHERE id = ?`, head?.id ?? '')
		await claim(h.store, NOW + deliveries.LEASE_MS, 'b')
		const after = await rows(h.store)
		expect(after.find((r) => r.id === head?.id)?.state).toBe('gave_up')
		expect(after.find((r) => r.inbox_url === 'https://carol.example/users/carol/inbox')?.state).not.toBe('queued')
	})
})

describe('retraction targets in every state (VIS-3)', () => {
	it('sends the Delete to delivered, leased, queued, given-up and unexpanded receivers', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const names = ['delivered', 'leased', 'gaveup', 'queued']
		const ids: Record<string, string> = {}
		for (const name of names) {
			ids[name] = await remoteAccount(h.store, name, `${name}.example`)
		}
		await remoteFollows(h.store, ids.delivered ?? '', alice.id)
		await remoteFollows(h.store, ids.gaveup ?? '', alice.id)
		await post(h, alice, { status: 'earlier, holds queued.example' })
		await sql(h.store, 'DELETE FROM deliveries')
		await sql(h.store, 'DELETE FROM outbound_activities')
		const status = await post(h, alice, { status: 'to be deleted' })
		await settleAll(h.store, (inbox) => (new URL(inbox).origin === 'https://gaveup.example' ? GONE : OK))
		await remoteFollows(h.store, ids.leased ?? '', alice.id)
		await remoteFollows(h.store, ids.queued ?? '', alice.id)
		await post(h, alice, { status: 'occupies queued.example' })
		await sql(h.store, "DELETE FROM deliveries WHERE inbox_url <> 'https://queued.example/inbox'")
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, json({ status: 'edited' }, { method: 'PUT' })))
		await claim(h.store, NOW, 'lease-leased')
		for (const name of names) {
			await unfollow(h.store, ids[name] ?? '')
		}
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: 'DELETE' }))
		const deletes = (await rows(h.store)).filter((r) => r.type === 'Delete').map((r) => new URL(r.inbox_url).hostname)
		expect(deletes.sort()).toEqual(['delivered.example', 'gaveup.example', 'leased.example', 'queued.example'])
	})
})

describe('copies as sent on the wire (VIS-2, VIS-7)', () => {
	// Misskey keeps the first Create of a note it processes, and its audience is the persons in to and cc.
	function misskeyAudience(note: { to?: string[]; cc?: string[] }) {
		return [...(note.to ?? []), ...(note.cc ?? [])].filter((u) => !u.endsWith('#Public') && !u.endsWith('/followers'))
	}

	it('POSTs each silent recipient a copy naming only them, and everyone else a neutral copy', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(
			h.store,
			'UPDATE local_accounts SET privkey = ?, privkey_salt = ?, pubkey = ? WHERE account_id = ?',
			LEGACY.privkey.slice().buffer,
			LEGACY.salt.slice().buffer,
			LEGACY.pubkey,
			alice.id
		)
		await remoteAccount(h.store, 'erin', 'misskey.example')
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'misskey.example'), alice.id)
		const status = await post(h, alice, { status: '@erin@misskey.example hi', visibility: 'private' })
		await settleAll(h.store)
		await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'no mention' }, { method: 'PUT' }))
		)
		const sent: { url: string; body: Record<string, unknown> }[] = []
		const fetch = vi.fn(async (request: Request) => {
			sent.push({ url: request.url, body: (await request.json()) as Record<string, unknown> })
			return new Response(null, { status: 202 })
		}) as unknown as typeof globalThis.fetch
		const deps: DeliveryDeps = {
			build: () => env.CF_VERSION_METADATA.id,
			store: () => h.store,
			now: () => NOW,
			fetch,
			checkHost: publicHost,
		}
		const testEnv = { ...env, USER_KEK: LEGACY.kek } as unknown as Env
		await deliveryRound(testEnv, deps)
		await deliveryRound(testEnv, deps)
		expect(sent.map((s) => s.url)).toEqual([
			'https://misskey.example/users/erin/inbox',
			'https://misskey.example/inbox',
		])
		const [personal, shared] = sent.map(
			(s) => s.body as { to: string[]; cc: string[]; object: { to: string[]; cc: string[]; tag: unknown[] } }
		)
		expect(misskeyAudience(personal?.object ?? {})).toEqual(['https://misskey.example/users/erin'])
		expect(personal?.object.tag).toEqual([])
		expect(JSON.stringify(shared)).not.toContain('users/erin')
		expect(misskeyAudience(shared?.object ?? {})).toEqual([])
	})
})

describe('the outbox', () => {
	// The collection's totalItems is the account's stored statuses_count (activities.ts getOutbox).
	it('runs no count query, for a page or for the collection', async () => {
		const h = await community(['alice'])
		await post(h, h.users.alice, { status: 'hello' })
		const queries = await runInDurableObject(h.store, (_instance, state) => {
			const seen: string[] = []
			const spy = new Proxy(state.storage.sql, {
				get(target, name) {
					if (name === 'exec') {
						return (query: string, ...params: SqlStorageValue[]) => {
							seen.push(query)
							return target.exec(query, ...params)
						}
					}
					return Reflect.get(target, name) as unknown
				},
			})
			getOutbox.run(spy, { username: 'alice', before: '~' })
			const page = seen.splice(0)
			getOutbox.run(spy, { username: 'alice', before: null })
			return { page, collection: seen }
		})
		expect(queries.page.some((q) => /count\(/i.test(q))).toBe(false)
		expect(queries.collection.some((q) => /count\(/i.test(q))).toBe(false)
		expect(queries.collection.length).toBeGreaterThan(0)
	})
})
