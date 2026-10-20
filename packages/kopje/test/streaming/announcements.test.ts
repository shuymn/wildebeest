import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { Db } from '../../src/db/sql'
import {
	createAnnouncement,
	publishAnnouncement,
	reactToAnnouncement,
	unpublishAnnouncement,
	updateAnnouncement,
} from '../../src/domain/announcements'
import { streamAnnouncement } from '../../src/domain/streaming'
import { sha256Hex } from '../../src/security/tokens'
import { announcementHarness, reactionPath, send } from '../announcement-helpers'
import { sql } from '../api-helpers'
import { BUILD } from '../helpers'
import { scopedToken } from '../read-helpers'
import { getJson } from '../status-helpers'
import { drained, type Inbox, type StreamMessage, subscribed } from './stream-helpers'

// The `user` stream's announcement events (R33, R40; Mastodon's PublishScheduledAnnouncementWorker,
// UnpublishAnnouncementWorker and PublishAnnouncementReactionWorker): `announcement` with the entity as REST presents
// it, less the viewer's `read` and `me`; `announcement.reaction` with the name's count; `announcement.delete` with the
// id. Journaled per subject until sent, so the state when sent decides. Absence is proved with the drain barrier.

const EVENTS = ['announcement', 'announcement.reaction', 'announcement.delete']

function events(inbox: Inbox): StreamMessage[] {
	return inbox.rest().filter((m) => EVENTS.includes(m.event ?? ''))
}

// The REST entity as the stream presents it: no `read`, no `me`.
function unviewed(entity: Record<string, unknown>): Record<string, unknown> {
	const { read: _read, reactions, ...rest } = entity as { read: boolean; reactions: Record<string, unknown>[] }
	return { ...rest, reactions: reactions.map(({ me: _me, ...reaction }) => reaction) }
}

describe('announcement events on user', () => {
	it('sends each transition as Mastodon does, presented with no viewer', async () => {
		const h = await announcementHarness(['alice', 'bob'])
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const created = await h.admin.create({ text: 'Hi @bob #news' })
		await drained(h, inbox)
		const [first, ...more] = events(inbox)
		expect(more).toEqual([])
		expect(first).toMatchObject({ stream: ['user'], event: 'announcement' })
		const listed = await getJson<Record<string, unknown>[]>(h, '/api/v1/announcements', h.users.alice.token)
		expect(JSON.parse(first!.payload!)).toEqual(unviewed(listed.body[0]!))
		expect(Object.keys(JSON.parse(first!.payload!))).not.toContain('read')
		await inbox.next((m) => m.event === 'announcement')

		// A reaction, then its removal: the count goes to 0 with no image.
		await send(h, 'PUT', reactionPath(created.id, '👍'), h.users.bob.token)
		await drained(h, inbox)
		await send(h, 'DELETE', reactionPath(created.id, '👍'), h.users.bob.token)
		await drained(h, inbox)
		expect(events(inbox).map((m): unknown[] => [m.event, JSON.parse(m.payload!)])).toEqual([
			['announcement.reaction', { name: '👍', count: 1, announcement_id: created.id }],
			['announcement.reaction', { name: '👍', count: 0, announcement_id: created.id }],
		])
		for (let left = events(inbox).length; left > 0; left--) {
			await inbox.next((m) => EVENTS.includes(m.event ?? ''))
		}

		// An update of a published one, an unpublish, a publish and a delete; the delete's payload is the id itself.
		const take = async (): Promise<unknown[]> => {
			await drained(h, inbox)
			const [message, ...rest] = events(inbox)
			expect(rest).toEqual([])
			await inbox.next((m) => EVENTS.includes(m.event ?? ''))
			return [
				message?.event,
				message?.event === 'announcement'
					? (JSON.parse(message.payload!) as { content: string }).content
					: message?.payload,
			]
		}
		await h.admin.update(created.id, { text: 'Changed' })
		expect(await take()).toEqual(['announcement', '<p>Changed</p>'])
		await h.admin.unpublish(created.id)
		expect(await take()).toEqual(['announcement.delete', created.id])
		// A change of an unpublished one sends nothing.
		await h.admin.update(created.id, { text: 'Hidden' })
		await drained(h, inbox)
		expect(events(inbox)).toEqual([])
		await h.admin.publish(created.id)
		expect(await take()).toEqual(['announcement', '<p>Hidden</p>'])
		await h.admin.remove(created.id)
		expect(await take()).toEqual(['announcement.delete', created.id])
		// A scheduled one is streamed when the cron publishes it, not when it is created.
		const scheduled = await h.admin.create({ scheduledAt: '2099-01-01T00:00:00.000Z' })
		await drained(h, inbox)
		expect(events(inbox)).toEqual([])
		await h.store.announcementRound(BUILD, { now: Date.parse('2099-01-01T00:00:00.000Z') })
		await drained(h, inbox)
		expect(events(inbox).map((m) => [m.event, (JSON.parse(m.payload!) as { id: string }).id])).toEqual([
			['announcement', scheduled.id],
		])
	})

	it('goes to `user` under read:statuses or read, and to no other stream or scope', async () => {
		const h = await announcementHarness(['alice'])
		const statuses = await subscribed(h, await scopedToken(h, 'read:statuses'), 'user')
		const read = await subscribed(h, await scopedToken(h, 'read'), 'user')
		const notifications = await subscribed(h, await scopedToken(h, 'read:notifications'), 'user:notification')
		const others = await subscribed(h, h.users.alice.token, 'user:notification', 'public', 'public:local', 'direct')
		await h.admin.create()
		await drained(h, statuses, read, notifications, others)
		expect(events(statuses).map((m) => m.event)).toEqual(['announcement'])
		expect(events(read).map((m) => m.event)).toEqual(['announcement'])
		expect([events(notifications), events(others)]).toEqual([[], []])
	})

	it('sends one event per subject for a burst, as the state is when it is sent', async () => {
		const h = await announcementHarness(['alice', 'bob'])
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const authority = h.authority
		const now = Date.now()
		const [alice, bob] = await Promise.all([sha256Hex(h.users.alice.token), sha256Hex(h.users.bob.token)])
		// Written without the fan-out between them (the operations run in the Store, no turn requested).
		const created = await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			const made = createAnnouncement.run(sql, {
				authority,
				text: 'one',
				startsAt: null,
				endsAt: null,
				allDay: false,
				scheduledAt: null,
				now,
			})
			if (!made.ok) {
				throw new Error(made.code)
			}
			const { id } = made.announcement
			updateAnnouncement.run(sql, { authority, id, changes: { text: 'two' }, now: now + 1 })
			unpublishAnnouncement.run(sql, { authority, id, now: now + 2 })
			publishAnnouncement.run(sql, { authority, id, now: now + 3 })
			updateAnnouncement.run(sql, { authority, id, changes: { text: 'three' }, now: now + 4 })
			// Two reactions of one name.
			for (const user of [alice, bob]) {
				const credential = { tokenHash: user, scope: 'write:favourites' as const, now }
				const reacted = reactToAnnouncement.run(sql, { credential, id, name: '👍' })
				expect(reacted).toEqual({ status: 'ok', value: 'ok' })
			}
			return id
		})
		expect(await sql(h.store, 'SELECT kind, subject FROM stream_events')).toEqual([
			{ kind: 'announcement', subject: created },
			{ kind: 'announcement_reaction', subject: JSON.stringify([created, '👍']) },
		])
		await drained(h, inbox)
		const sent = events(inbox)
		expect(sent.map((m) => m.event)).toEqual(['announcement', 'announcement.reaction'])
		expect(JSON.parse(sent[0]!.payload!).content).toBe('<p>three</p>')
		expect(JSON.parse(sent[1]!.payload!)).toEqual({ name: '👍', count: 2, announcement_id: created })
	})

	it('sends nothing to the socket of a revoked token, which is closed', async () => {
		const h = await announcementHarness(['alice'])
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		await sql(h.store, "DELETE FROM oauth_tokens WHERE kind = 'access'")
		await h.admin.create()
		await drained(h)
		await inbox.closed()
		expect(events(inbox)).toEqual([])
	})
})

describe('the announcement journal', () => {
	// The journal helper on its own: a listener on `user`, the cursor at event 5.
	async function journal(rows: { id: number; kind: string; subject: string }[], cursor: number) {
		const h = await announcementHarness(['alice'])
		await sql(
			h.store,
			"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)",
			h.users.alice.id
		)
		for (const row of rows) {
			await sql(
				h.store,
				"INSERT INTO stream_events (id, kind, subject, created_at) VALUES (?, ?, ?, '2026-10-12T00:00:00.000Z')",
				row.id,
				row.kind,
				row.subject
			)
		}
		await sql(h.store, 'UPDATE stream_cursor SET event_id = ?, account_id = NULL WHERE id = 1', cursor)
		const record = (kind: 'announcement' | 'announcement_reaction', subject: string) =>
			runInDurableObject(h.store, (_instance, state) =>
				streamAnnouncement(new Db(state.storage.sql), kind, subject, '2026-10-12T00:00:00.000Z')
			)
		const ids = async () =>
			(await sql<{ id: number }>(h.store, 'SELECT id FROM stream_events ORDER BY id')).map((row) => row.id)
		return { h, record, ids }
	}

	it('records an event anew unless the same one is ahead of the position: ahead, at and behind it', async () => {
		const ahead = await journal([{ id: 6, kind: 'announcement', subject: 'a' }], 5)
		await ahead.record('announcement', 'a')
		expect(await ahead.ids()).toEqual([6])
		// Another subject or kind is recorded.
		await ahead.record('announcement', 'b')
		await ahead.record('announcement_reaction', 'a')
		expect(await ahead.ids()).toEqual([6, 7, 8])
		const at = await journal([{ id: 5, kind: 'announcement', subject: 'a' }], 5)
		await at.record('announcement', 'a')
		expect(await at.ids()).toEqual([5, 6])
		const behind = await journal([{ id: 4, kind: 'announcement', subject: 'a' }], 5)
		await behind.record('announcement', 'a')
		expect(await behind.ids()).toEqual([4, 5])
	})

	it('records nothing while nobody listens on `user`, or once the journal spans 4,096 ids', async () => {
		const full = await journal(
			[
				{ id: 1, kind: 'status', subject: '1' },
				{ id: 4097, kind: 'status', subject: '2' },
			],
			0
		)
		await full.record('announcement', 'a')
		expect(await full.ids()).toEqual([1, 4097])
		const almost = await journal(
			[
				{ id: 2, kind: 'status', subject: '1' },
				{ id: 4097, kind: 'status', subject: '2' },
			],
			0
		)
		await almost.record('announcement', 'a')
		expect(await almost.ids()).toEqual([2, 4097, 4098])
		await sql(almost.h.store, 'DELETE FROM stream_subscriptions')
		await almost.record('announcement', 'b')
		expect(await almost.ids()).toEqual([2, 4097, 4098])
	})
})
