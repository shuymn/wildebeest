import { describe, expect, it } from 'vitest'

import { type ApiHarness, apiHarness, bearer, form, json, login, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { newClient, VAPID } from './push-helpers'
import { community, type User } from './status-helpers'

// /api/v1/push/subscription (Mastodon 4.5): the subscription of the request's own token (PUSH-1), the push scope,
// NET-3 at registration (PUSH-2), and the client keys. Sending is in test/push-send.test.ts.

const PATH = '/api/v1/push/subscription'
const ENDPOINT = 'https://push.example/send/abc'
const SCOPES = 'read write follow push'

async function harness(names: readonly ('alice' | 'bob')[] = ['alice', 'bob'], scope = SCOPES, env = {}) {
	return community(names, scope, {}, { VAPID_JWK: VAPID.env, ...env })
}

async function subscription(overrides: { endpoint?: string; p256dh?: string; auth?: string } = {}) {
	const client = await newClient()
	return {
		endpoint: overrides.endpoint ?? ENDPOINT,
		keys: { p256dh: overrides.p256dh ?? client.p256dh, auth: overrides.auth ?? client.auth },
	}
}

async function call(h: ApiHarness, user: User | string, method: string, body?: Record<string, unknown>) {
	const token = typeof user === 'string' ? user : user.token
	const init = body === undefined ? { method } : json(body, { method })
	const response = await h.request(PATH, bearer(token, init))
	return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('push subscription endpoints', () => {
	it('creates, reads, updates and deletes the token’s subscription in Mastodon’s shape', async () => {
		const h = await harness()
		const { alice } = h.users
		const created = await call(h, alice, 'POST', {
			subscription: { ...(await subscription()), standard: true },
			data: { alerts: { mention: true, favourite: 'false', 'admin.sign_up': true, bogus: true }, policy: 'followed' },
		})
		expect(created).toEqual({
			status: 200,
			body: {
				// A JSON number, as Mastodon's REST::WebPushSubscriptionSerializer emits it.
				id: expect.any(Number),
				endpoint: ENDPOINT,
				standard: true,
				alerts: { mention: true, favourite: false, 'admin.sign_up': true },
				server_key: VAPID.publicKey,
				policy: 'followed',
			},
		})
		expect(await call(h, alice, 'GET')).toEqual(created)

		// PUT replaces the data as a whole, as Mastodon's update does.
		const updated = await call(h, alice, 'PUT', { data: { alerts: { reblog: true } } })
		expect(updated.body).toMatchObject({ id: created.body.id, alerts: { reblog: true }, policy: 'all' })
		expect((await call(h, alice, 'GET')).body).toEqual(updated.body)
		// PATCH is the same update (Api::V1::Push::SubscriptionsController#update serves both).
		const patched = await call(h, alice, 'PATCH', { data: { alerts: { follow: true }, policy: 'follower' } })
		expect(patched.body).toMatchObject({ id: created.body.id, alerts: { follow: true }, policy: 'follower' })
		expect((await call(h, alice, 'GET')).body).toEqual(patched.body)

		expect(await call(h, alice, 'DELETE')).toEqual({ status: 200, body: {} })
		expect(await call(h, alice, 'GET')).toEqual({ status: 404, body: { error: 'Record not found' } })
		expect(await call(h, alice, 'PUT', { data: { policy: 'all' } })).toEqual({
			status: 404,
			body: { error: 'Record not found' },
		})
		// Deleting nothing still answers {}.
		expect(await call(h, alice, 'DELETE')).toEqual({ status: 200, body: {} })
	})

	it('reads form parameters, defaults to the aesgcm encoding, and replaces the subscription on a second POST', async () => {
		const h = await harness()
		const { alice } = h.users
		const client = await newClient()
		const response = await h.request(
			PATH,
			bearer(
				alice.token,
				form({
					'subscription[endpoint]': ENDPOINT,
					// Standard base64 with padding, as some clients send it.
					'subscription[keys][p256dh]': `${btoa(String.fromCharCode(...client.keys.p256dh))}`,
					'subscription[keys][auth]': `${btoa(String.fromCharCode(...client.keys.auth))}`,
					'data[alerts][follow]': '1',
				})
			)
		)
		const first = (await response.json()) as Record<string, unknown>
		expect(first).toMatchObject({ standard: false, alerts: { follow: true }, policy: 'all' })
		expect(
			await sql(h.store, 'SELECT key_p256dh, key_auth FROM push_subscriptions WHERE id = ?', Number(first.id))
		).toEqual([{ key_p256dh: client.p256dh, key_auth: client.auth }])

		const second = await call(h, alice, 'POST', { subscription: await subscription({ endpoint: `${ENDPOINT}2` }) })
		expect(second.body).toMatchObject({ endpoint: `${ENDPOINT}2`, alerts: {} })
		expect(await sql(h.store, 'SELECT endpoint FROM push_subscriptions')).toEqual([{ endpoint: `${ENDPOINT}2` }])
	})

	it('PUSH-1: another token, of another user or the same one, cannot read, change or delete a subscription', async () => {
		const h = await harness()
		const { alice, bob } = h.users
		await call(h, alice, 'POST', { subscription: await subscription(), data: { alerts: { mention: true } } })
		const { token: aliceAgain } = await login(h, { email: 'alice@example.com', scope: SCOPES })
		for (const other of [bob.token, aliceAgain]) {
			expect((await call(h, other, 'GET')).status).toBe(404)
			expect((await call(h, other, 'PUT', { data: { policy: 'none' } })).status).toBe(404)
			expect((await call(h, other, 'DELETE')).status).toBe(200)
		}
		expect((await call(h, alice, 'GET')).body).toMatchObject({ alerts: { mention: true }, policy: 'all' })
		// The id in a request selects nothing: only the token does.
		const own = await call(h, bob, 'POST', { subscription: await subscription(), id: '1' })
		expect(own.body.id).not.toBe((await call(h, alice, 'GET')).body.id)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM push_subscriptions')).toEqual([{ n: 2 }])
	})

	it('requires the push scope and a user', async () => {
		const h = await harness(['alice'], 'read write follow')
		const { alice } = h.users
		const forbidden = { status: 403, body: { error: 'This action is outside the authorized scopes' } }
		expect(await call(h, alice, 'GET')).toEqual(forbidden)
		expect(await call(h, alice, 'POST', { subscription: await subscription() })).toEqual(forbidden)
		expect(await call(h, alice, 'PUT', { data: {} })).toEqual(forbidden)
		expect(await call(h, alice, 'PATCH', { data: {} })).toEqual(forbidden)
		expect(await call(h, alice, 'DELETE')).toEqual(forbidden)
		const anonymous = await h.request(PATH)
		expect(anonymous.status).toBe(401)
		// A bad token is answered as unauthenticated before its parameters are looked at.
		expect(await call(h, 'nope', 'POST', {})).toEqual({ status: 401, body: { error: 'The access token is invalid' } })
	})

	it('NET-3: refuses endpoints that are not public https URLs, and invalid client keys', async () => {
		const h = await harness(['alice'])
		const { alice } = h.users
		const endpointInvalid = { status: 422, body: { error: 'Validation failed: Endpoint is invalid' } }
		for (const endpoint of [
			'http://push.example/send',
			'https://127.0.0.1/send',
			'https://[::1]/send',
			'https://localhost/send',
			'https://push.localhost/send',
			'https://intranet/send',
			'https://user:secret@push.example/send',
			'not a url',
			`https://push.example/${'a'.repeat(2048)}`,
		]) {
			expect(await call(h, alice, 'POST', { subscription: await subscription({ endpoint }) })).toEqual(endpointInvalid)
		}
		const offCurve = btoa(String.fromCharCode(4, ...new Uint8Array(64))).replace(/=+$/, '')
		const compressed = (await subscription()).keys.p256dh.slice(0, 44)
		for (const p256dh of [offCurve, compressed, '!!!']) {
			expect(await call(h, alice, 'POST', { subscription: await subscription({ p256dh }) })).toEqual({
				status: 422,
				body: { error: 'Validation failed: Key p256dh is invalid' },
			})
		}
		for (const auth of ['AAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAA', '***']) {
			expect(await call(h, alice, 'POST', { subscription: await subscription({ auth }) })).toEqual({
				status: 422,
				body: { error: 'Validation failed: Key auth is invalid' },
			})
		}
		expect(await call(h, alice, 'POST', { subscription: await subscription(), data: { policy: 'friends' } })).toEqual({
			status: 422,
			body: { error: 'Validation failed: Policy is not included in the list' },
		})
		const missing = { status: 400, body: { error: 'param is missing or the value is empty or invalid: subscription' } }
		expect(await call(h, alice, 'POST', {})).toEqual(missing)
		expect(await call(h, alice, 'POST', { subscription: { endpoint: ENDPOINT } })).toEqual(missing)
		expect(await sql(h.store, 'SELECT id FROM push_subscriptions')).toEqual([])
	})

	it('DATA-2: without a VAPID_JWK, push is unavailable and no key is made', async () => {
		const h = await community(['alice'], SCOPES)
		const { alice } = h.users
		const notFound = { status: 404, body: { error: 'Record not found' } }
		expect(await call(h, alice, 'POST', { subscription: await subscription() })).toEqual(notFound)
		expect(await call(h, alice, 'GET')).toEqual(notFound)
		expect(await call(h, alice, 'PUT', { data: {} })).toEqual(notFound)
		expect(await call(h, alice, 'DELETE')).toEqual({ status: 200, body: {} })
		expect(await call(h, 'nope', 'POST', {})).toEqual({ status: 401, body: { error: 'The access token is invalid' } })
		expect((await h.request('/api/v2/instance').then((r) => r.json())) as unknown).toMatchObject({
			configuration: { vapid: { public_key: '' } },
		})
		expect(await sql(h.store, 'SELECT id FROM push_subscriptions')).toEqual([])
	})

	it('refuses a VAPID_JWK without its private key as misconfiguration (DATA-2)', async () => {
		const { d: _, ...publicOnly } = VAPID.jwk
		const h = await apiHarness({ VAPID_JWK: JSON.stringify(publicOnly) })
		const response = await h.request(PATH, { headers: { authorization: 'Bearer x' } })
		expect({ status: response.status, body: await response.json() }).toEqual({
			status: 503,
			body: { error: 'This server is misconfigured' },
		})
	})

	it('PUSH-3: revoking the token or suspending the account deletes its subscriptions', async () => {
		const h = await harness(['alice'])
		const { app, token } = await login(h, { email: 'alice@example.com', scope: SCOPES })
		await call(h, token, 'POST', { subscription: await subscription() })
		await call(h, h.users.alice, 'POST', { subscription: await subscription() })
		const count = async () => (await sql<{ n: number }>(h.store, 'SELECT count(*) AS n FROM push_subscriptions'))[0]?.n
		expect(await count()).toBe(2)
		const revoked = await h.request(
			'/oauth/revoke',
			form({ token, client_id: app.client_id, client_secret: app.client_secret })
		)
		expect(revoked.status).toBe(200)
		expect(await count()).toBe(1)
		await h.store.suspendAccount(h.env.CF_VERSION_METADATA.id, { accountId: h.users.alice.id, now: NOW })
		// The tokens job deletes the subscription with its token (domain/suspension.ts).
		await h.store.runInboundJobs(h.env.CF_VERSION_METADATA.id, { now: NOW })
		expect(await count()).toBe(0)
	})

	it('serves registration in readonly maintenance, as sign-ins, and refuses deletion there', async () => {
		const h = await harness(['alice'], SCOPES, { MAINTENANCE: 'readonly' })
		const { alice } = h.users
		expect((await call(h, alice, 'POST', { subscription: await subscription() })).status).toBe(200)
		expect((await call(h, alice, 'PUT', { data: { policy: 'none' } })).status).toBe(200)
		expect((await call(h, alice, 'GET')).body).toMatchObject({ policy: 'none' })
		expect((await call(h, alice, 'DELETE')).status).toBe(503)
	})
})
