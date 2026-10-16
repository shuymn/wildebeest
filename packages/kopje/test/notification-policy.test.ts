import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, form, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { act, community, follow, getJson, ids, post, remoteAccount, type Status, type User } from './status-helpers'
import { Db } from '../src/db/sql'
import { PRIVATE_MENTION_WALK } from '../src/domain/audience'
import { deleteStatusBatch, purgeBatch } from '../src/domain/inbox'
import { MAX_BULK_REQUESTS, REQUEST_JOB_BATCHES, REQUEST_JOB_WINDOW } from '../src/domain/notification-requests'
import { type NotificationType, notify } from '../src/domain/notifications'
import { writeOperation } from '../src/domain/operation'

// The notification policy and notification requests (Mastodon 4.5's NotifyService::DropCondition and
// FilterCondition, NotificationPolicy, NotificationRequest, NotificationPermission and their controllers).

type Notification = { id: string; type: string; account: { id: string }; status?: Status }
type Request = {
	id: string
	created_at: string
	updated_at: string
	notifications_count: string
	account: { id: string }
	last_status: Status | null
}

const DAY = 86_400_000
const iso = (at: number) => new Date(at).toISOString()

const notifyOp = writeOperation<
	{ recipientId: string; type: NotificationType; fromId: string; statusId: string | null },
	void
>((db, input) => notify(db, { ...input, now: NOW }))

async function setPolicy(h: ApiHarness, user: User, policy: Record<string, string>): Promise<Response> {
	return h.request('/api/v2/notifications/policy', bearer(user.token, json(policy, { method: 'PUT' })))
}

// The recipient's notifications as [type, sender], newest first, with the query given.
async function listed(h: ApiHarness, user: User, query = ''): Promise<[string, string][]> {
	const { status, body } = await getJson<Notification[]>(h, `/api/v1/notifications${query}`, user.token)
	expect(status).toBe(200)
	return body.map((n) => [n.type, n.account.id])
}

// Every notification row of the recipient, filtered or not, as [type, sender, filtered].
async function stored(h: ApiHarness, user: User): Promise<[string, string, number][]> {
	return (
		await sql<{ type: string; from_account_id: string; filtered: number }>(
			h.store,
			'SELECT type, from_account_id, filtered FROM notifications WHERE account_id = ? ORDER BY id DESC',
			user.id
		)
	).map((row) => [row.type, row.from_account_id, row.filtered])
}

async function requests(h: ApiHarness, user: User, query = ''): Promise<Request[]> {
	const { status, body } = await getJson<Request[]>(h, `/api/v1/notifications/requests${query}`, user.token)
	expect(status).toBe(200)
	return body
}

const defaults = {
	for_not_following: 'accept',
	for_not_followers: 'accept',
	for_new_accounts: 'accept',
	for_private_mentions: 'filter',
	for_limited_accounts: 'filter',
}

describe('the notification policy', () => {
	it("shows Mastodon's defaults through both versions, with an empty summary", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		expect((await getJson(h, '/api/v2/notifications/policy', alice.token)).body).toEqual({
			...defaults,
			summary: { pending_requests_count: 0, pending_notifications_count: 0 },
		})
		expect((await getJson(h, '/api/v1/notifications/policy', alice.token)).body).toEqual({
			filter_not_following: false,
			filter_not_followers: false,
			filter_new_accounts: false,
			filter_private_mentions: true,
			summary: { pending_requests_count: 0, pending_notifications_count: 0 },
		})
	})

	it('updates the v2 enums sent and keeps the others, refusing a value that is not one', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const response = await setPolicy(h, alice, { for_not_following: 'filter', for_limited_accounts: 'drop' })
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			...defaults,
			for_not_following: 'filter',
			for_limited_accounts: 'drop',
			summary: { pending_requests_count: 0, pending_notifications_count: 0 },
		})
		// PATCH too, a form, and the enum's integer.
		const patched = await h.request(
			'/api/v2/notifications/policy',
			bearer(alice.token, form({ for_new_accounts: '2', unknown: 'x' }, { method: 'PATCH' }))
		)
		expect(await patched.json()).toMatchObject({ for_not_following: 'filter', for_new_accounts: 'drop' })
		// An unknown choice changes nothing, the other values sent included.
		const refused = await setPolicy(h, alice, { for_not_followers: 'filter', for_private_mentions: 'block' })
		expect({ status: refused.status, body: await refused.json() }).toEqual({
			status: 422,
			body: { error: "'block' is not a valid for_private_mentions" },
		})
		expect((await setPolicy(h, alice, { for_not_followers: '' })).status).toBe(422)
		expect((await getJson(h, '/api/v2/notifications/policy', alice.token)).body).toMatchObject({
			for_not_followers: 'accept',
			for_private_mentions: 'filter',
		})
	})

	it('maps the v1 booleans to filter and accept, and shows drop as true', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await setPolicy(h, alice, { for_new_accounts: 'drop' })
		const response = await h.request(
			'/api/v1/notifications/policy',
			bearer(alice.token, json({ filter_not_following: true, filter_private_mentions: false }, { method: 'PUT' }))
		)
		expect(await response.json()).toEqual({
			filter_not_following: true,
			filter_not_followers: false,
			filter_new_accounts: true,
			filter_private_mentions: false,
			summary: { pending_requests_count: 0, pending_notifications_count: 0 },
		})
		expect((await getJson(h, '/api/v2/notifications/policy', alice.token)).body).toMatchObject({
			for_not_following: 'filter',
			for_new_accounts: 'drop',
			for_private_mentions: 'accept',
		})
		// A form's "false" and "0" accept; filter_new_accounts=false turns drop into accept.
		await h.request(
			'/api/v1/notifications/policy',
			bearer(alice.token, form({ filter_not_following: 'false', filter_new_accounts: '0' }, { method: 'PATCH' }))
		)
		expect((await getJson(h, '/api/v2/notifications/policy', alice.token)).body).toMatchObject({
			for_not_following: 'accept',
			for_new_accounts: 'accept',
		})
	})

	it('needs the notification scopes', async () => {
		const h = await community(['alice'], 'read:notifications')
		const { alice } = h.users
		expect((await h.request('/api/v2/notifications/policy', bearer(alice.token))).status).toBe(200)
		expect((await setPolicy(h, alice, { for_not_following: 'filter' })).status).toBe(403)
		const other = await community(['bob'], 'read:statuses')
		expect((await h.request('/api/v1/notifications/policy', bearer(other.users.bob.token))).status).toBe(401)
	})

	it('summarizes at most 100 requests from available senders', async () => {
		const h = await community(['alice', 'eve'])
		const { alice, eve } = h.users
		// 150 remote senders with a request of 100 notifications each, and a suspended local sender's request.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(700000000000000000 + i AS TEXT), 'https://far.example/users/s' || i, 's' || i, 'far.example' FROM n`
		)
		await sql(
			h.store,
			`INSERT INTO notification_requests (account_id, from_account_id, notifications_count)
			SELECT ?, id, 100 FROM accounts WHERE domain = 'far.example'`,
			alice.id
		)
		const summary = async () =>
			(
				(await getJson<{ summary: unknown }>(h, '/api/v2/notifications/policy', alice.token)).body as {
					summary: unknown
				}
			).summary
		expect(await summary()).toEqual({ pending_requests_count: 100, pending_notifications_count: 10_000 })
		await sql(h.store, "DELETE FROM notification_requests WHERE from_account_id GLOB '7*' AND rowid > 3")
		await sql(
			h.store,
			'INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 7)',
			alice.id,
			eve.id
		)
		expect(await summary()).toEqual({ pending_requests_count: 4, pending_notifications_count: 307 })
		await sql(
			h.store,
			"UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
			eve.id
		)
		expect(await summary()).toEqual({ pending_requests_count: 3, pending_notifications_count: 300 })
	})
})

describe('the policy as notify writes', () => {
	it('filters or drops a sender the recipient does not follow (for_not_following)', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await post(h, bob, { status: '@alice one' })
		expect(await stored(h, alice)).toEqual([['mention', bob.id, 0]])
		await setPolicy(h, alice, { for_not_following: 'filter' })
		await post(h, bob, { status: '@alice two' })
		expect(await stored(h, alice)).toEqual([
			['mention', bob.id, 1],
			['mention', bob.id, 0],
		])
		await setPolicy(h, alice, { for_not_following: 'drop' })
		await post(h, bob, { status: '@alice three' })
		expect(await stored(h, alice)).toHaveLength(2)
		// Following the sender lets everything through.
		await follow(h, alice, bob.id)
		await post(h, bob, { status: '@alice four' })
		expect((await stored(h, alice))[0]).toEqual(['mention', bob.id, 0])
	})

	it('counts a follower from three days of following (for_not_followers)', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await setPolicy(h, alice, { for_not_followers: 'filter' })
		const status = await post(h, alice, { status: 'hello' })
		await act(h, bob, `/api/v1/statuses/${status.id}/favourite`)
		expect(await stored(h, alice)).toEqual([['favourite', bob.id, 1]])
		await follow(h, bob, alice.id)
		// A follow younger than three days counts as none.
		await sql(h.store, 'UPDATE follows SET created_at = ? WHERE account_id = ?', iso(NOW - 3 * DAY + 1), bob.id)
		await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)
		await sql(h.store, 'UPDATE follows SET created_at = ? WHERE account_id = ?', iso(NOW - 3 * DAY), bob.id)
		const other = await post(h, alice, { status: 'again' })
		await act(h, bob, `/api/v1/statuses/${other.id}/favourite`)
		expect((await stored(h, alice)).filter(([type]) => type !== 'follow')).toEqual([
			['favourite', bob.id, 0],
			['reblog', bob.id, 1],
			['favourite', bob.id, 1],
		])
		// The follow notification itself came from a sender who did not follow yet.
		expect((await stored(h, alice)).find(([type]) => type === 'follow')).toEqual(['follow', bob.id, 1])
		await setPolicy(h, alice, { for_not_followers: 'drop' })
		await sql(h.store, 'DELETE FROM follows')
		const third = await post(h, alice, { status: 'third' })
		await act(h, bob, `/api/v1/statuses/${third.id}/favourite`)
		expect(await stored(h, alice)).toHaveLength(4)
	})

	it('filters an account younger than 30 days the recipient does not follow (for_new_accounts)', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await setPolicy(h, alice, { for_new_accounts: 'filter' })
		const age = (at: number) => sql(h.store, 'UPDATE accounts SET created_at = ? WHERE id = ?', iso(at), bob.id)
		await age(NOW - 30 * DAY + 1)
		await post(h, bob, { status: '@alice young' })
		await age(NOW - 30 * DAY)
		await post(h, bob, { status: '@alice old enough' })
		expect(await stored(h, alice)).toEqual([
			['mention', bob.id, 0],
			['mention', bob.id, 1],
		])
		await age(NOW)
		await setPolicy(h, alice, { for_new_accounts: 'drop' })
		await post(h, bob, { status: '@alice dropped' })
		expect(await stored(h, alice)).toHaveLength(2)
		await follow(h, alice, bob.id)
		await post(h, bob, { status: '@alice followed' })
		expect((await stored(h, alice))[0]).toEqual(['mention', bob.id, 0])
	})

	it('filters a private mention that answers none of the recipient’s by default (for_private_mentions)', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const direct = (user: User, text: string, reply?: string) =>
			post(h, user, { status: text, visibility: 'direct', ...(reply === undefined ? {} : { in_reply_to_id: reply }) })
		const first = await direct(bob, '@alice hi')
		expect(await stored(h, alice)).toEqual([['mention', bob.id, 1]])
		// A public mention is not a private one.
		await post(h, bob, { status: '@alice public' })
		// Alice's private mention of bob, and bob's answer to it, and to a status below it: answers.
		const asked = await direct(alice, '@bob @carol hello')
		const answer = await direct(bob, '@alice answer', asked.id)
		await direct(bob, '@alice more', answer.id)
		// A reply to bob's own first message answers nothing of alice's.
		await direct(bob, '@alice again', first.id)
		expect((await stored(h, alice)).filter(([, from]) => from === bob.id)).toEqual([
			['mention', bob.id, 1],
			['mention', bob.id, 0],
			['mention', bob.id, 0],
			['mention', bob.id, 0],
			['mention', bob.id, 1],
		])
		// A parent that mentions the sender ends the walk even when someone else wrote it: carol's message to bob, under
		// alice's to bob, is not alice's.
		const fromCarol = await direct(carol, '@bob @alice from carol', asked.id)
		await direct(bob, '@alice under carol', fromCarol.id)
		expect((await stored(h, alice))[0]).toEqual(['mention', bob.id, 1])
		await setPolicy(h, alice, { for_private_mentions: 'drop' })
		const before = (await stored(h, alice)).length
		await direct(bob, '@alice dropped')
		expect(await stored(h, alice)).toHaveLength(before)
		await setPolicy(h, alice, { for_private_mentions: 'accept' })
		await direct(bob, '@alice accepted')
		expect((await stored(h, alice))[0]).toEqual(['mention', bob.id, 0])
	})

	it('walks a thread up to the depth Mastodon does', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const asked = await post(h, alice, { status: '@bob question', visibility: 'direct' })
		// A chain of public statuses of bob's below alice's private mention, PRIVATE_MENTION_WALK + 1 long and then one
		// more, seeded directly.
		const chain = async (length: number, top: string) => {
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO statuses (id, uri, account_id, in_reply_to_id, in_reply_to_uri, visibility, content, published_at)
				SELECT printf('9%017d', ?3 + i), 'https://kopje.test/ap/o/chain' || (?3 + i), ?2,
					CASE WHEN i = 1 THEN ?4 ELSE printf('9%017d', ?3 + i - 1) END, 'https://kopje.test/ap/o/parent', 'public',
					'', '2026-10-01T00:00:00.000Z'
				FROM n`,
				length,
				bob.id,
				length * 1000,
				top
			)
			return `9${String(length * 1000 + length).padStart(17, '0')}`
		}
		// The parent and PRIVATE_MENTION_WALK statuses above it are read: alice's at the top of a chain of
		// PRIVATE_MENTION_WALK is read, one further up is not.
		const near = await chain(PRIVATE_MENTION_WALK, asked.id)
		const far = await chain(PRIVATE_MENTION_WALK + 1, asked.id)
		await post(h, bob, { status: '@alice near', visibility: 'direct', in_reply_to_id: near })
		await post(h, bob, { status: '@alice far', visibility: 'direct', in_reply_to_id: far })
		expect(await stored(h, alice)).toEqual([
			['mention', bob.id, 1],
			['mention', bob.id, 0],
		])
	})

	it('lets a sender with a permission through whatever the policy chooses', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await setPolicy(h, alice, {
			for_not_following: 'drop',
			for_not_followers: 'drop',
			for_new_accounts: 'drop',
			for_private_mentions: 'drop',
		})
		await post(h, bob, { status: '@alice dropped', visibility: 'direct' })
		expect(await stored(h, alice)).toEqual([])
		await sql(
			h.store,
			'INSERT INTO notification_permissions (account_id, from_account_id) VALUES (?, ?)',
			alice.id,
			bob.id
		)
		await post(h, bob, { status: '@alice through', visibility: 'direct' })
		expect(await stored(h, alice)).toEqual([['mention', bob.id, 0]])
	})

	it('never filters or drops a type that is not filterable', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await setPolicy(h, alice, {
			for_not_following: 'drop',
			for_not_followers: 'drop',
			for_new_accounts: 'drop',
			for_private_mentions: 'drop',
		})
		const status = await post(h, bob, { status: 'mine' })
		// Bob's boost of it, which a reblog notification needs.
		await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)
		const types: NotificationType[] = ['status', 'update', 'poll', 'mention', 'favourite', 'reblog', 'follow']
		for (const type of [...types, 'follow_request' as const]) {
			await runInDurableObject(h.store, (_instance, state) =>
				notifyOp.run(state.storage.sql, {
					recipientId: alice.id,
					type,
					fromId: bob.id,
					statusId: ['follow', 'follow_request'].includes(type) ? null : status.id,
				})
			)
		}
		expect((await stored(h, alice)).map(([type]) => type).sort()).toEqual(['poll', 'status', 'update'])
		await setPolicy(h, alice, {
			for_not_following: 'filter',
			for_not_followers: 'filter',
			for_new_accounts: 'filter',
			for_private_mentions: 'filter',
		})
		for (const type of ['favourite', 'reblog', 'follow', 'follow_request'] as const) {
			await runInDurableObject(h.store, (_instance, state) =>
				notifyOp.run(state.storage.sql, {
					recipientId: alice.id,
					type,
					fromId: bob.id,
					statusId: type.startsWith('follow') ? null : status.id,
				})
			)
		}
		expect((await stored(h, alice)).map(([type, , filtered]) => `${type}:${filtered}`).sort()).toEqual([
			'favourite:1',
			'follow:1',
			'follow_request:1',
			'poll:0',
			'reblog:1',
			'status:0',
			'update:0',
		])
		// A filtered notification has no group, and opens no request unless it is a mention.
		expect(
			await sql(h.store, 'SELECT count(*) AS n FROM notifications WHERE filtered = 1 AND group_key IS NOT NULL')
		).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM notification_requests')).toEqual([{ n: 0 }])
	})
})

describe('filtered notifications in the reads', () => {
	// Bob's filtered private mention and filtered favourite of alice, between carol's shown mention and favourite.
	async function scene() {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await setPolicy(h, alice, { for_not_followers: 'filter', for_private_mentions: 'accept' })
		// Carol's follow is filtered (a follow of no time is none), and it counts from four days ago afterwards.
		await follow(h, carol, alice.id)
		await sql(h.store, 'UPDATE follows SET created_at = ? WHERE account_id = ?', iso(NOW - 4 * DAY), carol.id)
		const status = await post(h, alice, { status: 'hello' })
		await post(h, carol, { status: '@alice from carol', visibility: 'direct' })
		await post(h, bob, { status: '@alice from bob', visibility: 'direct' })
		await act(h, bob, `/api/v1/statuses/${status.id}/favourite`)
		await act(h, carol, `/api/v1/statuses/${status.id}/favourite`)
		return { h, alice, bob, carol, status }
	}

	it('leaves them out of the v1 list and its unread count unless include_filtered or account_id asks', async () => {
		const { h, alice, bob, carol } = await scene()
		expect(await listed(h, alice)).toEqual([
			['favourite', carol.id],
			['mention', carol.id],
		])
		expect(await listed(h, alice, '?include_filtered=true')).toEqual([
			['favourite', carol.id],
			['favourite', bob.id],
			['mention', bob.id],
			['mention', carol.id],
			['follow', carol.id],
		])
		expect(await listed(h, alice, '?include_filtered=false')).toHaveLength(2)
		expect(await listed(h, alice, `?account_id=${bob.id}`)).toEqual([
			['favourite', bob.id],
			['mention', bob.id],
		])
		const count = async (path: string) => (await getJson<{ count: number }>(h, path, alice.token)).body.count
		expect(await count('/api/v1/notifications/unread_count')).toBe(2)
		expect(await count('/api/v1/notifications/unread_count?include_filtered=1')).toBe(5)
		expect(await count(`/api/v1/notifications/unread_count?account_id=${bob.id}`)).toBe(2)
		// One by id, as Mastodon's show finds any of the viewer's.
		const [filtered] = await ids(h, `/api/v1/notifications?account_id=${bob.id}`, alice.token)
		expect((await getJson(h, `/api/v1/notifications/${filtered}`, alice.token)).body).toMatchObject({
			id: filtered,
			type: 'favourite',
		})
	})

	it('leaves them out of the grouped list and its unread count unless include_filtered asks', async () => {
		const { h, alice, bob, carol, status } = await scene()
		type Grouped = { notification_groups: { group_key: string; type: string; sample_account_ids: string[] }[] }
		const groups = async (query = '') =>
			(await getJson<Grouped>(h, `/api/v2/notifications${query}`, alice.token)).body.notification_groups.map((g) => [
				g.type,
				g.sample_account_ids,
			])
		expect(await groups()).toEqual([
			['favourite', [carol.id]],
			['mention', [carol.id]],
		])
		// Bob's favourite is filtered, so it is a group of its own and not in carol's.
		expect(await groups('?include_filtered=true')).toEqual([
			['favourite', [carol.id]],
			['favourite', [bob.id]],
			['mention', [bob.id]],
			['mention', [carol.id]],
			['follow', [carol.id]],
		])
		const count = async (query = '') =>
			(await getJson<{ count: number }>(h, `/api/v2/notifications/unread_count${query}`, alice.token)).body.count
		expect(await count()).toBe(2)
		expect(await count('?include_filtered=true')).toBe(5)
		// The group of the status's favourites holds carol's alone, and its accounts too.
		const key = `favourite-${status.id}-${Math.floor(NOW / 3_600_000)}`
		const group = (await getJson<Grouped>(h, `/api/v2/notifications/${key}`, alice.token)).body
		expect(group.notification_groups.map((g) => g.sample_account_ids)).toEqual([[carol.id]])
		const accounts = (await getJson<{ id: string }[]>(h, `/api/v2/notifications/${key}/accounts`, alice.token)).body
		expect(accounts.map((a) => a.id)).toEqual([carol.id])
	})

	it('queues no push for them and adds no conversation', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await sql(
			h.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy)
			SELECT token_hash, 'https://push.example/1', 'p', 'a', '{"mention":true}', 'all' FROM oauth_tokens WHERE account_id = ?`,
			alice.id
		)
		await post(h, bob, { status: '@alice secret', visibility: 'direct' })
		expect(await stored(h, alice)).toEqual([['mention', bob.id, 1]])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversations WHERE account_id = ?', alice.id)).toEqual([
			{ n: 0 },
		])
		// A shown one is pushed.
		await follow(h, alice, bob.id)
		await post(h, bob, { status: '@alice open', visibility: 'direct' })
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 1 }])
	})
})

describe('notification requests', () => {
	// Bob, carol and dave send alice private mentions she filters: bob two, carol and dave one each.
	async function scene() {
		const h = await community(['alice', 'bob', 'carol', 'dave'])
		const { alice, bob, carol, dave } = h.users
		const mention = (user: User, text: string) => post(h, user, { status: `@alice ${text}`, visibility: 'direct' })
		await mention(bob, 'one')
		const last = await mention(bob, 'two')
		await mention(carol, 'three')
		await mention(dave, 'four')
		return { h, alice, bob, carol, dave, last }
	}

	it('lists the requests newest first, paged by id with Link headers, in Mastodon’s shape', async () => {
		const { h, alice, bob, carol, dave, last } = await scene()
		const all = await requests(h, alice)
		expect(all.map((r) => [r.account.id, r.notifications_count])).toEqual([
			[dave.id, '1'],
			[carol.id, '1'],
			[bob.id, '2'],
		])
		expect(all[2]).toEqual({
			id: expect.stringMatching(/^\d+$/),
			created_at: iso(NOW),
			updated_at: iso(NOW),
			notifications_count: '2',
			account: expect.objectContaining({ id: bob.id, acct: 'bob' }),
			last_status: expect.objectContaining({ id: last.id }),
		})
		const response = await h.request('/api/v1/notifications/requests?limit=2', bearer(alice.token))
		expect(response.headers.get('link')).toContain(`max_id=${all[1]!.id}>; rel="next"`)
		expect(response.headers.get('link')).toContain(`min_id=${all[0]!.id}>; rel="prev"`)
		expect((await requests(h, alice, `?max_id=${all[1]!.id}`)).map((r) => r.id)).toEqual([all[2]!.id])
		expect((await requests(h, alice, `?min_id=${all[2]!.id}&limit=1`)).map((r) => r.id)).toEqual([all[1]!.id])
		// Another account has none; a suspended sender's request is not listed, but is shown by id.
		expect(await requests(h, bob)).toEqual([])
		await sql(
			h.store,
			"UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
			dave.id
		)
		expect((await requests(h, alice)).map((r) => r.account.id)).toEqual([carol.id, bob.id])
		expect((await getJson(h, `/api/v1/notifications/requests/${all[0]!.id}`, alice.token)).status).toBe(200)
	})

	it('shows one request to its recipient alone, and counts at most 100 notifications', async () => {
		const { h, alice, bob } = await scene()
		const [request] = (await requests(h, alice)).filter((r) => r.account.id === bob.id)
		const shown = await getJson<Request>(h, `/api/v1/notifications/requests/${request!.id}`, alice.token)
		expect(shown).toMatchObject({ status: 200, body: { id: request!.id, notifications_count: '2' } })
		expect((await getJson(h, `/api/v1/notifications/requests/${request!.id}`, bob.token)).status).toBe(404)
		expect((await getJson(h, '/api/v1/notifications/requests/nope', alice.token)).status).toBe(404)
		await sql(h.store, 'UPDATE notification_requests SET notifications_count = 99 WHERE id = ?', request!.id)
		for (const text of ['a', 'b']) {
			await post(h, bob, { status: `@alice ${text}`, visibility: 'direct' })
		}
		expect(
			(await getJson<Request>(h, `/api/v1/notifications/requests/${request!.id}`, alice.token)).body.notifications_count
		).toBe('100')
	})

	it('accepts: the sender’s notifications are shown and join the conversations, and later ones are not filtered', async () => {
		const { h, alice, bob, carol } = await scene()
		const [request] = (await requests(h, alice)).filter((r) => r.account.id === bob.id)
		expect(
			(await h.request(`/api/v1/notifications/requests/${request!.id}/accept`, bearer(bob.token, form({})))).status
		).toBe(404)
		const accepted = await h.request(
			`/api/v1/notifications/requests/${request!.id}/accept`,
			bearer(alice.token, form({}))
		)
		expect({ status: accepted.status, body: await accepted.json() }).toEqual({ status: 200, body: {} })
		expect(await listed(h, alice)).toEqual([
			['mention', bob.id],
			['mention', bob.id],
		])
		expect((await requests(h, alice)).map((r) => r.account.id)).not.toContain(bob.id)
		expect((await getJson(h, '/api/v1/notifications/requests/merged', alice.token)).body).toEqual({ merged: true })
		const { body: conversations } = await getJson<{ accounts: { id: string }[] }[]>(
			h,
			'/api/v1/conversations',
			alice.token
		)
		expect(conversations.map((c) => c.accounts.map((a) => a.id))).toEqual([[bob.id], [bob.id]])
		await post(h, bob, { status: '@alice later', visibility: 'direct' })
		expect((await stored(h, alice)).filter(([, from]) => from === bob.id).map(([, , f]) => f)).toEqual([0, 0, 0])
		// Carol's stay filtered.
		expect(await listed(h, alice, `?account_id=${carol.id}`)).toEqual([['mention', carol.id]])
		expect((await listed(h, alice)).some(([, from]) => from === carol.id)).toBe(false)
	})

	it('dismisses: the request and the sender’s filtered notifications go, and a later one opens a new request', async () => {
		const { h, alice, bob } = await scene()
		const [request] = (await requests(h, alice)).filter((r) => r.account.id === bob.id)
		expect(
			(await h.request(`/api/v1/notifications/requests/${request!.id}/dismiss`, bearer(bob.token, form({})))).status
		).toBe(404)
		const dismissed = await h.request(
			`/api/v1/notifications/requests/${request!.id}/dismiss`,
			bearer(alice.token, form({}))
		)
		expect({ status: dismissed.status, body: await dismissed.json() }).toEqual({ status: 200, body: {} })
		expect(await listed(h, alice, `?account_id=${bob.id}`)).toEqual([])
		expect((await stored(h, alice)).some(([, from]) => from === bob.id)).toBe(false)
		expect((await getJson(h, `/api/v1/notifications/requests/${request!.id}`, alice.token)).status).toBe(404)
		await post(h, bob, { status: '@alice again', visibility: 'direct' })
		const [again] = (await requests(h, alice)).filter((r) => r.account.id === bob.id)
		expect(again).toMatchObject({ notifications_count: '1' })
		expect(BigInt(again!.id)).toBeGreaterThan(BigInt(request!.id))
	})

	it('accepts and dismisses in bulk, the viewer’s requests among the ids', async () => {
		const { h, alice, bob, carol, dave } = await scene()
		const byAccount = new Map((await requests(h, alice)).map((r) => [r.account.id, r.id]))
		const accepted = await h.request(
			'/api/v1/notifications/requests/accept',
			bearer(alice.token, json({ id: [byAccount.get(bob.id), byAccount.get(carol.id), '999', 'x'] }))
		)
		expect({ status: accepted.status, body: await accepted.json() }).toEqual({ status: 200, body: {} })
		expect((await listed(h, alice)).map(([, from]) => from)).toEqual([carol.id, bob.id, bob.id])
		// dismiss_bulk destroys the requests alone, as Mastodon's: the sender's filtered notifications stay.
		const dismissed = await h.request(
			'/api/v1/notifications/requests/dismiss',
			bearer(alice.token, form({ 'id[]': byAccount.get(dave.id)! }))
		)
		expect({ status: dismissed.status, body: await dismissed.json() }).toEqual({ status: 200, body: {} })
		expect(await requests(h, alice)).toEqual([])
		expect(await listed(h, alice, `?account_id=${dave.id}`)).toEqual([['mention', dave.id]])
		// Too many ids at once.
		const many = Array.from({ length: MAX_BULK_REQUESTS + 1 }, (_, i) => String(i + 1))
		const refused = await h.request('/api/v1/notifications/requests/accept', bearer(alice.token, json({ id: many })))
		expect(refused.status).toBe(422)
		expect(
			(await h.request('/api/v1/notifications/requests/accept', bearer(alice.token, json({ id: many.slice(1) }))))
				.status
		).toBe(200)
	})

	it('needs the notification scopes', async () => {
		const h = await community(['alice'], 'read:notifications')
		const { alice } = h.users
		expect((await h.request('/api/v1/notifications/requests', bearer(alice.token))).status).toBe(200)
		expect((await h.request('/api/v1/notifications/requests/merged', bearer(alice.token))).status).toBe(200)
		expect((await h.request('/api/v1/notifications/requests/accept', bearer(alice.token, form({})))).status).toBe(403)
		expect((await h.request('/api/v1/notifications/requests/1/dismiss', bearer(alice.token, form({})))).status).toBe(
			403
		)
	})

	it('unfilters a sender with more notifications than the request’s batches in the job rounds, merged once done', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		const status = await post(h, alice, { status: 'hello' })
		const count = REQUEST_JOB_WINDOW * REQUEST_JOB_BATCHES + 10
		// Bob's filtered favourites of alice's status by many of his own boosts' worth of ids: one notification each,
		// seeded with distinct statuses.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('8%017d', i), 'https://remote.example/o/' || i, ?2, 'direct', '', '2026-10-01T00:00:00.000Z' FROM n`,
			count,
			bob
		)
		await sql(
			h.store,
			`INSERT INTO notifications (account_id, type, from_account_id, status_id, filtered)
			SELECT ?, 'mention', ?, id, 1 FROM statuses WHERE account_id = ? ORDER BY id`,
			alice.id,
			bob,
			bob
		)
		await sql(
			h.store,
			'INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM statuses WHERE account_id = ?',
			alice.id,
			bob
		)
		await sql(
			h.store,
			'INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 100)',
			alice.id,
			bob
		)
		expect(status.id).toBeDefined()
		const [request] = await requests(h, alice)
		await h.request(`/api/v1/notifications/requests/${request!.id}/accept`, bearer(alice.token, form({})))
		const filtered = async () =>
			(await sql<{ n: number }>(h.store, 'SELECT count(*) AS n FROM notifications WHERE filtered = 1'))[0]!.n
		expect(await filtered()).toBe(10)
		expect((await getJson(h, '/api/v1/notifications/requests/merged', alice.token)).body).toEqual({ merged: false })
		expect(await h.store.runInboundJobs(BUILD, { now: NOW })).toMatchObject({ pending: false })
		expect(await filtered()).toBe(0)
		expect((await getJson(h, '/api/v1/notifications/requests/merged', alice.token)).body).toEqual({ merged: true })
		// Each direct mention joined alice's conversations (one per status, each its own thread).
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversations WHERE account_id = ?', alice.id)).toEqual([
			{ n: count },
		])
	}, 60_000)
})

describe('a remote sender’s purge and a status’s removal', () => {
	it('deletes the sender’s requests, permissions and jobs in its batches, and clears a removed last status', async () => {
		const h = await community(['alice', 'carol'])
		const { alice, carol } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		const uri = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', bob))[0]!.uri
		await sql(
			h.store,
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES ('800000000000000001', 'https://remote.example/o/1', ?, 'direct', '', '2026-10-01T00:00:00.000Z')`,
			bob
		)
		await sql(h.store, "INSERT INTO status_mentions (status_id, account_id) VALUES ('800000000000000001', ?)", alice.id)
		await runInDurableObject(h.store, (_instance, state) =>
			notifyOp.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'mention',
				fromId: bob,
				statusId: '800000000000000001',
			})
		)
		expect(await requests(h, alice)).toMatchObject([
			{ account: { id: bob }, last_status: { id: '800000000000000001' } },
		])
		// The status's removal leaves the request without a last status.
		await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			while (deleteStatusBatch(db, '800000000000000001', NOW)) {
				// Each batch is bounded; the loop runs them all.
			}
		})
		expect(await requests(h, alice)).toMatchObject([{ account: { id: bob }, last_status: null }])
		await sql(
			h.store,
			'INSERT INTO notification_permissions (account_id, from_account_id) VALUES (?, ?)',
			carol.id,
			bob
		)
		await sql(
			h.store,
			"INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor) VALUES (?, ?, 'dismiss', 1)",
			carol.id,
			bob
		)
		for (;;) {
			const more = await runInDurableObject(h.store, (_instance, state) =>
				purgeBatch(new Db(state.storage.sql), uri, NOW)
			)
			if (!more) {
				break
			}
		}
		expect(await sql(h.store, 'SELECT id FROM accounts WHERE id = ?', bob)).toEqual([])
		for (const table of ['notification_requests', 'notification_permissions', 'notification_request_jobs']) {
			expect([table, await sql(h.store, `SELECT count(*) AS n FROM ${table}`)]).toEqual([table, [{ n: 0 }]])
		}
	})
})
