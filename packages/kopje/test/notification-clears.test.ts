import { runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApiHarness, bearer, form, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD, runStoreJobs } from './helpers'
import { community, getJson, post, remoteAccount, type User } from './status-helpers'
import { Db } from '../src/db/sql'
import { purgeBatch } from '../src/domain/inbox'
import { JOB_RETRY_DELAYS_MS } from '../src/domain/job-attempts'
import { notify, type NotificationType, REMOVAL_BATCHES, REMOVAL_WINDOW } from '../src/domain/notifications'
import { writeOperation } from '../src/domain/operation'

// Clearing notifications and dismissing a group (Mastodon's delete_all and destroy_all) are bounded: the request
// records the highest id removed, R15 hides everything at or below it from every read at once, and the rows go in
// batches, the first in the request and the rest in the inbound job rounds.

const HOUR = 3_600_000
const BUCKET = Math.floor(NOW / HOUR)
// What the request deletes; the scenes hold more, so rows are left for the rounds.
const IN_REQUEST = REMOVAL_WINDOW * REMOVAL_BATCHES
const FAVOURITES = IN_REQUEST + 600
const FOLLOWS = 3

const notifyAt = writeOperation<
	{ recipientId: string; type: NotificationType; fromId: string; statusId: string | null; now: number },
	void
>((db, input) => notify(db, input))

// Alice's status favourited by FAVOURITES remote accounts, in one group, and followed by the first FOLLOWS of them,
// with a filtered follow request from the next one, all as notify would have written them.
async function scene(favouritesCount = FAVOURITES) {
	const h = await community(['alice'])
	const { alice } = h.users
	const status = await post(h, alice, { status: 'hello' })
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT printf('7%017d', i), 'https://far.example/users/u' || i, 'u' || i, 'far.example' FROM n`,
		favouritesCount + 1
	)
	const favourites = `favourite-${status.id}-${BUCKET}`
	await sql(
		h.store,
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key)
		SELECT ?1, 'favourite', id, ?2, ?3 FROM accounts WHERE domain = 'far.example' ORDER BY id LIMIT ?4`,
		alice.id,
		status.id,
		favourites,
		favouritesCount
	)
	await sql(
		h.store,
		`INSERT INTO notifications (account_id, type, from_account_id, group_key)
		SELECT ?1, 'follow', id, ?2 FROM accounts WHERE domain = 'far.example' ORDER BY id LIMIT ?3`,
		alice.id,
		`follow-${BUCKET}`,
		FOLLOWS
	)
	await sql(
		h.store,
		`INSERT INTO notifications (account_id, type, from_account_id, filtered) VALUES (?, 'follow_request', ?, 1)`,
		alice.id,
		sender(favouritesCount + 1)
	)
	return { h, alice, status, favourites }
}

const sender = (i: number) => `7${String(i).padStart(17, '0')}`

afterEach(() => {
	vi.restoreAllMocks()
})

// What every reader of alice's notifications shows her: v1 (also with filtered ones, and of one sender), one
// notification by id, the grouped list, the favourites' group and its accounts, and both unread counts.
async function readers(h: ApiHarness, alice: User, favourites: string, oneId: string) {
	const length = async (path: string) => {
		const { status, body } = await getJson<unknown[]>(h, path, alice.token)
		return status === 200 ? body.length : status
	}
	const grouped = await getJson<{ notification_groups: { group_key: string; notifications_count: number }[] }>(
		h,
		'/api/v2/notifications?limit=80',
		alice.token
	)
	const group = await getJson<{ notification_groups: { notifications_count: number }[] }>(
		h,
		`/api/v2/notifications/${favourites}`,
		alice.token
	)
	return {
		v1: await length('/api/v1/notifications?limit=80'),
		filtered: await length('/api/v1/notifications?limit=80&include_filtered=true'),
		sender: await length(`/api/v1/notifications?account_id=${sender(1)}`),
		one: [
			(await getJson(h, `/api/v1/notifications/${oneId}`, alice.token)).status,
			(await getJson(h, `/api/v2/notifications/ungrouped-${oneId}`, alice.token)).status,
		],
		grouped: grouped.body.notification_groups.map((g) => [g.group_key, g.notifications_count]),
		group: group.status === 200 ? group.body.notification_groups[0]?.notifications_count : group.status,
		accounts: await length(`/api/v2/notifications/${favourites}/accounts?limit=80`),
		unread: (await getJson<{ count: number }>(h, '/api/v1/notifications/unread_count', alice.token)).body.count,
		unreadGroups: (await getJson<{ count: number }>(h, '/api/v2/notifications/unread_count', alice.token)).body.count,
	}
}

// The one row a query returns.
async function one<T>(rows: Promise<T[]>): Promise<T> {
	const [row] = await rows
	if (row === undefined) {
		throw new Error('no row')
	}
	return row
}

async function count(h: ApiHarness, where = '1', ...params: SqlStorageValue[]): Promise<number> {
	return (await sql<{ n: number }>(h.store, `SELECT count(*) AS n FROM notifications WHERE ${where}`, ...params))[0]!.n
}

async function pending(h: ApiHarness) {
	return sql(
		h.store,
		`SELECT 'clear' AS kind, account_id, NULL AS group_key, max_id FROM notification_clears
		UNION ALL SELECT 'dismissal', account_id, group_key, max_id FROM notification_dismissals`
	)
}

// Runs the inbound job rounds until none is pending; returns how many ran.
async function rounds(h: ApiHarness): Promise<number> {
	let ran = 0
	for (;;) {
		ran += 1
		if (!(await runStoreJobs(h.store, BUILD, { now: NOW })).pending) {
			return ran
		}
	}
}

const clear = (h: ApiHarness, user: User, version = 'v1') =>
	h.request(`/api/${version}/notifications/clear`, bearer(user.token, form({})))

const dismiss = (h: ApiHarness, user: User, key: string) =>
	h.request(`/api/v2/notifications/${key}/dismiss`, bearer(user.token, form({})))

describe('clearing notifications', () => {
	it('hides every notification from every reader at once, and the rounds delete them', async () => {
		const { h, alice, status, favourites } = await scene()
		const { id: newest } = await one(sql<{ id: number }>(h.store, 'SELECT max(id) AS id FROM notifications'))
		// The oldest notification, which the request leaves for the rounds: read by id, it must be hidden by the mark.
		const { id: oneId } = await one(sql<{ id: number }>(h.store, 'SELECT min(id) AS id FROM notifications'))
		const before = await readers(h, alice, favourites, String(oneId))
		expect(before).toMatchObject({ v1: 80, filtered: 80, sender: 2, one: [200, 200], group: 400, accounts: 80 })
		const total = FAVOURITES + FOLLOWS + 1
		const response = await clear(h, alice)
		expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: {} })
		// The request deleted its batches, newest first; the rest is still stored, and hidden.
		expect(await count(h)).toBe(total - IN_REQUEST)
		expect(await pending(h)).toEqual([{ kind: 'clear', account_id: alice.id, group_key: null, max_id: newest }])
		expect(await count(h, 'id = ?', oneId)).toBe(1)
		const gone = { v1: 0, filtered: 0, sender: 0, one: [404, 404], grouped: [], group: 404, accounts: 0, unread: 0 }
		expect(await readers(h, alice, favourites, String(oneId))).toEqual({ ...gone, unreadGroups: 0 })
		// A notification written after the clear shows, in a group of its own kind (the cleared one is not joined).
		await runInDurableObject(h.store, (_instance, state) =>
			notifyAt.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'favourite',
				fromId: sender(FAVOURITES + 1),
				statusId: status.id,
				now: NOW,
			})
		)
		const after = await readers(h, alice, favourites, String(oneId))
		expect(after).toMatchObject({ v1: 1, grouped: [[favourites, 1]], group: 1, accounts: 1, unread: 1 })
		expect(await rounds(h)).toBe(Math.ceil((total - IN_REQUEST + 1) / IN_REQUEST))
		expect(await count(h)).toBe(1)
		expect(await count(h, 'id > ?', newest)).toBe(1)
		expect(await pending(h)).toEqual([])
		expect(await readers(h, alice, favourites, String(oneId))).toEqual(after)
	}, 120_000)

	it('raises the mark with a second clear, before the first is done', async () => {
		// More than both requests delete.
		const favourites = 2 * IN_REQUEST + 600
		const { h, alice } = await scene(favourites)
		await clear(h, alice)
		const { max_id: first } = await one(pending(h) as Promise<{ max_id: number }[]>)
		await runInDurableObject(h.store, (_instance, state) =>
			notifyAt.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'follow',
				fromId: sender(favourites + 1),
				statusId: null,
				now: NOW,
			})
		)
		expect((await getJson<unknown[]>(h, '/api/v1/notifications', alice.token)).body).toHaveLength(1)
		expect((await clear(h, alice, 'v2')).status).toBe(200)
		expect((await getJson<unknown[]>(h, '/api/v1/notifications', alice.token)).body).toEqual([])
		expect(await pending(h)).toEqual([{ kind: 'clear', account_id: alice.id, group_key: null, max_id: first + 1 }])
		await rounds(h)
		expect(await count(h)).toBe(0)
		expect(await pending(h)).toEqual([])
	}, 120_000)

	it("is only the viewer's, and records nothing without notifications", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol')
		await sql(
			h.store,
			"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)",
			alice.id,
			carol
		)
		expect((await clear(h, bob)).status).toBe(200)
		expect(await pending(h)).toEqual([])
		expect((await getJson<unknown[]>(h, '/api/v1/notifications', alice.token)).body).toHaveLength(1)
		// Alice's one notification goes in the request, and the clear with it.
		expect((await clear(h, alice)).status).toBe(200)
		expect(await count(h)).toBe(0)
		expect(await pending(h)).toEqual([])
	})

	it("finishes while a purge deletes a sender's notifications it would delete", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		const { uri } = await one(sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', bob))
		// Bob's direct statuses mentioning alice, each with its notification, more than the request deletes.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('8%017d', i), 'https://remote.example/o/' || i, ?2, 'direct', '', '2026-10-01T00:00:00.000Z' FROM n`,
			FAVOURITES,
			bob
		)
		await sql(h.store, 'INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM statuses', alice.id)
		await sql(
			h.store,
			`INSERT INTO notifications (account_id, type, from_account_id, status_id)
			SELECT ?, 'mention', account_id, id FROM statuses ORDER BY id`,
			alice.id
		)
		await clear(h, alice)
		expect(await count(h)).toBe(FAVOURITES - IN_REQUEST)
		// The purge and the rounds take turns until both are done.
		for (let more = true; more;) {
			more = await runInDurableObject(h.store, (_instance, state) => purgeBatch(new Db(state.storage.sql), uri, NOW))
			await runStoreJobs(h.store, BUILD, { now: NOW })
		}
		await rounds(h)
		expect(await sql(h.store, 'SELECT id FROM accounts WHERE id = ?', bob)).toEqual([])
		expect(await count(h)).toBe(0)
		expect(await pending(h)).toEqual([])
	}, 120_000)
})

describe('dismissing a group', () => {
	it('hides a large group from every reader at once, and the rounds delete it across batches', async () => {
		const { h, alice, status, favourites } = await scene()
		const { id: newest } = await one(
			sql<{ id: number }>(h.store, 'SELECT max(id) AS id FROM notifications WHERE group_key = ?', favourites)
		)
		const response = await dismiss(h, alice, favourites)
		expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: {} })
		expect(await count(h, 'group_key = ?', favourites)).toBe(FAVOURITES - IN_REQUEST)
		expect(await pending(h)).toEqual([
			{ kind: 'dismissal', account_id: alice.id, group_key: favourites, max_id: newest },
		])
		// The group's oldest notification, which the request leaves for the rounds: read by id, it must be hidden.
		const { id: oldest } = await one(
			sql<{ id: number }>(h.store, 'SELECT min(id) AS id FROM notifications WHERE group_key = ?', favourites)
		)
		expect(await count(h, 'id = ? AND group_key = ?', oldest, favourites)).toBe(1)
		// The follows and the filtered follow request stay; nothing of the group shows.
		const hidden = {
			v1: FOLLOWS,
			filtered: FOLLOWS + 1,
			sender: 1,
			one: [404, 404],
			grouped: [[`follow-${BUCKET}`, FOLLOWS]],
			group: 404,
			accounts: 0,
			unread: FOLLOWS,
			unreadGroups: 1,
		}
		expect(await readers(h, alice, favourites, String(oldest))).toEqual(hidden)
		// A favourite in the same hour after the dismissal shows, under the same key, alone.
		await runInDurableObject(h.store, (_instance, state) =>
			notifyAt.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'favourite',
				fromId: sender(FAVOURITES + 1),
				statusId: status.id,
				now: NOW,
			})
		)
		const after = await readers(h, alice, favourites, String(oldest))
		expect(after).toMatchObject({ v1: FOLLOWS + 1, group: 1, accounts: 1, unread: FOLLOWS + 1, unreadGroups: 2 })
		expect(await rounds(h)).toBe(Math.ceil((FAVOURITES - IN_REQUEST + 1) / IN_REQUEST))
		expect(await count(h, 'group_key = ?', favourites)).toBe(1)
		expect(await count(h)).toBe(FOLLOWS + 2)
		expect(await pending(h)).toEqual([])
		expect(await readers(h, alice, favourites, String(oldest))).toEqual(after)
	}, 120_000)

	it('starts a new group for a later favourite within its hours, as when it was deleted', async () => {
		const { h, alice, status, favourites } = await scene()
		await dismiss(h, alice, favourites)
		await runInDurableObject(h.store, (_instance, state) =>
			notifyAt.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'favourite',
				fromId: sender(FAVOURITES + 1),
				statusId: status.id,
				now: NOW + 2 * HOUR,
			})
		)
		const later = `favourite-${status.id}-${BUCKET + 2}`
		const { body } = await getJson<{ group_key: string }[]>(h, '/api/v1/notifications?types[]=favourite', alice.token)
		expect(body.map((n) => n.group_key)).toEqual([later])
	}, 120_000)

	it("leaves another account's group, and dismisses one ungrouped notification at once", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol')
		await sql(
			h.store,
			`INSERT INTO notifications (account_id, type, from_account_id, group_key) VALUES
				(?1, 'follow', ?3, 'follow-1'), (?2, 'follow', ?3, 'follow-1'), (?1, 'follow_request', ?3, NULL)`,
			alice.id,
			bob.id,
			carol
		)
		await dismiss(h, bob, 'follow-1')
		expect(await count(h, 'account_id = ?', alice.id)).toBe(2)
		const { id } = await one(sql<{ id: number }>(h.store, "SELECT id FROM notifications WHERE type = 'follow_request'"))
		await dismiss(h, alice, `ungrouped-${id}`)
		expect(await count(h, 'account_id = ?', alice.id)).toBe(1)
		expect(await pending(h)).toEqual([])
	})
})

describe('accepting a request after a clear', () => {
	it('neither shows nor adds to conversations the filtered mentions cleared', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('8%017d', i), 'https://remote.example/o/' || i, ?2, 'direct', '', '2026-10-01T00:00:00.000Z' FROM n`,
			FAVOURITES,
			bob
		)
		await sql(h.store, 'INSERT INTO status_mentions (status_id, account_id) SELECT id, ? FROM statuses', alice.id)
		await sql(
			h.store,
			`INSERT INTO notifications (account_id, type, from_account_id, status_id, filtered)
			SELECT ?, 'mention', account_id, id, 1 FROM statuses ORDER BY id`,
			alice.id
		)
		await sql(
			h.store,
			'INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 100)',
			alice.id,
			bob
		)
		await clear(h, alice)
		expect(await count(h)).toBe(FAVOURITES - IN_REQUEST)
		const [request] = (await getJson<{ id: string }[]>(h, '/api/v1/notifications/requests', alice.token)).body
		const accepted = await h.request(
			`/api/v1/notifications/requests/${request!.id}/accept`,
			bearer(alice.token, form({}))
		)
		expect(accepted.status).toBe(200)
		const conversations = async () =>
			(await sql<{ n: number }>(h.store, 'SELECT count(*) AS n FROM conversations WHERE account_id = ?', alice.id))[0]!
				.n
		expect(await conversations()).toBe(0)
		expect(await count(h, 'filtered = 0')).toBe(0)
		expect((await getJson<unknown[]>(h, '/api/v1/notifications?include_filtered=true', alice.token)).body).toEqual([])
		await rounds(h)
		expect(await conversations()).toBe(0)
		expect(await count(h)).toBe(0)
	}, 120_000)
})

describe('a notification again after a clear, its old row not yet deleted', () => {
	it('replaces the hidden row with a new one, shown', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		await sql(
			h.store,
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES ('800000000000000001', 'https://remote.example/o/1', ?, 'public', '', '2026-10-01T00:00:00.000Z')`,
			bob
		)
		await sql(h.store, "INSERT INTO status_mentions (status_id, account_id) VALUES ('800000000000000001', ?)", alice.id)
		// Bob's mention, the oldest, then more follows than the request deletes, so the mention stays for the rounds.
		await sql(
			h.store,
			"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, '800000000000000001')",
			alice.id,
			bob
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('7%017d', i), 'https://far.example/users/u' || i, 'u' || i, 'far.example' FROM n`,
			IN_REQUEST + 10
		)
		await sql(
			h.store,
			"INSERT INTO notifications (account_id, type, from_account_id) SELECT ?, 'follow', id FROM accounts WHERE domain = 'far.example'",
			alice.id
		)
		await clear(h, alice)
		expect(await count(h, "type = 'mention'")).toBe(1)
		// Bob's Update mentions alice again (updateRemoteStatus notifies her).
		await runInDurableObject(h.store, (_instance, state) =>
			notifyAt.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'mention',
				fromId: bob,
				statusId: '800000000000000001',
				now: NOW,
			})
		)
		const { body } = await getJson<{ type: string }[]>(h, '/api/v1/notifications', alice.token)
		expect(body.map((n) => n.type)).toEqual(['mention'])
		await rounds(h)
		expect(await count(h)).toBe(1)
	}, 120_000)
})

describe('the rounds share their batches between clears and dismissals', () => {
	it("deletes a dismissed group while other accounts' clears keep arriving, within the round's batches", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const GROUP = 3 * IN_REQUEST
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('7%017d', i), 'https://far.example/users/u' || i, 'u' || i, 'far.example' FROM n`,
			GROUP
		)
		// Bob's group, dismissed, and alice's follows, cleared, each pending with more than a round deletes.
		await sql(
			h.store,
			`INSERT INTO notifications (account_id, type, from_account_id, group_key)
			SELECT ?, 'follow', id, 'follow-1' FROM accounts WHERE domain = 'far.example'`,
			bob.id
		)
		await sql(
			h.store,
			`INSERT INTO notification_dismissals (account_id, group_key, max_id)
			SELECT ?, 'follow-1', max(id) FROM notifications`,
			bob.id
		)
		const clearMore = async () => {
			await sql(
				h.store,
				`INSERT INTO notifications (account_id, type, from_account_id)
				SELECT ?1, 'follow_request', id FROM accounts WHERE domain = 'far.example' ORDER BY id LIMIT ?2
				ON CONFLICT DO NOTHING`,
				alice.id,
				IN_REQUEST * 2
			)
			await sql(
				h.store,
				`INSERT INTO notification_clears (account_id, max_id) SELECT ?1, max(id) FROM notifications WHERE account_id = ?1
				ON CONFLICT (account_id) DO UPDATE SET max_id = excluded.max_id`,
				alice.id
			)
		}
		const left = async () => [await count(h, 'account_id = ?', alice.id), await count(h, 'account_id = ?', bob.id)]
		await clearMore()
		// Bob's group takes half of each round's batches: six rounds, and a seventh finds it done.
		for (let round = 0; round < 7; round++) {
			const [aliceBefore, bobBefore] = await left()
			expect((await runStoreJobs(h.store, BUILD, { now: NOW })).pending).toBe(true)
			const [aliceAfter, bobAfter] = await left()
			// The round's batches, shared: no more than they delete in all, and some of each.
			expect(aliceBefore! - aliceAfter! + (bobBefore! - bobAfter!)).toBeLessThanOrEqual(IN_REQUEST)
			if (bobBefore! > 0) {
				expect(bobAfter).toBeLessThan(bobBefore!)
			}
			// Alice's clear is never done: her follow requests come back, cleared again.
			await sql(h.store, "DELETE FROM notifications WHERE account_id = ? AND type = 'follow_request'", alice.id)
			await clearMore()
		}
		expect((await left())[1]).toBe(0)
		expect(await pending(h)).toEqual([expect.objectContaining({ kind: 'clear' })])
	}, 120_000)
})

describe('a failing batch (RES-5)', () => {
	const SMALL = 10
	const retry = (h: ApiHarness) =>
		sql<{ kind: string; attempts: number; due_at: number | null }>(
			h.store,
			`SELECT 'clear' AS kind, attempts, due_at FROM notification_clears
			UNION ALL SELECT 'dismissal', attempts, due_at FROM notification_dismissals`
		)
	// A removal batch that fails at its last write, the end of its removal's record (`table`), after it deleted what it
	// removes (a test trigger).
	const failing = (h: ApiHarness, table: string) =>
		sql(
			h.store,
			`CREATE TRIGGER test_removal_fails BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'test: the batch fails'); END`
		)

	it.each([
		['the clear', 'notification_clears', (h: ApiHarness, alice: User) => clear(h, alice), () => 0],
		[
			'the group dismissal',
			'notification_dismissals',
			(h: ApiHarness, alice: User, favourites: string) => dismiss(h, alice, favourites),
			(total: number, stored: number) => total - stored,
		],
	] as const)(
		'commits the mark of %s when its first batch fails after its deletions, the removal backing off, and the rounds finish it',
		async (_name, table, remove, left) => {
			const { h, alice, favourites } = await scene(SMALL)
			const total = await count(h)
			const stored = await count(h, 'group_key = ?', favourites)
			await failing(h, table)
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			const response = await remove(h, alice, favourites)
			expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: {} })
			// The batch's deletions were rolled back; its mark committed, so what it removes is hidden at once (R15).
			expect(await count(h)).toBe(total)
			expect(await retry(h)).toEqual([{ kind: expect.any(String), attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]! }])
			const group = await getJson(h, `/api/v2/notifications/${favourites}`, alice.token)
			expect(group.status).toBe(404)
			expect(errors.mock.calls.map(([entry]) => (entry as { event?: string }).event)).toContain(
				'kopje.jobs.item.failed'
			)
			// Not due yet: a round runs no batch of it; once the cause is gone, the round at its due time finishes it.
			await sql(h.store, 'DROP TRIGGER test_removal_fails')
			expect(await runStoreJobs(h.store, BUILD, { now: NOW })).toMatchObject({ pending: false })
			expect(await count(h)).toBe(total)
			await runStoreJobs(h.store, BUILD, { now: NOW + JOB_RETRY_DELAYS_MS[0]! })
			expect(await pending(h)).toEqual([])
			expect(await count(h, 'group_key = ?', favourites)).toBe(0)
			expect(await count(h)).toBe(left(total, stored))
		}
	)

	it('makes a parked clear fresh when a newer notification raises it, and keeps it parked when a clear changes nothing', async () => {
		const { h, alice, status } = await scene(SMALL)
		const total = await count(h)
		await failing(h, 'notification_clears')
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect((await clear(h, alice)).status).toBe(200)
		await sql(h.store, 'UPDATE notification_clears SET attempts = 6, due_at = NULL')
		await sql(h.store, 'DROP TRIGGER test_removal_fails')
		// The same mark again: still parked, and no batch ran (it would delete now).
		expect((await clear(h, alice)).status).toBe(200)
		expect(await retry(h)).toEqual([{ kind: 'clear', attempts: 6, due_at: null }])
		expect(await count(h)).toBe(total)
		// A newer notification, then a clear: the mark rises, the removal is fresh, and its batch removes everything.
		await runInDurableObject(h.store, (_instance, state) =>
			notifyAt.run(state.storage.sql, {
				recipientId: alice.id,
				type: 'favourite',
				fromId: sender(SMALL + 1),
				statusId: status.id,
				now: NOW,
			})
		)
		expect(await count(h)).toBe(total + 1)
		expect((await clear(h, alice)).status).toBe(200)
		expect(await count(h)).toBe(0)
		expect(await pending(h)).toEqual([])
	})
})
