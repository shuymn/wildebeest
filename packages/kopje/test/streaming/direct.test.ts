import { evictDurableObject, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { Db } from '../../src/db/sql'
import { addToConversation } from '../../src/domain/conversations'
import { runNotificationRequestJobs } from '../../src/domain/notification-requests'
import { type ApiHarness, bearer, sql } from '../api-helpers'
import { NOW } from '../app-helpers'
import { BUILD } from '../helpers'
import { scopedToken } from '../read-helpers'
import { act, community, follow, getJson, post, remoteAccount, seedStatus, type User } from '../status-helpers'
import { connect, drained, echo, type Inbox, type StreamMessage, subscribed } from './stream-helpers'
import { sha256Hex } from '../../src/security/tokens'
import { STREAM_FAULTS } from '../../src/stream-hub'

// The `direct` stream and `notifications_merged` (design "Kopje streaming API" PR 3). `conversation` is sent when a
// conversation of the viewer changes, as the conversation list presents it (R33: the row of the viewer, R25), by the
// owner's change sequence (conversations.stream_seq, from the owner's mark), journaled as one 'conversation' event per
// owner until it is sent: at most its 20 newest changes each.
// `notifications_merged` is sent on the transition to no pending accept job, under a notification scope. Absence is
// proved with the drain barrier.

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

		// Each change observed before the next is written: the reply (unread), then the read.
		const conversation = (m: StreamMessage) =>
			m.event === 'conversation' ? (JSON.parse(m.payload!) as Conversation) : null
		const reply = await post(h, h.users.bob, { status: '@alice again', visibility: 'direct', in_reply_to_id: first.id })
		const unread = conversation(await inbox.next((m) => conversation(m)?.last_status?.id === reply.id))
		expect([unread?.id, unread?.unread]).toEqual([listed.body[0]!.id, true])
		expect((await act(h, h.users.alice, `/api/v1/conversations/${listed.body[0]!.id}/read`)).status).toBe(200)
		const read = conversation(await inbox.next((m) => conversation(m)?.unread === false))
		expect([read?.id, read?.last_status?.id]).toEqual([listed.body[0]!.id, reply.id])
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([])

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

	it('coalesces changes written before a turn into one message with the latest state', async () => {
		const h = await community(['alice', 'bob'])
		const inbox = await subscribed(h, h.users.alice.token, 'direct')
		// Two statuses of one conversation join it with no turn between (written straight to the Store).
		const first = await seedStatus(h.store, {
			accountId: h.users.bob.id,
			visibility: 'direct',
			mentions: [{ accountId: h.users.alice.id }],
		})
		const second = await seedStatus(h.store, {
			accountId: h.users.bob.id,
			visibility: 'direct',
			mentions: [{ accountId: h.users.alice.id }],
			inReplyToId: first,
		})
		await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			state.storage.transactionSync(() => addToConversation(db, h.users.alice.id, first))
			state.storage.transactionSync(() => addToConversation(db, h.users.alice.id, second))
		})
		expect(await sql(h.store, 'SELECT count(*) AS n, max(stream_seq) AS seq FROM conversations')).toEqual([
			{ n: 1, seq: 2 },
		])
		await h.store.streamTick(BUILD)
		await drained(h, inbox)
		expect(conversations(inbox).map((c) => c.last_status?.id)).toEqual([second])
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

// `count` local accounts (ids 4 then 17 digits, from `start`), each with the token `cap-<id>` (read and write).
async function owners(h: ApiHarness, count: number, start = 1): Promise<string[]> {
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT ?2 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 + ?1 - 1)
		INSERT INTO accounts (id, uri, username) SELECT printf('4%017d', i), 'https://kopje.test/ap/users/o' || i, 'o' || i FROM n`,
		count,
		start
	)
	await sql(
		h.store,
		`INSERT OR IGNORE INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '4*'`
	)
	const ids = Array.from({ length: count }, (_, i) => `4${String(start + i).padStart(17, '0')}`)
	for (const id of ids) {
		await sql(
			h.store,
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) SELECT ?, 'access', client_id, ?, 'read write' FROM oauth_tokens LIMIT 1",
			await sha256Hex(`cap-${id}`),
			id
		)
	}
	return ids
}

// `perOwner` sockets of each owner, subscribed to `direct`, the subscriptions in effect.
async function directSockets(h: ApiHarness, ids: readonly string[], perOwner = 1): Promise<Inbox[]> {
	const inboxes: Inbox[] = []
	for (const id of ids) {
		for (let i = 0; i < perOwner; i++) {
			const inbox = await connect(h, `cap-${id}`)
			inbox.send({ type: 'subscribe', stream: 'direct' })
			inboxes.push(inbox)
		}
	}
	for (const inbox of inboxes) {
		await echo(inbox)
	}
	await drained(h)
	return inboxes
}

let nextStatus = 700000000000000000n

// A new conversation of each owner, from a direct status of theirs, written with no turn (straight to the Store).
// Returns the statuses' ids, by owner.
async function changed(h: ApiHarness, ids: readonly string[]): Promise<string[]> {
	const statuses = ids.map(() => String(nextStatus++))
	await runInDurableObject(h.store, (_instance, state) => {
		const db = new Db(state.storage.sql)
		state.storage.transactionSync(() => {
			ids.forEach((id, i) => {
				db.run(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'direct', '<p>x</p>', '2026-10-12T00:00:00.000Z')`,
					statuses[i]!,
					id
				)
				addToConversation(db, id, statuses[i]!)
			})
		})
	})
	return statuses
}

const sentStatus = (status: string) => (m: StreamMessage) =>
	m.event === 'conversation' && (JSON.parse(m.payload!) as Conversation).last_status?.id === status

describe('conversations at the caps', () => {
	// 256 owners, each with a `direct` socket (the instance's cap): a turn's token sweep takes 256 checks of its 512, so
	// one turn sends only some of the owners' conversations; the journal's position carries the rest to the next.
	it('reaches the last of 256 owners, then asks for no further turn', async () => {
		const h = await community(['alice'])
		const ids = await owners(h, 256)
		const inboxes = await directSockets(h, ids)
		const statuses = await changed(h, ids)
		// One journal row per owner.
		expect(await sql(h.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'conversation'")).toEqual([
			{ n: 256 },
		])
		await h.store.streamTick(BUILD)
		for (const [i, inbox] of inboxes.entries()) {
			await inbox.next(sentStatus(statuses[i]!))
		}
		// Quiescent: once nothing is left, no turn runs or is asked for, and asking again changes nothing.
		const { turns } = await drained(h)
		expect((await drained(h)).turns).toBe(turns)
		expect(inboxes.flatMap((inbox) => inbox.rest())).toEqual([])
	}, 120_000)

	it('sends a change written while a continuation is pending, for an owner the fan-out already passed', async () => {
		const h = await community(['alice'])
		const ids = await owners(h, 256)
		const inboxes = await directSockets(h, ids)
		const statuses = await changed(h, ids)
		await h.store.streamTick(BUILD)
		// The first owner's conversation is sent by the first turn; the last owner's waits for a continuation.
		await inboxes[0]!.next(sentStatus(statuses[0]!))
		const [conversation] = await sql<{ id: string }>(
			h.store,
			'SELECT CAST(id AS TEXT) AS id FROM conversations WHERE account_id = ?',
			ids[0]!
		)
		const read = await h.request(
			`/api/v1/conversations/${conversation!.id}/read`,
			bearer(`cap-${ids[0]!}`, { method: 'POST' })
		)
		expect(read.status).toBe(200)
		// No drain barrier and no cron: the write's own wakeup and the continuations deliver both.
		await inboxes.at(-1)!.next(sentStatus(statuses.at(-1)!))
		const marked = await inboxes[0]!.next((m) => m.event === 'conversation')
		expect((JSON.parse(marked.payload!) as Conversation).id).toBe(conversation!.id)
	}, 120_000)

	it('serves 240 owners in turn while one owner with 16 sockets keeps changing', async () => {
		const h = await community(['alice'])
		const [busy, ...others] = await owners(h, 241)
		const busySockets = await directSockets(h, [busy!], 16)
		const inboxes = await directSockets(h, others)
		let writing = true
		const steady = (async () => {
			while (writing) {
				await changed(h, [busy!])
				await h.store.streamTick(BUILD)
			}
		})()
		const statuses = await changed(h, others)
		await h.store.streamTick(BUILD)
		for (const [i, inbox] of inboxes.entries()) {
			await inbox.next(sentStatus(statuses[i]!))
		}
		writing = false
		await steady
		await drained(h)
		// Each of the busy owner's sockets was sent its changes too, each at most once.
		for (const inbox of busySockets) {
			const sent = inbox.rest().map((m) => (JSON.parse(m.payload!) as Conversation).id)
			expect(sent.length).toBeGreaterThan(0)
			expect(new Set(sent).size).toBe(sent.length)
		}
	}, 120_000)

	// 10 owners with 16 sockets each, every socket its own token: a turn sweeps 160 tokens and a conversation unit checks
	// 16, so one turn sends fewer than 20 of an owner's changes and the busy owner's event spans turns. Between turns the
	// busy owner writes 20 more changes: they go to its next row, behind the other owners', and the event in progress
	// ends at the ceiling fixed when the fan-out entered it.
	it("ends an owner's event at its ceiling while the owner keeps changing, so the owners after it are served", async () => {
		const h = await community(['alice'])
		const ids = await owners(h, 10)
		const [busy, ...others] = ids
		const inboxes = new Map<string, Inbox[]>()
		for (const id of ids) {
			const sockets: Inbox[] = []
			for (let k = 0; k < 16; k++) {
				await sql(
					h.store,
					"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) SELECT ?, 'access', client_id, ?, 'read' FROM oauth_tokens LIMIT 1",
					await sha256Hex(`cap-${id}-${k}`),
					id
				)
				const inbox = await connect(h, `cap-${id}-${k}`)
				inbox.send({ type: 'subscribe', stream: 'direct' })
				sockets.push(inbox)
			}
			inboxes.set(id, sockets)
		}
		for (const inbox of [...inboxes.values()].flat()) {
			await echo(inbox)
		}
		await drained(h)
		const first = await changed(h, Array<string>(20).fill(busy!))
		const statuses = await changed(h, others)
		const turn = async () => {
			const response = await h.store.fetch('https://store.internal/stream/turn', { method: 'POST' })
			await response.body?.cancel()
		}
		STREAM_FAULTS.dropContinuation = () => {}
		try {
			for (let i = 0; i < 6; i++) {
				await turn()
				await changed(h, Array<string>(20).fill(busy!))
			}
		} finally {
			STREAM_FAULTS.dropContinuation = null
		}
		for (const inbox of [...inboxes.values()].flat()) {
			await echo(inbox)
		}
		// Every other owner's sockets got its conversation within those turns, with no drain barrier asking for more.
		others.forEach((id, i) => {
			for (const inbox of inboxes.get(id)!) {
				expect(inbox.messages.filter(sentStatus(statuses[i]!))).toHaveLength(1)
			}
		})
		// The busy owner's first event sent its 20 changes once each.
		for (const inbox of inboxes.get(busy!)!) {
			for (const status of first) {
				expect(inbox.messages.filter(sentStatus(status))).toHaveLength(1)
			}
		}
	}, 120_000)

	it('resumes after a failed continuation and hibernation, from the cron, past the owners already sent', async () => {
		const h = await community(['alice'])
		const ids = await owners(h, 256)
		const inboxes = await directSockets(h, ids)
		const statuses = await changed(h, ids)
		const last = inboxes.at(-1)!
		const arrived = () => last.messages.some(sentStatus(statuses.at(-1)!))
		let turns = 0
		// Each turn's continuation fails; the object hibernates; the cron's turn (the same request to the Store's own
		// stub, awaited here so the test knows it ended) runs again.
		STREAM_FAULTS.dropContinuation = () => {}
		try {
			while (!arrived() && turns < 10) {
				await evictDurableObject(h.store)
				const response = await h.store.fetch('https://store.internal/stream/turn', { method: 'POST' })
				await response.body?.cancel()
				turns++
				await echo(last)
			}
		} finally {
			STREAM_FAULTS.dropContinuation = null
		}
		expect(arrived()).toBe(true)
		expect(turns).toBeGreaterThan(1)
		// Each cron turn went on from the persisted position: a few turns for 256 owners.
		expect(turns).toBeLessThanOrEqual(5)
		await drained(h)
		for (const [i, inbox] of inboxes.entries()) {
			expect(inbox.messages.filter(sentStatus(statuses[i]!))).toHaveLength(1)
		}
	}, 120_000)
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
