import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, settle, sql, userToken } from './api-helpers'
import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { rowsRead } from './read-helpers'
import {
	act,
	adminEntity,
	adminIds,
	jobs,
	receive,
	rejects,
	round,
	toFollows,
	unsuspend,
	uriOf,
	world,
	type World,
} from './remote-suspension-helpers'
import { follow, remoteAccount, remoteFollows } from './status-helpers'
import { EXPANSION_STEP, supersedeEarlier } from '../src/domain/deliveries'
import { writeOperation } from '../src/domain/operation'
import { SEVER_ROUND, SEVER_ROWS } from '../src/domain/remote-suspension'
import { MODERATION_ROUND_ROWS } from '../src/domain/suspension'
import type { StoreStub } from '../src/platform/store-client'

// The instance suspension of a remote account through the Mastodon admin API (R1, R38, VIS-30; Admin::AccountAction,
// SuspendAccountService#reject_remote_follows! and UnsuspendAccountService of Mastodon 4.5.11): the action and its
// errors, the entity and the lists, the account job's rounds and their generation, its budget, and follow requests.
// Deliveries are in remote-suspension-deliveries.test.ts, the inbound paths in remote-suspension-inbound.test.ts.

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
		// The ordinary and the bulk account reads present it redacted, reading availability live.
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

describe('the account job and its generation', () => {
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

describe("the severing round's budget and its preparatory steps", () => {
	const PAIR = 'https://remote.example/follows/r/alice'

	// r follows alice through the Store's inbox: with a Misskey pair-shaped Follow id when `generations` > 1, undone and
	// made again that many times, so alice's Accept of each generation waits as an intent about that one id (pending or
	// queued, or given up once the lane is full); the last generation stays.
	async function followed(w: World, generations = 1) {
		const r = await remoteAccount(w.h.store, 'r')
		const uri = await uriOf(w.h.store, r)
		const alice = await uriOf(w.h.store, w.alice.id)
		const follow = { type: 'Follow', id: PAIR, object: alice }
		for (let generation = 1; generation < generations; generation++) {
			expect(await receive(w.h.store, uri, follow)).toMatchObject({ applied: true })
			expect(
				await receive(w.h.store, uri, { type: 'Undo', object: { id: PAIR, type: 'Follow', actor: uri, object: alice } })
			).toMatchObject({ applied: true })
		}
		expect(await receive(w.h.store, uri, generations > 1 ? follow : { type: 'Follow', object: alice })).toMatchObject({
			applied: true,
		})
		return { r, uri }
	}

	// `pushes` push deliveries waiting on alice's follow notification, one subscription each.
	async function pushes(w: World, count: number) {
		const [notification] = await sql<{ id: number }>(
			w.h.store,
			"SELECT id FROM notifications WHERE account_id = ? AND type = 'follow'",
			w.alice.id
		)
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
			SELECT 'push-' || i, 'access', (SELECT id FROM oauth_clients LIMIT 1), ?2, 'push' FROM n`,
			count,
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
	}

	// Another activity's targets still to expand, one per chunk (the costliest expansion): the Reject's recording
	// expands EXPANSION_STEP of them.
	const BACKLOG = EXPANSION_STEP + 50
	async function backlog(w: World) {
		await sql(
			w.h.store,
			`INSERT INTO outbound_activities (id, account_id, body, created_at)
			VALUES (9000, ?, '{"activity":{"type":"Note"},"audience":{"followers":false,"accounts":[]}}', ?)`,
			w.bob.id,
			NOW
		)
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO outbound_targets (activity_id, targets)
			SELECT 9000, json_array(json_object('inbox', 'https://b' || i || '.example/inbox', 'addressee', NULL)) FROM n`,
			BACKLOG
		)
	}

	// Rounds until the job ends; the rows each wrote.
	async function rounds(store: StoreStub): Promise<number[]> {
		const written: number[] = []
		for (let ran = await round(store); ran !== null; ran = await round(store)) {
			written.push(ran.rows)
			expect(written.length).toBeLessThan(30)
		}
		return written
	}

	// The job ran to its end within the budget, and ended r's follow of alice once, with a withdrawing Reject.
	async function severedOnce(w: World, r: string, uri: string, written: number[]) {
		expect(written.filter((rows) => rows > MODERATION_ROUND_ROWS)).toEqual([])
		expect(await sql(w.h.store, 'SELECT * FROM remote_moderation_jobs')).toEqual([])
		expect(await sql(w.h.store, 'SELECT * FROM follows WHERE account_id = ?', r)).toEqual([])
		expect(await sql(w.h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
		expect(await rejects(w.h.store)).toEqual([{ signer: w.alice.id, follower: uri, retracts: 1 }])
	}

	it('deletes more than 600 pushes of one follow notification in bounded rounds, then ends the follow', async () => {
		const w = await world()
		const { r, uri } = await followed(w)
		await pushes(w, 1_300)
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		const written = await rounds(w.h.store)
		// The reports round, then at least five rounds of pushes and the follow's end.
		expect(written.length).toBeGreaterThanOrEqual(6)
		await severedOnce(w, r, uri, written)
	})

	it.each([
		[560, true],
		[MODERATION_ROUND_ROWS - SEVER_ROWS, true],
		[560, false],
	])(
		'stays within the budget with %i pushes and an unrelated expansion backlog (Follow id stored: %s)',
		async (count, named) => {
			const w = await world()
			const { r, uri } = await followed(w)
			if (!named) {
				// A follow stored without its Follow's id: its Reject names none.
				await sql(w.h.store, 'UPDATE follows SET uri = NULL WHERE account_id = ?', r)
			}
			await pushes(w, count)
			await backlog(w)
			expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
			await severedOnce(w, r, uri, await rounds(w.h.store))
			// Recording the Reject expanded the backlog's first EXPANSION_STEP chunks.
			expect(await sql(w.h.store, 'SELECT count(*) AS n FROM deliveries WHERE activity_id = 9000')).toEqual([
				{ n: EXPANSION_STEP },
			])
		}
	)

	it.each([
		['alone', false],
		['with 560 pushes and an expansion backlog', true],
	])(
		'supersedes 600 earlier Accepts of a Misskey pair-id follow in bounded rounds before its Reject, %s',
		async (_, loaded) => {
			const w = await world()
			const { r, uri } = await followed(w, 601)
			const accepts = () =>
				sql<{ n: number }>(
					w.h.store,
					`SELECT count(*) AS n FROM outbound_activities
					WHERE account_id = ? AND object_uri = ? AND superseded = 0 AND json_extract(body, '$.activity.type') = 'Accept'`,
					w.alice.id,
					PAIR
				)
			expect(await accepts()).toEqual([{ n: 601 }])
			if (loaded) {
				await pushes(w, 560)
				await backlog(w)
			}
			expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
			const written = await rounds(w.h.store)
			await severedOnce(w, r, uri, written)
			expect(await accepts()).toEqual([{ n: 0 }])
			// The reports round, at least three rounds superseding (at most 130 activities each), and the end.
			expect(written.length).toBeGreaterThanOrEqual(loaded ? 7 : 5)
		},
		120_000
	)

	// The Reject's targets, expanded or not: each inbox and how many times it is named.
	const rejectInboxes = (store: StoreStub) =>
		sql<{ inbox: string; n: number }>(
			store,
			`SELECT inbox, count(*) AS n FROM (
				SELECT d.inbox_url AS inbox FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE json_extract(o.body, '$.activity.type') = 'Reject'
				UNION ALL SELECT json_extract(t.value, '$.inbox')
				FROM outbound_activities o JOIN outbound_targets c ON c.activity_id = o.id, json_each(c.targets) t
				WHERE json_extract(o.body, '$.activity.type') = 'Reject' AND t.key >= c.next)
			GROUP BY 1`
		)

	it('rejects a pair-id follow accepted at 300 inboxes once, at its current inbox, in bounded rounds', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r')
		const uri = await uriOf(w.h.store, r)
		const alice = await uriOf(w.h.store, w.alice.id)
		const GENERATIONS = 300
		for (let generation = 0; generation < GENERATIONS; generation++) {
			const inbox = `https://h${generation}.example/inbox`
			await sql(w.h.store, 'UPDATE accounts SET inbox_url = ?, shared_inbox_url = ? WHERE id = ?', inbox, inbox, r)
			expect(await receive(w.h.store, uri, { type: 'Follow', id: PAIR, object: alice })).toMatchObject({
				applied: true,
			})
			if (generation < GENERATIONS - 1) {
				expect(
					await receive(w.h.store, uri, {
						type: 'Undo',
						object: { id: PAIR, type: 'Follow', actor: uri, object: alice },
					})
				).toMatchObject({ applied: true })
			}
		}
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		await severedOnce(w, r, uri, await rounds(w.h.store))
		expect(await rejectInboxes(w.h.store)).toEqual([{ inbox: `https://h${GENERATIONS - 1}.example/inbox`, n: 1 }])
	}, 180_000)

	it('rejects once at the current inbox though an earlier Accept waits for 65,000 inboxes', async () => {
		const w = await world()
		const { r, uri } = await followed(w, 2)
		// The earlier Accept about the pair id waits with targets not yet expanded at RECEIVERS distinct inboxes (as many
		// changes of its shared inbox would leave), in chunks of 100.
		const RECEIVERS = 65_000
		const [accept] = await sql<{ id: number }>(
			w.h.store,
			"SELECT id FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Accept' ORDER BY id LIMIT 1",
			PAIR
		)
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO outbound_targets (activity_id, targets)
			SELECT ?2, json_group_array(json_object('inbox', 'https://s' || i || '.example/inbox', 'addressee', NULL))
			FROM n GROUP BY i / 100`,
			RECEIVERS,
			accept!.id
		)
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		await severedOnce(w, r, uri, await rounds(w.h.store))
		const [current] = await sql<{ inbox: string }>(
			w.h.store,
			'SELECT coalesce(shared_inbox_url, inbox_url) AS inbox FROM accounts WHERE id = ?',
			r
		)
		expect(await rejectInboxes(w.h.store)).toEqual([{ inbox: current!.inbox, n: 1 }])
	}, 180_000)
})

describe('follow requests of a suspended account', () => {
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

describe('the supersession lookup (outbound_activities_unsuperseded)', () => {
	const SIGNER = '900000000000000001'
	const OBJECT = 'https://remote.example/follows/r/alice'
	const supersede = writeOperation<{ limit: number }, boolean>((db, { limit }) =>
		supersedeEarlier(db, SIGNER, OBJECT, limit)
	)

	// `history` activities about the object superseded already (each with a delivery kept, as a given-up row is), and
	// two not yet.
	async function store(history: number) {
		const s = await migratedStore()
		await runInDurableObject(s, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
				SIGNER
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				SIGNER
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO outbound_activities (account_id, body, object_uri, retracts, superseded, created_at)
				SELECT ?2, '{"activity":{"type":"Accept"}}', ?3, 0, CASE WHEN i < ?1 - 2 THEN 1 ELSE 0 END, 0 FROM n`,
				history + 2,
				SIGNER,
				OBJECT
			)
			sql.exec(
				`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
				SELECT id, ?, 'https://remote.example/inbox', 'https://remote.example', 'gave_up', 0, 0 FROM outbound_activities`,
				SIGNER
			)
		})
		return s
	}

	it('seeks the activities not superseded yet, so its reads do not grow with the superseded history', async () => {
		const read: number[] = []
		for (const history of [100, 10_000]) {
			const s = await store(history)
			read.push(await rowsRead({ store: s }, supersede, { limit: 1 }))
			expect(await rowsRead({ store: s }, supersede, { limit: 10 })).toBeLessThanOrEqual(read.at(-1)! + 10)
			// The plans of the lookups supersedeEarlier runs (SUPERSEDED in deliveries.ts), as it runs them.
			const plans = await runInDurableObject(s, (_instance, state) => {
				const real = state.storage.sql
				const found: string[][] = []
				const capturing = {
					exec: (query: string, ...params: SqlStorageValue[]) => {
						if (/^\s*SELECT [\s\S]*FROM outbound_activities WHERE account_id = \?/.test(query)) {
							found.push(
								real
									.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
									.toArray()
									.map((row) => row.detail)
							)
						}
						return real.exec(query, ...params)
					},
				} as unknown as SqlStorage
				supersede.run(capturing, { limit: 1 })
				return found
			})
			expect(plans.map((plan) => [plan[0], plan.some((step) => step.includes('TEMP B-TREE'))])).toEqual([
				[
					'SEARCH outbound_activities USING INDEX outbound_activities_unsuperseded (account_id=? AND object_uri=?)',
					false,
				],
				[
					'SEARCH outbound_activities USING INDEX outbound_activities_unsuperseded (account_id=? AND object_uri=?)',
					false,
				],
			])
		}
		expect(read[1]).toBeLessThanOrEqual(read[0]! + 5)
	})
})
