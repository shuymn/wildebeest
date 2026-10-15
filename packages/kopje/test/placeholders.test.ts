import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, seedAccount, sql } from './api-helpers'
import { appToken, scopedToken } from './read-helpers'
import { community, getJson } from './status-helpers'

// Features Kopje has no data for yet answer empty, under the access Mastodon gives each route (AUTH-2).

describe('features without data yet', () => {
	const userLists: [string, string][] = [
		['/api/v1/filters', 'read:filters'],
		['/api/v2/filters', 'read:filters'],
		['/api/v1/followed_tags', 'read:follows'],
		['/api/v1/featured_tags', 'read:accounts'],
		['/api/v1/suggestions', 'read:accounts'],
		['/api/v2/suggestions', 'read:accounts'],
	]

	it.each(userLists)('%s is an empty list of the user, under %s (AUTH-2)', async (route, scope) => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const response = await h.request(route, bearer(await scopedToken(h, scope)))
		expect(response.status).toBe(200)
		expect(response.headers.get('link')).toBeNull()
		expect(await response.json()).toEqual([])
		expect((await h.request(route)).status).toBe(401)
		expect((await h.request(route, bearer('nope'))).status).toBe(401)
		expect((await h.request(route, bearer(await scopedToken(h, 'write')))).status).toBe(403)
		expect((await h.request(route, bearer(await appToken(h)))).status).toBe(422)
	})

	it('/api/v1/announcements is an empty list for any user token, whatever its scopes (AUTH-2)', async () => {
		const h = await apiHarness()
		const alice = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		for (const scope of ['read:accounts read:statuses', 'write', 'push']) {
			expect(await getJson(h, '/api/v1/announcements', await scopedToken(h, scope))).toEqual({ status: 200, body: [] })
		}
		expect((await h.request('/api/v1/announcements')).status).toBe(401)
		expect((await h.request('/api/v1/announcements', bearer('nope'))).status).toBe(401)
		expect((await h.request('/api/v1/announcements', bearer(await appToken(h)))).status).toBe(422)
		const token = await scopedToken(h, 'read')
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', alice)
		expect((await h.request('/api/v1/announcements', bearer(token))).status).toBe(403)
	})

	it('a revoked token gets no empty list', async () => {
		const h = await community(['alice'])
		await sql(h.store, "DELETE FROM oauth_tokens WHERE kind = 'access'")
		expect((await h.request('/api/v2/filters', bearer(h.users.alice.token))).status).toBe(401)
	})

	it.each(['/api/v1/trends', '/api/v1/trends/tags', '/api/v1/trends/statuses', '/api/v1/trends/links'])(
		'%s is a public empty list',
		async (route) => {
			const h = await apiHarness()
			expect(await getJson(h, route)).toEqual({ status: 200, body: [] })
			expect(await getJson(h, route, 'stale')).toEqual({ status: 200, body: [] })
		}
	)

	it('shows no featured tags of an account that exists, and 404 for one that does not', async () => {
		const h = await apiHarness()
		const alice = await seedAccount(h.store, { username: 'alice' })
		expect(await getJson(h, `/api/v1/accounts/${alice}/featured_tags`)).toEqual({ status: 200, body: [] })
		expect(await getJson(h, '/api/v1/accounts/999999999999999999/featured_tags')).toEqual({
			status: 404,
			body: { error: 'Record not found' },
		})
	})
})
