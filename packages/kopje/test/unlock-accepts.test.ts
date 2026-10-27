import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY } from './federation-helpers'
import { BUILD, migratedStore, runStoreJobs } from './helpers'
import { ACCESS, dumpViaRpc, importViaRpc, setAccess } from './ops-helpers'
import { community, domainBlock, follow, getJson, post, remoteAccount, type User } from './status-helpers'
import { csrfOf, postForm, signIn } from './web-helpers'
import { Db } from '../src/db/sql'
import { suspendLocal, unsuspendLocal } from '../src/domain/suspension'
import { NEXT_REQUEST, UNLOCK_ACCEPTS_PER_ROUND, unlockAcceptStep } from '../src/domain/unlock-accepts'
import type { StoreStub } from '../src/platform/store-client'

// Unlocking an account accepts its pending follow requests in rounds (domain/unlock-accepts.ts), each request through
// the single authorize path, at most UNLOCK_ACCEPTS_PER_ROUND per round; relocking stops it; unavailable and blocked
// requesters stay pending (R1, R21).

async function setup<const N extends string = never>(names: readonly N[] = []) {
	const h = await community<'alice' | N>(['alice', ...names], 'read write follow')
	await sql(h.store, 'UPDATE local_accounts SET pubkey = ?', LEGACY.pubkey)
	await sql(h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', h.users.alice.id)
	return h
}

type H = Awaited<ReturnType<typeof setup<never>>>

function patch(h: H, user: User, body: unknown) {
	return h.request('/api/v1/accounts/update_credentials', bearer(user.token, { ...json(body), method: 'PATCH' }))
}

// Pending requests from new remote accounts, `count` on each of `domains`, as inbound Follows leave them.
async function remoteRequests(store: StoreStub, target: string, domains: string[], count: number): Promise<string[]> {
	const ids: string[] = []
	for (const domain of domains) {
		for (let i = 0; i < count; i++) {
			const id = await remoteAccount(store, `r${i}`, domain)
			await sql(
				store,
				"INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
				id,
				target,
				`https://${domain}/follows/${i}`
			)
			ids.push(id)
		}
	}
	return ids
}

async function states(store: StoreStub, target: string) {
	const rows = await sql<{ state: string; n: number }>(
		store,
		'SELECT state, count(*) AS n FROM follows WHERE target_account_id = ? GROUP BY state ORDER BY state',
		target
	)
	return Object.fromEntries(rows.map((row) => [row.state, row.n]))
}

async function cursor(store: StoreStub, accountId: string): Promise<string | null> {
	const [row] = await sql<{ c: string | null }>(
		store,
		'SELECT CAST(accept_requests_after AS TEXT) AS c FROM local_accounts WHERE account_id = ?',
		accountId
	)
	return row?.c ?? null
}

function round(store: StoreStub) {
	return runStoreJobs(store, BUILD, { now: NOW })
}

describe('unlock acceptance', () => {
	it('accepts 250 requests in rounds of at most 20, passing over unavailable and blocked requesters', async () => {
		const h = await setup(['bob', 'carol'])
		const { alice, bob, carol } = h.users
		await follow(h, bob, alice.id)
		await follow(h, carol, alice.id)
		const remote = await remoteRequests(h.store, alice.id, ['one.example', 'two.example', 'three.example'], 82)
		// One unavailable requester (its deletion started) and one from a domain alice blocks.
		await sql(h.store, 'UPDATE accounts SET deleted_at = ? WHERE id = ?', new Date(NOW).toISOString(), remote[5]!)
		await domainBlock(h.store, alice.id, 'blocked.example')
		await remoteRequests(h.store, alice.id, ['blocked.example'], 2)
		expect(await states(h.store, alice.id)).toEqual({ pending: 250 })
		// The plan at saturation, with no statistics: 10,000 accepted followers of alice besides the requests.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(120000000000000000 + i AS TEXT), 'https://many.example/users/f' || i, 'f' || i, 'many.example' FROM n`
		)
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state)
			SELECT id, ?, 'accepted' FROM accounts WHERE domain = 'many.example'`,
			alice.id
		)
		const plan = await runInDurableObject(h.store, (_instance, state) =>
			state.storage.sql
				.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${NEXT_REQUEST}`, alice.id)
				.toArray()
				.map((row) => row.detail)
				.join('\n')
		)
		expect(plan).toMatch(/SEARCH f USING INDEX follows_target \(target_account_id=\? AND state=\? AND rowid>\?\)/)
		// The rest is availableSql's and blockedSql's probes (audience.ts states their cost).
		expect(plan).not.toMatch(/SCAN f\b|TEMP B-TREE FOR ORDER BY/)

		const response = await patch(h, alice, { locked: false })
		expect(response.status).toBe(200)
		expect(h.jobs).toHaveBeenCalled()
		const accepted: number[] = []
		for (let r = 0; r < 20; r++) {
			const before = (await states(h.store, alice.id)).accepted ?? 0
			const result = await round(h.store)
			accepted.push(((await states(h.store, alice.id)).accepted ?? 0) - before)
			if (!result.pending) {
				break
			}
		}
		expect(Math.max(...accepted)).toBeLessThanOrEqual(UNLOCK_ACCEPTS_PER_ROUND)
		expect(accepted.reduce((a, b) => a + b, 0)).toBe(247)
		expect(await states(h.store, alice.id)).toEqual({ accepted: 10_247, pending: 3 })
		expect(await cursor(h.store, alice.id)).toBeNull()
		// The counters match a recount; each local requester follows one more account.
		const [counts] = await sql<{ followers_count: number }>(
			h.store,
			'SELECT followers_count FROM accounts WHERE id = ?',
			alice.id
		)
		expect(counts?.followers_count).toBe(10_247)
		expect(await sql(h.store, 'SELECT following_count FROM accounts WHERE id IN (?, ?)', bob.id, carol.id)).toEqual([
			{ following_count: 1 },
			{ following_count: 1 },
		])
		// Each remote acceptance recorded its Accept; the follow_request notifications went.
		const [sent] = await sql<{ n: number }>(
			h.store,
			"SELECT count(*) AS n FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Accept'"
		)
		expect(sent?.n).toBe(245)
		expect(
			await sql(
				h.store,
				"SELECT count(*) AS n FROM notifications WHERE type = 'follow_request' AND account_id = ?",
				alice.id
			)
		).toEqual([{ n: 0 }])
	}, 120_000)

	it('stops when the account locks again', async () => {
		const h = await setup()
		const { alice } = h.users
		await remoteRequests(h.store, alice.id, ['one.example'], 30)
		await patch(h, alice, { locked: false })
		await round(h.store)
		expect(await states(h.store, alice.id)).toEqual({ accepted: 20, pending: 10 })
		await patch(h, alice, { locked: true })
		expect(await cursor(h.store, alice.id)).toBeNull()
		expect(await round(h.store)).toMatchObject({ pending: false })
		expect(await states(h.store, alice.id)).toEqual({ accepted: 20, pending: 10 })
	})

	it('ends with a suspension, and an unsuspension before the next round does not resume it', async () => {
		const h = await setup()
		const { alice } = h.users
		await remoteRequests(h.store, alice.id, ['one.example'], 30)
		await patch(h, alice, { locked: false })
		await round(h.store)
		expect(await states(h.store, alice.id)).toEqual({ accepted: 20, pending: 10 })
		await runInDurableObject(h.store, (_instance, state) =>
			state.storage.transactionSync(() => {
				const db = new Db(state.storage.sql)
				suspendLocal(db, alice.id, null, NOW)
				unsuspendLocal(db, alice.id, NOW + 1)
			})
		)
		expect(await cursor(h.store, alice.id)).toBeNull()
		await round(h.store)
		expect(await states(h.store, alice.id)).toEqual({ accepted: 20, pending: 10 })
	})

	it('passes follow ids above 2^53 exactly, one step at a time', async () => {
		const h = await setup()
		const { alice } = h.users
		// Two ids a JS number cannot tell from their neighbours (2^53 + 1 and 2^53 + 3).
		const ids = ['9007199254740993', '9007199254740995']
		const requesters: string[] = []
		for (const [i, id] of ids.entries()) {
			const requester = await remoteAccount(h.store, `big${i}`, 'one.example')
			await sql(
				h.store,
				`INSERT INTO follows (id, account_id, target_account_id, state, uri)
				VALUES (CAST(? AS INTEGER), ?, ?, 'pending', ?)`,
				id,
				requester,
				alice.id,
				`https://one.example/follows/big${i}`
			)
			requesters.push(requester)
		}
		await patch(h, alice, { locked: false })
		// One step in its own transaction, with the storage's savepoint as the kernel passes it (Db.savepoint).
		const step = () =>
			runInDurableObject(h.store, (_instance, state) =>
				state.storage.transactionSync(() =>
					unlockAcceptStep.run(state.storage.sql, { now: NOW }, (fn) => state.storage.transactionSync(fn))
				)
			)
		expect(await step()).toEqual({ done: false, delivers: true })
		expect(await cursor(h.store, alice.id)).toBe(ids[0])
		const statesOf = () =>
			sql(
				h.store,
				'SELECT CAST(id AS TEXT) AS id, state FROM follows WHERE target_account_id = ? ORDER BY id',
				alice.id
			)
		expect(await statesOf()).toEqual([
			{ id: ids[0], state: 'accepted' },
			{ id: ids[1], state: 'pending' },
		])
		await step()
		expect(await cursor(h.store, alice.id)).toBe(ids[1])
		await step()
		expect(await cursor(h.store, alice.id)).toBeNull()
		expect(await statesOf()).toEqual([
			{ id: ids[0], state: 'accepted' },
			{ id: ids[1], state: 'accepted' },
		])
	})

	it('starts no job when nothing is pending, and leaves an unlocked account alone', async () => {
		const h = await setup()
		const { alice } = h.users
		await patch(h, alice, { locked: false })
		expect(await cursor(h.store, alice.id)).toBeNull()
		expect(h.jobs).not.toHaveBeenCalled()
		await remoteRequests(h.store, alice.id, ['one.example'], 1)
		await patch(h, alice, { locked: false })
		expect(await cursor(h.store, alice.id)).toBeNull()
	})

	it('lets an accepted local requester see the earlier followers-only post; a blocked one still sees nothing', async () => {
		const h = await setup(['bob', 'carol'])
		const { alice, bob, carol } = h.users
		const secret = await post(h, alice, { status: 'followers only', visibility: 'private' })
		await follow(h, bob, alice.id)
		await follow(h, carol, alice.id)
		await sql(h.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', alice.id, carol.id)
		await patch(h, alice, { locked: false })
		await round(h.store)
		expect((await getJson(h, `/api/v1/statuses/${secret.id}`, bob.token)).status).toBe(200)
		expect((await getJson(h, `/api/v1/statuses/${secret.id}`, carol.token)).status).toBe(404)
		expect(await sql(h.store, 'SELECT state FROM follows WHERE account_id = ?', carol.id)).toEqual([
			{ state: 'pending' },
		])
	})

	it('is started by the settings page', async () => {
		const h = await setup()
		const { alice } = h.users
		await remoteRequests(h.store, alice.id, ['one.example'], 3)
		const browser = await signIn(h)
		const csrf = await csrfOf(h, browser)
		const response = await postForm(h, browser, '/settings/profile', {
			csrf,
			locked: 'false',
			display_name: '',
			note: '',
		})
		expect(response.status).toBe(303)
		expect(h.jobs).toHaveBeenCalled()
		await round(h.store)
		expect(await states(h.store, alice.id)).toEqual({ accepted: 3 })
	})

	it('finishes after a dump taken mid-job is imported', async () => {
		const h = await setup()
		const { alice } = h.users
		await setAccess(h.store)
		await remoteRequests(h.store, alice.id, ['one.example'], 30)
		await patch(h, alice, { locked: false })
		await round(h.store)
		const { text } = await dumpViaRpc(h.store)
		const target = await migratedStore()
		await setAccess(target)
		await importViaRpc(target, text)
		await target.publish(BUILD, ACCESS)
		expect(await cursor(target, alice.id)).toBe(await cursor(h.store, alice.id))
		await round(target)
		expect(await states(target, alice.id)).toEqual({ accepted: 30 })
	})
})
