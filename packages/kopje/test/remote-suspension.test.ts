import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import {
	act,
	adminEntity,
	adminIds,
	jobs,
	receive,
	rejects,
	round,
	settle,
	toFollows,
	unsuspend,
	uriOf,
	userToken,
	world,
} from './remote-suspension-helpers'
import { follow, remoteAccount, remoteFollows } from './status-helpers'
import { SEVER_ROUND } from '../src/domain/remote-suspension'
import { MODERATION_ROUND_ROWS } from '../src/domain/suspension'

// The instance suspension of a remote account through the Mastodon admin API (R1, R38, VIS-30; Admin::AccountAction,
// SuspendAccountService#reject_remote_follows! and UnsuspendAccountService of Mastodon 4.5.11): the action and its
// errors, the entity and the lists, the account job's rounds and their generation (concurrency row 1), its budget
// (change 2 of the phase B design), and follow requests (row 12). Deliveries (rows 13 to 18) are in
// remote-suspension-deliveries.test.ts, the inbound paths (rows 5, 7, 8, 10, changes 3 and 4) in
// remote-suspension-inbound.test.ts.

describe('the remote suspension action (Admin::AccountAction, R38)', () => {
	it('suspends a remote account: 200, logged, a job, and the entity, list and profile show it suspended', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		const before = await adminEntity(w, r)
		expect(before).toMatchObject({ id: r, domain: 'remote.example', suspended: false, email: null, role: null })
		expect(before.account).not.toHaveProperty('suspended')
		expect(await adminIds(w, 'status=suspended')).toEqual([])
		expect(await adminIds(w, 'origin=remote&status=active')).toEqual([r])

		expect(await act(w, r, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		const after = await adminEntity(w, r)
		expect(after).toMatchObject({ id: r, suspended: true })
		expect(after.account).toMatchObject({ id: r, suspended: true, display_name: '', note: '', fields: [] })
		expect(await adminIds(w, 'status=suspended')).toEqual([r])
		expect(await adminIds(w, 'origin=remote&status=active')).toEqual([])
		expect(await adminIds(w, 'status=active')).not.toContain(r)
		// The ordinary and the bulk account reads present it redacted (change 6).
		const single = await w.h.request(`/api/v1/accounts/${r}`, bearer(w.alice.token))
		expect(await single.json()).toMatchObject({ id: r, suspended: true })
		const bulk = await w.h.request(`/api/v1/accounts?id[]=${r}`, bearer(w.alice.token))
		expect(await bulk.json()).toEqual([expect.objectContaining({ id: r, suspended: true })])
		expect(
			await sql(w.h.store, "SELECT action, target_id FROM admin_actions WHERE target_type = 'Account' ORDER BY id")
		).toEqual([{ action: 'suspend', target_id: r }])
		expect(await jobs(w.h.store)).toEqual([
			{ kind: 'account', subject: r, mode: 'account', phase: 'reports', cursor: '' },
		])
		expect(await sql(w.h.store, 'SELECT suspended_at, suspension_source FROM accounts WHERE id = ?', r)).toEqual([
			{ suspended_at: new Date(NOW).toISOString(), suspension_source: 'account' },
		])
	})

	it('unsuspends it: 200 with the entity, the job ends at its next round; again, 403', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		const lifted = await unsuspend(w, r)
		expect(lifted).toMatchObject({ status: 200, body: { id: r, suspended: false } })
		expect((lifted.body as { account: Record<string, unknown> }).account).not.toHaveProperty('suspended')
		expect(await unsuspend(w, r)).toEqual({ status: 403, body: { error: 'This action is not allowed' } })
		expect(await adminIds(w, 'status=suspended')).toEqual([])
		expect(await adminIds(w, 'origin=remote&status=active')).toEqual([r])
		expect(await jobs(w.h.store)).toHaveLength(1)
		expect(await round(w.h.store)).toMatchObject({ delivers: false, rows: 1 })
		expect(await jobs(w.h.store)).toEqual([])
		expect(
			(await sql<{ action: string }>(w.h.store, 'SELECT action FROM admin_actions ORDER BY id')).map((r) => r.action)
		).toEqual(['suspend', 'unsuspend'])
	})

	it("answers Mastodon's errors: not found, invalid type, the admin's own account, a missing report, not allowed", async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		const gone = await remoteAccount(w.h.store, 'gone')
		const unknown = '999999999999999999'
		expect(await act(w, unknown, { type: 'suspend' })).toMatchObject({ status: 404 })
		expect(await unsuspend(w, unknown)).toMatchObject({ status: 404 })
		expect(await act(w, r, {})).toEqual({
			status: 422,
			body: { error: "Validation failed: Type can't be blank, Type is not included in the list" },
		})
		expect(await act(w, r, { type: 'silence' })).toEqual({
			status: 422,
			body: { error: 'Validation failed: Type is not included in the list' },
		})
		expect(await act(w, w.owner.id, { type: 'suspend' })).toEqual({
			status: 403,
			body: { error: 'This action is not allowed' },
		})
		expect(await act(w, r, { type: 'suspend', report_id: '424242' })).toMatchObject({ status: 404 })
		// Not suspended, or unavailable only because its deletion has started: not this instance's suspension.
		expect(await unsuspend(w, r)).toEqual({ status: 403, body: { error: 'This action is not allowed' } })
		await sql(w.h.store, 'UPDATE accounts SET deleted_at = ? WHERE id = ?', new Date(NOW).toISOString(), gone)
		expect(await unsuspend(w, gone)).toEqual({ status: 403, body: { error: 'This action is not allowed' } })
		// A user token without the admin scopes is refused before anything is read.
		expect(await act(w, r, { type: 'suspend' }, w.alice.token)).toMatchObject({ status: 403 })
		expect(await sql(w.h.store, 'SELECT * FROM admin_actions')).toEqual([])
		expect(await jobs(w.h.store)).toEqual([])
		expect(await sql(w.h.store, 'SELECT suspended_at FROM accounts WHERE id = ?', r)).toEqual([{ suspended_at: null }])
	})

	it('resolves the report named with the suspension, and keeps local follows of the account', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		await follow(w.h, w.alice, r)
		const reporter = await userToken(w.h, 'bob@example.com', 'write:reports')
		const report = (
			await (await w.h.request('/api/v1/reports', bearer(reporter, json({ account_id: r })))).json<{ id: string }>()
		).id
		expect(await act(w, r, { type: 'suspend', report_id: report })).toEqual({ status: 200, body: {} })
		await settle(w.h.store)
		expect(
			await sql(
				w.h.store,
				'SELECT action_taken_at IS NOT NULL AS resolved, action_taken_by_account_id AS by FROM reports'
			)
		).toEqual([{ resolved: 1, by: w.owner.id }])
		// alice's follow of r is kept (SuspendAccountService rejects only the account's own follows).
		expect(await sql(w.h.store, 'SELECT account_id FROM follows WHERE target_account_id = ?', r)).toEqual([
			{ account_id: w.alice.id },
		])
	})
})

describe('the account job (concurrency row 1)', () => {
	// r follows alice, bob and carol, and bob files two reports of it.
	async function followed() {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		for (const local of [w.alice, w.bob, w.carol]) {
			await remoteFollows(w.h.store, r, local.id)
		}
		const reporter = await userToken(w.h, 'bob@example.com', 'write:reports')
		const report = async () =>
			(await (await w.h.request('/api/v1/reports', bearer(reporter, json({ account_id: r })))).json<{ id: string }>())
				.id
		const reports = [await report(), await report()]
		return { w, r, reporter, reports, report }
	}

	it('suspend, unsuspend, a new follow, suspend again while gated: one job, one withdrawing Reject each', async () => {
		const { w, r, report } = await followed()
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		// Gated before the Reject phase: the reports are resolved, nothing is rejected yet.
		await toFollows(w.h.store)
		expect(await rejects(w.h.store)).toEqual([])
		expect(await unsuspend(w, r)).toMatchObject({ status: 200 })
		// While available, r follows dan (through the Store's inbox) and is reported again.
		const dan = await uriOf(w.h.store, w.dan.id)
		expect(await receive(w.h.store, await uriOf(w.h.store, r), { type: 'Follow', object: dan })).toMatchObject({
			applied: true,
		})
		const third = await report()
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		expect(await jobs(w.h.store)).toEqual([
			{ kind: 'account', subject: r, mode: 'account', phase: 'reports', cursor: '' },
		])
		await settle(w.h.store)
		expect(await jobs(w.h.store)).toEqual([])
		const uri = await uriOf(w.h.store, r)
		expect((await rejects(w.h.store)).map((row) => [row.signer, row.follower, row.retracts]).sort()).toEqual(
			[w.alice.id, w.bob.id, w.carol.id, w.dan.id].map((id) => [id, uri, 1]).sort()
		)
		expect(await sql(w.h.store, 'SELECT * FROM follows WHERE account_id = ?', r)).toEqual([])
		// The report filed while r was available is frozen at the second suspension, and resolved too.
		expect(
			await sql(w.h.store, 'SELECT action_taken_at IS NOT NULL AS resolved FROM reports WHERE id = ?', third)
		).toEqual([{ resolved: 1 }])
		expect(await sql(w.h.store, 'SELECT count(*) AS n FROM reports WHERE action_taken_at IS NULL')).toEqual([{ n: 0 }])
	})

	it('unsuspend only: the next round ends the job and writes nothing else', async () => {
		const { w, r } = await followed()
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		await toFollows(w.h.store)
		expect(await unsuspend(w, r)).toMatchObject({ status: 200 })
		expect(await round(w.h.store)).toMatchObject({ delivers: false, rows: 1 })
		expect(await jobs(w.h.store)).toEqual([])
		expect(await rejects(w.h.store)).toEqual([])
		expect(await sql(w.h.store, 'SELECT count(*) AS n FROM follows WHERE account_id = ?', r)).toEqual([{ n: 3 }])
	})

	it('deletes a pending request of the account without a Reject, and leaves a follow above its bound', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		await sql(w.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', w.bob.id)
		const uri = await uriOf(w.h.store, r)
		expect(await receive(w.h.store, uri, { type: 'Follow', object: await uriOf(w.h.store, w.bob.id) })).toMatchObject({
			applied: true,
		})
		expect(await sql(w.h.store, 'SELECT state FROM follows WHERE account_id = ?', r)).toEqual([{ state: 'pending' }])
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		await settle(w.h.store)
		expect(await sql(w.h.store, 'SELECT * FROM follows WHERE account_id = ?', r)).toEqual([])
		expect(await rejects(w.h.store)).toEqual([])
		expect(await sql(w.h.store, "SELECT * FROM notifications WHERE type = 'follow_request'")).toEqual([])
	})

	it('ends when a purge removed the account, and walks more follows than one round reads', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		// More local accounts than SEVER_ROUND, each followed by r.
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, created_at) SELECT printf('%018d', 500000000000000000 + i),
				'https://kopje.test/ap/users/l' || i, 'l' || i, ?2 FROM n`,
			SEVER_ROUND + 5,
			new Date(NOW).toISOString()
		)
		await sql(
			w.h.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE id LIKE '5000%'`
		)
		await sql(
			w.h.store,
			`INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts
			WHERE id LIKE '5000%'`,
			r
		)
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		let rounds = 0
		for (let ran = await round(w.h.store); ran !== null; ran = await round(w.h.store)) {
			expect(ran.rows).toBeLessThanOrEqual(MODERATION_ROUND_ROWS)
			rounds++
		}
		expect(rounds).toBeGreaterThan(2)
		expect(await rejects(w.h.store)).toHaveLength(SEVER_ROUND + 5)

		// A second account, purged through its DeleteActor while its job waits: the next round ends it.
		const p = await remoteAccount(w.h.store, 'p')
		await remoteFollows(w.h.store, p, w.alice.id)
		expect(await act(w, p, { type: 'suspend' })).toMatchObject({ status: 200 })
		expect(await receive(w.h.store, await uriOf(w.h.store, p), { type: 'DeleteActor' })).toMatchObject({
			applied: true,
		})
		expect(await jobs(w.h.store)).toHaveLength(1)
		// The purge's batches, then the job's round in the same calls: it finds no account and ends.
		await settle(w.h.store)
		expect(await sql(w.h.store, 'SELECT id FROM accounts WHERE id = ?', p)).toEqual([])
		expect(await jobs(w.h.store)).toEqual([])
		// Row existence decides: the follow ends once, by the purge or by the job.
		const pUri = 'https://remote.example/users/p'
		expect((await rejects(w.h.store)).filter((row) => row.follower === pUri).length).toBeLessThanOrEqual(1)
		expect(await sql(w.h.store, 'SELECT * FROM follows WHERE account_id = ?', p)).toEqual([])
	})
})

describe("the severing round's budget (change 2)", () => {
	it('deletes more than 600 pushes of one follow notification in bounded rounds, then ends the follow', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		const uri = await uriOf(w.h.store, r)
		expect(await receive(w.h.store, uri, { type: 'Follow', object: await uriOf(w.h.store, w.alice.id) })).toMatchObject(
			{ applied: true }
		)
		const [notification] = await sql<{ id: number }>(
			w.h.store,
			"SELECT id FROM notifications WHERE account_id = ? AND type = 'follow'",
			w.alice.id
		)
		const PUSHES = 1_300
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
			SELECT 'push-' || i, 'access', (SELECT id FROM oauth_clients LIMIT 1), ?2, 'push' FROM n`,
			PUSHES,
			w.alice.id
		)
		await sql(
			w.h.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
			SELECT token_hash, 'https://push.example/' || token_hash, 'k', 'a' FROM oauth_tokens WHERE token_hash LIKE 'push-%'`
		)
		await sql(
			w.h.store,
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT id, ?, ?, ? FROM push_subscriptions WHERE token_hash LIKE 'push-%'`,
			notification!.id,
			NOW,
			NOW
		)
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		const written: number[] = []
		for (let ran = await round(w.h.store); ran !== null; ran = await round(w.h.store)) {
			written.push(ran.rows)
			expect(written.length).toBeLessThan(20)
		}
		expect(Math.max(...written)).toBeLessThanOrEqual(MODERATION_ROUND_ROWS)
		// The reports round, then at least three rounds of pushes and the follow's end.
		expect(written.length).toBeGreaterThanOrEqual(4)
		expect(await sql(w.h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
		expect(await sql(w.h.store, 'SELECT * FROM follows WHERE account_id = ?', r)).toEqual([])
		expect(await rejects(w.h.store)).toEqual([{ signer: w.alice.id, follower: uri, retracts: 1 }])
	})
})

describe('follow requests of a suspended account (row 12 b)', () => {
	it('are refused to authorize and left out of the list while it is suspended, and listed again after', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		await sql(w.h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', w.bob.id)
		expect(
			await receive(w.h.store, await uriOf(w.h.store, r), {
				type: 'Follow',
				object: await uriOf(w.h.store, w.bob.id),
			})
		).toMatchObject({ applied: true })
		const listed = async () =>
			(await (await w.h.request('/api/v1/follow_requests', bearer(w.bob.token))).json<{ id: string }[]>()).map(
				(account) => account.id
			)
		expect(await listed()).toEqual([r])
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		// The job has not run: the request is still stored.
		expect(await listed()).toEqual([])
		const authorize = await w.h.request(
			`/api/v1/follow_requests/${r}/authorize`,
			bearer(w.bob.token, { method: 'POST' })
		)
		expect(authorize.status).toBe(404)
		expect(await sql(w.h.store, 'SELECT state FROM follows WHERE account_id = ?', r)).toEqual([{ state: 'pending' }])
		expect(await unsuspend(w, r)).toMatchObject({ status: 200 })
		expect(await listed()).toEqual([r])
	})
})
