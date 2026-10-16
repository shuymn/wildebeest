import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, sql } from '../api-helpers'
import { NOW } from '../app-helpers'
import { BUILD } from '../helpers'
import { scopedToken } from '../read-helpers'
import { act, community, follow, getJson, post, remoteAccount, type User } from '../status-helpers'
import { drained, type Inbox, subscribed } from './stream-helpers'
import { runNotificationRequestJobs } from '../../src/domain/notification-requests'

// The `direct` stream and `notifications_merged` (design "Kopje streaming API" PR 3). `conversation` is sent when a
// conversation of the viewer changes, as the conversation list presents it (R33: the row of the viewer, R25), by the
// owner's change sequence (conversations.stream_seq, from the owner's mark): at most 20 newest changes per owner a turn.
// `notifications_merged` is sent on the transition to no pending accept job, under a notification scope. Absence is
// proved with the drain barrier, which also waits for every `direct` socket's pending conversation changes.

type Conversation = { id: string; unread: boolean; last_status: { id: string } | null }

function conversations(inbox: Inbox): Conversation[] {
	return inbox
		.rest()
		.filter((m) => m.event === 'conversation')
		.map((m) => JSON.parse(m.payload!) as Conversation)
}

function merged(inbox: Inbox): unknown[] {
	return inbox.rest().filter((m) => m.event === 'notifications_merged')
}

describe('conversation on direct', () => {
	it('sends a changed conversation as the list presents it: a new status, a read, a removed last status', async () => {
		const h = await community(['alice', 'bob'])
		await follow(h, h.users.alice, h.users.bob.id)
		const inbox = await subscribed(h, h.users.alice.token, 'direct')
		const home = await subscribed(h, h.users.alice.token, 'user:notification')

		const first = await post(h, h.users.bob, { status: '@alice hi', visibility: 'direct' })
		await drained(h, inbox, home)
		const [sent] = conversations(inbox)
		const listed = await getJson<Conversation[]>(h, '/api/v1/conversations', h.users.alice.token)
		expect(listed.body).toHaveLength(1)
		expect(JSON.parse((await inbox.next((m) => m.event === 'conversation')).payload!)).toEqual(listed.body[0])
		expect(sent?.unread).toBe(true)
		// Not on the notification socket.
		expect(home.rest().filter((m) => m.event === 'conversation')).toEqual([])

		const reply = await post(h, h.users.bob, { status: '@alice again', visibility: 'direct', in_reply_to_id: first.id })
		expect((await act(h, h.users.alice, `/api/v1/conversations/${listed.body[0]!.id}/read`)).status).toBe(200)
		await drained(h, inbox)
		expect(conversations(inbox).map((c) => [c.id, c.last_status?.id, c.unread])).toEqual([
			[listed.body[0]!.id, reply.id, true],
			[listed.body[0]!.id, reply.id, false],
		])
		for (const _ of conversations(inbox)) {
			await inbox.next((m) => m.event === 'conversation')
		}

		// The reply's delete moves the last status back (the trigger), which is a change; deleting the conversation
		// sends nothing.
		const removed = await h.request(`/api/v1/statuses/${reply.id}`, bearer(h.users.bob.token, { method: 'DELETE' }))
		expect(removed.status).toBe(200)
		await drained(h, inbox)
		expect(conversations(inbox).map((c) => [c.id, c.last_status?.id])).toEqual([[listed.body[0]!.id, first.id]])
		await inbox.next((m) => m.event === 'conversation')
		const deleted = await h.request(
			`/api/v1/conversations/${listed.body[0]!.id}`,
			bearer(h.users.alice.token, { method: 'DELETE' })
		)
		expect(deleted.status).toBe(200)
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([])
	})

	it("sends nothing of another owner's conversations, or of changes before the subscription", async () => {
		const h = await community(['alice', 'bob', 'carol'])
		await follow(h, h.users.alice, h.users.bob.id)
		await follow(h, h.users.carol, h.users.bob.id)
		// A change before alice subscribes: not sent; the mark starts above it.
		await post(h, h.users.bob, { status: '@alice before', visibility: 'direct' })
		const inbox = await subscribed(h, h.users.alice.token, 'direct')
		await post(h, h.users.bob, { status: '@carol not for alice', visibility: 'direct' })
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([])
		const control = await post(h, h.users.bob, { status: '@alice after', visibility: 'direct' })
		await drained(h, inbox)
		expect(conversations(inbox).map((c) => c.last_status?.id)).toEqual([control.id])
	})
})

// `count` filtered mentions (direct statuses from `base`, each its own thread) from `sender` to `recipient`, and the
// request. Returns the request's id.
async function filtered(h: ApiHarness, recipient: User, sender: string, count: number, base: bigint): Promise<string> {
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
		SELECT CAST(?2 + i AS TEXT), 'https://remote.example/objects/' || (?2 + i), ?3, 'direct', '<p>hi</p>', ?4, ?4 FROM n`,
		count,
		String(base),
		sender,
		new Date(NOW).toISOString()
	)
	await sql(
		h.store,
		'INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM statuses WHERE account_id = ?',
		recipient.id,
		sender
	)
	await sql(
		h.store,
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, filtered)
		SELECT ?, 'mention', account_id, id, 1 FROM statuses WHERE account_id = ? ORDER BY id`,
		recipient.id,
		sender
	)
	return newRequest(h, recipient, sender)
}

async function newRequest(h: ApiHarness, recipient: User, sender: string): Promise<string> {
	const [row] = await sql<{ id: string }>(
		h.store,
		`INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 1)
		RETURNING CAST(id AS TEXT) AS id`,
		recipient.id,
		sender
	)
	return row!.id
}

// A round of the request jobs (as the inbound jobs' runner makes it), then the turn it would start.
async function round(h: ApiHarness): Promise<boolean> {
	const { pending } = await runInDurableObject(h.store, (_instance, state) =>
		state.storage.transactionSync(() => runNotificationRequestJobs.run(state.storage.sql, { now: NOW }))
	)
	await h.store.streamTick(BUILD)
	return pending
}

describe('a burst of conversations', () => {
	it('sends the 20 newest of 1,200 conversations an acceptance makes, and notifications_merged once', async () => {
		const h = await community(['alice'])
		const carol = await remoteAccount(h.store, 'carol')
		const request = await filtered(h, h.users.alice, carol, 1200, 600000000000000000n)
		const inbox = await subscribed(h, h.users.alice.token, 'direct')
		const notified = await subscribed(h, h.users.alice.token, 'user:notification')
		const accepted = await act(h, h.users.alice, `/api/v1/notifications/requests/${request}/accept`)
		expect(accepted.status).toBe(200)
		const { turns } = await drained(h, inbox, notified)
		expect(
			await sql(h.store, 'SELECT count(*) AS n FROM conversations WHERE account_id = ?', h.users.alice.id)
		).toEqual([{ n: 1200 }])
		const newest = await sql<{ id: string }>(
			h.store,
			'SELECT CAST(id AS TEXT) AS id FROM conversations WHERE account_id = ? ORDER BY stream_seq DESC LIMIT 20',
			h.users.alice.id
		)
		expect(conversations(inbox).map((c) => c.id)).toEqual(newest.map((row) => row.id).reverse())
		expect(merged(notified)).toEqual([{ stream: ['user:notification'], event: 'notifications_merged', payload: '1' }])
		// The acceptance journaled nothing but the merge: its notifications were unfiltered by update.
		expect(turns).toBeGreaterThan(0)
	}, 60_000)
})

describe('notifications_merged', () => {
	it('is sent once, when the last of overlapping accept jobs completes, and never for a dismiss', async () => {
		const h = await community(['alice'])
		const [a, b, c] = [
			await remoteAccount(h.store, 'a'),
			await remoteAccount(h.store, 'b'),
			await remoteAccount(h.store, 'c'),
		]
		// Each job batch walks 500 of the sender's notifications and a request runs four: a's job needs one more batch,
		// b's five more, c's dismiss one more.
		const requests = [
			await filtered(h, h.users.alice, a, 2100, 610000000000000000n),
			await filtered(h, h.users.alice, b, 4100, 620000000000000000n),
			await filtered(h, h.users.alice, c, 2100, 630000000000000000n),
		]
		const user = await subscribed(h, h.users.alice.token, 'user')
		const notified = await subscribed(h, h.users.alice.token, 'user:notification')
		expect((await act(h, h.users.alice, `/api/v1/notifications/requests/${requests[0]}/accept`)).status).toBe(200)
		expect((await act(h, h.users.alice, `/api/v1/notifications/requests/${requests[1]}/accept`)).status).toBe(200)
		expect((await act(h, h.users.alice, `/api/v1/notifications/requests/${requests[2]}/dismiss`)).status).toBe(200)
		await drained(h, user, notified)
		expect([merged(user), merged(notified)]).toEqual([[], []])
		// Round 1: a's job completes, b's goes on.
		expect(await round(h)).toBe(true)
		await drained(h, user, notified)
		expect([merged(user), merged(notified)]).toEqual([[], []])
		// Round 2: b's completes (and c's dismiss).
		expect(await round(h)).toBe(false)
		await drained(h, user, notified)
		expect(merged(user)).toEqual([{ stream: ['user'], event: 'notifications_merged', payload: '1' }])
		expect(merged(notified)).toEqual([{ stream: ['user:notification'], event: 'notifications_merged', payload: '1' }])
		const response = await getJson<{ merged: boolean }>(h, '/api/v1/notifications/requests/merged', h.users.alice.token)
		expect(response.body).toEqual({ merged: true })
	}, 60_000)

	it('is sent when a dismiss replaces the last accept job, and not under read:statuses alone', async () => {
		const h = await community(['alice'])
		const a = await remoteAccount(h.store, 'a')
		const request = await filtered(h, h.users.alice, a, 2100, 610000000000000000n)
		const notified = await subscribed(h, h.users.alice.token, 'user:notification')
		const statusesOnly = await subscribed(h, await scopedToken(h, 'read:statuses'), 'user')
		expect((await act(h, h.users.alice, `/api/v1/notifications/requests/${request}/accept`)).status).toBe(200)
		await drained(h, notified, statusesOnly)
		expect(merged(notified)).toEqual([])
		// A new request from the same sender, dismissed: the accept job is replaced.
		const again = await newRequest(h, h.users.alice, a)
		expect((await act(h, h.users.alice, `/api/v1/notifications/requests/${again}/dismiss`)).status).toBe(200)
		await drained(h, notified, statusesOnly)
		expect(merged(notified)).toEqual([{ stream: ['user:notification'], event: 'notifications_merged', payload: '1' }])
		expect(merged(statusesOnly)).toEqual([])
		// The dismiss job's completion sends nothing more.
		while (await round(h)) {
			await drained(h)
		}
		await drained(h, notified)
		expect(merged(notified)).toHaveLength(1)
	}, 60_000)
})
