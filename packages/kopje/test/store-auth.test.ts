import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, json, login, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import * as accounts from '../src/mastodon/accounts'
import type { ApiHandler } from '../src/mastodon/context'
import { mastodonApi, ROUTES } from '../src/mastodon/routes'

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

// The same for every B4a write: nothing is written when the token dies between admission and the Store call.
describe('authorization inside the B4a operations', () => {
	const interferences = {
		revoked: (store: Parameters<typeof sql>[0]) => sql(store, "DELETE FROM oauth_tokens WHERE kind = 'access'"),
		suspended: (store: Parameters<typeof sql>[0]) =>
			sql(store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString()),
	}

	for (const [name, interfere] of Object.entries(interferences)) {
		it(`writes nothing when the token is ${name} before the write`, async () => {
			const h = await apiHarness()
			const alice = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
			const bob = await seedAccount(h.store, { username: 'bob' })
			const remote = await seedAccount(h.store, { username: 'fan', domain: 'fans.example' })
			await sql(
				h.store,
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				remote,
				alice
			)
			const { token } = await login(h)
			const own = (
				await (await h.request('/api/v1/statuses', bearer(token, json({ status: 'mine @bob' })))).json<{ id: string }>()
			).id
			await sql(
				h.store,
				"INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES ('100000000000000001', 'https://kopje.test/ap/o/b', ?, 'public', '<p>b</p>', '2026-01-01T00:00:00.000Z')",
				bob
			)
			const before = await snapshot(h.store)

			let interfering = true
			const late =
				(handler: ApiHandler): ApiHandler =>
				async (c, deps) => {
					if (interfering) {
						await interfere(h.store)
					}
					return handler(c, deps)
				}
			const api = mastodonApi(
				{ build: () => env.CF_VERSION_METADATA.id, now: () => NOW, store: () => h.store, randomToken: () => 'late' },
				ROUTES.map((route) => (route.method === 'GET' ? route : { ...route, handler: late(route.handler) }))
			)
			const call = (path: string, init: RequestInit) =>
				api.fetch(new Request(`https://kopje.test${path}`, init), h.env, createExecutionContext())
			const writes: [string, RequestInit][] = [
				['/api/v1/statuses', json({ status: 'new @bob' })],
				[`/api/v1/statuses/${own}`, json({ status: 'edited' }, { method: 'PUT' })],
				[`/api/v1/statuses/${own}`, { method: 'DELETE' }],
				...['favourite', 'reblog', 'bookmark'].map((action): [string, RequestInit] => [
					`/api/v1/statuses/100000000000000001/${action}`,
					{ method: 'POST' },
				]),
				['/api/v1/notifications/clear', { method: 'POST' }],
			]
			for (const [path, init] of writes) {
				const response = await call(path, bearer(token, init))
				expect({ path, status: response.status >= 401 && response.status <= 403 }).toEqual({ path, status: true })
			}
			interfering = false
			expect(await snapshot(h.store)).toEqual(before)
		})
	}

	async function snapshot(store: Parameters<typeof sql>[0]) {
		const tables = [
			'statuses',
			'status_edits',
			'status_mentions',
			'favourites',
			'bookmarks',
			'notifications',
			'outbound_activities',
		]
		const counts: Record<string, unknown> = {}
		for (const table of tables) {
			counts[table] = await sql(store, `SELECT * FROM ${table} ORDER BY 1`)
		}
		return counts
	}
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
