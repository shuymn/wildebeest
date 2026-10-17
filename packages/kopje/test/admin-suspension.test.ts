import { runInDurableObject } from 'cloudflare:test'

import { beforeEach, describe, expect, it } from 'vitest'

import { type AccessTeam, adminClaims, adminHarness, adminTeam, setTeamAccess } from './access-helpers'
import {
	type ApiHarness,
	authorizationCode,
	bearer,
	exchange,
	form,
	json,
	login,
	registerApp,
	seedAccount,
	setSetting,
	sql,
} from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD, migratedStore } from './helpers'
import { newClient, VAPID } from './push-helpers'
import { deferred } from './quote-helpers'
import { community, post, remoteAccount, remoteFollows, seedStatus } from './status-helpers'
import { signIn } from './web-helpers'
import { Db } from '../src/db/sql'
import { TARGET_CHUNK_SIZE } from '../src/domain/deliveries'
import {
	MODERATION_ROUND_ROWS,
	moderationRound,
	REACH_ROUND,
	RECENT_MS,
	REPORT_ROUND,
	suspendLocal,
	TOKEN_ROUND_ROWS,
} from '../src/domain/suspension'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// Local suspension through the Mastodon admin API (R1, R37, VIS-29; Admin::AccountAction, SuspendAccountService,
// UnsuspendAccountService and AccountReachFinder of Mastodon 4.5.11): who may act, the action's types, the token
// fence, the jobs' rounds and their generations, the audience of both Updates, the sender rule, and the Access
// unsuspension.

const OWNER = 'owner@example.com'
const ADMIN_SCOPES = 'read write admin:read admin:write'

async function userToken(h: ApiHarness, email: string, scope: string): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	return (await login(h, { app, scope, email })).token
}

// The owner (the OAuth admin), alice and bob, each signed in; `admin` is the owner's token with the admin scopes.
async function world(overrides: Record<string, unknown> = {}) {
	const h = await community(['owner', 'alice', 'bob'], 'read write follow', {}, overrides)
	await setSetting(h.store, 'admin_email', OWNER)
	const admin = await userToken(h, OWNER, ADMIN_SCOPES)
	return { h, admin, ...h.users }
}

type Answer = { status: number; body: unknown }

async function answer(response: Response): Promise<Answer> {
	return { status: response.status, body: await response.json() }
}

// POST /api/v1/admin/accounts/:id/action, as a form (Fedilab) or as JSON.
async function act(
	h: ApiHarness,
	token: string | null,
	id: string,
	body: Record<string, string>,
	as: 'form' | 'json' = 'form'
): Promise<Answer> {
	const init = as === 'form' ? form(body) : json(body)
	return answer(await h.request(`/api/v1/admin/accounts/${id}/action`, token === null ? init : bearer(token, init)))
}

async function unsuspend(h: ApiHarness, token: string | null, id: string): Promise<Answer> {
	const init = { method: 'POST' }
	return answer(await h.request(`/api/v1/admin/accounts/${id}/unsuspend`, token === null ? init : bearer(token, init)))
}

// Runs the Store's jobs until none is left; returns how many calls it took.
async function settle(store: StoreStub): Promise<number> {
	for (let call = 1; call <= 200; call++) {
		if (!(await store.runInboundJobs(BUILD, { now: NOW })).pending) {
			return call
		}
	}
	throw new Error('the jobs did not settle')
}

type Sent = { type: string; inbox: string; suspended: boolean; object: unknown }

// Claims and completes every delivery due, until nothing is left; what was sent, in order.
async function drain(store: StoreStub, now = NOW): Promise<Sent[]> {
	const sent: Sent[] = []
	for (let round = 0; round < 200; round++) {
		const leaseToken = `lease-${round}`
		const claim = await store.claimDeliveries(BUILD, { now, leaseToken })
		for (const delivery of claim.deliveries) {
			const body = JSON.parse(delivery.body) as { type: string; object?: { suspended?: boolean } }
			sent.push({
				type: body.type,
				inbox: delivery.inbox,
				suspended: body.object?.suspended === true,
				object: body.object,
			})
			await store.completeDelivery(BUILD, {
				id: delivery.id,
				leaseToken,
				now,
				outcome: { kind: 'delivered', status: 202 },
			})
		}
		if (claim.deliveries.length === 0 && claim.nextDueAt === null) {
			return sent
		}
	}
	throw new Error('the deliveries did not drain')
}

const logRows = (store: StoreStub) =>
	sql<{ account_id: string | null; action: string; target_type: string; target_id: string }>(
		store,
		'SELECT account_id, action, target_type, target_id FROM admin_actions ORDER BY id'
	)

const suspendedAt = async (store: StoreStub, id: string) =>
	(
		await sql<{ suspended_at: string | null; credential_epoch: number }>(
			store,
			'SELECT suspended_at, credential_epoch FROM local_accounts WHERE account_id = ?',
			id
		)
	)[0]

describe('the account action and unsuspend: who is answered (R37, VIS-29)', () => {
	it('serve the admin, and refuse a non-admin, an app token, an anonymous caller and a wrongly scoped token', async () => {
		const { h, admin, alice, bob } = await world()
		const app = await registerApp(h, { scopes: 'admin:read admin:write' })
		const appToken = (
			await (
				await h.request(
					'/oauth/token',
					form({
						grant_type: 'client_credentials',
						client_id: app.client_id,
						client_secret: app.client_secret,
						scope: 'admin:read admin:write',
					})
				)
			).json<{ access_token: string }>()
		).access_token
		const nonAdmin = await userToken(h, 'bob@example.com', ADMIN_SCOPES)
		const notAllowed = { status: 403, body: { error: 'This action is not allowed' } }
		for (const token of [nonAdmin, appToken, null]) {
			expect(await act(h, token, alice.id, { type: 'suspend' })).toEqual(notAllowed)
			expect(await act(h, token, alice.id, { type: 'none' })).toEqual(notAllowed)
			expect(await unsuspend(h, token, alice.id)).toEqual(notAllowed)
		}
		// admin:read, or the user scopes alone, do not cover admin:write:accounts.
		const outside = { status: 403, body: { error: 'This action is outside the authorized scopes' } }
		for (const scope of ['read write', 'admin:read admin:write:reports']) {
			const narrow = await userToken(h, OWNER, scope)
			expect(await act(h, narrow, alice.id, { type: 'suspend' })).toEqual(outside)
			expect(await unsuspend(h, narrow, alice.id)).toEqual(outside)
		}
		expect(await act(h, 'not-a-token', alice.id, { type: 'suspend' })).toMatchObject({ status: 401 })
		expect(await suspendedAt(h.store, alice.id)).toEqual({ suspended_at: null, credential_epoch: 0 })
		expect(await logRows(h.store)).toEqual([])

		// The admin, through the route's own scope.
		const narrow = await userToken(h, OWNER, 'admin:write:accounts')
		expect(await act(h, narrow, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		expect(await suspendedAt(h.store, alice.id)).toEqual({
			suspended_at: new Date(NOW).toISOString(),
			credential_epoch: 1,
		})
		const shown = await unsuspend(h, admin, alice.id)
		expect(shown).toMatchObject({ status: 200, body: { id: alice.id, suspended: false, account: { id: alice.id } } })
		// Unsuspending an account that is not suspended is refused (AccountPolicy#unsuspend?).
		expect(await unsuspend(h, admin, alice.id)).toEqual(notAllowed)
		expect(await unsuspend(h, admin, bob.id)).toEqual(notAllowed)
		expect(await unsuspend(h, admin, '999999999999999999')).toEqual({
			status: 404,
			body: { error: 'Record not found' },
		})
		expect((await logRows(h.store)).map((row) => [row.account_id, row.action, row.target_id])).toEqual([
			[h.users.owner.id, 'suspend', alice.id],
			[h.users.owner.id, 'unsuspend', alice.id],
		])
	})

	it("never acts on the admin's own account, and refuses a remote unsuspension", async () => {
		const { h, admin, owner } = await world()
		const carol = await remoteAccount(h.store, 'carol')
		for (const type of ['suspend', 'none']) {
			expect(await act(h, admin, owner.id, { type })).toEqual({
				status: 403,
				body: { error: 'This action is not allowed' },
			})
		}
		expect(await suspendedAt(h.store, owner.id)).toMatchObject({ suspended_at: null })
		expect(await unsuspend(h, admin, carol)).toMatchObject({ status: 403 })
		expect(await logRows(h.store)).toEqual([])
	})
})

describe('the account action types (Admin::AccountAction)', () => {
	it("answers Fedilab's request shapes: a suspend, a none with its text, and the types Kopje does not serve", async () => {
		const { h, admin, alice, bob } = await world()
		const carol = await remoteAccount(h.store, 'carol')
		// AccountReportActivity: none with the comment and the email flag; text is dropped (no strikes).
		expect(await act(h, admin, bob.id, { type: 'none', text: 'please stop', send_email_notification: 'true' })).toEqual(
			{ status: 200, body: {} }
		)
		// AdminAccountActivity sends "disable " with a trailing space, and silence; Kopje serves neither.
		const outside = { status: 422, body: { error: 'Validation failed: Type is not included in the list' } }
		for (const type of ['disable ', 'disable', 'sensitive', 'silence', 'warn']) {
			expect(await act(h, admin, bob.id, { type })).toEqual(outside)
		}
		expect(await act(h, admin, bob.id, {})).toEqual({
			status: 422,
			body: { error: "Validation failed: Type can't be blank, Type is not included in the list" },
		})
		expect(await act(h, admin, bob.id, { type: '' })).toMatchObject({ status: 422 })
		// Remote suspension is phase B's.
		expect(await act(h, admin, carol, { type: 'suspend' })).toEqual({
			status: 422,
			body: { error: 'Remote accounts cannot be suspended yet' },
		})
		// None of these changed anything or logged.
		expect(await suspendedAt(h.store, bob.id)).toMatchObject({ suspended_at: null })
		expect(await logRows(h.store)).toEqual([])
		// An id that is no account's, or a report that does not exist, is not found.
		expect(await act(h, admin, '999999999999999999', { type: 'suspend' })).toMatchObject({ status: 404 })
		expect(await act(h, admin, alice.id, { type: 'suspend', report_id: '424242' })).toMatchObject({ status: 404 })
		expect(await suspendedAt(h.store, alice.id)).toMatchObject({ suspended_at: null })
		// AdminAccountActivity's suspend: the type alone, as a form; JSON reads alike.
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		expect(await act(h, admin, alice.id, { type: 'suspend', warning_preset_id: '1' }, 'json')).toEqual({
			status: 200,
			body: {},
		})
		expect((await logRows(h.store)).map((row) => row.action)).toEqual(['suspend', 'suspend'])
	})

	it('none with a report_id resolves that report only', async () => {
		const { h, admin, alice, bob } = await world()
		const report = async () => {
			const response = await h.request(
				'/api/v1/reports',
				bearer(await userToken(h, 'bob@example.com', 'write:reports'), json({ account_id: alice.id }))
			)
			return (await response.json<{ id: string }>()).id
		}
		const [first, second] = [await report(), await report()]
		expect(await act(h, admin, alice.id, { type: 'none', report_id: first })).toEqual({ status: 200, body: {} })
		expect(
			await sql(h.store, 'SELECT CAST(id AS TEXT) AS id, action_taken_by_account_id AS by FROM reports ORDER BY id')
		).toEqual([
			{ id: first, by: h.users.owner.id },
			{ id: second, by: null },
		])
		expect((await logRows(h.store)).map((row) => [row.action, row.target_type, row.target_id])).toEqual([
			['resolve', 'Report', first],
		])
		expect(bob).toBeDefined()
	})
})

describe('the credential epoch (VIS-29)', () => {
	it('refuses access tokens, codes, web sessions and pushes at once, and still after the unsuspension', async () => {
		const { h, admin, alice, bob } = await world({ VAPID_JWK: VAPID.env })
		// Alice's API token, a pushing token with its subscription, a code not exchanged yet, and a web session.
		const pushing = await userToken(h, 'alice@example.com', 'read write push')
		const client = await newClient()
		const subscribed = await h.request(
			'/api/v1/push/subscription',
			bearer(
				pushing,
				json({
					subscription: { endpoint: 'https://push.example/x', keys: { p256dh: client.p256dh, auth: client.auth } },
					data: { alerts: { favourite: true }, policy: 'all' },
				})
			)
		)
		expect(subscribed.status).toBe(200)
		const app = await registerApp(h)
		const [before, after] = [
			await authorizationCode(h, app, { email: 'alice@example.com' }),
			await authorizationCode(h, app, { email: 'alice@example.com' }),
		]
		const browser = await signIn(h, 'alice@example.com')
		const settings = () => h.request('/settings', { headers: { cookie: browser.cookie } })
		expect((await settings()).status).toBe(200)
		// Two of alice's statuses, which bob favourites before the suspension and after the unsuspension.
		const statuses = [await post(h, alice, { status: 'one' }), await post(h, alice, { status: 'two' })]
		const favourited = async (index: number) => {
			const id = statuses[index]!.id
			expect((await h.request(`/api/v1/statuses/${id}/favourite`, bearer(bob.token, { method: 'POST' }))).status).toBe(
				200
			)
		}
		const pushes = async () => (await h.store.claimPushes(BUILD, { now: NOW, leaseToken: 'push' })).pushes.length
		await favourited(0)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 1 }])

		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		const verify = () => h.request('/api/v1/accounts/verify_credentials', bearer(alice.token))
		expect((await verify()).status).toBe(403)
		expect((await exchange(h, app, before)).status).toBe(400)
		expect((await settings()).status).toBe(302)
		// The push queued before the suspension is dropped at its claim.
		expect(await pushes()).toBe(0)

		// Unsuspended a second later, before the tokens job ran: every token and code from before stays refused, as
		// invalid now.
		h.now.mockReturnValue(NOW + 1000)
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM oauth_tokens WHERE account_id = ?', alice.id)).not.toEqual([
			{ n: 0 },
		])
		expect((await verify()).status).toBe(401)
		expect((await exchange(h, app, after)).status).toBe(400)
		expect((await settings()).status).toBe(302)
		expect((await h.request('/api/v1/push/subscription', bearer(pushing))).status).toBe(401)
		// A new notification queues no push for the old token, and none is claimed.
		await favourited(1)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
		expect(await pushes()).toBe(0)

		// A sign-in after the unsuspension works; the tokens job deletes only the credentials of the earlier epoch.
		const fresh = await userToken(h, 'alice@example.com', 'read')
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(fresh))).status).toBe(200)
		await settle(h.store)
		expect(
			await sql(
				h.store,
				'SELECT count(*) AS n FROM oauth_tokens WHERE account_id = ? AND created_at <= ?',
				alice.id,
				new Date(NOW).toISOString()
			)
		).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_subscriptions')).toEqual([{ n: 0 }])
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(fresh))).status).toBe(200)
	})
})

// A SqlStorage that counts the rows each statement reads.
function countingSql(real: SqlStorage): { sql: SqlStorage; read: () => number } {
	let read = 0
	const sql = {
		exec: (query: string, ...params: SqlStorageValue[]) => {
			const cursor = real.exec(query, ...params)
			return {
				toArray: () => {
					const rows = cursor.toArray()
					read += cursor.rowsRead
					return rows
				},
				get rowsWritten() {
					const written = cursor.rowsWritten
					read += cursor.rowsRead
					return written
				},
			}
		},
	} as unknown as SqlStorage
	return { sql, read: () => read }
}

type Round = { kind: string; phase: string; read: number; wrote: number }

// Runs every job round by round, each in its own transaction, measuring what it reads and writes (total_changes(), so
// cascades and triggers count).
async function rounds(store: StoreStub): Promise<Round[]> {
	const measured: Round[] = []
	let after = 0
	for (let i = 0; i < 1_000; i++) {
		const round = await runInDurableObject(store, (_instance, state) => {
			const job = state.storage.sql
				.exec<{ kind: string; phase: string }>(
					'SELECT kind, phase FROM moderation_jobs WHERE id > ? UNION ALL SELECT kind, phase FROM moderation_jobs LIMIT 1',
					after
				)
				.toArray()[0]
			const { sql: counting, read } = countingSql(state.storage.sql)
			const db = new Db(counting)
			const changes = () => new Db(state.storage.sql).first<{ n: number }>('SELECT total_changes() AS n')!.n
			const before = changes()
			const ran = state.storage.transactionSync(() => moderationRound(db, NOW, after))
			return ran === null
				? null
				: { id: ran.id, kind: job!.kind, phase: job!.phase, read: read(), wrote: changes() - before }
		})
		if (round === null) {
			return measured
		}
		after = round.id
		measured.push({ kind: round.kind, phase: round.phase, read: round.read, wrote: round.wrote })
	}
	throw new Error('the jobs did not end')
}

describe('the tokens job (RES-6)', () => {
	it('deletes a large token, subscription and push history child-first, within every round budget', async () => {
		const { h, admin, alice, bob } = await world()
		const client = (await sql<{ id: string }>(h.store, 'SELECT client_id AS id FROM oauth_tokens LIMIT 1'))[0]!.id
		// 600 tokens of alice's from before the suspension, 250 of them with a subscription; the first subscription has 450
		// pushes waiting (more than a round), 20 others 10 each.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
			INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, created_at)
			SELECT printf('t%05d', i), 'access', ?1, ?2, 'read', '2026-01-01T00:00:00.000Z' FROM n`,
			client,
			alice.id
		)
		await sql(
			h.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
			SELECT token_hash, 'https://push.example/' || token_hash, 'p', 'a' FROM oauth_tokens
			WHERE token_hash GLOB 't*' ORDER BY token_hash LIMIT 250`
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 450)
			INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'mention' || i, ?2 FROM n`,
			alice.id,
			bob.id
		)
		await sql(
			h.store,
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT p.id, n.id, 0, 0 FROM push_subscriptions p, notifications n
			WHERE p.token_hash = 't00001' AND n.account_id = ?`,
			alice.id
		)
		await sql(
			h.store,
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT p.id, n.id, 0, 0 FROM push_subscriptions p, (SELECT id FROM notifications ORDER BY id LIMIT 10) n
			WHERE p.token_hash BETWEEN 't00002' AND 't00021'`
		)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 650 }])

		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		// 5 tokens issued after the suspension committed, in its epoch, are not the job's to delete.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
			INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, created_at, epoch)
			SELECT printf('u%05d', i), 'access', ?1, ?2, 'read', '2026-01-01T00:00:00.000Z',
				(SELECT credential_epoch FROM local_accounts WHERE account_id = ?2) FROM n`,
			client,
			alice.id
		)
		const tokenRounds = (await rounds(h.store)).filter((round) => round.kind === 'tokens')
		// 601 tokens (alice's sign-in included), 250 subscriptions and 650 pushes: several rounds, each within its budget.
		expect(tokenRounds.length).toBeGreaterThanOrEqual(Math.ceil((601 + 250 + 650) / TOKEN_ROUND_ROWS))
		for (const round of tokenRounds) {
			expect(round.wrote).toBeLessThanOrEqual(TOKEN_ROUND_ROWS)
			expect(round.read).toBeLessThanOrEqual(6 * TOKEN_ROUND_ROWS)
		}
		expect(await sql(h.store, 'SELECT token_hash FROM oauth_tokens WHERE account_id = ? ORDER BY 1', alice.id)).toEqual(
			[1, 2, 3, 4, 5].map((i) => ({ token_hash: `u0000${i}` }))
		)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_subscriptions')).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
		// The other accounts' tokens are untouched.
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(bob.token))).status).toBe(200)
	}, 120_000)
})

describe('report resolution, bound to the generation', () => {
	async function reported() {
		const w = await world()
		const reporter = await userToken(w.h, 'bob@example.com', 'write:reports')
		const report = async () => {
			const response = await w.h.request('/api/v1/reports', bearer(reporter, json({ account_id: w.alice.id })))
			return (await response.json<{ id: string }>()).id
		}
		const states = () =>
			sql<{ id: string; resolved: number; by: string | null }>(
				w.h.store,
				`SELECT CAST(id AS TEXT) AS id, action_taken_at IS NOT NULL AS resolved, action_taken_by_account_id AS by
				FROM reports ORDER BY id`
			)
		return { ...w, report, states }
	}

	it('resolves the reports frozen at the suspension; never one filed after it, or one the admin reopened since', async () => {
		const { h, admin, alice, owner, report, states } = await reported()
		const [open, closed] = [await report(), await report()]
		await h.request(`/api/v1/admin/reports/${closed}/resolve`, bearer(admin, { method: 'POST' }))
		h.now.mockReturnValue(NOW + 1000)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		// After the suspension: the admin reopens one, and a report on alice arrives (only a row can: she is unavailable).
		h.now.mockReturnValue(NOW + 2000)
		expect((await h.request(`/api/v1/admin/reports/${closed}/reopen`, bearer(admin, { method: 'POST' }))).status).toBe(
			200
		)
		await sql(
			h.store,
			`INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, forwarded, uri, created_at)
			VALUES (?, ?, '[]', '', 'other', 0, 'https://kopje.test/late-report', ?)`,
			h.users.bob.id,
			alice.id,
			new Date(NOW + 2000).toISOString()
		)
		const late = (await states()).at(-1)!.id
		await settle(h.store)
		expect(await states()).toEqual([
			{ id: open, resolved: 1, by: owner.id },
			{ id: closed, resolved: 0, by: null },
			{ id: late, resolved: 0, by: null },
		])
	})

	it('resolves nothing for a generation that ended, and resolves for the next one', async () => {
		const { h, admin, alice, owner, report, states } = await reported()
		const first = await report()
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		h.now.mockReturnValue(NOW + 1000)
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		await settle(h.store)
		expect(await states()).toEqual([{ id: first, resolved: 0, by: null }])
		// Suspended again: a new generation, whose job resolves what is unresolved at its time.
		const second = await report()
		h.now.mockReturnValue(NOW + 2000)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(h.store)
		expect(await states()).toEqual([
			{ id: first, resolved: 1, by: owner.id },
			{ id: second, resolved: 1, by: owner.id },
		])
	})

	it('ends the jobs of a suspension that a second one replaced', async () => {
		const { h, admin, alice, report, states } = await reported()
		h.now.mockReturnValue(NOW - 1000)
		await report()
		h.now.mockReturnValue(NOW)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		// The same request time: the second suspension still gets an epoch of its own.
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		const generations = await sql<{ generation: number }>(
			h.store,
			"SELECT generation FROM moderation_jobs WHERE kind = 'suspension' ORDER BY id"
		)
		expect(generations).toEqual([{ generation: 1 }, { generation: 2 }])
		expect((await suspendedAt(h.store, alice.id))?.credential_epoch).toBe(2)
		await settle(h.store)
		expect((await states()).map((row) => row.resolved)).toEqual([1])
		// One Update of each generation was recorded; only the second's carries targets.
		expect(await sql(h.store, 'SELECT count(*) AS n FROM moderation_jobs')).toEqual([{ n: 0 }])
	})
})

describe('the report fence (R37, VIS-29; concurrency row 21)', () => {
	// A report of alice's, filed and resolved through the API at `filed` (both before the suspension).
	async function resolvedReport(w: Awaited<ReturnType<typeof world>>, reporter: string) {
		const response = await w.h.request('/api/v1/reports', bearer(reporter, json({ account_id: w.alice.id })))
		const id = (await response.json<{ id: string }>()).id
		expect((await w.h.request(`/api/v1/admin/reports/${id}/resolve`, bearer(w.admin, { method: 'POST' }))).status).toBe(
			200
		)
		return id
	}

	const reopen = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
		(await w.h.request(`/api/v1/admin/reports/${id}/reopen`, bearer(w.admin, { method: 'POST' }))).status

	const resolved = (store: StoreStub) =>
		sql<{ id: string; resolved: number }>(
			store,
			'SELECT CAST(id AS TEXT) AS id, action_taken_at IS NOT NULL AS resolved FROM reports ORDER BY id'
		)

	it('leaves open a report reopened after the suspension, though its clock reads earlier (row 21)', async () => {
		const w = await world()
		const reporter = await userToken(w.h, 'bob@example.com', 'write:reports')
		const t0 = NOW
		const t1 = NOW + 60_000
		w.h.now.mockReturnValue(t0 - 1000)
		const report = await resolvedReport(w, reporter)
		const untouched = (
			await (
				await w.h.request('/api/v1/reports', bearer(reporter, json({ account_id: w.alice.id })))
			).json<{
				id: string
			}>()
		).id
		// Applied in this order through the Store: the suspension at t1, then the reopen at t0 < t1.
		w.h.now.mockReturnValue(t1)
		expect(await act(w.h, w.admin, w.alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		w.h.now.mockReturnValue(t0)
		expect(await reopen(w, report)).toBe(200)
		await settle(w.h.store)
		expect(await resolved(w.h.store)).toEqual([
			{ id: report, resolved: 0 },
			{ id: untouched, resolved: 1 },
		])
		// Each report carries the log row of the admin action that last wrote it: the reopen's, and the suspension's for
		// the one its round resolved (no row of its own).
		expect(
			await sql(
				w.h.store,
				`SELECT CAST(r.id AS TEXT) AS id, a.action FROM reports r JOIN admin_actions a ON a.id = r.last_action_id
				ORDER BY r.id`
			)
		).toEqual([
			{ id: report, action: 'reopen' },
			{ id: untouched, action: 'suspend' },
		])
		expect((await logRows(w.h.store)).map((row) => row.action)).toEqual(['resolve', 'suspend', 'reopen'])
	})

	it('resolves a report reopened before the suspension, though its clock reads later', async () => {
		const w = await world()
		const reporter = await userToken(w.h, 'bob@example.com', 'write:reports')
		w.h.now.mockReturnValue(NOW - 1000)
		const report = await resolvedReport(w, reporter)
		w.h.now.mockReturnValue(NOW + 60_000)
		expect(await reopen(w, report)).toBe(200)
		w.h.now.mockReturnValue(NOW)
		expect(await act(w.h, w.admin, w.alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(w.h.store)
		expect(await resolved(w.h.store)).toEqual([{ id: report, resolved: 1 }])
	})

	it('never resolves a report filed after the suspension, though its clock reads earlier', async () => {
		const w = await world()
		w.h.now.mockReturnValue(NOW)
		expect(await act(w.h, w.admin, w.alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		// Only a row can report alice now (she is unavailable to the API); it carries a clock before the suspension.
		await sql(
			w.h.store,
			`INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, forwarded, uri, created_at)
			VALUES (?, ?, '[]', '', 'other', 0, 'https://kopje.test/late-report', ?)`,
			w.bob.id,
			w.alice.id,
			new Date(NOW - 60_000).toISOString()
		)
		await settle(w.h.store)
		expect((await resolved(w.h.store)).map((row) => row.resolved)).toEqual([0])
	})

	it('leaves open a report reopened while the job is held between its report rounds', async () => {
		const w = await world()
		const reporter = await userToken(w.h, 'bob@example.com', 'write:reports')
		// More reports than one round reads, so the job's report phase spans rounds; the reopened one is read last.
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, forwarded, uri, created_at)
			SELECT ?1, ?2, '[]', '', 'other', 0, 'https://kopje.test/seeded/' || i, ?4 FROM n`,
			w.bob.id,
			w.alice.id,
			REPORT_ROUND + 20,
			new Date(NOW - 120_000).toISOString()
		)
		w.h.now.mockReturnValue(NOW - 60_000)
		const report = await resolvedReport(w, reporter)
		w.h.now.mockReturnValue(NOW)
		expect(await act(w.h, w.admin, w.alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		const reached = deferred()
		const gate = deferred()
		// The jobs a round at a time, each in its own transaction (as runModerationJobs runs them); held once the
		// suspension job has read its first round of reports.
		const run = (async () => {
			let after = 0
			let held = false
			for (let i = 0; i < 1_000; i++) {
				if (!held) {
					const cursor = await sql<{ n: number }>(
						w.h.store,
						`SELECT count(*) AS n FROM moderation_jobs
						WHERE kind = 'suspension' AND phase = 'reports' AND json_extract(state, '$.cursor') > 0`
					)
					if (cursor[0]!.n > 0) {
						held = true
						reached.resolve()
						await gate.promise
					}
				}
				const ran = await runInDurableObject(w.h.store, (_instance, state) =>
					state.storage.transactionSync(() => moderationRound(new Db(state.storage.sql), NOW, after))
				)
				if (ran === null) {
					return held
				}
				after = ran.id
			}
			throw new Error('the jobs did not end')
		})()
		await reached.promise
		w.h.now.mockReturnValue(NOW - 30_000)
		expect(await reopen(w, report)).toBe(200)
		gate.resolve()
		expect(await run).toBe(true)
		const rows = await resolved(w.h.store)
		expect(rows.filter((row) => row.resolved === 0)).toEqual([{ id: report, resolved: 0 }])
		expect(rows).toHaveLength(REPORT_ROUND + 21)
	})
})

describe('the reach of both Updates (AccountReachFinder)', () => {
	it('sends both Updates to followers and to the remote recipient of a recent direct message who does not follow', async () => {
		const { h, admin, alice } = await world()
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		await remoteAccount(h.store, 'dan', 'dm.example')
		const followed = await remoteAccount(h.store, 'followed', 'followed.example')
		const stale = await remoteAccount(h.store, 'stale', 'stale.example')
		const requested = await remoteAccount(h.store, 'requested', 'requested.example')
		const distant = await remoteAccount(h.store, 'distant', 'distant.example')
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES
				(?1, ?2, 'accepted', ?5), (?1, ?3, 'accepted', '2020-01-01T00:00:00.000Z'), (?1, ?4, 'pending', ?5)`,
			alice.id,
			followed,
			stale,
			requested,
			new Date(NOW - 60_000).toISOString()
		)
		await post(h, alice, { status: '@dan@dm.example just you', visibility: 'direct' })
		// A direct message older than the cutoff reaches no one (its id is a snowflake of its time, as a status's is).
		const old = ((BigInt(NOW - RECENT_MS - 60_000) << 16n) | 1n).toString()
		await sql(
			h.store,
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?1, 'https://kopje.test/old', ?2, 'direct', '', ?3)`,
			old,
			alice.id,
			new Date(NOW - RECENT_MS - 60_000).toISOString()
		)
		await sql(
			h.store,
			'INSERT INTO status_mentions (status_id, account_id, requires_mention) VALUES (?, ?, 1)',
			old,
			distant
		)
		expect((await drain(h.store)).map((sent) => [sent.type, sent.inbox])).toEqual([
			['Create', 'https://dm.example/inbox'],
		])

		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		// Nothing is sent before the job stages the audience.
		expect(await drain(h.store)).toEqual([])
		await settle(h.store)
		const reach = [
			'https://dm.example/inbox',
			'https://fans.example/inbox',
			'https://followed.example/inbox',
			'https://requested.example/inbox',
		]
		const suspension = await drain(h.store)
		expect(suspension.map((sent) => [sent.type, sent.inbox, sent.suspended])).toEqual(
			reach.map((inbox) => ['Update', inbox, true])
		)
		expect(suspension[0]!.object).not.toHaveProperty('name')

		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		await settle(h.store)
		const restoration = await drain(h.store)
		expect(restoration.map((sent) => [sent.type, sent.inbox, sent.suspended])).toEqual(
			reach.map((inbox) => ['Update', inbox, false])
		)
		expect(restoration[0]!.object).toMatchObject({ preferredUsername: 'alice', name: '' })
		// Staging leaves nothing behind.
		expect(await sql(h.store, 'SELECT count(*) AS n FROM moderation_reach')).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM outbound_activities')).toEqual([{ n: 0 }])
	})

	it('stages 10,000 followers within every round budget', async () => {
		const measure = async (followers: number) => {
			const { h, admin, alice } = await world()
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain, inbox_url)
				SELECT printf('%018d', 700000000000000000 + i), 'https://f' || i || '.example/users/u', 'u', 'f' || i || '.example',
					'https://f' || i || '.example/inbox' FROM n`,
				followers
			)
			await sql(
				h.store,
				"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '7*'",
				alice.id
			)
			expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
			const measured = (await rounds(h.store)).filter((round) => round.kind === 'suspension')
			const targets = await sql<{ n: number }>(
				h.store,
				'SELECT coalesce(sum(json_array_length(targets)), 0) + (SELECT count(*) FROM deliveries) AS n FROM outbound_targets'
			)
			return { measured, targets: targets[0]!.n }
		}
		const few = await measure(1_000)
		const many = await measure(10_000)
		expect(many.targets).toBe(10_000)
		expect(few.targets).toBe(1_000)
		// Staging and writing take a round per REACH_ROUND followers each.
		expect(many.measured.length).toBeGreaterThanOrEqual((2 * 10_000) / REACH_ROUND)
		for (const round of [...few.measured, ...many.measured]) {
			expect(round.wrote, round.phase).toBeLessThanOrEqual(MODERATION_ROUND_ROWS)
		}
		// A round reads no more with ten times the followers.
		const most = (rounds: Round[]) => Math.max(...rounds.map((round) => round.read))
		expect(most(many.measured)).toBeLessThanOrEqual(most(few.measured) + 10)
		expect(REACH_ROUND / TARGET_CHUNK_SIZE).toBeLessThan(MODERATION_ROUND_ROWS - REACH_ROUND)
	}, 300_000)
})

describe('the sender rule (R1)', () => {
	it('drops the content a suspended account queued, and sends its retraction and its suspension Update', async () => {
		const { h, admin, alice } = await world()
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		const author = await remoteAccount(h.store, 'author', 'remote.example')
		const early = await seedStatus(h.store, { accountId: author, visibility: 'public' })
		const later = await seedStatus(h.store, { accountId: author, visibility: 'public' })
		const boost = (id: string, undo = false) =>
			h.request(`/api/v1/statuses/${id}/${undo ? 'unreblog' : 'reblog'}`, bearer(alice.token, { method: 'POST' }))
		expect((await boost(early)).status).toBe(200)
		expect((await drain(h.store)).map((sent) => sent.type)).toEqual(['Announce', 'Announce'])
		// Queued before the suspension: a Create, a boost, and the Undo of the boost already sent.
		await post(h, alice, { status: 'queued before the suspension' })
		expect((await boost(later)).status).toBe(200)
		expect((await boost(early, true)).status).toBe(200)
		const queued = await sql<{ type: string }>(
			h.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type FROM deliveries d
			JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
		)
		expect(queued.map((row) => row.type)).toEqual(['Create', 'Announce', 'Announce', 'Undo', 'Undo'])

		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(h.store)
		const sent = await drain(h.store)
		expect(sent.map((s) => [s.type, s.inbox, s.suspended]).sort()).toEqual([
			['Undo', 'https://fans.example/inbox', false],
			['Undo', 'https://remote.example/inbox', false],
			['Update', 'https://fans.example/inbox', true],
		])
		// Nothing is left in the lanes: the Create and the boost were dropped.
		expect(await sql(h.store, 'SELECT count(*) AS n FROM deliveries')).toEqual([{ n: 0 }])
		// Dropped at their claim while suspended: nothing comes back after the unsuspension but its Update.
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		await settle(h.store)
		expect((await drain(h.store)).map((s) => [s.type, s.suspended])).toEqual([['Update', false]])
	})

	it('drops the restoration Update once the account is suspended again before it is sent', async () => {
		const { h, admin, alice } = await world()
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(h.store)
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		await settle(h.store)
		h.now.mockReturnValue(NOW + 1000)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(h.store)
		expect((await drain(h.store)).map((s) => [s.type, s.suspended])).toEqual([
			['Update', true],
			['Update', true],
		])
	})
})

describe('review regressions (A3b rounds 1 and 2)', () => {
	it('refuses an old token stamped far ahead, and signs in again at once after the unsuspension', async () => {
		const { h, admin, alice } = await world()
		const client = (await sql<{ id: string }>(h.store, 'SELECT client_id AS id FROM oauth_tokens LIMIT 1'))[0]!.id
		// Issued before the suspension by a caller whose clock ran years ahead.
		const late = 'late-token-0123456789abcdef'
		await sql(
			h.store,
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, created_at) VALUES (?, 'access', ?, ?, 'read', ?)",
			await sha256Hex(late),
			client,
			alice.id,
			'2030-01-01T00:00:00.000Z'
		)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		expect(await suspendedAt(h.store, alice.id)).toEqual({
			suspended_at: new Date(NOW).toISOString(),
			credential_epoch: 1,
		})
		h.now.mockReturnValue(NOW + 1000)
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(late))).status).toBe(401)
		// A sign-in right after the unsuspension works, through a code and the web, whatever the old token's time.
		const fresh = await userToken(h, 'alice@example.com', 'read')
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(fresh))).status).toBe(200)
		const browser = await signIn(h, 'alice@example.com')
		expect((await h.request('/settings', { headers: { cookie: browser.cookie } })).status).toBe(200)
		// The tokens job deletes the old one with the others, and leaves the new ones.
		await settle(h.store)
		expect(
			await sql(h.store, 'SELECT count(*) AS n FROM oauth_tokens WHERE token_hash = ?', await sha256Hex(late))
		).toEqual([{ n: 0 }])
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(fresh))).status).toBe(200)
	})

	it('ends the credentials of a suspension made before the epoch existed when it is lifted', async () => {
		const { h, admin, alice } = await world()
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			alice.id
		)
		h.now.mockReturnValue(NOW + 1000)
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		expect(await suspendedAt(h.store, alice.id)).toEqual({ suspended_at: null, credential_epoch: 1 })
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(alice.token))).status).toBe(401)
		const fresh = await userToken(h, 'alice@example.com', 'read')
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(fresh))).status).toBe(200)
	})

	it('leaves open a report reopened after a re-suspension, before its job runs', async () => {
		const { h, admin, alice } = await world()
		const client = (await sql<{ id: string }>(h.store, 'SELECT client_id AS id FROM oauth_tokens LIMIT 1'))[0]!.id
		await sql(
			h.store,
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, created_at) VALUES ('ahead', 'access', ?, ?, 'read', ?)",
			client,
			alice.id,
			new Date(NOW + 60_000).toISOString()
		)
		const reporter = await userToken(h, 'bob@example.com', 'write:reports')
		h.now.mockReturnValue(NOW - 1000)
		const report = (
			await (
				await h.request('/api/v1/reports', bearer(reporter, json({ account_id: alice.id })))
			).json<{ id: string }>()
		).id
		await h.request(`/api/v1/admin/reports/${report}/resolve`, bearer(admin, { method: 'POST' }))
		h.now.mockReturnValue(NOW)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		h.now.mockReturnValue(NOW + 1000)
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		h.now.mockReturnValue(NOW + 2000)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		h.now.mockReturnValue(NOW + 3000)
		expect((await h.request(`/api/v1/admin/reports/${report}/reopen`, bearer(admin, { method: 'POST' }))).status).toBe(
			200
		)
		await settle(h.store)
		expect(await sql(h.store, 'SELECT action_taken_at IS NOT NULL AS resolved FROM reports')).toEqual([{ resolved: 0 }])
	})

	it("keeps the newer suspension's Update when the replaced one's job ends, its intent id reused", async () => {
		const { h, admin, alice } = await world()
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		// The first Update had no targets yet, so superseding it deleted it, and the second took its id.
		const intents = await sql<{ intent_id: number }>(
			h.store,
			"SELECT intent_id FROM moderation_jobs WHERE kind = 'suspension' ORDER BY id"
		)
		expect(intents).toHaveLength(2)
		expect(intents[0]!.intent_id).toBe(intents[1]!.intent_id)
		await settle(h.store)
		expect((await drain(h.store)).map((sent) => [sent.type, sent.inbox, sent.suspended])).toEqual([
			['Update', 'https://fans.example/inbox', true],
		])
	})

	it('sends the restoration to a non-follower even when the profile is edited before it is staged', async () => {
		const { h, admin, alice } = await world()
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		await remoteAccount(h.store, 'dan', 'dm.example')
		await post(h, alice, { status: '@dan@dm.example just you', visibility: 'direct' })
		await drain(h.store)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(h.store)
		await drain(h.store)
		h.now.mockReturnValue(NOW + 1000)
		expect((await unsuspend(h, admin, alice.id)).status).toBe(200)
		// Signed in again, alice edits her profile before the restoration's audience is staged.
		const token = await userToken(h, 'alice@example.com', 'read write')
		const edited = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(token, form({ display_name: 'Alice again' }, { method: 'PATCH' }))
		)
		expect(edited.status).toBe(200)
		await settle(h.store)
		const sent = await drain(h.store, NOW + 1000)
		const dm = sent.filter((s) => s.inbox === 'https://dm.example/inbox')
		expect(dm.map((s) => [s.type, s.suspended])).toEqual([['Update', false]])
		// It carries the edited profile, not the one from before the edit.
		expect(dm[0]!.object).toMatchObject({ name: 'Alice again' })
		expect(sent.filter((s) => s.inbox === 'https://fans.example/inbox').every((s) => !s.suspended)).toBe(true)
	})

	it('reads the next status mentions when the read budget runs out on the status itself', async () => {
		const { h, admin, alice } = await world()
		const [m1, m2] = [
			await remoteAccount(h.store, 'm1', 'mention.example'),
			await remoteAccount(h.store, 'm2', 'mention.example'),
		]
		const dan = await remoteAccount(h.store, 'dan', 'dm.example')
		// 166 statuses of two mentions each read 3 rows apiece (498), an unmentioned one 1 more: finding the next
		// status takes the round's last read, so its mentions are read in the next round.
		for (let i = 0; i < 166; i++) {
			await seedStatus(h.store, {
				accountId: alice.id,
				visibility: 'direct',
				mentions: [{ accountId: m1 }, { accountId: m2 }],
			})
		}
		await seedStatus(h.store, { accountId: alice.id, visibility: 'public' })
		await seedStatus(h.store, { accountId: alice.id, visibility: 'direct', mentions: [{ accountId: dan }] })
		expect(REACH_ROUND).toBe(500)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(h.store)
		expect((await drain(h.store)).map((sent) => sent.inbox).sort()).toEqual([
			'https://dm.example/inbox',
			'https://mention.example/inbox',
		])
	})

	it('never resolves a report the admin touched in the millisecond of the suspension', async () => {
		const { h, admin, alice } = await world()
		const reporter = await userToken(h, 'bob@example.com', 'write:reports')
		h.now.mockReturnValue(NOW - 1000)
		const report = async () =>
			(
				await (
					await h.request('/api/v1/reports', bearer(reporter, json({ account_id: alice.id })))
				).json<{ id: string }>()
			).id
		const [untouched, reopened] = [await report(), await report()]
		await h.request(`/api/v1/admin/reports/${reopened}/resolve`, bearer(admin, { method: 'POST' }))
		h.now.mockReturnValue(NOW)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		expect(
			(await h.request(`/api/v1/admin/reports/${reopened}/reopen`, bearer(admin, { method: 'POST' }))).status
		).toBe(200)
		await settle(h.store)
		expect(
			await sql(
				h.store,
				'SELECT CAST(id AS TEXT) AS id, action_taken_at IS NOT NULL AS resolved FROM reports ORDER BY id'
			)
		).toEqual([
			{ id: untouched, resolved: 1 },
			{ id: reopened, resolved: 0 },
		])
	})

	it('counts only the inboxes a capped source stages first', async () => {
		const { h, admin, alice } = await world()
		// 2,001 recent follows of accounts sharing one server's inbox, then one of another server: Mastodon counts the
		// distinct inboxes, so the last one is reached.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
			INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			SELECT printf('%018d', 700000000000000000 + i), 'https://crowd.example/users/u' || i, 'u' || i, 'crowd.example',
				'https://crowd.example/users/u' || i || '/inbox', 'https://crowd.example/inbox' FROM n`
		)
		// Its id is above the crowd's, so the walk in target order reaches it last.
		await sql(
			h.store,
			"INSERT INTO accounts (id, uri, username, domain, inbox_url) VALUES ('800000000000000000', 'https://zz.example/users/zz', 'zz', 'zz.example', 'https://zz.example/users/zz/inbox')"
		)
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state, created_at) SELECT ?1, id, 'accepted', ?2 FROM accounts WHERE domain IN ('crowd.example', 'zz.example')",
			alice.id,
			new Date(NOW - 60_000).toISOString()
		)
		expect(await act(h, admin, alice.id, { type: 'suspend' })).toEqual({ status: 200, body: {} })
		await settle(h.store)
		expect((await drain(h.store)).map((sent) => sent.inbox).sort()).toEqual([
			'https://crowd.example/inbox',
			'https://zz.example/users/zz/inbox',
		])
	})
})

describe('POST /admin/accounts/unsuspend (AUTH-5)', () => {
	let team: AccessTeam

	beforeEach(async () => {
		team = await adminTeam()
	})

	it('unsuspends a local account through Access only, keeps its epoch, and logs the Access identity', async () => {
		const store = await migratedStore()
		await setTeamAccess(store, team)
		const alice = await seedAccount(store, { username: 'alice', email: 'alice@example.com' })
		await runInDurableObject(store, (_instance, state) =>
			state.storage.transactionSync(() => suspendLocal(new Db(state.storage.sql), alice, null, NOW))
		)
		const { as, request, jobs } = adminHarness(store, team)
		const call = async (body: Record<string, unknown>) => {
			const response = await as(adminClaims(), '/admin/accounts/unsuspend', json(body))
			return { status: response.status, body: await response.json<Record<string, unknown>>() }
		}
		expect(await call({ username: 'nobody' })).toMatchObject({ status: 404, body: { code: 'account-not-found' } })
		expect(await call({})).toMatchObject({ status: 400 })
		expect(jobs).not.toHaveBeenCalled()
		expect(await call({ username: '@Alice' })).toEqual({ status: 200, body: { username: 'alice' } })
		expect(jobs).toHaveBeenCalledTimes(1)
		expect(await suspendedAt(store, alice)).toEqual({ suspended_at: null, credential_epoch: 1 })
		expect(await sql(store, "SELECT kind FROM moderation_jobs WHERE kind = 'reach'")).toEqual([{ kind: 'reach' }])
		expect(await call({ username: 'alice' })).toMatchObject({ status: 409, body: { code: 'not-suspended' } })
		expect(
			await sql<{ actor: string; action: string; target_id: string; detail: string }>(
				store,
				'SELECT actor, action, target_id, detail FROM admin_actions'
			)
		).toEqual([
			{
				actor: 'access',
				action: 'unsuspend',
				target_id: alice,
				detail: expect.stringContaining('"username":"alice"'),
			},
		])
		// Without Access: no route.
		expect((await request('/admin/accounts/unsuspend', json({ username: 'alice' }))).status).toBe(401)
	})
})
