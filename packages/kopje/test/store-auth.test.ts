import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, json, login, registerApp, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import * as accounts from '../src/mastodon/accounts'
import type { ApiHandler } from '../src/mastodon/context'
import { mastodonApi, ROUTES } from '../src/mastodon/routes'
import { imagesCodec } from '../src/platform/images'

// The token is checked in the transaction of the operation it authorizes: a token revoked, or an account suspended,
// after the request was admitted but before its write, must not write.
describe('authorization inside the Store operation', () => {
	const interferences = {
		revoked: (store: Parameters<typeof sql>[0]) => sql(store, "DELETE FROM oauth_tokens WHERE kind = 'access'"),
		suspended: (store: Parameters<typeof sql>[0]) =>
			sql(store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString()),
	}

	for (const [name, interfere] of Object.entries(interferences)) {
		it(`refuses a follow and a profile update when the token is ${name} before the write`, async () => {
			const h = await apiHarness()
			await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
			const bob = await seedAccount(h.store, { username: 'bob' })
			const { token } = await login(h)

			// The real route table, with the interference between request admission and the handler's Store call.
			const late =
				(handler: ApiHandler): ApiHandler =>
				async (c, deps) => {
					await interfere(h.store)
					return handler(c, deps)
				}
			const routes = ROUTES.map((route) =>
				route.handler === accounts.follow || route.handler === accounts.updateCredentials
					? { ...route, handler: late(route.handler) }
					: route
			)
			let counter = 0
			const api = mastodonApi(
				{
					build: () => env.CF_VERSION_METADATA.id,
					now: () => NOW,
					store: () => h.store,
					randomToken: () => `late-${++counter}`,
					images: (e) => imagesCodec(e.IMAGES),
				},
				routes
			)
			const call = (path: string, init: RequestInit) =>
				api.fetch(new Request(`https://kopje.test${path}`, init), h.env, createExecutionContext())

			const followed = await call(`/api/v1/accounts/${bob}/follow`, bearer(token, { method: 'POST' }))
			expect(followed.status).toBeGreaterThanOrEqual(401)
			expect(followed.status).toBeLessThanOrEqual(403)
			expect(await sql(h.store, 'SELECT 1 FROM follows')).toEqual([])

			const updated = await call(
				'/api/v1/accounts/update_credentials',
				bearer(token, json({ display_name: 'Mallory' }, { method: 'PATCH' }))
			)
			expect(updated.status).toBeGreaterThanOrEqual(401)
			expect(updated.status).toBeLessThanOrEqual(403)
			expect(await sql(h.store, "SELECT display_name FROM accounts WHERE username = 'alice'")).toEqual([
				{ display_name: 'Alice' },
			])
		})
	}
})

// The same for every B4a write: nothing is written when the token dies between admission and the Store call. Each
// operation gets a fresh fixture in which it would write (the edges an undo removes exist, the notification a dismiss
// removes exists), and every table it could touch is compared, counters included.
describe('authorization inside the B4a operations', () => {
	const interferences = {
		revoked: (store: Parameters<typeof sql>[0]) => sql(store, "DELETE FROM oauth_tokens WHERE kind = 'access'"),
		suspended: (store: Parameters<typeof sql>[0]) =>
			sql(store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString()),
	}
	type Fixture = { own: string; theirs: string; notification: string }
	const operations: [string, (f: Fixture) => [string, RequestInit]][] = [
		['post', () => ['/api/v1/statuses', json({ status: 'new @bob #tag' })]],
		['edit', (f) => [`/api/v1/statuses/${f.own}`, json({ status: 'edited #other' }, { method: 'PUT' })]],
		['delete', (f) => [`/api/v1/statuses/${f.own}?delete_media=true`, { method: 'DELETE' }]],
		...(['favourite', 'reblog', 'bookmark', 'unfavourite', 'unreblog', 'unbookmark'] as const).map(
			(action): [string, (f: Fixture) => [string, RequestInit]] => [
				action,
				(f) => [`/api/v1/statuses/${f.theirs}/${action}`, { method: 'POST' }],
			]
		),
		['dismiss', (f) => [`/api/v1/notifications/${f.notification}/dismiss`, { method: 'POST' }]],
		['clear', () => ['/api/v1/notifications/clear', { method: 'POST' }]],
	]

	// alice (signed in) has a status with media, a tag and a mention; bob has a status alice already favourited,
	// boosted and bookmarked; alice has a notification; a remote account follows alice.
	async function fixture() {
		const h = await apiHarness()
		const alice = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const bob = await seedAccount(h.store, { username: 'bob', email: 'bob@example.com' })
		const remote = await seedAccount(h.store, { username: 'fan', domain: 'fans.example' })
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			remote,
			alice
		)
		const app = await registerApp(h)
		const { token } = await login(h, { app })
		const { token: bobToken } = await login(h, { app, email: 'bob@example.com' })
		await sql(
			h.store,
			"INSERT INTO media_attachments (id, account_id, type, url) VALUES ('100000000000000009', ?, 'image', 'u')",
			alice
		)
		const write = async (t: string, path: string, body: Record<string, unknown> = {}) =>
			(await h.request(path, bearer(t, json(body)))).json<{ id: string }>()
		const own = (
			await write(token, '/api/v1/statuses', { status: 'mine @bob #tag', media_ids: ['100000000000000009'] })
		).id
		const theirs = (await write(bobToken, '/api/v1/statuses', { status: 'theirs @alice' })).id
		for (const action of ['favourite', 'reblog', 'bookmark']) {
			await write(token, `/api/v1/statuses/${theirs}/${action}`)
		}
		const [notification] = await sql<{ id: string }>(
			h.store,
			'SELECT CAST(id AS TEXT) AS id FROM notifications WHERE account_id = ?',
			alice
		)
		if (notification === undefined) {
			throw new Error('fixture has no notification')
		}
		return { h, token, fixture: { own, theirs, notification: notification.id } }
	}

	async function snapshot(store: Parameters<typeof sql>[0]) {
		const tables = [
			'statuses',
			'status_edits',
			'status_mentions',
			'status_tags',
			'media_attachments',
			'favourites',
			'bookmarks',
			'notifications',
			'outbound_activities',
		]
		const rows: Record<string, unknown> = {}
		for (const table of tables) {
			rows[table] = await sql(store, `SELECT * FROM ${table} ORDER BY 1, 2`)
		}
		rows.counters = await sql(
			store,
			'SELECT id, statuses_count, followers_count, following_count FROM accounts ORDER BY id'
		)
		return rows
	}

	for (const [name, interfere] of Object.entries(interferences)) {
		for (const [operation, request] of operations) {
			it(`writes nothing for ${operation} when the token is ${name} before the write`, async () => {
				const { h, token, fixture: f } = await fixture()
				const before = await snapshot(h.store)
				const late =
					(handler: ApiHandler): ApiHandler =>
					async (c, deps) => {
						await interfere(h.store)
						return handler(c, deps)
					}
				const api = mastodonApi(
					{
						build: () => env.CF_VERSION_METADATA.id,
						now: () => NOW,
						store: () => h.store,
						randomToken: () => 'late',
						images: (e) => imagesCodec(e.IMAGES),
					},
					ROUTES.map((route) => (route.method === 'GET' ? route : { ...route, handler: late(route.handler) }))
				)
				const [path, init] = request(f)
				const response = await api.fetch(
					new Request(`https://kopje.test${path}`, bearer(token, init)),
					h.env,
					createExecutionContext()
				)
				expect(response.status).toBeGreaterThanOrEqual(401)
				expect(response.status).toBeLessThanOrEqual(403)
				// Revocation deleted the token rows, suspension set suspended_at; nothing else may differ.
				expect(await snapshot(h.store)).toEqual(before)
			})
		}
	}
})

describe('token expiry', () => {
	it('judges expiry when the Store is called, after a slow body has been read', async () => {
		const h = await apiHarness()
		const alice = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
		const bob = await seedAccount(h.store, { username: 'bob' })
		const { token } = await login(h)
		const status = await (
			await h.request('/api/v1/statuses', bearer(token, json({ status: 'v1' })))
		).json<{ id: string }>()
		await sql(
			h.store,
			"UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'",
			new Date(NOW + 1000).toISOString()
		)
		const before = await sql(h.store, 'SELECT id, content, edited_at FROM statuses ORDER BY id')
		// The body arrives after the token has expired.
		const slow = (body: unknown, method: string): RequestInit => {
			const bytes = new TextEncoder().encode(JSON.stringify(body))
			const stream = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						h.now.mockReturnValue(NOW + 5000)
						controller.enqueue(bytes)
						controller.close()
					},
				},
				// Nothing is pulled until the handler reads the body.
				{ highWaterMark: 0 }
			)
			return bearer(token, { method, headers: { 'content-type': 'application/json' }, body: stream })
		}
		const writes: [string, () => RequestInit][] = [
			['/api/v1/statuses', () => slow({ status: 'late' }, 'POST')],
			[`/api/v1/statuses/${status.id}`, () => slow({ status: 'late edit' }, 'PUT')],
			[`/api/v1/accounts/${bob}/follow`, () => slow({}, 'POST')],
			['/api/v1/accounts/update_credentials', () => slow({ display_name: 'Mallory' }, 'PATCH')],
		]
		for (const [path, init] of writes) {
			h.now.mockReturnValue(NOW)
			expect({ path, status: (await h.request(path, init())).status }).toEqual({ path, status: 401 })
		}
		expect(await sql(h.store, 'SELECT id, content, edited_at FROM statuses ORDER BY id')).toEqual(before)
		expect(await sql(h.store, 'SELECT 1 FROM follows')).toEqual([])
		expect(await sql(h.store, 'SELECT display_name FROM accounts WHERE id = ?', alice)).toEqual([
			{ display_name: 'Alice' },
		])
	})
})

describe('error order', () => {
	it('answers a bad token before a parameter error, as Mastodon authenticates first', async () => {
		const h = await apiHarness()
		const response = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer('nope', json({ display_name: 'x'.repeat(31) }, { method: 'PATCH' }))
		)
		expect(response.status).toBe(401)
		expect((await h.request('/api/v1/accounts/search', bearer('nope'))).status).toBe(401)
	})
})
