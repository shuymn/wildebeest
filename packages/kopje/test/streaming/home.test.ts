import { evictDurableObject, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, json, seedAccount, sql } from '../api-helpers'
import { NOW } from '../app-helpers'
import { BUILD } from '../helpers'
import { token } from '../inbox-status-helpers'
import { scopedToken } from '../read-helpers'
import { act, community, follow, getJson, post, remoteAccount, type Status } from '../status-helpers'
import { connect, drained, echo, type Inbox, type StreamMessage, subscribed } from './stream-helpers'
import { Db } from '../../src/db/sql'
import { streamDelete } from '../../src/domain/streaming'
import { sha256Hex } from '../../src/security/tokens'

// The `user` stream's statuses (design "Kopje streaming API" PR 2): `update` when a status enters home (R33: home
// positioned at it, within the real-time window), `status.update` when one is edited (home, or the viewer's mention of
// it with a notification scope; on `user:notification` the mention alone), and `delete` as its capture allowed (R32).
// Absence is proved with the drain barrier.

const HOUR = 3_600_000

// The messages left on a socket, as [stream, event, the payload's status id (or the deleted id)].
function events(inbox: Inbox): [string | undefined, string | undefined, string][] {
	return inbox.rest().map((m) => [m.stream?.[0], m.event, idOf(m)])
}

function idOf(m: StreamMessage): string {
	const payload: unknown = JSON.parse(m.payload ?? 'null')
	return typeof payload === 'string' ? payload : ((payload as { id?: string } | null)?.id ?? '')
}

async function edit(h: ApiHarness, token: string, id: string, status: string): Promise<void> {
	const response = await h.request(`/api/v1/statuses/${id}`, bearer(token, json({ status }, { method: 'PUT' })))
	expect(response.status).toBe(200)
}

async function remove(h: ApiHarness, token: string, id: string): Promise<void> {
	const response = await h.request(`/api/v1/statuses/${id}`, bearer(token, { method: 'DELETE' }))
	expect(response.status).toBe(200)
}

describe('update on user', () => {
	it("sends a status entering home, as REST presents it, and the author's own; nothing else", async () => {
		const h = await community(['alice', 'bob', 'carol'])
		await follow(h, h.users.alice, h.users.bob.id)
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const notificationsOnly = await subscribed(h, h.users.alice.token, 'user:notification')

		// Not in alice's home: an account she does not follow, and bob's direct status to carol.
		await post(h, h.users.carol, { status: 'not followed', visibility: 'public' })
		await post(h, h.users.bob, { status: '@carol not for alice', visibility: 'direct' })
		await drained(h, inbox, notificationsOnly)
		expect(events(inbox)).toEqual([])

		const shown = await post(h, h.users.bob, { status: 'for followers', visibility: 'private' })
		const own = await post(h, h.users.alice, { status: 'mine', visibility: 'unlisted' })
		await drained(h, inbox, notificationsOnly)
		expect(events(inbox)).toEqual([
			['user', 'update', shown.id],
			['user', 'update', own.id],
		])
		expect(notificationsOnly.rest()).toEqual([])
		// The payload is the status as REST presents it to alice, encoded as a JSON string.
		const rest = await getJson(h, `/api/v1/statuses/${shown.id}`, h.users.alice.token)
		expect(JSON.parse((await inbox.next()).payload!)).toEqual(rest.body)
	})

	it('needs read:statuses, and a status home leaves out (a blocked mention, an exclusive list) is not sent', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		await follow(h, h.users.alice, h.users.bob.id)
		await follow(h, h.users.alice, h.users.carol.id)
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const statusesOnly = await subscribed(h, await scopedToken(h, 'read:statuses'), 'user')
		await sql(
			h.store,
			'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)',
			h.users.alice.id,
			h.users.carol.id
		)
		await post(h, h.users.bob, { status: 'hello @carol', visibility: 'public' })
		// carol is in an exclusive list of alice's: her posts go to the list, not home.
		await sql(h.store, 'DELETE FROM blocks')
		await sql(
			h.store,
			"INSERT INTO lists (id, account_id, title, exclusive) VALUES ('100000000000000001', ?, 'x', 1)",
			h.users.alice.id
		)
		await sql(
			h.store,
			"INSERT INTO list_accounts (list_id, account_id) VALUES ('100000000000000001', ?)",
			h.users.carol.id
		)
		await post(h, h.users.carol, { status: 'listed', visibility: 'public' })
		await drained(h, inbox, statusesOnly)
		expect(events(inbox)).toEqual([])
		expect(events(statusesOnly)).toEqual([])

		const control = await post(h, h.users.bob, { status: 'shown', visibility: 'public' })
		await drained(h, inbox, statusesOnly)
		expect(events(inbox)).toEqual([['user', 'update', control.id]])
		expect(events(statusesOnly)).toEqual([['user', 'update', control.id]])
	})

	it('leaves out a status published more than 6 hours before it arrived (the real-time window)', async () => {
		const h = await community(['alice'])
		const remote = await remoteAccount(h.store, 'erin')
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			h.users.alice.id,
			remote
		)
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const arrived = new Date(NOW).toISOString()
		const insert = (id: string, publishedAgo: number) =>
			sql(
				h.store,
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
				VALUES (?, ?, ?, 'public', '<p>x</p>', ?, ?)`,
				id,
				`https://remote.example/objects/${id}`,
				remote,
				new Date(NOW - publishedAgo).toISOString(),
				arrived
			)
		await insert('900000000000000001', 6 * HOUR + 1000)
		await insert('900000000000000002', 6 * HOUR - 1000)
		// Rows written straight to the Store start no turn; the cron's does.
		await h.store.streamTick(BUILD)
		await drained(h, inbox)
		expect(events(inbox)).toEqual([['user', 'update', '900000000000000002']])
	})

	it('sends each status once and in order across turns', async () => {
		const h = await community(['alice', 'bob'])
		await follow(h, h.users.alice, h.users.bob.id)
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const before = (await drained(h)).turns
		const count = 150
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
			SELECT printf('9%017d', i), 'https://kopje.test/ap/o/many-' || i, ?2, 'public', '<p>x</p>', ?3, ?3 FROM n`,
			count,
			h.users.bob.id,
			new Date(NOW).toISOString()
		)
		await h.store.streamTick(BUILD)
		const { turns } = await drained(h, inbox)
		const sent = events(inbox).map(([, , id]) => id)
		const stored = await sql<{ id: string }>(h.store, "SELECT id FROM statuses WHERE id GLOB '9*' ORDER BY id")
		expect(sent).toEqual(stored.map((row) => row.id))
		// At most 64 presentations a turn.
		expect(turns - before).toBeGreaterThanOrEqual(Math.ceil(count / 64))
	})
})

describe('status.update', () => {
	it('sends an edit of a status in home on user', async () => {
		const h = await community(['alice', 'bob'])
		await follow(h, h.users.alice, h.users.bob.id)
		const status = await post(h, h.users.bob, { status: 'before', visibility: 'public' })
		const inbox = await subscribed(h, h.users.alice.token, 'user', 'user:notification')
		await edit(h, h.users.bob.token, status.id, 'after')
		await drained(h, inbox)
		expect(events(inbox)).toEqual([['user', 'status.update', status.id]])
		const rest = await getJson<Status>(h, `/api/v1/statuses/${status.id}`, h.users.alice.token)
		expect(JSON.parse((await inbox.next()).payload!)).toEqual(rest.body)
	})

	// The streamed status is presented without a viewer of its own (inline_renderer.rb:27, :47-49): its application as
	// its author's setting shows it, which REST shows too.
	it("carries the status's application in update and status.update", async () => {
		const h = await community(['alice', 'bob'])
		await follow(h, h.users.alice, h.users.bob.id)
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const status = await post(h, h.users.bob, { status: 'before', visibility: 'public' })
		await edit(h, h.users.bob.token, status.id, 'after')
		await drained(h, inbox)
		expect(events(inbox)).toEqual([
			['user', 'update', status.id],
			['user', 'status.update', status.id],
		])
		for (const message of inbox.rest()) {
			expect(JSON.parse(message.payload!), message.event).toHaveProperty('application', {
				name: 'Test Client',
				website: 'https://client.test',
			})
		}
	})

	it('sends an edit of a direct mention from an unfollowed account through the mention alone', async () => {
		const h = await community(['alice', 'carol'])
		// Private mentions from accounts alice does not follow are accepted, so the mention is not filtered.
		await sql(
			h.store,
			"INSERT INTO notification_policies (account_id, for_private_mentions) VALUES (?, 'accept')",
			h.users.alice.id
		)
		const status = await post(h, h.users.carol, { status: '@alice secret', visibility: 'direct' })
		const both = await subscribed(h, h.users.alice.token, 'user', 'user:notification')
		const statusesOnly = await subscribed(h, await scopedToken(h, 'read:statuses'), 'user')
		const notificationsOnly = await subscribed(h, await scopedToken(h, 'read:notifications'), 'user:notification')
		await edit(h, h.users.carol.token, status.id, '@alice secret, edited')
		await drained(h, both, statusesOnly, notificationsOnly)
		// Not in home (carol is not followed): only with a notification scope, on both streams.
		expect(events(both)).toEqual([
			['user', 'status.update', status.id],
			['user:notification', 'status.update', status.id],
		])
		expect(events(statusesOnly)).toEqual([])
		expect(events(notificationsOnly)).toEqual([['user:notification', 'status.update', status.id]])
	})

	it('sends nothing for an edit whose mention the policy filtered, or of a status the viewer neither sees nor is told of', async () => {
		const h = await community(['alice', 'carol'])
		// The default policy filters a private mention from an account alice does not follow.
		const filtered = await post(h, h.users.carol, { status: '@alice filtered', visibility: 'direct' })
		const unrelated = await post(h, h.users.carol, { status: 'public', visibility: 'public' })
		const inbox = await subscribed(h, h.users.alice.token, 'user', 'user:notification')
		await edit(h, h.users.carol.token, filtered.id, '@alice filtered, edited')
		await edit(h, h.users.carol.token, unrelated.id, 'public, edited')
		await drained(h, inbox)
		expect(events(inbox)).toEqual([])
		expect(await sql(h.store, 'SELECT filtered FROM notifications WHERE account_id = ?', h.users.alice.id)).toEqual([
			{ filtered: 1 },
		])
	})
})

describe('delete on user', () => {
	it('sends the delete of a status alice could view, and not of one she could not', async () => {
		const h = await community(['alice', 'bob', 'carol', 'dave'])
		await follow(h, h.users.alice, h.users.bob.id)
		const followed = await post(h, h.users.bob, { status: 'followers only', visibility: 'private' })
		const mention = await post(h, h.users.carol, { status: '@alice direct', visibility: 'direct' })
		const hidden = await post(h, h.users.dave, { status: 'followers only', visibility: 'private' })
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const notificationsOnly = await subscribed(h, h.users.alice.token, 'user:notification')
		await remove(h, h.users.dave.token, hidden.id)
		await drained(h, inbox, notificationsOnly)
		expect(events(inbox)).toEqual([])

		// The capture is taken before the delete changes the audience: the private status of a followed account, and a
		// direct status whose mention authorized alice.
		await remove(h, h.users.bob.token, followed.id)
		await remove(h, h.users.carol.token, mention.id)
		await drained(h, inbox, notificationsOnly)
		expect(inbox.rest()).toEqual([
			{ stream: ['user'], event: 'delete', payload: followed.id },
			{ stream: ['user'], event: 'delete', payload: mention.id },
		])
		expect(notificationsOnly.rest().filter((m) => m.event === 'delete')).toEqual([])
		// The capture rows went with their journal rows once sent, but the newest's, which is never pruned.
		expect(await sql(h.store, 'SELECT count(*) AS n FROM stream_events')).toEqual([{ n: 1 }])
		expect(
			await sql(
				h.store,
				'SELECT count(*) AS n FROM stream_delete_viewers WHERE event_id <> (SELECT id FROM stream_events)'
			)
		).toEqual([{ n: 0 }])
	})

	it('sends the delete of a boost, by unreblog and with its original, the status first', async () => {
		const h = await community(['alice', 'bob', 'dave'])
		await follow(h, h.users.alice, h.users.bob.id)
		const original = await post(h, h.users.dave, { status: 'boosted', visibility: 'public' })
		const other = await post(h, h.users.dave, { status: 'boosted, then unboosted', visibility: 'public' })
		const boost = await act(h, h.users.bob, `/api/v1/statuses/${original.id}/reblog`)
		const second = await act(h, h.users.bob, `/api/v1/statuses/${other.id}/reblog`)
		const boostId = (await boost.json<Status>()).id
		const secondId = (await second.json<Status>()).id
		const inbox = await subscribed(h, h.users.alice.token, 'user')

		expect((await act(h, h.users.bob, `/api/v1/statuses/${other.id}/unreblog`)).status).toBe(200)
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([{ stream: ['user'], event: 'delete', payload: secondId }])
		await inbox.next()

		await remove(h, h.users.dave.token, original.id)
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([
			{ stream: ['user'], event: 'delete', payload: original.id },
			{ stream: ['user'], event: 'delete', payload: boostId },
		])
	})

	it('records no capture while nobody listens on user', async () => {
		const h = await community(['alice', 'bob'])
		const status = await post(h, h.users.alice, { status: 'gone', visibility: 'public' })
		const inbox = await subscribed(h, h.users.bob.token, 'user:notification')
		await remove(h, h.users.alice.token, status.id)
		await drained(h, inbox)
		expect(await sql(h.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'delete'")).toEqual([{ n: 0 }])
		expect(inbox.rest()).toEqual([])
	})
})

describe('a delete across turns', () => {
	const VIEWERS = 16
	const BOOSTS = 40

	// The author's public status, boosted by 40 remote accounts that each of 16 listening viewers follows: 16 × 41
	// units, more than a turn's checks (512).
	async function boostedForMany(): Promise<{
		h: ApiHarness & { users: Record<'author', { id: string; token: string }> }
		status: string
		boosts: string[]
		inboxes: Inbox[]
	}> {
		const h = await community(['author'])
		const status = (await post(h, h.users.author, { status: 'boosted', visibility: 'public' })).id
		const inboxes: Inbox[] = []
		const viewers: string[] = []
		for (let i = 0; i < VIEWERS; i++) {
			const id = await seedAccount(h.store, { username: `viewer${i}`, email: `viewer${i}@example.com` })
			viewers.push(id)
			inboxes.push(await subscribed(h, await token(h.store, id), 'user'))
		}
		for (let i = 0; i < BOOSTS; i++) {
			const booster = await remoteAccount(h.store, `booster${i}`)
			await sql(
				h.store,
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at, created_at)
				VALUES (?, ?, ?, ?, 'public', '', ?, ?)`,
				String(800000000000000000n + BigInt(i)),
				`https://remote.example/boosts/${i}`,
				booster,
				status,
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString()
			)
			for (const viewer of viewers) {
				await sql(
					h.store,
					"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
					viewer,
					booster
				)
			}
		}
		const boosts = Array.from({ length: BOOSTS }, (_, i) => String(800000000000000000n + BigInt(i)))
		// The boosts' own inserts were journaled (sent as `update`); send them first.
		await h.store.streamTick(BUILD)
		await drained(h, ...inboxes)
		return { h, status, boosts, inboxes }
	}

	const deletes = (inbox: Inbox) => inbox.rest().flatMap((m) => (m.event === 'delete' ? [m.payload] : []))

	it('sends every viewer the status and its 40 boosts once, in order, over several turns', async () => {
		const { h, status, boosts, inboxes } = await boostedForMany()
		const before = (await drained(h)).turns
		await remove(h, h.users.author.token, status)
		const { turns } = await drained(h, ...inboxes)
		for (const inbox of inboxes) {
			expect(deletes(inbox)).toEqual([status, ...boosts])
		}
		expect(turns - before).toBeGreaterThanOrEqual(2)
	})

	it('resumes mid-event after the Store restarts, from the persisted position', async () => {
		const { h, status, boosts, inboxes } = await boostedForMany()
		// The capture, with no turn yet; then the position as a turn that sent units up to viewer 2's sixth subject left it.
		await runInDurableObject(h.store, (_instance, state) => {
			state.storage.transactionSync(() => streamDelete(new Db(state.storage.sql), status, NOW))
		})
		const viewers = await sql<{ account_id: string }>(
			h.store,
			'SELECT account_id FROM stream_delete_viewers ORDER BY account_id'
		)
		expect(viewers).toHaveLength(VIEWERS)
		await sql(
			h.store,
			`UPDATE stream_cursor SET event_id = (SELECT max(id) FROM stream_events WHERE kind = 'delete'), subject = 5,
				account_id = ?`,
			viewers[2]!.account_id
		)
		// A new instance: its first turn (which the drain barrier asks for) starts from the persisted position.
		await evictDurableObject(h.store)
		const { turns } = await drained(h, ...inboxes)
		const sent = inboxes.map(deletes)
		// The sockets were opened in account id order (seedAccount allocates ascending ids).
		expect(sent.slice(0, 2)).toEqual([[], []])
		expect(sent[2]).toEqual(boosts.slice(5))
		for (const rest of sent.slice(3)) {
			expect(rest).toEqual([status, ...boosts])
		}
		expect(turns).toBeGreaterThanOrEqual(2)
	})
})

describe('turns over captures nobody can be sent', () => {
	// `events` finished-or-pending delete events, each capturing `viewers` accounts that have no socket.
	async function captures(h: ApiHarness, events: number, viewers: number): Promise<number> {
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO stream_events (kind, subject, created_at)
			SELECT 'delete', '100000000000000000', '2026-10-12T00:00:00.000Z' FROM n`,
			events
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO stream_delete_viewers (event_id, account_id, lists, boosts)
			SELECT e.id, printf('7%017d', n.i), '[]', '[]' FROM stream_events e, n WHERE e.kind = 'delete'`,
			viewers
		)
		return (await sql<{ head: number }>(h.store, 'SELECT max(id) AS head FROM stream_events'))[0]!.head
	}

	it('moves past dense captures whose viewers all left, though no page has anything to send', async () => {
		const h = await community(['alice'])
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		// 64 events of 256 viewers: 2,000 pages and more, several turns' checks.
		const head = await captures(h, 64, 256)
		await h.store.streamTick(BUILD)
		const { turns } = await drained(h, inbox)
		expect(await sql(h.store, 'SELECT event_id, account_id FROM stream_cursor')).toEqual([
			{ event_id: head, account_id: null },
		])
		expect(inbox.rest()).toEqual([])
		// The pages, then the pruning of 16,384 capture rows, 500 a turn.
		expect(turns).toBeLessThanOrEqual(64)
	})

	it('prunes a dispatched dense journal down to its newest row in continuing turns, with no further write', async () => {
		const h = await community(['alice'])
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const head = await captures(h, 600, 8)
		// Already sent: the position is at the head.
		await sql(h.store, 'UPDATE stream_cursor SET event_id = ?, subject = 0, account_id = NULL', head)
		await h.store.streamTick(BUILD)
		const { turns } = await drained(h, inbox)
		expect(await sql(h.store, 'SELECT id FROM stream_events')).toEqual([{ id: head }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM stream_delete_viewers WHERE event_id <> ?', head)).toEqual([
			{ n: 0 },
		])
		// 599 journal rows and 4,792 capture rows, 500 a turn.
		expect(turns).toBeLessThanOrEqual(Math.ceil((599 + 599 * 8) / 500) + 2)
	})
})

describe('a status event across turns', () => {
	const VIEWERS = 100

	// 100 local accounts following the author, each with a socket on `user` of its own token: one turn presents at most
	// 64 statuses, so the event's units span two turns, the second resuming from the persisted account.
	it('sends each listener the status once when the event resumes in a later turn, and the turns end', async () => {
		const h = await community(['author'])
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username) SELECT printf('5%017d', i), 'https://kopje.test/ap/users/v' || i, 'v' || i FROM n`,
			VIEWERS
		)
		await sql(
			h.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`
		)
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*'",
			h.users.author.id
		)
		const inboxes: Inbox[] = []
		for (let i = 1; i <= VIEWERS; i++) {
			const id = `5${String(i).padStart(17, '0')}`
			await sql(
				h.store,
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) SELECT ?, 'access', client_id, ?, 'read' FROM oauth_tokens LIMIT 1",
				await sha256Hex(`resume-${id}`),
				id
			)
			const inbox = await connect(h, `resume-${id}`)
			inbox.send({ type: 'subscribe', stream: 'user' })
			inboxes.push(inbox)
		}
		for (const inbox of inboxes) {
			await echo(inbox)
		}
		const before = (await drained(h)).turns
		const status = await post(h, h.users.author, { status: 'for every follower', visibility: 'public' })
		// Quiescent: the barrier resolves only once no turn runs or is asked for and the position is at the head.
		const { turns } = await drained(h, ...inboxes)
		for (const inbox of inboxes) {
			expect(events(inbox)).toEqual([['user', 'update', status.id]])
		}
		expect(turns - before).toBeGreaterThanOrEqual(2)
		// Asking again runs no further turn and sends nothing.
		expect((await drained(h, ...inboxes)).turns).toBe(turns)
		expect(inboxes.every((inbox) => inbox.rest().length === 1)).toBe(true)
	}, 60_000)
})
