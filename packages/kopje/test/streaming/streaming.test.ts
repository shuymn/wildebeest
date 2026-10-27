import { evictDurableObject, runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { sha256Hex } from '../../src/security/tokens'
import { STREAM_LIMITS } from '../../src/stream-hub'
import { type ApiHarness, form, login, sql } from '../api-helpers'
import { NOW } from '../app-helpers'
import { BUILD } from '../helpers'
import { appToken, scopedToken } from '../read-helpers'
import { block, community, follow, post } from '../status-helpers'
import { csrfOf, postForm, signIn } from '../web-helpers'
import { connect, drained, type Inbox, notifications, settled, subscribed, upgrade } from './stream-helpers'

// The streaming API (Mastodon 4.5's streaming server): the upgrade and its token
// sources, the subscribe protocol and its errors, the caps, `notification` on `user` and `user:notification` (R33,
// VIS-26), the closing of revoked tokens' sockets, hibernation and the fan-out's turns. Absence is proved with the
// drain barrier: once it returns, every event written before it has been judged and anything due has been sent.

const LIMITS = { ...STREAM_LIMITS }

afterEach(() => {
	Object.assign(STREAM_LIMITS, LIMITS)
	vi.restoreAllMocks()
})

describe('the upgrade', () => {
	it.each(['protocol', 'header'] as const)('takes the token from the %s', async (via) => {
		const h = await community(['alice'])
		const response = await upgrade(h, h.users.alice.token, { via })
		expect(response.status).toBe(101)
		// The subprotocol a client offered is echoed (browsers fail the handshake otherwise), and only then.
		expect(response.headers.get('sec-websocket-protocol')).toBe(via === 'protocol' ? h.users.alice.token : null)
		response.webSocket?.accept()
		response.webSocket?.close()
	})

	it('prefers the Authorization header to the other sources, and takes any path below the endpoint', async () => {
		const h = await community(['alice'])
		const response = await h.request('/api/v1/streaming/user?access_token=wrong', {
			headers: {
				upgrade: 'websocket',
				authorization: `Bearer ${h.users.alice.token}`,
				'sec-websocket-protocol': 'wrong-too',
			},
		})
		expect(response.status).toBe(101)
		expect(response.headers.get('sec-websocket-protocol')).toBe('wrong-too')
		response.webSocket?.accept()
		response.webSocket?.close()
	})

	it('answers 401 without a token, with a token that is not valid, and with an app token', async () => {
		const h = await community(['alice'])
		// A token in the query alone is not read (it would reach the platform's request logs): as none.
		const query = await upgrade(h, h.users.alice.token, { via: 'query' })
		expect([query.status, query.headers.get('x-error-message')]).toEqual([401, 'Missing access token'])
		const missing = await upgrade(h, null)
		expect([missing.status, missing.headers.get('x-error-message'), await missing.text()]).toEqual([
			401,
			'Missing access token',
			'',
		])
		for (const token of ['not-a-token', await appToken(h)]) {
			const refused = await upgrade(h, token)
			expect([refused.status, refused.headers.get('x-error-message')]).toEqual([401, 'Invalid access token'])
		}
	})

	it('serves the health check, and answers 404 to a request that is not an upgrade (no SSE)', async () => {
		const h = await community(['alice'])
		const health = await h.request('/api/v1/streaming/health')
		expect([health.status, await health.text(), health.headers.get('cache-control')]).toEqual([
			200,
			'OK',
			'private, no-store',
		])
		for (const path of ['/api/v1/streaming', '/api/v1/streaming/user']) {
			const response = await h.request(path, { headers: { authorization: `Bearer ${h.users.alice.token}` } })
			expect([response.status, await response.json()]).toEqual([404, { error: 'Not found' }])
		}
	})

	it('subscribes to ?stream= on connect', async () => {
		const h = await community(['alice', 'bob'])
		const inbox = await connect(h, h.users.alice.token, { query: 'stream=user:notification' })
		await settled(h, inbox)
		await follow(h, h.users.bob, h.users.alice.id)
		const message = await inbox.next((m) => m.event === 'notification')
		expect(message.stream).toEqual(['user:notification'])
	})
})

describe('the subscribe protocol', () => {
	it('sends a notification to each subscription that carries it, with the stream as masto.js matches it', async () => {
		const h = await community(['alice', 'bob'])
		const inbox = await connect(h, h.users.alice.token)
		inbox.send({ type: 'subscribe', stream: ['user'] })
		inbox.send({ type: 'subscribe', stream: 'user:notification' })
		// A subscription already present is ignored.
		inbox.send({ type: 'subscribe', stream: 'user' })
		await settled(h, inbox)
		await follow(h, h.users.bob, h.users.alice.id)
		await drained(h, inbox)
		const sent = inbox.rest()
		expect(sent.map((m) => [m.stream, m.event])).toEqual([
			[['user'], 'notification'],
			[['user:notification'], 'notification'],
		])
		// The payload is the notification as REST shows it, encoded as a JSON string.
		const listed = await h.request('/api/v1/notifications', {
			headers: { authorization: `Bearer ${h.users.alice.token}` },
		})
		const [rest] = await listed.json<unknown[]>()
		expect(JSON.parse(sent[0]!.payload!)).toEqual(rest)
		expect(notifications(sent, 'user')).toMatchObject([{ type: 'follow' }])

		// Unsubscribed, a stream carries nothing more.
		await inbox.next()
		await inbox.next()
		inbox.send({ type: 'unsubscribe', stream: 'user' })
		await settled(h, inbox)
		await post(h, h.users.bob, { status: '@alice hello', visibility: 'public' })
		await drained(h, inbox)
		expect(inbox.rest().map((m) => [m.stream, m.event])).toEqual([[['user:notification'], 'notification']])
	})

	it('refuses a subscription the registry cannot record (a dump freezes it), so the client subscribes again', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		// A turn has run: the registry is not rebuilt from the sockets again.
		const other = await subscribed(h, h.users.bob.token, 'user:notification')
		await drained(h, other)
		const inbox = await connect(h, h.users.alice.token)
		const started = await h.store.dumpStart(BUILD)
		if (!started.ok) {
			throw new Error(started.message)
		}
		// An expected refusal: logged as a warning, not an error.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		inbox.send({ type: 'subscribe', stream: 'user:notification' })
		expect(await inbox.next()).toEqual({ error: 'An unexpected error occurred', status: 500 })
		expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.stream.register-failed' }))
		expect(error).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.stream.register-failed' }))
		vi.restoreAllMocks()
		expect(await h.store.dumpFinish(BUILD, started.cursor, true)).toMatchObject({ ok: true })
		await follow(h, h.users.bob, h.users.alice.id)
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([])
		inbox.send({ type: 'subscribe', stream: 'user:notification' })
		await settled(h, inbox)
		await follow(h, h.users.carol, h.users.alice.id)
		await drained(h, inbox)
		expect(notifications(inbox.rest(), 'user:notification')).toMatchObject([{ type: 'follow' }])
	})

	it('logs an unexpected registration failure as an error', async () => {
		const h = await community(['alice'])
		const inbox = await connect(h, h.users.alice.token)
		await sql(
			h.store,
			"CREATE TRIGGER fail_register BEFORE INSERT ON stream_subscriptions BEGIN SELECT RAISE(ABORT, 'injected'); END"
		)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		inbox.send({ type: 'subscribe', stream: 'user:notification' })
		expect(await inbox.next()).toEqual({ error: 'An unexpected error occurred', status: 500 })
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.stream.register-failed' }))
		expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.stream.register-failed' }))
		vi.restoreAllMocks()
		await sql(h.store, 'DROP TRIGGER fail_register')
	})

	it('answers an unknown stream with Unknown stream type, and an unknown unsubscribe', async () => {
		const h = await community(['alice'])
		const inbox = await connect(h, h.users.alice.token)
		// Ice Cubes' `local` is not a Mastodon stream; every stream Mastodon knows is served.
		for (const stream of ['local', 'public:media:local', 'hashtag:remote', 42]) {
			inbox.send({ type: 'subscribe', stream, tag: 'kopje', list: '1' })
			expect(await inbox.next()).toEqual({ error: 'Unknown stream type', status: 400 })
		}
		inbox.send({ type: 'unsubscribe', stream: 'local' })
		expect(await inbox.next()).toEqual({ error: 'Error unsubscribing from channel' })
		// Unparseable messages and other types are ignored, as Mastodon does.
		inbox.send('not json')
		inbox.send({ type: 'ping' })
		await settled(h, inbox)
		expect(inbox.rest()).toEqual([])
	})

	it('checks the scope of each stream, and sends notifications on user only with a notification scope', async () => {
		const h = await community(['alice', 'bob'])
		const statusesOnly = await connect(h, await scopedToken(h, 'read:statuses'))
		statusesOnly.send({ type: 'subscribe', stream: 'user:notification' })
		expect(await statusesOnly.next()).toEqual({
			error: 'Access token does not have the required scopes',
			status: 401,
		})
		statusesOnly.send({ type: 'subscribe', stream: 'user' })
		await settled(h, statusesOnly)

		const notificationsOnly = await connect(h, await scopedToken(h, 'read:notifications'))
		notificationsOnly.send({ type: 'subscribe', stream: 'user' })
		expect(await notificationsOnly.next()).toEqual({
			error: 'Access token does not have the required scopes',
			status: 401,
		})
		notificationsOnly.send({ type: 'subscribe', stream: 'user:notification' })
		await settled(h, notificationsOnly)

		await follow(h, h.users.bob, h.users.alice.id)
		await drained(h, statusesOnly, notificationsOnly)
		expect(statusesOnly.rest()).toEqual([])
		expect(notifications(notificationsOnly.rest(), 'user:notification')).toMatchObject([{ type: 'follow' }])
	})
})

describe('what a notification stream does not carry', () => {
	// Each case writes what must not be sent, proves its absence with the drain barrier, then sends a control that
	// must arrive.
	async function absent(h: ApiHarness, inbox: Inbox) {
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([])
	}

	it('leaves out a filtered or dropped notification, a blocked sender and another account', async () => {
		const h = await community(['alice', 'bob', 'carol', 'dave', 'erin'])
		const inbox = await subscribed(h, h.users.alice.token, 'user', 'user:notification')

		// The policy filters, then drops, mentions from accounts alice does not follow.
		await sql(
			h.store,
			"INSERT INTO notification_policies (account_id, for_not_following) VALUES (?, 'filter')",
			h.users.alice.id
		)
		await post(h, h.users.bob, { status: '@alice filtered', visibility: 'public' })
		await absent(h, inbox)
		expect(await sql(h.store, 'SELECT filtered FROM notifications WHERE account_id = ?', h.users.alice.id)).toEqual([
			{ filtered: 1 },
		])
		await sql(
			h.store,
			"UPDATE notification_policies SET for_not_following = 'drop' WHERE account_id = ?",
			h.users.alice.id
		)
		await post(h, h.users.carol, { status: '@alice dropped', visibility: 'public' })
		await absent(h, inbox)
		await sql(
			h.store,
			"UPDATE notification_policies SET for_not_following = 'accept' WHERE account_id = ?",
			h.users.alice.id
		)

		// A sender alice blocks is not notified at all.
		await block(h.store, h.users.alice.id, h.users.dave.id)
		await post(h, h.users.dave, { status: '@alice blocked', visibility: 'public' })
		await absent(h, inbox)

		// Another account's notification: alice's own post reaches her home (`update`), and no notification.
		await post(h, h.users.alice, { status: '@bob yours', visibility: 'public' })
		await drained(h, inbox)
		expect(inbox.rest().map((m) => [m.stream, m.event])).toEqual([[['user'], 'update']])
		await inbox.next()

		// The control: a mention alice's policy accepts arrives on both streams.
		await post(h, h.users.erin, { status: '@alice shown', visibility: 'public' })
		await drained(h, inbox)
		expect(inbox.rest().map((m) => m.stream)).toEqual([['user'], ['user:notification']])
		expect(notifications(inbox.rest(), 'user')).toMatchObject([{ type: 'mention' }])
		// A streamed notification is never a filtered one, so it carries no `filtered` (REST::NotificationSerializer).
		for (const stream of ['user', 'user:notification']) {
			expect(notifications(inbox.rest(), stream).map((n) => Object.hasOwn(n, 'filtered'))).toEqual([false])
		}
	})

	it('leaves out a notification dismissed before its turn', async () => {
		const h = await community(['alice', 'bob'])
		const inbox = await subscribed(h, h.users.alice.token, 'user:notification')
		// Written and dismissed with no turn between (the sockets' turns run after the writes, in one go here).
		await runInDurableObject(h.store, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)",
				h.users.alice.id,
				h.users.bob.id
			)
			state.storage.sql.exec('DELETE FROM notifications')
		})
		await h.store.streamTick(BUILD)
		await drained(h, inbox)
		expect(inbox.rest()).toEqual([])
		// Pruned behind the position, but for the newest row, which keeps ids from being given twice.
		expect(await sql(h.store, 'SELECT count(*) AS n FROM stream_events')).toEqual([{ n: 1 }])
	})
})

describe('the caps', () => {
	it('refuses a seventeenth socket of an account, and a socket over the instance cap', async () => {
		const h = await community(['alice', 'bob'])
		const open: Inbox[] = []
		for (let i = 0; i < 16; i++) {
			open.push(await connect(h, h.users.alice.token))
		}
		const seventeenth = await upgrade(h, h.users.alice.token)
		expect([seventeenth.status, seventeenth.headers.get('x-error-message')]).toEqual([429, 'Too many connections'])
		// One closed makes room.
		open.pop()!.ws.close(1000)
		await settled(h, open[0]!)
		await expectEventually(async () => (await upgrade(h, h.users.alice.token)).status === 101, open[0]!, h)

		STREAM_LIMITS.socketsPerInstance = 16
		const over = await upgrade(h, h.users.bob.token)
		expect([over.status, over.headers.get('x-error-message')]).toEqual([503, 'Too many connections'])
	})

	it('refuses a subscription over the socket, account and attachment bounds', async () => {
		const h = await community(['alice'])
		const inbox = await connect(h, h.users.alice.token)
		STREAM_LIMITS.subscriptionsPerSocket = 1
		inbox.send({ type: 'subscribe', stream: 'user' })
		inbox.send({ type: 'subscribe', stream: 'user:notification' })
		expect(await inbox.next()).toEqual({ error: 'Too many subscriptions', status: 429 })
		STREAM_LIMITS.subscriptionsPerSocket = LIMITS.subscriptionsPerSocket

		STREAM_LIMITS.keysPerAccount = 1
		const other = await connect(h, h.users.alice.token)
		other.send({ type: 'subscribe', stream: 'user' })
		other.send({ type: 'subscribe', stream: 'user:notification' })
		expect(await other.next()).toEqual({ error: 'Too many subscriptions', status: 429 })
		STREAM_LIMITS.keysPerAccount = LIMITS.keysPerAccount

		STREAM_LIMITS.attachmentBytes = 200
		other.send({ type: 'subscribe', stream: 'user:notification' })
		expect(await other.next()).toEqual({ error: 'Too many subscriptions', status: 429 })
		STREAM_LIMITS.attachmentBytes = LIMITS.attachmentBytes
		other.send({ type: 'subscribe', stream: 'user:notification' })
		await settled(h, other)
		expect(other.rest()).toEqual([])
		expect(await sql(h.store, 'SELECT stream_key, sockets FROM stream_subscriptions ORDER BY stream_key')).toEqual([
			{ stream_key: 'user', sockets: 2 },
			{ stream_key: 'user:notification', sockets: 1 },
		])
	})

	it('closes a socket that sends a binary message (1003), an oversize one or too many (1008)', async () => {
		const h = await community(['alice'])
		const binary = await connect(h, h.users.alice.token)
		binary.ws.send(new Uint8Array([1, 2, 3]))
		expect((await binary.closed()).code).toBe(1003)

		const oversize = await connect(h, h.users.alice.token)
		oversize.send('x'.repeat(STREAM_LIMITS.messageBytes))
		await settled(h, oversize)
		oversize.send('x'.repeat(STREAM_LIMITS.messageBytes + 1))
		expect((await oversize.closed()).code).toBe(1008)
		// Counted in bytes of UTF-8, not characters.
		const multibyte = await connect(h, h.users.alice.token)
		multibyte.send('é'.repeat(STREAM_LIMITS.messageBytes / 2 + 1))
		expect((await multibyte.closed()).code).toBe(1008)

		const flood = await connect(h, h.users.alice.token)
		for (let i = 0; i < STREAM_LIMITS.messagesPerMinute + 1; i++) {
			flood.send({ type: 'ping' })
		}
		expect((await flood.closed()).code).toBe(1008)
		// The registry follows the sockets that are left.
		await drained(h)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM stream_subscriptions')).toEqual([{ n: 0 }])
	})

	it('closes a socket whose attachment does not validate (1011)', async () => {
		const h = await community(['alice'])
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		await runInDurableObject(h.store, (_instance, state) => {
			for (const ws of state.getWebSockets()) {
				ws.serializeAttachment({ v: 1, subs: ['public'] })
			}
		})
		inbox.send({ type: 'subscribe', stream: 'user:notification' })
		expect((await inbox.closed()).code).toBe(1011)
	})
})

describe("closing a token's sockets", () => {
	it('closes the sockets of a revoked token (1008) and of no other', async () => {
		const h = await community(['alice', 'bob'])
		const { app, token } = await login(h, { email: 'alice@example.com' })
		const revoked = await subscribed(h, token, 'user:notification')
		const kept = await subscribed(h, h.users.alice.token, 'user:notification')
		const response = await h.request(
			'/oauth/revoke',
			form({ token, client_id: app.client_id, client_secret: app.client_secret })
		)
		expect(response.status).toBe(200)
		expect((await revoked.closed()).code).toBe(1008)
		await follow(h, h.users.bob, h.users.alice.id)
		await drained(h, kept)
		expect(kept.isClosed).toBe(false)
		expect(notifications(kept.rest(), 'user:notification')).toMatchObject([{ type: 'follow' }])
	})

	it('closes a signed-out web session, a suspended account and an expired token', async () => {
		const h = await community(['alice', 'bob'])
		const browser = await signIn(h)
		const session = await subscribed(h, browser.session, 'user:notification')
		expect((await postForm(h, browser, '/logout', { csrf: await csrfOf(h, browser) })).status).toBe(200)
		expect((await session.closed()).code).toBe(1008)

		const expiring = await subscribed(h, h.users.bob.token, 'user:notification')
		await sql(
			h.store,
			"UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?",
			await sha256Hex(h.users.bob.token)
		)
		// The cron's turn closes it.
		await h.store.streamTick(BUILD)
		expect((await expiring.closed()).code).toBe(1008)

		const suspended = await subscribed(h, h.users.alice.token, 'user')
		await h.store.suspendAccount(BUILD, { accountId: h.users.alice.id, now: NOW })
		expect((await suspended.closed()).code).toBe(1008)
		await drained(h)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM stream_subscriptions')).toEqual([{ n: 0 }])
	})
})

describe('hibernation and turns', () => {
	it('continues by itself until the journal is sent, from one request for a turn', async () => {
		const h = await community(['alice'])
		const inbox = await subscribed(h, h.users.alice.token, 'user:notification')
		const count = 150
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('7%017d', i), 'https://many.example/users/u' || i, 'u' || i, 'many.example' FROM n`,
			count
		)
		await sql(
			h.store,
			"INSERT INTO notifications (account_id, type, from_account_id) SELECT ?, 'follow', id FROM accounts WHERE domain = 'many.example' ORDER BY id",
			h.users.alice.id
		)
		// One turn is asked for; nothing else starts one (no write, no drain barrier): the turns continue themselves.
		await h.store.streamTick(BUILD)
		for (let i = 0; i < count; i++) {
			await inbox.next((m) => m.event === 'notification')
		}
	})

	it('delivers after the Store is evicted, its sockets hibernated', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const inbox = await subscribed(h, h.users.alice.token, 'user:notification')
		await evictDurableObject(h.store)
		await follow(h, h.users.bob, h.users.alice.id)
		expect(notifications([await inbox.next()], 'user:notification')).toMatchObject([{ type: 'follow' }])
		// The socket's attachment came back whole: it still takes messages and keeps its subscription.
		await evictDurableObject(h.store)
		inbox.send({ type: 'subscribe', stream: 'user' })
		await settled(h, inbox)
		await follow(h, h.users.carol, h.users.alice.id)
		await drained(h, inbox)
		expect(inbox.rest().map((m) => m.stream)).toEqual([['user:notification'], ['user']])
	})

	it('continues across turns, each unit sent once and in order, whoever asks for a turn', async () => {
		const h = await community(['alice'])
		const inbox = await subscribed(h, h.users.alice.token, 'user:notification')
		const count = 150
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('7%017d', i), 'https://many.example/users/u' || i, 'u' || i, 'many.example' FROM n`,
			count
		)
		const before = (await drained(h)).turns
		await sql(
			h.store,
			"INSERT INTO notifications (account_id, type, from_account_id) SELECT ?, 'follow', id FROM accounts WHERE domain = 'many.example' ORDER BY id",
			h.users.alice.id
		)
		// Turns asked for while one runs, by the cron and by writes, do not run alongside it.
		await Promise.all([h.store.streamTick(BUILD), h.store.streamTick(BUILD), h.store.streamTick(BUILD)])
		const { turns } = await drained(h, inbox)
		const ids = notifications(inbox.rest(), 'user:notification').map((n) => Number(n.id))
		const stored = await sql<{ id: number }>(h.store, 'SELECT id FROM notifications ORDER BY id')
		expect(ids).toEqual(stored.map((row) => row.id))
		// At most 64 presentations a turn: three turns at least.
		expect(turns - before).toBeGreaterThanOrEqual(Math.ceil(count / 64))
		// Pruned behind the position, but for the newest row, which keeps ids from being given twice.
		expect(await sql(h.store, 'SELECT count(*) AS n FROM stream_events')).toEqual([{ n: 1 }])
	})
})

// Retries `check` after each drain of the Store, for what a socket's close makes true once the Store has seen it.
async function expectEventually(check: () => Promise<boolean>, inbox: Inbox, h: ApiHarness): Promise<void> {
	while (!(await check())) {
		await settled(h, inbox)
	}
}
