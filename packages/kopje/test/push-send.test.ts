import { env } from 'cloudflare:workers'

import { importJWK, jwtVerify } from 'jose'
import { describe, expect, it, vi } from 'vitest'

import { type ApiHarness, bearer, form, json, login, sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { mastodonActor } from './inbox-helpers'
import { like, localStatus, setup } from './inbox-status-helpers'
import { type Client, newClient, readPush, VAPID } from './push-helpers'
import { act, community, follow, post, type User } from './status-helpers'
import { LEASE_MS, MAX_ATTEMPTS, retryDelay } from '../src/domain/deliveries'
import { MAX_PUSH_BACKLOG } from '../src/domain/notifications'
import { PUSH_TTL_MS } from '../src/domain/push'
import type { DeliveryDeps } from '../src/jobs/deliver'
import { pushPayload, pushRound } from '../src/jobs/push'
import { handleQueue } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'
import { MAX_PUSH_PLAINTEXT, sealPushToken } from '../src/security/web-push'

// Sending Web Push (domain/push.ts, jobs/push.ts): a push per new notification and matching subscription (VIS-10),
// re-checked before sending (PUSH-3), through the delivery sink (PUSH-2, NET-3), encrypted and signed with VAPID, and
// settled as Mastodon does (404 and 410 unsubscribe). Every fetch is mocked; nothing leaves the test.

const ENDPOINT = 'https://push.example/send/abc'
const SCOPES = 'read write follow push'
const publicHost = () => Promise.resolve()

type Sent = { url: string; request: Request }

function recordingFetch(answer: (request: Request) => Response = () => new Response(null, { status: 201 })) {
	const sent: Sent[] = []
	const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		sent.push({ url: request.url, request: request.clone() })
		return Promise.resolve(answer(request))
	})
	return { fetch: fetch as unknown as typeof globalThis.fetch, sent }
}

function roundDeps(store: StoreStub, fetch: typeof globalThis.fetch, extra: Partial<DeliveryDeps> = {}): DeliveryDeps {
	let n = 0
	return {
		build: () => env.CF_VERSION_METADATA.id,
		store: () => store,
		now: () => NOW,
		fetch,
		checkHost: publicHost,
		leaseToken: () => `lease-${++n}`,
		...extra,
	}
}

type Subscribe = { standard?: boolean; alerts?: Record<string, boolean>; policy?: string; endpoint?: string }

const ALL = {
	mention: true,
	status: true,
	reblog: true,
	favourite: true,
	follow: true,
	follow_request: true,
	update: true,
}

async function subscribe(h: ApiHarness, user: User, options: Subscribe = {}): Promise<Client> {
	const client = await newClient()
	const response = await h.request(
		'/api/v1/push/subscription',
		bearer(
			user.token,
			json({
				subscription: {
					endpoint: options.endpoint ?? ENDPOINT,
					keys: { p256dh: client.p256dh, auth: client.auth },
					standard: options.standard ?? false,
				},
				data: { alerts: options.alerts ?? ALL, policy: options.policy ?? 'all' },
			})
		)
	)
	expect(response.status).toBe(200)
	return client
}

async function pushing(names: readonly ('alice' | 'bob' | 'carol')[] = ['alice', 'bob'], options: Subscribe = {}) {
	const h = await community(names, SCOPES, {}, { VAPID_JWK: VAPID.env })
	const client = await subscribe(h, h.users.alice, options)
	return { h, client }
}

type Harness = Awaited<ReturnType<typeof pushing>>['h']

async function round(h: ApiHarness, fetch: typeof globalThis.fetch, extra: Partial<DeliveryDeps> = {}) {
	return pushRound(h.env, roundDeps(h.store, fetch, extra))
}

type Row = { attempts: number; state: string; next_attempt_at: number; last_status: number | null }

const rows = (store: StoreStub) =>
	sql<Row>(store, 'SELECT attempts, state, next_attempt_at, last_status FROM push_deliveries ORDER BY id')

// A host check that waits until released, so a test can change the Store between the claim and the POST.
function pausedHost() {
	let entered: () => void = () => {}
	let release: () => void = () => {}
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve
	})
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const check = async () => {
		entered()
		await gate
	}
	return { check, entered: enteredPromise, release }
}

async function pushedTypes(h: ApiHarness, client: Client): Promise<string[]> {
	const { fetch, sent } = recordingFetch()
	await round(h, fetch)
	const payloads = await Promise.all(sent.map((s) => readPush(client, s.request)))
	return payloads.map((p) => p.notification_type as string).sort()
}

describe('sending a push', () => {
	it('sends a mention encrypted with aesgcm and signed with VAPID, in Mastodon’s payload', async () => {
		const { h, client } = await pushing()
		const { alice, bob } = h.users
		await post(h, bob, { status: '@alice hello <b>there</b>' })
		const [notification] = (await (await h.request('/api/v1/notifications', bearer(alice.token))).json()) as {
			id: string
		}[]
		const { fetch, sent } = recordingFetch()
		expect(await round(h, fetch)).toMatchObject({ claimed: 1, settled: ['delivered'] })

		expect(sent.map((s) => s.url)).toEqual([ENDPOINT])
		const request = sent[0]?.request as Request
		expect(request.method).toBe('POST')
		expect(request.redirect).toBe('manual')
		expect(Object.fromEntries(request.headers)).toMatchObject({
			'content-type': 'application/octet-stream',
			'content-encoding': 'aesgcm',
			ttl: '172800',
			urgency: 'normal',
			encryption: expect.stringMatching(/^salt=[\w-]{22}$/),
			'crypto-key': expect.stringMatching(new RegExp(`^dh=[\\w-]{87};p256ecdsa=${VAPID.publicKey}$`)),
			authorization: expect.stringMatching(/^WebPush /),
		})
		const jwt = request.headers.get('authorization')?.slice('WebPush '.length) ?? ''
		const { x, y } = VAPID.jwk
		const { payload } = await jwtVerify(jwt, await importJWK({ kty: 'EC', crv: 'P-256', x, y }, 'ES256'), {
			currentDate: new Date(NOW),
		})
		expect(payload).toEqual({ aud: 'https://push.example', sub: 'https://kopje.test/', exp: expect.any(Number) })
		expect((payload.exp ?? 0) - NOW / 1000).toBeLessThanOrEqual(24 * 60 * 60)

		expect(await readPush(client, request)).toEqual({
			access_token: alice.token,
			preferred_locale: 'en',
			notification_id: Number(notification?.id),
			notification_type: 'mention',
			icon: 'https://kopje.test/assets/avatar.png',
			title: 'You were mentioned by bob',
			body: '@alice hello <b>there</b>',
		})
		expect(await rows(h.store)).toEqual([])
	})

	it('decodes as Mastodon’s payload types: a numeric notification_id, strings elsewhere', async () => {
		const { h, client } = await pushing()
		await post(h, h.users.bob, { status: '@alice typed' })
		const { fetch, sent } = recordingFetch()
		await round(h, fetch)
		const payload = await readPush(client, sent[0]?.request as Request)
		expect(Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value]))).toEqual({
			access_token: 'string',
			preferred_locale: 'string',
			notification_id: 'number',
			notification_type: 'string',
			icon: 'string',
			title: 'string',
			body: 'string',
		})
		expect(Number.isSafeInteger(payload.notification_id)).toBe(true)
		const [row] = await sql<{ id: number }>(h.store, 'SELECT id FROM notifications')
		expect(payload.notification_id).toBe(row?.id)
	})

	it('uses aes128gcm and the vapid scheme for a standard subscription', async () => {
		const { h, client } = await pushing(['alice', 'bob'], { standard: true })
		await post(h, h.users.bob, { status: '@alice hi' })
		const { fetch, sent } = recordingFetch()
		await round(h, fetch)
		const request = sent[0]?.request as Request
		expect(request.headers.get('content-encoding')).toBe('aes128gcm')
		expect(request.headers.get('authorization')).toMatch(
			new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${VAPID.publicKey}$`)
		)
		expect(request.headers.has('crypto-key')).toBe(false)
		expect(request.headers.has('encryption')).toBe(false)
		expect(await readPush(client, request)).toMatchObject({ notification_type: 'mention', body: '@alice hi' })
	})

	it('pushes every notification type Kopje emits, once each (VIS-10)', async () => {
		const { h, client } = await pushing(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const own = await post(h, alice, { status: 'mine' })
		await follow(h, bob, alice.id)
		await act(h, bob, `/api/v1/statuses/${own.id}/favourite`)
		await act(h, bob, `/api/v1/statuses/${own.id}/reblog`)
		await post(h, bob, { status: '@alice look' })
		// A favourite repeated is no new notification, so no second push.
		await act(h, bob, `/api/v1/statuses/${own.id}/unfavourite`)
		await act(h, bob, `/api/v1/statuses/${own.id}/favourite`)
		await act(h, alice, `/api/v1/accounts/${bob.id}/follow`, { notify: true })
		const news = await post(h, bob, { status: 'news' })
		await act(h, alice, `/api/v1/statuses/${news.id}/reblog`)
		await h.request(
			`/api/v1/statuses/${news.id}`,
			bearer(bob.token, json({ status: 'news, edited' }, { method: 'PUT' }))
		)
		await sql(h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', alice.id)
		await follow(h, carol, alice.id)
		expect(await pushedTypes(h, client)).toEqual([
			'favourite',
			'follow',
			'follow_request',
			'mention',
			'reblog',
			'status',
			'update',
		])
	})

	it('pushes only the alerts the subscription asked for', async () => {
		const { h, client } = await pushing(['alice', 'bob'], { alerts: { mention: true, favourite: false } })
		const { alice, bob } = h.users
		const own = await post(h, alice, { status: 'mine' })
		await act(h, bob, `/api/v1/statuses/${own.id}/favourite`)
		await follow(h, bob, alice.id)
		await post(h, bob, { status: '@alice hi' })
		expect(await pushedTypes(h, client)).toEqual(['mention'])
	})

	it.each([
		['all', ['bob', 'carol']],
		['followed', ['bob']],
		['follower', ['carol']],
		['none', []],
	])('applies the %s policy', async (policy, senders) => {
		const { h, client } = await pushing(['alice', 'bob', 'carol'], { policy, alerts: { mention: true } })
		const { alice, bob, carol } = h.users
		await follow(h, alice, bob.id)
		await follow(h, carol, alice.id)
		await post(h, bob, { status: '@alice from bob' })
		await post(h, carol, { status: '@alice from carol' })
		const { fetch, sent } = recordingFetch()
		await round(h, fetch)
		const bodies = await Promise.all(sent.map(async (s) => (await readPush(client, s.request)).body as string))
		expect(bodies.map((body) => body.replace('@alice from ', '')).sort()).toEqual(senders)
	})

	it('sends to each subscription of the recipient, never to another account’s', async () => {
		const { h, client } = await pushing()
		const { token } = await login(h, { email: 'alice@example.com', scope: SCOPES })
		const second = await subscribe(h, { id: h.users.alice.id, token }, { endpoint: 'https://push.example/second' })
		const bobs = await subscribe(h, h.users.bob, { endpoint: 'https://push.example/bob' })
		await post(h, h.users.bob, { status: '@alice hi' })
		const { fetch, sent } = recordingFetch()
		await round(h, fetch)
		expect(sent.map((s) => s.url).sort()).toEqual(['https://push.example/second', ENDPOINT])
		const byUrl = new Map(sent.map((s) => [s.url, s.request]))
		expect((await readPush(client, byUrl.get(ENDPOINT) as Request)).access_token).toBe(h.users.alice.token)
		expect((await readPush(second, byUrl.get('https://push.example/second') as Request)).access_token).toBe(token)
		expect(bobs).toBeDefined()
	})

	it('keeps a payload with a long display name and body under the 4 KiB limit', async () => {
		const { h, client } = await pushing()
		await sql(h.store, 'UPDATE accounts SET display_name = ? WHERE id = ?', '\u0001'.repeat(2000), h.users.bob.id)
		await post(h, h.users.bob, { status: `@alice ${'x'.repeat(400)}` })
		const { fetch, sent } = recordingFetch()
		await round(h, fetch)
		const payload = await readPush(client, sent[0]?.request as Request)
		expect(Array.from(payload.body as string)).toHaveLength(140)
		expect(payload.body).toMatch(/\.\.\.$/)
		expect(Array.from(payload.title as string)).toHaveLength(140)
		const content = {
			notification_id: 1,
			notification_type: 'mention',
			preferred_locale: 'en',
			icon: `https://kopje.test/${'i'.repeat(5000)}`,
			title: '\u0001'.repeat(5000),
			body: '\u0001'.repeat(140),
		}
		expect(pushPayload(content, 't'.repeat(43)).length).toBeLessThanOrEqual(MAX_PUSH_PLAINTEXT)
	})
})

describe('PUSH-3: a push reveals no more than the notification', () => {
	it('sends nothing for a notification deleted before sending', async () => {
		const { h } = await pushing()
		const status = await post(h, h.users.bob, { status: '@alice soon gone' })
		expect(await rows(h.store)).toHaveLength(1)
		await h.request(`/api/v1/statuses/${status.id}`, bearer(h.users.bob.token, { method: 'DELETE' }))
		expect(await rows(h.store)).toEqual([])
		const { fetch, sent } = recordingFetch()
		expect(await round(h, fetch)).toMatchObject({ claimed: 0 })
		expect(sent).toEqual([])
	})

	it.each([
		['the recipient blocks the sender', 'INSERT INTO blocks (account_id, target_account_id) VALUES (?1, ?2)'],
		[
			'the recipient mutes the sender’s notifications',
			'INSERT INTO mutes (account_id, target_account_id, hide_notifications) VALUES (?1, ?2, 1)',
		],
		[
			'the status is no longer visible to the recipient',
			"UPDATE statuses SET visibility = 'direct' WHERE account_id = ?2 AND ?1 IS NOT NULL",
		],
	])('sends nothing once %s', async (_case, change) => {
		const { h } = await pushing()
		await post(h, h.users.bob, { status: '@alice hi' })
		await sql(h.store, 'DELETE FROM status_mentions')
		expect(await rows(h.store)).toHaveLength(1)
		await sql(h.store, change, h.users.alice.id, h.users.bob.id)
		const { fetch, sent } = recordingFetch()
		expect(await round(h, fetch)).toMatchObject({ claimed: 0 })
		expect(sent).toEqual([])
		expect(await rows(h.store)).toEqual([])
	})

	it('sends nothing once the subscription stops wanting it, or its notification is older than the TTL', async () => {
		const { h } = await pushing()
		await post(h, h.users.bob, { status: '@alice one' })
		await h.request(
			'/api/v1/push/subscription',
			bearer(h.users.alice.token, json({ data: { alerts: { follow: true } } }, { method: 'PUT' }))
		)
		const { fetch, sent } = recordingFetch()
		await round(h, fetch)
		await h.request(
			'/api/v1/push/subscription',
			bearer(h.users.alice.token, json({ data: { alerts: { mention: true } } }, { method: 'PUT' }))
		)
		await post(h, h.users.bob, { status: '@alice two' })
		await round(h, fetch, { now: () => NOW + PUSH_TTL_MS })
		expect(sent).toEqual([])
		expect(await rows(h.store)).toEqual([])
	})

	it.each<[string, (h: Harness, status: { id: string }) => Promise<unknown>]>([
		[
			'the status is deleted',
			(h, status) => h.request(`/api/v1/statuses/${status.id}`, bearer(h.users.bob.token, { method: 'DELETE' })),
		],
		[
			'the recipient blocks the sender',
			(h) =>
				sql(
					h.store,
					'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)',
					h.users.alice.id,
					h.users.bob.id
				),
		],
		[
			'the status leaves the recipient’s audience',
			async (h, status) => {
				await sql(h.store, 'DELETE FROM status_mentions WHERE status_id = ?', status.id)
				await sql(h.store, "UPDATE statuses SET visibility = 'direct' WHERE id = ?", status.id)
			},
		],
		['the token is revoked', (h) => sql(h.store, 'DELETE FROM oauth_tokens WHERE account_id = ?', h.users.alice.id)],
		['the subscription is replaced', (h) => subscribe(h, h.users.alice, { endpoint: 'https://push.example/new' })],
		[
			'the subscription turns the alert off',
			(h) =>
				h.request(
					'/api/v1/push/subscription',
					bearer(h.users.alice.token, json({ data: { alerts: { follow: true } } }, { method: 'PUT' }))
				),
		],
		[
			'the policy no longer lets the sender through',
			(h) => sql(h.store, "UPDATE push_subscriptions SET policy = 'none'"),
		],
		['the notification is dismissed', (h) => sql(h.store, 'DELETE FROM notifications')],
		[
			'the recipient mutes the sender with notifications',
			(h) => act(h, h.users.alice, `/api/v1/accounts/${h.users.bob.id}/mute`, { notifications: true }),
		],
	])('PUSH-3: sends nothing when %s while the host check runs', async (_case, mutate) => {
		const { h } = await pushing()
		const status = await post(h, h.users.bob, { status: '@alice hi' })
		const { fetch, sent } = recordingFetch()
		const host = pausedHost()
		const running = round(h, fetch, { checkHost: host.check })
		await host.entered
		await mutate(h, status)
		host.release()
		expect(await running).toMatchObject({ claimed: 1, settled: ['dropped'] })
		expect(sent).toEqual([])
		expect(await rows(h.store)).toEqual([])
	})

	it('PUSH-3: applies the mention rule at sending: a mentioned account blocked meanwhile drops the push', async () => {
		const { h } = await pushing(['alice', 'bob', 'carol'])
		await post(h, h.users.bob, { status: '@alice @carol hi' })
		const { fetch, sent } = recordingFetch()
		const host = pausedHost()
		const running = round(h, fetch, { checkHost: host.check })
		await host.entered
		await act(h, h.users.alice, `/api/v1/accounts/${h.users.carol.id}/block`)
		host.release()
		expect(await running).toMatchObject({ claimed: 1, settled: ['dropped'] })
		expect(sent).toEqual([])
	})

	it.each([
		['has expired', NOW + 30_000, ['delivered'], 1],
		['still applies', NOW + 120_000, [], 0],
	])(
		'PUSH-3: judges a mute at the time of sending: one made after the notification that %s',
		async (_case, expires, settled, count) => {
			const { h } = await pushing()
			await post(h, h.users.bob, { status: '@alice hi' })
			await sql(
				h.store,
				'INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES (?, ?, 1, ?)',
				h.users.alice.id,
				h.users.bob.id,
				new Date(expires).toISOString()
			)
			const { fetch, sent } = recordingFetch()
			expect(await round(h, fetch, { now: () => NOW + 60_000 })).toMatchObject({ settled })
			expect(sent).toHaveLength(count)
			expect(await rows(h.store)).toEqual([])
		}
	)

	it('sends what holds when it is sent: an edit during the host check is in the payload', async () => {
		const { h, client } = await pushing()
		const status = await post(h, h.users.bob, { status: '@alice first' })
		const { fetch, sent } = recordingFetch()
		const host = pausedHost()
		const running = round(h, fetch, { checkHost: host.check })
		await host.entered
		await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(h.users.bob.token, json({ status: '@alice second' }, { method: 'PUT' }))
		)
		host.release()
		expect(await running).toMatchObject({ settled: ['delivered'] })
		expect(await readPush(client, sent[0]?.request as Request)).toMatchObject({ body: '@alice second' })
	})

	it('drops pending pushes with the token that subscribed', async () => {
		const h = await community(['alice', 'bob'], SCOPES, {}, { VAPID_JWK: VAPID.env })
		const { app, token } = await login(h, { email: 'alice@example.com', scope: SCOPES })
		await subscribe(h, { id: h.users.alice.id, token })
		await post(h, h.users.bob, { status: '@alice hi' })
		expect(await rows(h.store)).toHaveLength(1)
		await h.request('/oauth/revoke', form({ token, client_id: app.client_id, client_secret: app.client_secret }))
		expect(await rows(h.store)).toEqual([])
	})
})

describe('settling a push', () => {
	it('OPS-3: a lost completion leaves the push leased until the lease ends; a stale one changes nothing', async () => {
		const { h } = await pushing()
		await post(h, h.users.bob, { status: '@alice hi' })
		const build = env.CF_VERSION_METADATA.id
		const first = await h.store.claimPushes(build, { now: NOW, leaseToken: 'a' })
		expect(first.pushes).toHaveLength(1)
		const id = first.pushes[0]?.id ?? ''
		// Within the lease nothing is due; after it, the push is claimed again under a new lease.
		expect((await h.store.claimPushes(build, { now: NOW + 1000, leaseToken: 'b' })).pushes).toEqual([])
		expect(first.nextDueAt).toBe(NOW + LEASE_MS)
		const second = await h.store.claimPushes(build, { now: NOW + LEASE_MS, leaseToken: 'c' })
		expect(second.pushes.map((p) => p.id)).toEqual([id])
		const delivered = { kind: 'delivered', status: 201 } as const
		expect(
			await h.store.completePush(build, { id, leaseToken: 'a', now: NOW + LEASE_MS, outcome: delivered })
		).toMatchObject({ status: 'stale' })
		expect(await rows(h.store)).toEqual([
			{ attempts: 2, state: 'leased', next_attempt_at: NOW + 2 * LEASE_MS, last_status: null },
		])
		expect(
			await h.store.completePush(build, { id, leaseToken: 'c', now: NOW + LEASE_MS, outcome: delivered })
		).toMatchObject({ status: 'delivered' })
		expect(await rows(h.store)).toEqual([])
	})

	// Mastodon 4.5's Web::PushNotificationWorker: a 4xx other than 408 and 429 ends the subscription.
	it.each([400, 401, 403, 404, 410, 413])(
		'deletes the subscription and its pending pushes when the push service answers %i',
		async (status) => {
			const { h } = await pushing()
			await post(h, h.users.bob, { status: '@alice hi' })
			const { fetch, sent } = recordingFetch(() => new Response(null, { status }))
			expect((await round(h, fetch)).settled).toEqual(['unsubscribed'])
			expect(sent).toHaveLength(1)
			expect(await sql(h.store, 'SELECT id FROM push_subscriptions')).toEqual([])
			expect(await rows(h.store)).toEqual([])
			// Nothing more is recorded for it.
			await post(h, h.users.bob, { status: '@alice again' })
			expect(await rows(h.store)).toEqual([])
		}
	)

	it.each([408, 429, 500, 501, 503])(
		'keeps the subscription and retries when the push service answers %i',
		async (status) => {
			const { h } = await pushing()
			await post(h, h.users.bob, { status: '@alice hi' })
			const { fetch } = recordingFetch(() => new Response(null, { status }))
			expect(await round(h, fetch)).toMatchObject({ settled: ['retry'], nextDueAt: NOW + retryDelay(1) })
			expect(await rows(h.store)).toEqual([
				{ attempts: 1, state: 'pending', next_attempt_at: NOW + retryDelay(1), last_status: status },
			])
			expect(await sql(h.store, 'SELECT count(*) AS n FROM push_subscriptions')).toEqual([{ n: 1 }])
		}
	)

	it('retries a failure with the deliveries’ backoff and gives up after their limit', async () => {
		const { h } = await pushing()
		await post(h, h.users.bob, { status: '@alice hi' })
		const { fetch, sent } = recordingFetch(() => new Response(null, { status: 503 }))
		expect(await round(h, fetch)).toMatchObject({ settled: ['retry'], nextDueAt: NOW + retryDelay(1) })
		expect(await rows(h.store)).toEqual([
			{ attempts: 1, state: 'pending', next_attempt_at: NOW + retryDelay(1), last_status: 503 },
		])
		// Not due yet: nothing is sent.
		await round(h, fetch)
		expect(sent).toHaveLength(1)
		await sql(h.store, 'UPDATE push_deliveries SET attempts = ?', MAX_ATTEMPTS - 1)
		const later = NOW + 60 * 60 * 1000
		expect(await round(h, fetch, { now: () => later })).toMatchObject({ settled: ['gave_up'] })
		expect(sent).toHaveLength(2)
		expect(await rows(h.store)).toEqual([])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_subscriptions')).toEqual([{ n: 1 }])
	})

	it('never follows a redirect, and retries instead', async () => {
		const { h } = await pushing()
		await post(h, h.users.bob, { status: '@alice hi' })
		const { fetch, sent } = recordingFetch(
			() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } })
		)
		expect(await round(h, fetch)).toMatchObject({ settled: ['retry'] })
		expect(sent.map((s) => s.url)).toEqual([ENDPOINT])
		expect(sent[0]?.request.redirect).toBe('manual')
	})
})

describe('PUSH-2: the endpoint is an outbound sink at every send', () => {
	it('sends nothing to a host the DNS check refuses, and retries', async () => {
		const { h } = await pushing()
		await post(h, h.users.bob, { status: '@alice hi' })
		const { fetch, sent } = recordingFetch()
		const checkHost = vi.fn(() => Promise.reject(new Error('private address')))
		expect(await round(h, fetch, { checkHost })).toMatchObject({ settled: ['retry'] })
		expect(checkHost).toHaveBeenCalledWith(new URL(ENDPOINT))
		expect(sent).toEqual([])
	})

	it('deletes a subscription whose stored endpoint no longer passes the host rules, sending nothing', async () => {
		const { h } = await pushing()
		await post(h, h.users.bob, { status: '@alice hi' })
		await sql(h.store, "UPDATE push_subscriptions SET endpoint = 'https://10.0.0.1/send'")
		const { fetch, sent } = recordingFetch()
		expect(await round(h, fetch)).toMatchObject({ settled: ['unsubscribed'] })
		expect(sent).toEqual([])
		expect(await sql(h.store, 'SELECT id FROM push_subscriptions')).toEqual([])
	})
})

describe('the doorbell', () => {
	it('sends pushes from the delivery doorbell, and not without a VAPID_JWK or in maintenance', async () => {
		const { h, client } = await pushing()
		await post(h, h.users.bob, { status: '@alice hi' })
		const { fetch, sent } = recordingFetch()
		const deps = roundDeps(h.store, fetch)
		const batch = () =>
			({
				queue: 'kopje',
				messages: [
					{ id: 'd', body: { kind: 'deliver' }, timestamp: new Date(NOW), attempts: 1, ack: vi.fn(), retry: vi.fn() },
				],
				ackAll: vi.fn(),
				retryAll: vi.fn(),
			}) as unknown as MessageBatch
		const queueDeps = { build: deps.build, store: deps.store, delivery: deps }
		const { VAPID_JWK: _, ...withoutKey } = h.env as Record<string, unknown>
		await handleQueue(batch(), withoutKey as unknown as Env, queueDeps)
		await handleQueue(batch(), { ...h.env, MAINTENANCE: 'readonly' } as unknown as Env, queueDeps)
		expect(sent).toEqual([])
		await handleQueue(batch(), h.env, queueDeps)
		expect(sent).toHaveLength(1)
		expect(await readPush(client, sent[0]?.request as Request)).toMatchObject({ notification_type: 'mention' })
	})

	it('rings for a push an inbound activity recorded, and sends it', async () => {
		const t = await setup()
		const client = await newClient()
		const token = t.tokens.alice
		const tokenHash = await sha256Hex(token)
		await sql(
			t.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, token_sealed)
			VALUES (?, ?, ?, ?, '{"favourite":true}', ?)`,
			tokenHash,
			ENDPOINT,
			client.p256dh,
			client.auth,
			await sealPushToken(VAPID.jwk, tokenHash, token)
		)
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'like me', visibility: 'public' })
		t.queue.pending.splice(0)
		expect(await t.post(bob, like(bob, local.uri))).toBe(202)
		expect(t.queue.pending.map((m) => m.body)).toEqual([{ kind: 'deliver' }])
		const { fetch, sent } = recordingFetch()
		const deps = inboxDeps(() => t.store)
		await t.queue.deliver((batch) =>
			handleQueue(batch, { ...t.env, VAPID_JWK: VAPID.env } as unknown as Env, {
				...deps,
				delivery: { ...deps.delivery, fetch },
			})
		)
		expect(await readPush(client, sent[0]?.request as Request)).toMatchObject({
			access_token: token,
			notification_type: 'favourite',
			// The display name as the actor gives it, as Mastodon composes the title.
			title: 'bob <b>display</b> favorited your post',
			body: 'like me',
		})
	})

	it('RES-4: a notification fanned out to several subscriptions fills the backlog only up to its cap', async () => {
		const { h } = await pushing()
		const { token } = await login(h, { email: 'alice@example.com', scope: SCOPES })
		await subscribe(h, { id: h.users.alice.id, token }, { endpoint: 'https://push.example/second' })
		const { token: third } = await login(h, { email: 'alice@example.com', scope: SCOPES })
		await subscribe(h, { id: h.users.alice.id, token: third }, { endpoint: 'https://push.example/third' })
		// One below the cap.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'filler-' || i, ?2 FROM n`,
			h.users.alice.id,
			h.users.bob.id,
			MAX_PUSH_BACKLOG - 1
		)
		await sql(
			h.store,
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT (SELECT min(id) FROM push_subscriptions), id, ?1, ?1 FROM notifications WHERE type GLOB 'filler-*'`,
			NOW + 1_000_000
		)
		await post(h, h.users.bob, { status: '@alice fan out' })
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: MAX_PUSH_BACKLOG }])
	})

	it('records no push beyond the backlog cap, but still the notification (RES-4)', async () => {
		const { h } = await pushing()
		// MAX_PUSH_BACKLOG pushes waiting, each for a notification of its own.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO notifications (account_id, type, from_account_id) SELECT ?1, 'filler-' || i, ?2 FROM n`,
			h.users.alice.id,
			h.users.bob.id,
			MAX_PUSH_BACKLOG
		)
		await sql(
			h.store,
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT (SELECT id FROM push_subscriptions), id, ?1, ?1 FROM notifications WHERE type GLOB 'filler-*'`,
			NOW + 1_000_000
		)
		await post(h, h.users.bob, { status: '@alice one more' })
		expect(await sql(h.store, "SELECT count(*) AS n FROM notifications WHERE type = 'mention'")).toEqual([{ n: 1 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: MAX_PUSH_BACKLOG }])
	})
})
