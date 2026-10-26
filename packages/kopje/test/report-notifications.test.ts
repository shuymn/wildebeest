import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { adminClaims, adminHarness, adminTeam, setTeamAccess } from './access-helpers'
import { type ApiHarness, bearer, form, json, login, registerApp, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { mastodonFlag } from './fixtures/flags'
import { BUILD } from './helpers'
import { mastodonActor, type TestActor } from './inbox-helpers'
import { ALICE, type Setup, setup } from './inbox-status-helpers'
import { ADMIN_EMAIL } from './ops-helpers'
import { type Client, newClient, readPush, VAPID } from './push-helpers'
import { deferred, deliveryDeps } from './quote-helpers'
import { appToken, rowsRead } from './read-helpers'
import { community, remoteAccount, type User } from './status-helpers'
import { Db } from '../src/db/sql'
import { PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { MAX_PUSH_BACKLOG, streamedNotification } from '../src/domain/notifications'
import { createReport } from '../src/domain/reports'
import { MODERATION_ROUNDS, REPORT_ROUND } from '../src/domain/suspension'
import { pushRound } from '../src/jobs/push'
import type { StoreStub } from '../src/platform/store-client'

// The OAuth admin's admin.report notifications (Mastodon 4.5.11's ReportService#notify_staff!,
// REST::NotificationSerializer, REST::NotificationGroupSerializer and REST::ReportSerializer; R34, R37, VIS-29) and the
// /admin/reports/:id redirect that clients open from one.

const SCOPES = 'read write follow push'
const ENDPOINT = 'https://push.example/send/admin'

type ReportBody = Record<string, unknown> & { id: string; target_account: { id: string } }
type NotificationBody = Record<string, unknown> & {
	id: string
	type: string
	group_key: string
	account: { id: string }
	report?: ReportBody
}
type GroupedBody = {
	accounts: { id: string }[]
	notification_groups: (Record<string, unknown> & { group_key: string; type: string; report?: ReportBody })[]
}

// The owner (the OAuth admin, admin_email = ADMIN_EMAIL, as the Access settings name it), alice and bob (local
// reporters), carol and dave on remote.example.
async function world() {
	const h = await community(['owner', 'alice', 'bob'], SCOPES, {}, { VAPID_JWK: VAPID.env })
	await sql(h.store, 'UPDATE local_accounts SET email = ? WHERE account_id = ?', ADMIN_EMAIL, h.users.owner.id)
	await setSetting(h.store, 'admin_email', ADMIN_EMAIL)
	const carol = await remoteAccount(h.store, 'carol')
	const dave = await remoteAccount(h.store, 'dave')
	return { h, owner: h.users.owner, alice: h.users.alice, bob: h.users.bob, carol, dave }
}

async function report(h: ApiHarness, user: User, account: string): Promise<string> {
	const response = await h.request(
		'/api/v1/reports',
		bearer(user.token, json({ account_id: account, comment: 'spam' }))
	)
	expect(response.status).toBe(200)
	return (await response.json<{ id: string }>()).id
}

async function adminToken(h: ApiHarness): Promise<string> {
	const scope = 'read write admin:read admin:write'
	const app = await registerApp(h, { scopes: scope })
	return (await login(h, { app, scope, email: ADMIN_EMAIL })).token
}

async function resolve(h: ApiHarness, admin: string, id: string): Promise<void> {
	const response = await h.request(`/api/v1/admin/reports/${id}/resolve`, bearer(admin, { method: 'POST' }))
	expect(response.status).toBe(200)
}

async function get<T>(h: ApiHarness, path: string, token: string | null): Promise<{ status: number; body: T }> {
	const response = await h.request(path, token === null ? {} : bearer(token))
	return { status: response.status, body: await response.json<T>() }
}

// The admin.report notifications `user` is shown by GET /api/v1/notifications, as (reporter, report) pairs.
async function reportsShown(h: ApiHarness, user: User): Promise<[string, string][]> {
	const { body } = await get<NotificationBody[]>(h, '/api/v1/notifications', user.token)
	return body.filter((n) => n.type === 'admin.report').map((n) => [n.account.id, n.report!.id])
}

// A SqlStorage over `real` that counts the rows each statement reads, whether its rows or its rowsWritten are taken.
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

const stored = (store: StoreStub) =>
	sql<{ account_id: string; from_account_id: string; report_id: number }>(
		store,
		"SELECT account_id, from_account_id, report_id FROM notifications WHERE type = 'admin.report' ORDER BY id"
	)

describe('admin.report: who is notified (ReportService#notify_staff!)', () => {
	it("notifies the admin of another local account's report, with the report as REST::ReportSerializer shows it", async () => {
		const { h, owner, alice, carol } = await world()
		const id = await report(h, alice, carol)
		const { body } = await get<NotificationBody[]>(h, '/api/v1/notifications', owner.token)
		expect(body).toHaveLength(1)
		const [notification] = body
		expect(Object.keys(notification!)).toEqual(['id', 'type', 'created_at', 'group_key', 'account', 'report'])
		expect(notification).toMatchObject({
			type: 'admin.report',
			group_key: `ungrouped-${notification!.id}`,
			account: { id: alice.id },
		})
		expect(Object.keys(notification!.report!)).toEqual([
			'id',
			'action_taken',
			'action_taken_at',
			'category',
			'comment',
			'forwarded',
			'created_at',
			'status_ids',
			'rule_ids',
			'target_account',
		])
		expect(notification!.report).toMatchObject({
			id,
			action_taken: false,
			action_taken_at: null,
			category: 'other',
			comment: 'spam',
			forwarded: false,
			status_ids: [],
			rule_ids: null,
			target_account: { id: carol, acct: 'carol@remote.example' },
		})
		// The single notification reads the same.
		expect((await get(h, `/api/v1/notifications/${notification!.id}`, owner.token)).body).toEqual(notification)
	})

	it("notifies only of an account's first unresolved report (Report#unresolved_siblings?)", async () => {
		const { h, owner, alice, bob, carol, dave } = await world()
		const admin = await adminToken(h)
		const first = await report(h, alice, carol)
		const second = await report(h, bob, carol)
		expect(await reportsShown(h, owner)).toEqual([[alice.id, first]])
		// The first resolved, the second is still unresolved: a third is not the first either.
		await resolve(h, admin, first)
		await report(h, bob, carol)
		expect(await stored(h.store)).toHaveLength(1)
		// Every report of carol resolved: the next is the first unresolved again. dave's own first notifies too.
		await resolve(h, admin, second)
		const third = (await sql<{ id: number }>(h.store, 'SELECT max(id) AS id FROM reports'))[0]!.id
		await resolve(h, admin, String(third))
		const fourth = await report(h, bob, carol)
		const ofDave = await report(h, alice, dave)
		// Each report keeps its own notification, also two of the same reporter.
		expect(await reportsShown(h, owner)).toEqual([
			[alice.id, ofDave],
			[bob.id, fourth],
			[alice.id, first],
		])
	})

	it("notifies no one of the admin's own report, which still counts as an unresolved one", async () => {
		const { h, owner, alice, carol } = await world()
		const admin = await adminToken(h)
		const own = await report(h, owner, carol)
		await report(h, alice, carol)
		expect(await stored(h.store)).toEqual([])
		await resolve(h, admin, own)
		expect(await reportsShown(h, owner)).toEqual([])
	})

	it('notifies no one without an OAuth admin (unset, or two accounts matching)', async () => {
		const { h, alice, bob, carol, dave } = await world()
		await setSetting(h.store, 'admin_email', '')
		await report(h, alice, carol)
		await setSetting(h.store, 'admin_email', 'alice@example.com')
		await sql(h.store, "UPDATE local_accounts SET email = 'ALICE@example.com' WHERE account_id = ?", bob.id)
		await report(h, bob, dave)
		expect(await stored(h.store)).toEqual([])
	})

	it('notifies the admin of a remote report, from its remote reporter (ActivityPub::Activity::Flag)', async () => {
		const t = await setup()
		await setSetting(t.store, 'admin_email', 'alice@mail.example')
		const bob = await mastodonActor(t.web, 'bob')
		const flag = mastodonFlag(bob, ['https://kopje.test/ap/users/dave'], 'spam', `${bob.uri}#flags/1`)
		expect(await t.post(bob, flag)).toBe(202)
		const reports = await sql<{ id: number; account_id: string }>(t.store, 'SELECT id, account_id FROM reports')
		expect(reports).toEqual([{ id: expect.any(Number), account_id: expect.any(String) }])
		expect(
			await sql(t.store, 'SELECT type, from_account_id, report_id FROM notifications WHERE account_id = ?', ALICE)
		).toEqual([{ type: 'admin.report', from_account_id: reports[0]!.account_id, report_id: reports[0]!.id }])
	})
})

describe('admin.report: who sees it (R37)', () => {
	it('shows it to the admin alone; a non-admin, an app token and an anonymous caller see none of it', async () => {
		const { h, owner, alice, bob, carol } = await world()
		const id = await report(h, alice, carol)
		expect(await reportsShown(h, owner)).toEqual([[alice.id, id]])
		expect(await reportsShown(h, alice)).toEqual([])
		expect(await reportsShown(h, bob)).toEqual([])
		const app = await appToken(h)
		// Mastodon's require_user!: 422 for a token without a user.
		expect((await get(h, '/api/v1/notifications', app)).status).toBe(422)
		expect((await get(h, '/api/v1/notifications', null)).status).toBe(401)
		expect((await get(h, '/api/v2/notifications', app)).status).toBe(422)
		expect((await get(h, '/api/v2/notifications', null)).status).toBe(401)
	})

	it('leaves every read once the admin changes, and comes back with it', async () => {
		const { h, owner, alice, carol } = await world()
		const id = await report(h, alice, carol)
		const [notification] = (await get<NotificationBody[]>(h, '/api/v1/notifications', owner.token)).body
		const reads = async () => ({
			v1: (await reportsShown(h, owner)).length,
			v2: (await get<GroupedBody>(h, '/api/v2/notifications', owner.token)).body.notification_groups.length,
			one: (await get(h, `/api/v1/notifications/${notification!.id}`, owner.token)).status,
			group: (await get(h, `/api/v2/notifications/ungrouped-${notification!.id}`, owner.token)).status,
			unread: (await get<{ count: number }>(h, '/api/v1/notifications/unread_count', owner.token)).body.count,
			unreadGroups: (await get<{ count: number }>(h, '/api/v2/notifications/unread_count', owner.token)).body.count,
			alice: (await reportsShown(h, alice)).length,
		})
		const shown = { v1: 1, v2: 1, one: 200, group: 200, unread: 1, unreadGroups: 1, alice: 0 }
		const hidden = { v1: 0, v2: 0, one: 404, group: 404, unread: 0, unreadGroups: 0, alice: 0 }
		expect(await reads()).toEqual(shown)
		// alice becomes the admin: the owner's notification is no longer shown, and alice is never shown the owner's.
		await setSetting(h.store, 'admin_email', 'alice@example.com')
		expect(await reads()).toEqual(hidden)
		// No admin at all (the match suspended) hides it too.
		await setSetting(h.store, 'admin_email', ADMIN_EMAIL)
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			owner.id
		)
		await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const viewer = { accountId: owner.id, now: new Date(NOW).toISOString() }
			expect(streamedNotification(db, viewer, notification!.id, { origin: 'https://kopje.test' })).toBeNull()
		})
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?', owner.id)
		expect(await reads()).toEqual(shown)
		// A stream's notification event presents it as the list does.
		await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const viewer = { accountId: owner.id, now: new Date(NOW).toISOString() }
			expect(streamedNotification(db, viewer, notification!.id, { origin: 'https://kopje.test' })).toMatchObject({
				type: 'admin.report',
				report: { id },
			})
		})
	})

	it('filters it by types[] and exclude_types[], in v1, v2 and the unread counts', async () => {
		const { h, owner, alice, bob, carol } = await world()
		await report(h, alice, carol)
		// bob follows the owner: a follow notification besides it.
		expect((await h.request(`/api/v1/accounts/${owner.id}/follow`, bearer(bob.token, { method: 'POST' }))).status).toBe(
			200
		)
		const v1 = async (query: string) =>
			(await get<NotificationBody[]>(h, `/api/v1/notifications?${query}`, owner.token)).body.map((n) => n.type)
		const v2 = async (query: string) =>
			(await get<GroupedBody>(h, `/api/v2/notifications?${query}`, owner.token)).body.notification_groups.map(
				(g) => g.type
			)
		const count = async (version: string, query: string) =>
			(await get<{ count: number }>(h, `/api/${version}/notifications/unread_count?${query}`, owner.token)).body.count
		expect(await v1('')).toEqual(['follow', 'admin.report'])
		expect(await v1('types[]=admin.report')).toEqual(['admin.report'])
		expect(await v1('exclude_types[]=admin.report')).toEqual(['follow'])
		expect(await v1('types[]=admin.report&exclude_types[]=admin.report')).toEqual([])
		expect(await v2('types[]=admin.report')).toEqual(['admin.report'])
		expect(await v2('exclude_types[]=admin.report')).toEqual(['follow'])
		expect(await count('v1', 'types[]=admin.report')).toBe(1)
		expect(await count('v1', 'exclude_types[]=admin.report')).toBe(1)
		expect(await count('v2', 'exclude_types[]=admin.report&exclude_types[]=follow')).toBe(0)
		// Never filtered by the notification policy (Notification::PROPERTIES: not filterable), whatever it says.
		expect(
			(
				await h.request(
					'/api/v2/notifications/policy',
					bearer(owner.token, json({ for_not_following: 'drop', for_new_accounts: 'drop' }, { method: 'PATCH' }))
				)
			).status
		).toBe(200)
		await report(h, bob, await remoteAccount(h.store, 'erin'))
		expect(await reportsShown(h, owner)).toHaveLength(2)
	})

	it('shows it in v2 as a group of its own, with the report (REST::NotificationGroupSerializer)', async () => {
		const { h, owner, alice, carol } = await world()
		const id = await report(h, alice, carol)
		const { body } = await get<GroupedBody>(h, '/api/v2/notifications', owner.token)
		const [notification] = (await get<NotificationBody[]>(h, '/api/v1/notifications', owner.token)).body
		expect(body.accounts.map((account) => account.id)).toEqual([alice.id])
		expect(body.notification_groups).toHaveLength(1)
		const [group] = body.notification_groups
		expect(Object.keys(group!)).toEqual([
			'group_key',
			'notifications_count',
			'type',
			'most_recent_notification_id',
			'page_min_id',
			'page_max_id',
			'latest_page_notification_at',
			'sample_account_ids',
			'report',
		])
		expect(group).toMatchObject({
			group_key: `ungrouped-${notification!.id}`,
			notifications_count: 1,
			type: 'admin.report',
			most_recent_notification_id: Number(notification!.id),
			sample_account_ids: [alice.id],
			report: notification!.report,
		})
		expect(group!.report).toMatchObject({ id, target_account: { id: carol } })
		// grouped_types[] cannot group it: it is not groupable.
		const grouped = (await get<GroupedBody>(h, '/api/v2/notifications?grouped_types[]=admin.report', owner.token)).body
		expect(grouped.notification_groups.map((g) => g.group_key)).toEqual([`ungrouped-${notification!.id}`])
		const one = (await get<GroupedBody>(h, `/api/v2/notifications/ungrouped-${notification!.id}`, owner.token)).body
		expect(one.notification_groups).toEqual([
			{
				group_key: `ungrouped-${notification!.id}`,
				notifications_count: 1,
				type: 'admin.report',
				most_recent_notification_id: Number(notification!.id),
				sample_account_ids: [alice.id],
				report: notification!.report,
			},
		])
	})
})

// A Web Push subscription of `user`'s token with `alerts`.
async function subscribe(h: ApiHarness, user: User, alerts: Record<string, boolean>): Promise<Client> {
	const client = await newClient()
	const response = await h.request(
		'/api/v1/push/subscription',
		bearer(
			user.token,
			json({
				subscription: { endpoint: ENDPOINT, keys: { p256dh: client.p256dh, auth: client.auth } },
				data: { alerts, policy: 'all' },
			})
		)
	)
	expect(response.status).toBe(200)
	return client
}

describe('admin.report: push', () => {
	async function sent(h: ApiHarness, client: Client): Promise<Record<string, unknown>[]> {
		const requests: Request[] = []
		const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init))
			return Promise.resolve(new Response(null, { status: 201 }))
		})
		await pushRound(
			h.env,
			deliveryDeps(
				() => h.store,
				fetch,
				() => NOW
			)
		)
		return Promise.all(requests.map((request) => readPush(client, request)))
	}

	it('pushes it to a subscription with the admin.report alert, titled as Mastodon titles it', async () => {
		const { h, owner, alice, carol } = await world()
		await sql(h.store, "UPDATE accounts SET display_name = 'Alice', note = '<p>hello</p>' WHERE id = ?", alice.id)
		const client = await subscribe(h, owner, { 'admin.report': true })
		await report(h, alice, carol)
		const [notification] = (await get<NotificationBody[]>(h, '/api/v1/notifications', owner.token)).body
		expect(await sent(h, client)).toEqual([
			expect.objectContaining({
				notification_id: Number(notification!.id),
				notification_type: 'admin.report',
				title: 'Alice submitted a report',
				body: 'hello',
			}),
		])
	})

	it("keeps and pushes one reporter's reports of two accounts, each until its own report goes", async () => {
		const { h, owner, alice, carol, dave } = await world()
		const admin = await adminToken(h)
		const client = await subscribe(h, owner, { 'admin.report': true })
		const ofCarol = await report(h, alice, carol)
		const ofDave = await report(h, alice, dave)
		expect(await reportsShown(h, owner)).toEqual([
			[alice.id, ofDave],
			[alice.id, ofCarol],
		])
		const pushed = await sent(h, client)
		expect(pushed.map((push) => push.notification_type)).toEqual(['admin.report', 'admin.report'])
		// Resolving one leaves both notifications; a later report of carol is not the first, of dave neither.
		await resolve(h, admin, ofCarol)
		await report(h, alice, dave)
		expect(await reportsShown(h, owner)).toEqual([
			[alice.id, ofDave],
			[alice.id, ofCarol],
		])
		// A report's notification goes with it alone: carol's purge leaves dave's.
		const uri = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', carol))[0]!.uri
		await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			while (state.storage.transactionSync(() => purgeBatch(db, uri, NOW))) {
				// next batch
			}
		})
		expect(await reportsShown(h, owner)).toEqual([[alice.id, ofDave]])
	})

	it('pushes nothing without the alert, and drops a push once the admin changes before it is sent', async () => {
		const { h, owner, alice, bob, carol, dave } = await world()
		const off = await subscribe(h, owner, { 'admin.report': false, mention: true })
		await report(h, alice, carol)
		expect(await sent(h, off)).toEqual([])
		const on = await subscribe(h, owner, { 'admin.report': true })
		await report(h, bob, dave)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 1 }])
		await setSetting(h.store, 'admin_email', 'alice@example.com')
		expect(await sent(h, on)).toEqual([])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
	})
})

describe('admin.report: removal', () => {
	it("goes with its report in a remote account's purge, before the report, within the batch", async () => {
		const { h, owner, alice, bob, carol, dave } = await world()
		await subscribe(h, owner, { 'admin.report': true })
		await report(h, alice, carol)
		await report(h, bob, carol)
		await report(h, bob, dave)
		expect(await stored(h.store)).toHaveLength(2)
		const uri = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', carol))[0]!.uri
		const writes: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, more } = await runInDurableObject(h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => purgeBatch(db, uri, NOW))
				return { wrote: changes() - before, more }
			})
			writes.push(wrote)
			if (!more) {
				break
			}
		}
		expect(writes.every((wrote) => wrote <= PURGE_BATCH)).toBe(true)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM reports WHERE target_account_id = ?', carol)).toEqual([
			{ n: 0 },
		])
		// carol's report's notification is gone, with its push; dave's stays.
		expect(await stored(h.store)).toEqual([expect.objectContaining({ from_account_id: bob.id })])
		expect(await reportsShown(h, owner)).toHaveLength(1)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 1 }])
	})
})

describe('admin.report: the purge of reports, bounded (RES-6, RES-7)', () => {
	const uriOf = async (store: StoreStub, id: string) =>
		(await sql<{ uri: string }>(store, 'SELECT uri FROM accounts WHERE id = ?', id))[0]!.uri

	// One purge batch of `uri`, with the rows it wrote (total_changes) and read (each statement's rowsRead).
	const batch = (store: StoreStub, uri: string) =>
		runInDurableObject(store, (_instance, state) => {
			const real = state.storage.sql
			const { sql: counting, read } = countingSql(real)
			const db = new Db(counting)
			const changes = () => new Db(real).first<{ n: number }>('SELECT total_changes() AS n')!.n
			const before = changes()
			const more = state.storage.transactionSync(() => purgeBatch(db, uri, NOW))
			return { wrote: changes() - before, read: read(), more }
		})

	it("deletes a report notification's pushes child-first, every batch within PURGE_BATCH", async () => {
		const { h, owner, alice, carol } = await world()
		await report(h, alice, carol)
		const pushes = PURGE_BATCH + 300
		await sql(
			h.store,
			"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('seed', 's', 'seed', 'urn:ietf:wg:oauth:2.0:oob', 'push')"
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) SELECT 'seed-' || i, 'access', 'seed', ?2, 'push' FROM n`,
			pushes,
			owner.id
		)
		await sql(
			h.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
			SELECT token_hash, 'https://push.example/' || token_hash, 'p', 'a' FROM oauth_tokens WHERE client_id = 'seed'`
		)
		await sql(
			h.store,
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT p.id, n.id, 0, 0 FROM push_subscriptions p CROSS JOIN notifications n
			WHERE p.token_hash GLOB 'seed-*' AND n.type = 'admin.report'`
		)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: pushes }])
		const uri = await uriOf(h.store, carol)
		const writes: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, more } = await batch(h.store, uri)
			writes.push(wrote)
			if (!more) {
				break
			}
		}
		expect(writes.length).toBeGreaterThan(1)
		expect(writes[0]).toBe(PURGE_BATCH)
		expect(writes.every((wrote) => wrote <= PURGE_BATCH)).toBe(true)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
		expect(await stored(h.store)).toEqual([])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM accounts WHERE id = ?', carol)).toEqual([{ n: 0 }])
	})

	it('reads the same rows per batch with 2,000 or 20,000 resolved and unresolved reports of the account', async () => {
		const history = async (count: number) => {
			const { h, alice, carol } = await world()
			for (const resolved of [true, false]) {
				await sql(
					h.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at, action_taken_at)
					SELECT ?2, ?3, '[]', 'https://kopje.test/actor#reports/' || lower(hex(randomblob(16))), ?4, ?5 FROM n`,
					count / 2,
					alice.id,
					carol,
					new Date(NOW).toISOString(),
					resolved ? new Date(NOW).toISOString() : null
				)
			}
			return batch(h.store, await uriOf(h.store, carol))
		}
		const few = await history(2_000)
		const many = await history(20_000)
		expect([few.wrote, many.wrote]).toEqual([PURGE_BATCH, PURGE_BATCH])
		expect(many.read).toBeLessThanOrEqual(few.read + 10)
	}, 120_000)
})

describe("admin.report: a remote reporter's purge, child-first and whole-batch bounded (RES-6)", () => {
	// alice is the OAuth admin; bob, a remote reporter on mastodon.example, filed a report of dave by a Flag and is then
	// deleted (an inbound DeleteActor writes the purge job and its first batch).
	async function reporterWorld() {
		const t = await setup()
		await setSetting(t.store, 'admin_email', 'alice@mail.example')
		const bob = await mastodonActor(t.web, 'bob')
		const flag = mastodonFlag(bob, ['https://kopje.test/ap/users/dave'], 'spam', `${bob.uri}#flags/1`)
		expect(await t.post(bob, flag)).toBe(202)
		const id = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri))[0]!.id
		// No delete may cascade: a notification's delete aborts while a push names it, a report's while a notification
		// does (test-only guards on this Store).
		await sql(
			t.store,
			`CREATE TRIGGER test_no_push_cascade BEFORE DELETE ON notifications
			WHEN EXISTS (SELECT 1 FROM push_deliveries WHERE notification_id = OLD.id)
			BEGIN SELECT RAISE(ABORT, 'a notification deleted with its pushes'); END`
		)
		await sql(
			t.store,
			`CREATE TRIGGER test_no_report_cascade BEFORE DELETE ON reports
			WHEN EXISTS (SELECT 1 FROM notifications WHERE report_id = OLD.id)
			BEGIN SELECT RAISE(ABORT, 'a report deleted with its notifications'); END`
		)
		return { t, bob, id }
	}

	// `count` pushes of each notification `where` selects, to that many subscriptions of alice's.
	async function pushes(store: StoreStub, where: string, count: number): Promise<void> {
		await sql(
			store,
			"INSERT OR IGNORE INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('seed', 's', 'seed', 'urn:ietf:wg:oauth:2.0:oob', 'push')"
		)
		await sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT OR IGNORE INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
			SELECT 'seed-' || i, 'access', 'seed', ?2, 'push' FROM n`,
			count,
			ALICE
		)
		await sql(
			store,
			`INSERT OR IGNORE INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
			SELECT token_hash, 'https://push.example/' || token_hash, 'p', 'a' FROM oauth_tokens WHERE client_id = 'seed'`
		)
		await sql(
			store,
			`INSERT OR IGNORE INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT p.id, n.id, 0, 0 FROM (SELECT id FROM push_subscriptions WHERE token_hash GLOB 'seed-*' ORDER BY id LIMIT ?1) p
			CROSS JOIN (SELECT id FROM notifications WHERE ${where}) n`,
			count
		)
	}

	// The rows of the tables a purge deletes from, summed: what the batch removed, cascades included, whatever
	// counted them.
	const TABLES = ['reports', 'notifications', 'push_deliveries', 'statuses', 'status_mentions', 'accounts', 'follows']
	const rowsOf = (db: Db) =>
		TABLES.reduce((sum, table) => sum + db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n, 0)

	// Deletes bob (the DeleteActor's batch), then runs the job's batches to its end: each batch's writes
	// (total_changes(), its job's completion included) and the rows it removed, which no cascade adds to.
	async function purge(t: Setup, bob: TestActor) {
		const batches: { wrote: number; removed: number; read: number }[] = []
		const first = await runInDurableObject(t.store, async (instance, state) => {
			const db = new Db(state.storage.sql)
			const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
			const [before, rows] = [changes(), rowsOf(db)]
			const result = await instance.receiveActivity(BUILD, {
				now: NOW,
				origin: 'https://kopje.test',
				actorUri: bob.uri,
				actor: null,
				actorRevision: null,
				activity: { type: 'DeleteActor', id: `${bob.uri}#delete` },
			})
			return { result, wrote: changes() - before, removed: rows - rowsOf(db) }
		})
		expect(first.result).toMatchObject({ applied: true, reason: 'actor-deleted' })
		// The DeleteActor's own two rows (the job and the account's deleted_at) come before the batch's budget.
		expect(first.wrote).toBeLessThanOrEqual(PURGE_BATCH + 2)
		batches.push({ wrote: first.wrote - 2, removed: first.removed, read: 0 })
		for (let i = 0; i < 100 && first.result.jobsPending; i++) {
			const next = await runInDurableObject(t.store, (_instance, state) => {
				const real = state.storage.sql
				const { sql: counting, read } = countingSql(real)
				const db = new Db(real)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const [before, rows] = [changes(), rowsOf(db)]
				const more = state.storage.transactionSync(() => purgeBatch(new Db(counting), bob.uri, NOW))
				return { more, wrote: changes() - before, removed: rows - rowsOf(db), read: read() }
			})
			batches.push(next)
			if (!next.more) {
				break
			}
		}
		for (const batch of batches) {
			expect(batch.wrote).toBeLessThanOrEqual(PURGE_BATCH)
			expect(batch.removed).toBeLessThanOrEqual(batch.wrote)
		}
		expect(await sql(t.store, 'SELECT count(*) AS n FROM accounts WHERE uri = ?', bob.uri)).toEqual([{ n: 0 }])
		expect(
			await sql(
				t.store,
				"SELECT done_at IS NOT NULL AS done FROM inbound_jobs WHERE kind = 'purge' AND key = ?",
				bob.uri
			)
		).toEqual([{ done: 1 }])
		return batches
	}

	it(`deletes its report's notification after its ${MAX_PUSH_BACKLOG} pushes, over several batches`, async () => {
		const { t, bob, id } = await reporterWorld()
		await pushes(t.store, `type = 'admin.report' AND from_account_id = '${id}'`, MAX_PUSH_BACKLOG)
		const batches = await purge(t, bob)
		expect(batches.length).toBeGreaterThan(2)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM reports')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM notifications')).toEqual([{ n: 0 }])
	}, 60_000)

	it('purges 1,200 reports by it, resolved and unresolved, with notifications and pushes, and those of it', async () => {
		const { t, bob, id } = await reporterWorld()
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1199)
			INSERT INTO reports (account_id, target_account_id, uri, created_at, action_taken_at)
			SELECT ?1, CASE i % 2 WHEN 0 THEN ?2 ELSE ?3 END, ?4 || '#flags/seed-' || i, 'x', CASE WHEN i % 3 = 0 THEN 'x' END
			FROM n`,
			id,
			'222222222222222222',
			ALICE,
			bob.uri
		)
		await sql(
			t.store,
			`INSERT INTO notifications (account_id, type, from_account_id, report_id)
			SELECT ?1, 'admin.report', account_id, id FROM reports WHERE uri GLOB '*#flags/seed-*' AND id % 2 = 0`,
			ALICE
		)
		// It is also reported (by alice), with that report's notification: the account is reporter and target.
		await sql(
			t.store,
			"INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, 'https://kopje.test/r/of-bob', 'x')",
			ALICE,
			id
		)
		await sql(
			t.store,
			`INSERT INTO notifications (account_id, type, from_account_id, report_id)
			SELECT ?1, 'admin.report', ?1, id FROM reports WHERE uri = 'https://kopje.test/r/of-bob'`,
			ALICE
		)
		await pushes(t.store, "type = 'admin.report' AND report_id % 7 = 0", 3)
		await purge(t, bob)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM reports')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM notifications')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
	}, 60_000)

	it("deletes its mention notifications' pushes before them (the sender window)", async () => {
		const { t, bob, id } = await reporterWorld()
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(900000000000000000 + i AS TEXT), ?2 || '/statuses/' || i, ?1, 'public', 'x' FROM n`,
			id,
			bob.uri
		)
		await sql(
			t.store,
			`INSERT INTO notifications (account_id, type, from_account_id, status_id)
			SELECT l.account_id, 'mention', ?1, s.id FROM local_accounts l CROSS JOIN statuses s WHERE s.account_id = ?1`,
			id
		)
		await pushes(t.store, `type = 'mention' AND status_id = '900000000000000001'`, MAX_PUSH_BACKLOG)
		await pushes(t.store, `type = 'mention'`, 10)
		await purge(t, bob)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM notifications')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
	}, 60_000)

	it('reads the same rows per batch with 2,000 or 20,000 reports by it', async () => {
		const read = async (count: number) => {
			const { t, bob, id } = await reporterWorld()
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO reports (account_id, target_account_id, uri, created_at, action_taken_at)
				SELECT ?2, ?3, ?4 || '#flags/seed-' || i, 'x', CASE WHEN i % 2 = 0 THEN 'x' END FROM n`,
				count,
				id,
				'222222222222222222',
				bob.uri
			)
			const batches = await purge(t, bob)
			return batches[1]!.read
		}
		const few = await read(2_000)
		const many = await read(20_000)
		expect(many).toBeLessThanOrEqual(few + 10)
	}, 120_000)
})

describe('admin.report: interleavings with resolution', () => {
	type Answer = { status: number }
	const suspend = async (h: ApiHarness, admin: string, id: string): Promise<Answer> =>
		h.request(`/api/v1/admin/accounts/${id}/action`, bearer(admin, form({ type: 'suspend' })))
	const unsuspend = async (h: ApiHarness, admin: string, id: string): Promise<Answer> =>
		h.request(`/api/v1/admin/accounts/${id}/unsuspend`, bearer(admin, { method: 'POST' }))
	const runJobs = async (store: StoreStub) => {
		for (let call = 0; call < 50; call++) {
			if (!(await store.runInboundJobs(BUILD, { now: NOW })).pending) {
				return
			}
		}
		throw new Error('the jobs did not settle')
	}
	const unresolved = async (store: StoreStub) =>
		(await sql<{ id: number }>(store, 'SELECT id FROM reports WHERE action_taken_at IS NULL ORDER BY id')).map((row) =>
			String(row.id)
		)

	it('decides by the state committed first: a report before the resolution is not the first, one after it is', async () => {
		const { h, owner, alice, bob, carol } = await world()
		const admin = await adminToken(h)
		const first = await report(h, alice, carol)
		// Reported before the resolution commits: the first is still unresolved.
		await report(h, bob, carol)
		await resolve(h, admin, first)
		expect(await reportsShown(h, owner)).toEqual([[alice.id, first]])
		// Reported after every resolution committed: the first unresolved again.
		const [second] = await unresolved(h.store)
		await resolve(h, admin, second!)
		const third = await report(h, bob, carol)
		expect(await reportsShown(h, owner)).toEqual([
			[bob.id, third],
			[alice.id, first],
		])
	})

	it("pauses a suspension's resolution part-way, between two job calls, while another report arrives", async () => {
		const { h, owner, alice, bob } = await world()
		const admin = await adminToken(h)
		// bob is the reported account here: a local one, which the admin can suspend. The first report notifies; then
		// enough reports that one call of the jobs (MODERATION_ROUNDS rounds of REPORT_ROUND) cannot resolve them all.
		const first = await report(h, alice, bob.id)
		const frozen = 1 + MODERATION_ROUNDS * REPORT_ROUND
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at)
			SELECT ?2, ?3, '[]', 'https://kopje.test/actor#reports/' || lower(hex(randomblob(16))), ?4 FROM n`,
			frozen - 1,
			alice.id,
			bob.id,
			new Date(NOW).toISOString()
		)
		expect(await reportsShown(h, owner)).toEqual([[alice.id, first]])
		h.now.mockReturnValue(NOW + 1000)
		expect((await suspend(h, admin, bob.id)).status).toBe(200)
		// One real call of the jobs: it resolves part of the frozen reports, the first among them, and leaves the rest.
		expect((await h.store.runInboundJobs(BUILD, { now: NOW + 1000 })).pending).toBe(true)
		const left = (await unresolved(h.store)).length
		expect(left).toBeGreaterThan(0)
		expect(left).toBeLessThan(frozen)
		expect(await unresolved(h.store)).not.toContain(first)
		// The next call waits at a gate: the job has more rounds to run, but none runs until the gate opens.
		const gate = deferred()
		const next = (async () => {
			await gate.promise
			return h.store.runInboundJobs(BUILD, { now: NOW + 2000 })
		})()
		// Meanwhile bob is unsuspended and reported again: reports frozen at the suspension are still unresolved, so the
		// new one is not the first unresolved report of bob, and notifies no one.
		h.now.mockReturnValue(NOW + 2000)
		expect((await unsuspend(h, admin, bob.id)).status).toBe(200)
		const later = await report(h, alice, bob.id)
		expect(await reportsShown(h, owner)).toEqual([[alice.id, first]])
		// Released: the held call finds bob unsuspended and ends the job; the runner drains.
		gate.resolve()
		await next
		await runJobs(h.store)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM moderation_jobs')).toEqual([{ n: 0 }])
		const after = await unresolved(h.store)
		expect(after).toHaveLength(left + 1)
		expect(after).toContain(later)
		expect(await reportsShown(h, owner)).toEqual([[alice.id, first]])
	})

	it('notifies of the next report once a released suspension job resolved the frozen ones', async () => {
		const { h, owner, alice, bob } = await world()
		const admin = await adminToken(h)
		await report(h, alice, bob.id)
		h.now.mockReturnValue(NOW + 1000)
		expect((await suspend(h, admin, bob.id)).status).toBe(200)
		// Released before the unsuspension: the job resolves the frozen report.
		await runJobs(h.store)
		expect(await unresolved(h.store)).toEqual([])
		h.now.mockReturnValue(NOW + 2000)
		expect((await unsuspend(h, admin, bob.id)).status).toBe(200)
		await runJobs(h.store)
		const next = await report(h, alice, bob.id)
		expect((await reportsShown(h, owner))[0]).toEqual([alice.id, next])
	})
})

describe('admin.report: bounds (RES-7)', () => {
	// A report reads the same rows whatever the reported account's other reports: `resolved` resolved ones and `open`
	// unresolved ones of other accounts, plus `siblings` unresolved ones of the same account.
	async function reported(resolved: number, open: number, siblings: number) {
		const { h, alice, carol, dave } = await world()
		const seed = async (target: string, count: number, at: string | null) =>
			sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at, action_taken_at)
				SELECT ?2, ?3, '[]', 'https://kopje.test/actor#reports/' || lower(hex(randomblob(16))), ?4, ?5 FROM n
				WHERE ?1 > 0`,
				count,
				alice.id,
				target,
				new Date(NOW).toISOString(),
				at
			)
		await seed(carol, resolved, new Date(NOW).toISOString())
		await seed(dave, open, null)
		await seed(carol, siblings, null)
		const input = {
			credential: { tokenHash: '', scope: 'write:reports', now: NOW } as const,
			account: carol,
			statusIds: [],
			comment: undefined,
			category: undefined,
			ruleIds: [],
			forward: false,
			forwardToDomains: null,
			present: { origin: 'https://kopje.test' },
			now: NOW,
		}
		const [token] = await sql<{ token_hash: string }>(
			h.store,
			'SELECT token_hash FROM oauth_tokens WHERE account_id = ? AND kind = ? LIMIT 1',
			h.users.bob.id,
			'access'
		)
		return { h, input: { ...input, credential: { ...input.credential, tokenHash: token!.token_hash } } }
	}

	it('finds a sibling, or none, by one seek: the same rows with 20 or 2,000 reports', async () => {
		for (const siblings of [0, 1]) {
			const few = await reported(20, 20, siblings)
			const many = await reported(2000, 2000, siblings * 2000)
			const fewRows = await rowsRead(few.h, createReport, few.input)
			const manyRows = await rowsRead(many.h, createReport, many.input)
			expect(manyRows).toBeLessThanOrEqual(fewRows + 10)
			expect(await stored(many.h.store)).toHaveLength(siblings === 0 ? 1 : 0)
		}
	}, 120_000)
})

describe('GET /admin/reports/:id (where clients open an admin.report)', () => {
	// The Store stub with its report read held at a gate, after the /admin middleware has authenticated the request.
	function gatedStore(store: StoreStub) {
		const reached = deferred()
		const gate = deferred()
		const stub = new Proxy(store, {
			get(target, name) {
				if (name === 'reportTargetPage') {
					return async (...args: Parameters<StoreStub['reportTargetPage']>) => {
						reached.resolve()
						await gate.promise
						return target.reportTargetPage(...args)
					}
				}
				if (typeof name !== 'string' || name === 'then') {
					return undefined
				}
				// Every other call goes to the Store as it is (an RPC stub's methods are called on the stub itself).
				const methods = target as unknown as Record<string, (...a: unknown[]) => unknown>
				return (...args: unknown[]) => methods[name]!(...args)
			},
		})
		return { stub, atGate: reached.promise, release: gate.resolve }
	}

	it.each([
		['admin_email', 'someone-else@kopje.test'],
		['access_admin_aud', 'aud-another-application'],
	])('refuses in the read when %s changes after the request was authenticated', async (name, value) => {
		const { h, alice, carol } = await world()
		const team = await adminTeam()
		await setTeamAccess(h.store, team)
		const id = await report(h, alice, carol)
		const { stub, atGate, release } = gatedStore(h.store)
		const { as } = adminHarness(stub, team)
		const pending = as(adminClaims(), `/admin/reports/${id}`)
		await atGate
		await setSetting(h.store, name, value)
		release()
		const response = await pending
		expect(response.status).toBe(403)
		expect(response.headers.get('Location')).toBeNull()
	})

	it('redirects the Access admin to the reported account’s web page; 404 for no report; refuses anyone else', async () => {
		const { h, alice, bob, carol } = await world()
		const team = await adminTeam()
		await setTeamAccess(h.store, team)
		const remote = await report(h, alice, carol)
		const local = await report(h, alice, bob.id)
		const { as, request } = adminHarness(h.store, team, { IMPORT_TOKEN: 'import-token-0123456789abcdef0123456789' })
		const toRemote = await as(adminClaims(), `/admin/reports/${remote}`)
		expect([toRemote.status, toRemote.headers.get('Location')]).toEqual([302, 'https://remote.example/@carol'])
		const toLocal = await as(adminClaims(), `/admin/reports/${local}`)
		expect([toLocal.status, toLocal.headers.get('Location')]).toEqual([302, 'https://kopje.test/@bob'])
		for (const id of ['999999', 'abc', `${remote}x`]) {
			expect((await as(adminClaims(), `/admin/reports/${id}`)).status).toBe(404)
		}
		// Anyone but the Access admin is refused before the report is read, whether or not it exists.
		for (const id of [remote, '999999']) {
			expect((await as({ email: 'alice@example.com', sub: 'user-2' }, `/admin/reports/${id}`)).status).toBe(403)
			expect((await request(`/admin/reports/${id}`)).status).toBe(401)
			expect(
				(
					await request(`/admin/reports/${id}`, {
						headers: { 'Kopje-Import-Token': 'import-token-0123456789abcdef0123456789' },
					})
				).status
			).toBe(403)
		}
	})
})
