import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, json, setSetting, sql, userToken } from './api-helpers'
import { NOW } from './app-helpers'
import { newClient, VAPID } from './push-helpers'
import { type PlannedStatement, plannedSql, scansOf, staleStatistics } from './read-helpers'
import { community, getJson, remoteAccount, type User } from './status-helpers'
import { Db } from '../src/db/sql'
import { presentAccountWarning, writeAccountWarning } from '../src/domain/account-warnings'
import { presentAccountById } from '../src/domain/accounts'
import { listenerContext } from '../src/domain/auth'
import { notify, streamedNotification } from '../src/domain/notifications'

// The target's moderation_warning notifications (Mastodon 4.5.11's Admin::AccountAction#process_notification!,
// LocalNotificationWorker, REST::NotificationSerializer, REST::NotificationGroupSerializer and
// REST::AccountWarningSerializer; R15, R42, VIS-31): their shape in v1 and v2, who sees them, their key, removal,
// streaming, push and the notification policy.

const OWNER = 'owner@example.com'
const ADMIN_SCOPES = 'read write admin:read admin:write'
const PRESENT = { origin: 'https://kopje.test' }

type WarningBody = Record<string, unknown> & { id: string; target_account: { id: string } }
type NotificationBody = Record<string, unknown> & {
	id: string
	type: string
	group_key: string
	account: { id: string }
	moderation_warning?: WarningBody
}
type GroupedBody = {
	accounts: { id: string }[]
	notification_groups: (Record<string, unknown> & { group_key: string; type: string })[]
}

// The owner (the OAuth admin), alice and bob, each signed in; `admin` is the owner's token with the admin scopes.
async function world() {
	const h = await community(['owner', 'alice', 'bob'], 'read write follow push', {}, { VAPID_JWK: VAPID.env })
	await setSetting(h.store, 'admin_email', OWNER)
	const admin = await userToken(h, OWNER, ADMIN_SCOPES)
	return { h, admin, ...h.users }
}

async function warn(h: ApiHarness, admin: string, target: string, body: Record<string, unknown> = {}): Promise<void> {
	const response = await h.request(
		`/api/v1/admin/accounts/${target}/action`,
		bearer(admin, json({ type: 'none', ...body }))
	)
	expect(response.status).toBe(200)
}

const list = async (h: ApiHarness, user: User, query = '') =>
	(await getJson<NotificationBody[]>(h, `/api/v1/notifications${query}`, user.token)).body

const groups = async (h: ApiHarness, user: User, query = '') =>
	(await getJson<GroupedBody>(h, `/api/v2/notifications${query}`, user.token)).body

const streamed = (h: ApiHarness, user: User, id: string) =>
	runInDurableObject(h.store, (_instance, state) =>
		streamedNotification(
			new Db(state.storage.sql),
			{ accountId: user.id, now: new Date(NOW).toISOString() },
			id,
			PRESENT
		)
	)

const warningRows = (h: ApiHarness) =>
	sql<{ id: string; target_account_id: string }>(
		h.store,
		'SELECT CAST(id AS TEXT) AS id, target_account_id FROM account_warnings ORDER BY id'
	)

describe('moderation_warning: the entity (REST::AccountWarningSerializer)', () => {
	it('shows the warning in v1 to its target, sent by the target, with the account and no appeal', async () => {
		const { h, admin, bob } = await world()
		await warn(h, admin, bob.id, { text: 'please stop' })
		const body = await list(h, bob)
		expect(body).toHaveLength(1)
		const [notification] = body
		expect(Object.keys(notification!)).toEqual([
			'id',
			'type',
			'created_at',
			'group_key',
			'account',
			'moderation_warning',
		])
		expect(notification).toMatchObject({
			type: 'moderation_warning',
			created_at: new Date(NOW).toISOString(),
			group_key: `ungrouped-${notification!.id}`,
			account: { id: bob.id },
		})
		const warning = notification!.moderation_warning!
		expect(Object.keys(warning)).toEqual([
			'id',
			'action',
			'text',
			'status_ids',
			'created_at',
			'target_account',
			'appeal',
		])
		const [row] = await warningRows(h)
		expect(warning).toEqual({
			id: row!.id,
			action: 'none',
			text: 'please stop',
			status_ids: null,
			created_at: new Date(NOW).toISOString(),
			target_account: notification!.account,
			appeal: null,
		})
		expect((await getJson(h, `/api/v1/notifications/${notification!.id}`, bob.token)).body).toEqual(notification)
		// types[] and exclude_types[] name it.
		expect((await list(h, bob, '?types[]=moderation_warning')).map((n) => n.id)).toEqual([notification!.id])
		expect(await list(h, bob, '?exclude_types[]=moderation_warning')).toEqual([])
		// A stream's notification event presents it as the list does.
		expect(await streamed(h, bob, notification!.id)).toEqual(notification)
	})

	it("carries the named report's status_ids as strings", async () => {
		const { h, admin, alice, bob } = await world()
		const posted = await h.request('/api/v1/statuses', bearer(bob.token, json({ status: 'reported' })))
		const status = (await posted.json<{ id: string }>()).id
		const filed = await h.request(
			'/api/v1/reports',
			bearer(alice.token, json({ account_id: bob.id, status_ids: [status] }))
		)
		const report = (await filed.json<{ id: string }>()).id
		await warn(h, admin, bob.id, { report_id: report })
		const [notification] = await list(h, bob, '?types[]=moderation_warning')
		expect(notification!.moderation_warning).toMatchObject({ text: '', status_ids: [status] })
	})

	it('shows it in v2 as a group of its own, with the warning, and counts it unread', async () => {
		const { h, admin, bob } = await world()
		await warn(h, admin, bob.id, { text: 'one' })
		const [notification] = await list(h, bob)
		const body = await groups(h, bob)
		expect(body.accounts.map((account) => account.id)).toEqual([bob.id])
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
			'moderation_warning',
		])
		expect(group).toMatchObject({
			group_key: `ungrouped-${notification!.id}`,
			notifications_count: 1,
			type: 'moderation_warning',
			sample_account_ids: [bob.id],
			moderation_warning: notification!.moderation_warning,
		})
		// Not groupable, so grouped_types[] cannot group it; partial_avatars shows the one sample whole.
		const grouped = await groups(h, bob, '?grouped_types[]=moderation_warning&expand_accounts=partial_avatars')
		expect(grouped.notification_groups).toMatchObject([
			{ group_key: `ungrouped-${notification!.id}`, moderation_warning: notification!.moderation_warning },
		])
		expect(grouped.accounts.map((account) => account.id)).toEqual([bob.id])
		const one = await getJson<GroupedBody>(h, `/api/v2/notifications/ungrouped-${notification!.id}`, bob.token)
		expect(one.body.notification_groups).toMatchObject([{ moderation_warning: notification!.moderation_warning }])
		for (const version of ['v1', 'v2']) {
			expect((await getJson(h, `/api/${version}/notifications/unread_count`, bob.token)).body).toEqual({ count: 1 })
		}
	})
})

describe('moderation_warning: who sees it (R42, VIS-31)', () => {
	it('is its target’s alone: another account neither lists it nor finds it', async () => {
		const { h, admin, alice, bob } = await world()
		await warn(h, admin, bob.id)
		const [notification] = await list(h, bob)
		expect(await list(h, alice)).toEqual([])
		expect((await groups(h, alice)).notification_groups).toEqual([])
		expect((await getJson(h, `/api/v1/notifications/${notification!.id}`, alice.token)).status).toBe(404)
		expect((await getJson(h, `/api/v2/notifications/ungrouped-${notification!.id}`, alice.token)).status).toBe(404)
		expect(await streamed(h, alice, notification!.id)).toBeNull()
		// The owner (the admin who acted) sees none of it either.
		const owner = h.users.owner
		expect((await list(h, owner)).filter((n) => n.type === 'moderation_warning')).toEqual([])
	})

	it("leaves out a restored notification linked to another account's warning, or sent by another account", async () => {
		const { h, admin, alice, bob } = await world()
		await warn(h, admin, bob.id, { text: 'first' })
		await warn(h, admin, bob.id, { text: 'second' })
		const [, second] = await warningRows(h)
		// Unlink the second warning from its notification, then link it to alice's (sent by alice) and to one of bob's
		// sent by alice, as a crafted dump could.
		await sql(h.store, 'DELETE FROM notifications WHERE account_warning_id = ?', Number(second!.id))
		const [kept] = await list(h, bob)
		const crafted = async (recipient: string, from: string) =>
			(
				await sql<{ id: string }>(
					h.store,
					`INSERT INTO notifications (account_id, type, from_account_id, account_warning_id, created_at)
					VALUES (?, 'moderation_warning', ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
					recipient,
					from,
					Number(second!.id),
					new Date(NOW).toISOString()
				)
			)[0]!.id
		for (const [recipient, from] of [
			[alice, alice],
			[bob, alice],
		] as const) {
			const id = await crafted(recipient.id, from.id)
			expect((await list(h, recipient)).map((n) => n.id)).toEqual(recipient === bob ? [kept!.id] : [])
			expect((await groups(h, recipient)).notification_groups.map((g) => g.group_key)).toEqual(
				recipient === bob ? [kept!.group_key] : []
			)
			expect((await getJson(h, `/api/v1/notifications/${id}`, recipient.token)).status).toBe(404)
			// R15 leaves it out of the counts too, so they agree with the lists.
			for (const version of ['v1', 'v2']) {
				expect((await getJson(h, `/api/${version}/notifications/unread_count`, recipient.token)).body).toEqual({
					count: recipient === bob ? 1 : 0,
				})
			}
			expect(await streamed(h, recipient, id)).toBeNull()
			await sql(h.store, 'DELETE FROM notifications WHERE id = ?', Number(id))
		}
		// A moderation_warning with no warning at all is left out too.
		await sql(
			h.store,
			"INSERT INTO notifications (account_id, type, from_account_id, created_at) VALUES (?, 'moderation_warning', ?, ?)",
			bob.id,
			bob.id,
			new Date(NOW).toISOString()
		)
		expect((await list(h, bob)).map((n) => n.id)).toEqual([kept!.id])
		expect((await getJson(h, '/api/v1/notifications/unread_count', bob.token)).body).toEqual({ count: 1 })
	})

	it('keeps every other notification from the recipient itself out; a poll and a moderation_warning pass', async () => {
		const { h, bob } = await world()
		for (const type of ['follow', 'mention', 'favourite', 'poll', 'admin.report']) {
			await sql(
				h.store,
				'INSERT INTO notifications (account_id, type, from_account_id, created_at) VALUES (?, ?, ?, ?)',
				bob.id,
				type,
				bob.id,
				new Date(NOW).toISOString()
			)
		}
		expect((await list(h, bob)).map((n) => n.type)).toEqual(['poll'])
	})
})

describe('moderation_warning: its key and its removal', () => {
	it('writes one notification per warning: a second warning of the same account is a second notification', async () => {
		const { h, admin, bob } = await world()
		await warn(h, admin, bob.id, { text: 'one' })
		await warn(h, admin, bob.id, { text: 'one' })
		const shown = await list(h, bob)
		expect(shown.map((n) => n.moderation_warning!.id)).toEqual((await warningRows(h)).map((row) => row.id).reverse())
		// The warning's own key keeps a repeat of it out (notifications_account_warning).
		await expect(
			sql(
				h.store,
				`INSERT INTO notifications (account_id, type, from_account_id, account_warning_id, created_at)
				SELECT account_id, type, from_account_id, account_warning_id, created_at FROM notifications LIMIT 1`
			)
		).rejects.toThrow(/UNIQUE constraint failed/)
	})

	it('goes on dismissal, group dismissal and clear; the warning stays', async () => {
		const { h, admin, bob } = await world()
		for (const text of ['one', 'two', 'three']) {
			await warn(h, admin, bob.id, { text })
		}
		const [third, second] = await list(h, bob)
		const post = (path: string) => h.request(path, bearer(bob.token, { method: 'POST' }))
		expect((await post(`/api/v1/notifications/${third!.id}/dismiss`)).status).toBe(200)
		expect((await post(`/api/v2/notifications/${second!.group_key}/dismiss`)).status).toBe(200)
		expect(await list(h, bob)).toHaveLength(1)
		expect((await post('/api/v1/notifications/clear')).status).toBe(200)
		expect(await list(h, bob)).toEqual([])
		expect(await warningRows(h)).toHaveLength(3)
	})
})

describe('moderation_warning: push and the notification policy', () => {
	it('is pushed to a subscription of policy all only (the sender is the recipient itself)', async () => {
		const { h, admin, bob } = await world()
		for (const policy of ['all', 'followed', 'follower', 'none']) {
			const token = await userToken(h, 'bob@example.com', 'read push')
			const client = await newClient()
			const response = await h.request(
				'/api/v1/push/subscription',
				bearer(
					token,
					json({
						subscription: {
							endpoint: `https://push.example/send/${policy}`,
							keys: { p256dh: client.p256dh, auth: client.auth },
						},
						data: { alerts: { moderation_warning: true }, policy },
					})
				)
			)
			expect(response.status).toBe(200)
		}
		await warn(h, admin, bob.id)
		expect(
			await sql(h.store, 'SELECT p.policy FROM push_deliveries d JOIN push_subscriptions p ON p.id = d.subscription_id')
		).toEqual([{ policy: 'all' }])
	})

	it('is never filtered or dropped by the notification policy (not filterable)', async () => {
		const { h, admin, bob } = await world()
		const response = await h.request(
			'/api/v2/notifications/policy',
			bearer(
				bob.token,
				json(
					{
						for_not_following: 'drop',
						for_not_followers: 'drop',
						for_new_accounts: 'drop',
						for_private_mentions: 'drop',
						for_limited_accounts: 'drop',
					},
					{ method: 'PATCH' }
				)
			)
		)
		expect(response.status).toBe(200)
		await warn(h, admin, bob.id)
		expect((await list(h, bob)).map((n) => n.type)).toEqual(['moderation_warning'])
	})

	it('warns no remote account', async () => {
		const { h, admin } = await world()
		const carol = await remoteAccount(h.store, 'carol')
		await warn(h, admin, carol)
		expect(await warningRows(h)).toEqual([])
	})
})

describe('moderation_warning: plans (RES-7)', () => {
	it('writes and presents a warning by key, with the natural key whole, at saturation with stale statistics', async () => {
		const { h, bob, owner } = await world()
		const capture = (phase: 'before' | 'after') =>
			runInDurableObject(h.store, (_instance, state) => {
				const plans: PlannedStatement[] = []
				const db = new Db(plannedSql(state.storage.sql, /account_warning/, plans))
				const now = NOW + (phase === 'before' ? 1 : 2)
				const admin = { accountId: owner.id, clientId: 'plans', now, context: listenerContext(owner.id, now) }
				const id = state.storage.transactionSync(() => {
					const written = writeAccountWarning(db, admin, bob.id, phase, null)
					notify(db, {
						recipientId: bob.id,
						type: 'moderation_warning',
						fromId: bob.id,
						statusId: null,
						accountWarningId: written,
						now,
					})
					return written
				})
				const account = presentAccountById(db, bob.id, PRESENT)!
				expect(presentAccountWarning(db, id, account)).toMatchObject({ id, text: phase })
				return plans.map(({ query, plan }) => ({ query, plan }))
			})
		const { after } = await staleStatistics(h, {
			capture,
			grow: () =>
				// 2,000 warnings of bob, each notified, and 2,000 notifications of other types from bob's own account.
				runInDurableObject(h.store, (_instance, state) => {
					const sql = state.storage.sql
					sql.exec(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
						INSERT INTO account_warnings (target_account_id, action, text, created_at)
						SELECT ?1, 'none', 'grown ' || i, ?2 FROM n`,
						bob.id,
						new Date(NOW).toISOString()
					)
					sql.exec(
						`INSERT INTO notifications (account_id, type, from_account_id, account_warning_id, created_at)
						SELECT ?1, 'moderation_warning', ?1, id, ?2 FROM account_warnings WHERE text LIKE 'grown %'`,
						bob.id,
						new Date(NOW).toISOString()
					)
					sql.exec(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
						INSERT INTO notifications (account_id, type, from_account_id, created_at)
						SELECT ?1, 'grown-' || i, ?1, ?2 FROM n`,
						bob.id,
						new Date(NOW).toISOString()
					)
				}),
		})
		const of = (pattern: RegExp) => after.filter(({ query }) => pattern.test(query))
		for (const { query, plan } of after) {
			expect(scansOf(plan, ['notifications', 'account_warnings', 'aw']), `${query}\n${plan.join('\n')}`).toEqual([])
		}
		const [deleted] = of(/^DELETE FROM notifications WHERE account_id = \?1/)
		expect(deleted?.plan.join('\n')).toMatch(
			/SEARCH notifications USING INDEX notifications_natural \(account_id=\? AND type=\? AND from_account_id=\? AND <expr>=\? AND <expr>=\? AND <expr>=\?\)/
		)
		const [presented] = of(/FROM account_warnings/)
		expect(presented?.plan).toEqual(['SEARCH account_warnings USING INTEGER PRIMARY KEY (rowid=?)'])
		expect(of(/^INSERT INTO account_warnings/)).toHaveLength(1)
	})
})
