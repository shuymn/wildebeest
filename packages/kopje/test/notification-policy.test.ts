import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { type ApiHarness, bearer, form, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD, runStoreJobs } from './helpers'
import { observedSql } from './read-helpers'
import {
	act,
	community,
	follow,
	getJson,
	ids,
	mute,
	post,
	remoteAccount,
	type Status,
	type User,
} from './status-helpers'
import { Db } from '../src/db/sql'
import { PRIVATE_MENTION_WALK } from '../src/domain/audience'
import { deleteStatusBatch, purgeBatch } from '../src/domain/inbox'
import { JOB_RETRY_DELAYS_MS } from '../src/domain/job-attempts'
import { MAX_BULK_REQUESTS, REQUEST_JOB_BATCHES, REQUEST_JOB_WINDOW } from '../src/domain/notification-requests'
import { getNotification, listNotifications, type NotificationType, notify } from '../src/domain/notifications'
import { writeOperation } from '../src/domain/operation'
import { utf8Length } from '../src/platform/dump-format'
import { sha256Hex } from '../src/security/tokens'

// The notification policy and notification requests (Mastodon 4.5's NotifyService::DropCondition and
// FilterCondition, NotificationPolicy, NotificationRequest, NotificationPermission and their controllers).

type Notification = { id: string; type: string; account: { id: string }; status?: Status; filtered?: unknown }

// A notification's `filtered`, or 'absent' when it has no such key (REST::NotificationSerializer#filtered?).
const flag = (n: { filtered?: unknown }) => (Object.hasOwn(n, 'filtered') ? n.filtered : 'absent')
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

// `count` direct statuses of `from` to the recipient, each a filtered mention, and the request they make.
async function seedFilteredMentions(h: ApiHarness, recipient: User, from: string, count: number): Promise<void> {
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT printf('8%017d', i), 'https://remote.example/o/' || i, ?2, 'direct', '', '2026-10-01T00:00:00.000Z' FROM n`,
		count,
		from
	)
	await sql(
		h.store,
		'INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM statuses WHERE account_id = ?',
		recipient.id,
		from
	)
	await sql(
		h.store,
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, filtered)
		SELECT ?, 'mention', ?, id, 1 FROM statuses WHERE account_id = ? ORDER BY id`,
		recipient.id,
		from,
		from
	)
	await sql(
		h.store,
		'INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 100)',
		recipient.id,
		from
	)
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
			(await getJson<{ summary: unknown }>(h, '/api/v2/notifications/policy', alice.token)).body.summary
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

	// REST::NotificationSerializer's `attribute :filtered, if: :filtered?`: true on a filtered notification, else absent.
	it('presents filtered: true on a filtered notification alone', async () => {
		const { h, alice, bob, carol } = await scene()
		const shown = async (query: string) =>
			(await getJson<Notification[]>(h, `/api/v1/notifications${query}`, alice.token)).body.map((n) => [
				n.type,
				n.account.id,
				flag(n),
			])
		expect(await shown('?include_filtered=true')).toEqual([
			['favourite', carol.id, 'absent'],
			['favourite', bob.id, true],
			['mention', bob.id, true],
			['mention', carol.id, 'absent'],
			['follow', carol.id, true],
		])
		expect(await shown(`?account_id=${bob.id}`)).toEqual([
			['favourite', bob.id, true],
			['mention', bob.id, true],
		])
		expect(await shown(`?account_id=${carol.id}`)).toEqual([
			['favourite', carol.id, 'absent'],
			['mention', carol.id, 'absent'],
			['follow', carol.id, true],
		])
		const one = async (id: string) =>
			flag((await getJson<Notification>(h, `/api/v1/notifications/${id}`, alice.token)).body)
		const [filtered] = await ids(h, `/api/v1/notifications?account_id=${bob.id}`, alice.token)
		const [unfiltered] = await ids(h, '/api/v1/notifications', alice.token)
		expect([await one(filtered!), await one(unfiltered!)]).toEqual([true, 'absent'])
		// Grouped notifications and requests never carry it (REST::NotificationGroupSerializer,
		// REST::NotificationRequestSerializer).
		const { body: grouped } = await getJson<{ notification_groups: Record<string, unknown>[] }>(
			h,
			'/api/v2/notifications?include_filtered=true',
			alice.token
		)
		expect(grouped.notification_groups).toHaveLength(5)
		expect(grouped.notification_groups.some((g) => Object.hasOwn(g, 'filtered'))).toBe(false)
		const { body: ungrouped } = await getJson<{ notification_groups: Record<string, unknown>[] }>(
			h,
			`/api/v2/notifications/ungrouped-${filtered}`,
			alice.token
		)
		expect(ungrouped.notification_groups.map((g) => [g.group_key, Object.hasOwn(g, 'filtered')])).toEqual([
			[`ungrouped-${filtered}`, false],
		])
		const [request] = await requests(h, alice)
		const { body: shownRequest } = await getJson<Record<string, unknown>>(
			h,
			`/api/v1/notifications/requests/${request!.id}`,
			alice.token
		)
		expect(Object.hasOwn(shownRequest, 'filtered')).toBe(false)
		expect(JSON.stringify(shownRequest)).not.toContain('"filtered":true')
		// Accepting the request unfilters the sender's notifications, which no longer carry it.
		await h.request(`/api/v1/notifications/requests/${request!.id}/accept`, bearer(alice.token, form({})))
		expect(await shown(`?account_id=${bob.id}`)).toEqual([
			['favourite', bob.id, 'absent'],
			['mention', bob.id, 'absent'],
		])
		expect(await one(filtered!)).toBe('absent')
	})

	// An imported row may hold any value (NOTIFICATION_COLUMNS, VIS-23).
	it('presents filtered only for a stored integer 1, reading no imported value out whole', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const LARGE = 1_000_000
		// Each stored value, as SQL, and what INTEGER affinity keeps of it.
		const values: [string, string, true | 'absent'][] = [
			['1', 'integer', true],
			['1.0', 'integer', true],
			["'1'", 'integer', true],
			['2', 'integer', 'absent'],
			['1.5', 'real', 'absent'],
			["'1x'", 'text', 'absent'],
			["X'01'", 'blob', 'absent'],
			[`zeroblob(${LARGE})`, 'blob', 'absent'],
		]
		for (const [value] of values) {
			// A favourite of a status of its own each (notifications_natural).
			const status = await post(h, alice, { status: 'hello' })
			await sql(
				h.store,
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, filtered)
				VALUES (?, 'favourite', ?, ?, ?, ${value})`,
				alice.id,
				bob.id,
				status.id,
				iso(NOW)
			)
		}
		const kept = await sql<{ id: string; type: string; size: number }>(
			h.store,
			`SELECT CAST(id AS TEXT) AS id, typeof(filtered) AS type, length(CAST(filtered AS BLOB)) AS size
			FROM notifications WHERE account_id = ? ORDER BY id`,
			alice.id
		)
		expect(kept.map((row) => row.type)).toEqual(values.map(([, type]) => type))
		expect(kept.at(-1)!.size).toBe(LARGE)
		const listed = (await getJson<Notification[]>(h, '/api/v1/notifications?include_filtered=true', alice.token)).body
		expect(new Map(listed.map((n) => [n.id, flag(n)]))).toEqual(new Map(kept.map((row, i) => [row.id, values[i]![2]])))
		for (const [i, row] of kept.entries()) {
			expect(flag((await getJson<Notification>(h, `/api/v1/notifications/${row.id}`, alice.token)).body)).toBe(
				values[i]![2]
			)
		}
		// The list and the show read `filtered` as 0 or 1, and nothing near the large value's size leaves SQLite.
		const credential = { tokenHash: await sha256Hex(alice.token), scope: 'read' as const, now: NOW }
		const materialized = await runInDurableObject(h.store, (_instance, state) => {
			const flags: SqlStorageValue[] = []
			let bytes = 0
			const counting = observedSql(state.storage.sql, (read) => {
				for (const row of read) {
					for (const [column, value] of Object.entries(row)) {
						if (column === 'filtered') {
							flags.push(value)
						}
						// UTF-8 bytes of a string, a buffer's bytes, 8 per number (as test/status-bounds.test.ts counts).
						bytes += typeof value === 'string' ? utf8Length(value) : value instanceof ArrayBuffer ? value.byteLength : 8
					}
				}
			})
			const present = { origin: 'https://kopje.test' }
			listNotifications.run(counting, {
				credential,
				page: { limit: 40 },
				types: [],
				excludeTypes: [],
				accountId: null,
				includeFiltered: true,
				present,
			})
			getNotification.run(counting, { credential, id: kept.at(-1)!.id, present })
			return { flags, bytes }
		})
		expect(materialized.flags.length).toBeGreaterThan(kept.length)
		expect(new Set(materialized.flags)).toEqual(new Set([0, 1]))
		expect(materialized.bytes).toBeLessThan(LARGE / 10)
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

	it('commits the answers when one job’s first batch fails in a bulk accept, and runs the other job (RES-5, D5)', async () => {
		const { h, alice, bob, carol } = await scene()
		const byAccount = new Map((await requests(h, alice)).map((r) => [r.account.id, r.id]))
		// Every unfiltering of bob's notifications fails: his job's batches throw.
		await sql(
			h.store,
			`CREATE TRIGGER test_job_fails BEFORE UPDATE OF filtered ON notifications WHEN OLD.from_account_id = '${bob.id}'
			BEGIN SELECT RAISE(ABORT, 'test: the batch fails'); END`
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		// Alice's conversations' links to bob's statuses: his batch adds them before its failing unfiltering.
		const linked = () =>
			sql(
				h.store,
				`SELECT cs.status_id FROM conversation_statuses cs JOIN conversations c ON c.id = cs.conversation_id
				JOIN statuses s ON s.id = cs.status_id WHERE c.account_id = ? AND s.account_id = ? ORDER BY cs.status_id`,
				alice.id,
				bob.id
			)
		const conversations = () =>
			sql(h.store, 'SELECT id, last_status_id FROM conversations WHERE account_id = ? ORDER BY id', alice.id)
		expect(await linked()).toEqual([])
		try {
			const accepted = await h.request(
				'/api/v1/notifications/requests/accept',
				bearer(alice.token, json({ id: [byAccount.get(bob.id), byAccount.get(carol.id)] }))
			)
			expect({ status: accepted.status, body: await accepted.json() }).toEqual({ status: 200, body: {} })
			// Both requests answered, both permissions recorded; carol's job ran, bob's failed once and backs off.
			expect((await requests(h, alice)).map((r) => r.account.id)).toEqual([h.users.dave.id])
			expect(
				await sql(h.store, 'SELECT from_account_id FROM notification_permissions ORDER BY from_account_id')
			).toEqual([bob.id, carol.id].sort().map((id) => ({ from_account_id: id })))
			expect(await listed(h, alice)).toEqual([['mention', carol.id]])
			// Bob's batch was rolled back whole: no conversation links his statuses, carol's alone joined.
			expect(await linked()).toEqual([])
			const afterFailure = await conversations()
			expect(await sql(h.store, 'SELECT from_account_id, attempts, due_at FROM notification_request_jobs')).toEqual([
				{ from_account_id: bob.id, attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]! },
			])
			await sql(h.store, 'DROP TRIGGER test_job_fails')
			expect(await runStoreJobs(h.store, BUILD, { now: NOW })).toMatchObject({ pending: false })
			expect(await listed(h, alice)).toEqual([['mention', carol.id]])
			expect(await linked()).toEqual([])
			expect(await conversations()).toEqual(afterFailure)
			await runStoreJobs(h.store, BUILD, { now: NOW + JOB_RETRY_DELAYS_MS[0]! })
			expect((await listed(h, alice)).map(([, from]) => from)).toEqual([carol.id, bob.id, bob.id])
			// The retry added them, as the batch does.
			expect(await linked()).toHaveLength(2)
			expect(await sql(h.store, 'SELECT 1 FROM notification_request_jobs')).toEqual([])
		} finally {
			vi.restoreAllMocks()
		}
	})

	it('shows a request’s last status only while its mention is shown, and a block deletes the request', async () => {
		const { h, alice, bob, carol, last } = await scene()
		const lastOf = async (sender: string) => {
			const [request] = (await requests(h, alice)).filter((r) => r.account.id === sender)
			const shown = await getJson<Request>(h, `/api/v1/notifications/requests/${request!.id}`, alice.token)
			return [request!.last_status?.id ?? null, shown.body.last_status?.id ?? null]
		}
		expect(await lastOf(bob.id)).toEqual([last.id, last.id])
		// Muting bob with notifications hides his mention (R15), though alice may still see the status (R2).
		await mute(h.store, alice.id, bob.id)
		expect(await lastOf(bob.id)).toEqual([null, null])
		expect((await getJson(h, `/api/v1/statuses/${last.id}`, alice.token)).status).toBe(200)
		// Blocking carol deletes her request, as Mastodon's AfterBlockService does.
		const [request] = (await requests(h, alice)).filter((r) => r.account.id === carol.id)
		expect((await act(h, alice, `/api/v1/accounts/${carol.id}/block`)).status).toBe(200)
		expect((await requests(h, alice)).some((r) => r.account.id === carol.id)).toBe(false)
		expect((await getJson(h, `/api/v1/notifications/requests/${request!.id}`, alice.token)).status).toBe(404)
	})

	it('shows no last status whose own mention the rule refuses, whatever other statuses it would show', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		// Bob's private mention of alice and carol, filtered; alice then blocks carol, so the rule refuses that mention
		// (it names an account she blocks), while bob's other statuses and the status itself stay visible to her.
		const dm = await post(h, bob, { status: '@alice @carol hi', visibility: 'direct' })
		await post(h, bob, { status: 'public' })
		await act(h, alice, `/api/v1/accounts/${carol.id}/block`)
		expect((await getJson(h, `/api/v1/statuses/${dm.id}`, alice.token)).status).toBe(200)
		const [request] = await requests(h, alice)
		expect(request).toMatchObject({ account: { id: bob.id }, last_status: null })
		expect(
			(await getJson<Request>(h, `/api/v1/notifications/requests/${request!.id}`, alice.token)).body.last_status
		).toBeNull()
	})

	it('takes back the permission of an accepted request when the recipient blocks its sender', async () => {
		const { h, alice, bob } = await scene()
		const [request] = (await requests(h, alice)).filter((r) => r.account.id === bob.id)
		await h.request(`/api/v1/notifications/requests/${request!.id}/accept`, bearer(alice.token, form({})))
		await setPolicy(h, alice, { for_not_following: 'drop', for_private_mentions: 'drop' })
		const fromBob = async () => (await stored(h, alice)).filter(([, from]) => from === bob.id).length
		await post(h, bob, { status: '@alice through', visibility: 'direct' })
		expect(await fromBob()).toBe(3)
		expect((await act(h, alice, `/api/v1/accounts/${bob.id}/block`)).status).toBe(200)
		expect((await act(h, alice, `/api/v1/accounts/${bob.id}/unblock`)).status).toBe(200)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM notification_permissions')).toEqual([{ n: 0 }])
		await post(h, bob, { status: '@alice dropped', visibility: 'direct' })
		expect(await fromBob()).toBe(3)
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
		const count = REQUEST_JOB_WINDOW * REQUEST_JOB_BATCHES + 10
		await seedFilteredMentions(h, alice, bob, count)
		const [request] = await requests(h, alice)
		await h.request(`/api/v1/notifications/requests/${request!.id}/accept`, bearer(alice.token, form({})))
		const filtered = async () =>
			(await sql<{ n: number }>(h.store, 'SELECT count(*) AS n FROM notifications WHERE filtered = 1'))[0]!.n
		expect(await filtered()).toBe(10)
		expect((await getJson(h, '/api/v1/notifications/requests/merged', alice.token)).body).toEqual({ merged: false })
		// A row the request's batches did not reach is still filtered and presented so, until a round unfilters it.
		const [pending] = await sql<{ id: string }>(
			h.store,
			'SELECT CAST(id AS TEXT) AS id FROM notifications WHERE filtered = 1 ORDER BY id LIMIT 1'
		)
		const pendingFlag = async () =>
			flag((await getJson<Notification>(h, `/api/v1/notifications/${pending!.id}`, alice.token)).body)
		expect(await pendingFlag()).toBe(true)
		expect(await runStoreJobs(h.store, BUILD, { now: NOW })).toMatchObject({ pending: false })
		expect(await filtered()).toBe(0)
		expect(await pendingFlag()).toBe('absent')
		expect((await getJson(h, '/api/v1/notifications/requests/merged', alice.token)).body).toEqual({ merged: true })
		// Each direct mention joined alice's conversations (one per status, each its own thread).
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversations WHERE account_id = ?', alice.id)).toEqual([
			{ n: count },
		])
	}, 60_000)
	it('leaves out of a later batch what a block since refuses, and adds none of it to a conversation', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		await seedFilteredMentions(h, alice, bob, REQUEST_JOB_WINDOW * REQUEST_JOB_BATCHES + 10)
		const [request] = await requests(h, alice)
		await h.request(`/api/v1/notifications/requests/${request!.id}/accept`, bearer(alice.token, form({})))
		const conversations = async () =>
			(await sql<{ n: number }>(h.store, 'SELECT count(*) AS n FROM conversations WHERE account_id = ?', alice.id))[0]!
				.n
		expect(await conversations()).toBe(REQUEST_JOB_WINDOW * REQUEST_JOB_BATCHES)
		// The block clears alice's conversations with bob; the round that follows brings none of them back.
		expect((await act(h, alice, `/api/v1/accounts/${bob}/block`)).status).toBe(200)
		expect(await conversations()).toBe(0)
		expect(await runStoreJobs(h.store, BUILD, { now: NOW })).toMatchObject({ pending: false })
		expect(await conversations()).toBe(0)
		expect(
			await sql(h.store, 'SELECT count(*) AS n FROM notifications WHERE filtered = 1 AND from_account_id = ?', bob)
		).toEqual([{ n: 10 }])
	}, 60_000)
})

describe('answering a pair again while its job is pending', () => {
	const COUNT = REQUEST_JOB_WINDOW * REQUEST_JOB_BATCHES * 3
	const rounds = async (h: ApiHarness) => {
		while ((await runStoreJobs(h.store, BUILD, { now: NOW })).pending) {
			// Each round is bounded; the loop runs them all.
		}
	}
	// Bob's rows to alice as [filtered, how many].
	const rows = async (h: ApiHarness, alice: User, bob: string) =>
		(
			await sql<{ filtered: number; n: number }>(
				h.store,
				'SELECT filtered, count(*) AS n FROM notifications WHERE account_id = ? AND from_account_id = ? GROUP BY filtered',
				alice.id,
				bob
			)
		).map((row) => [row.filtered, row.n])
	const answer = async (h: ApiHarness, alice: User, how: 'accept' | 'dismiss') => {
		const [request] = await requests(h, alice)
		await h.request(`/api/v1/notifications/requests/${request!.id}/${how}`, bearer(alice.token, form({})))
	}
	// A new filtered mention from bob, opening a new request.
	const mentionAgain = async (h: ApiHarness, alice: User, bob: string) => {
		await sql(
			h.store,
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES ('899999999999999999', 'https://remote.example/o/again', ?, 'direct', '', '2026-10-01T00:00:00.000Z')`,
			bob
		)
		await sql(h.store, "INSERT INTO status_mentions (status_id, account_id) VALUES ('899999999999999999', ?)", alice.id)
		await runInDurableObject(h.store, (_instance, state) =>
			notifyOp.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'mention',
				fromId: bob,
				statusId: '899999999999999999',
			})
		)
		expect(await requests(h, alice)).toHaveLength(1)
	}

	it('accepts every remaining notification when an accept follows a dismiss', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		await seedFilteredMentions(h, alice, bob, COUNT)
		await answer(h, alice, 'dismiss')
		const left = COUNT - REQUEST_JOB_WINDOW * REQUEST_JOB_BATCHES
		expect(await rows(h, alice, bob)).toEqual([[1, left]])
		await mentionAgain(h, alice, bob)
		await answer(h, alice, 'accept')
		await rounds(h)
		expect(await rows(h, alice, bob)).toEqual([[0, left + 1]])
		expect((await getJson(h, '/api/v1/notifications/requests/merged', alice.token)).body).toEqual({ merged: true })
	}, 120_000)

	it('dismisses every remaining notification when a dismiss follows an accept', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		await seedFilteredMentions(h, alice, bob, COUNT)
		await answer(h, alice, 'accept')
		const done = REQUEST_JOB_WINDOW * REQUEST_JOB_BATCHES
		expect(await rows(h, alice, bob)).toEqual([
			[0, done],
			[1, COUNT - done],
		])
		// The permission goes with a block, so bob's next mention is filtered again.
		await act(h, alice, `/api/v1/accounts/${bob}/block`)
		await act(h, alice, `/api/v1/accounts/${bob}/unblock`)
		await mentionAgain(h, alice, bob)
		await answer(h, alice, 'dismiss')
		await rounds(h)
		expect(await rows(h, alice, bob)).toEqual([[0, done]])
		expect((await getJson(h, '/api/v1/notifications/requests/merged', alice.token)).body).toEqual({ merged: true })
	}, 120_000)
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
