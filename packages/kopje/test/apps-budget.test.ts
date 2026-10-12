import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import { apiHarness, bearer, json, login, registerApp, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { signIn } from './web-helpers'
import { EVICTION_GRACE_MS, MAX_PENDING_APPS, UNUSED_APP_TTL_MS } from '../src/domain/oauth'
import { handleScheduled } from '../src/jobs/scheduled'
import type { StoreStub } from '../src/platform/store-client'

// RES-6 for POST /api/v1/apps: a per-IP rate limit (the Rate Limiting binding) and a storage budget of
// never-authorized apps, with expiry of unused ones (Mastodon's ApplicationsVacuum) and a visible refusal.

const APP = { client_name: 'Flood', redirect_uris: 'https://flood.example/cb', scopes: 'read' }

function limiter(allowed: (key: string) => boolean) {
	return { limit: vi.fn(({ key }: { key: string }) => Promise.resolve({ success: allowed(key) })) }
}

// Fills the budget with apps created at `at`, without the API.
async function fill(store: StoreStub, count: number, at: number, prefix = 'filler'): Promise<void> {
	await runInDurableObject(store, (_instance, state) => {
		for (let i = 0; i < count; i++) {
			state.storage.sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes, created_at) VALUES (?, 's', 'f', 'https://f.example/cb', 'read', ?)",
				`${prefix}-${i}`,
				new Date(at + i).toISOString()
			)
		}
	})
}

async function count(store: StoreStub, where = '1'): Promise<number> {
	const [row] = await sql<{ n: number }>(store, `SELECT COUNT(*) AS n FROM oauth_clients WHERE ${where}`)
	return row?.n ?? 0
}

describe('app registration budget (RES-6)', () => {
	it('limits registrations per client IP before reading the body', async () => {
		const blocked = limiter((key) => key !== '203.0.113.9')
		const h = await apiHarness({ APP_REGISTRATION_LIMIT: blocked })
		const refused = await h.request('/api/v1/apps', json(APP, { headers: { 'cf-connecting-ip': '203.0.113.9' } }))
		expect(refused.status).toBe(429)
		expect(await refused.json()).toEqual({ error: 'Too many requests' })
		expect(blocked.limit).toHaveBeenCalledWith({ key: '203.0.113.9' })
		const other = await h.request('/api/v1/apps', json(APP, { headers: { 'cf-connecting-ip': '198.51.100.7' } }))
		expect(other.status).toBe(200)
		expect(await count(h.store)).toBe(1)
	})

	it('refuses a registration when the budget is full of recent never-authorized apps', async () => {
		const h = await apiHarness()
		await fill(h.store, MAX_PENDING_APPS, NOW - EVICTION_GRACE_MS + 1000)
		const response = await h.request('/api/v1/apps', json(APP))
		expect(response.status).toBe(429)
		expect(await count(h.store)).toBe(MAX_PENDING_APPS)
	})

	it('removes unused apps older than a day first, then evicts the oldest never-authorized one', async () => {
		const h = await apiHarness()
		await fill(h.store, 10, NOW - UNUSED_APP_TTL_MS - 1000, 'old')
		await fill(h.store, MAX_PENDING_APPS - 10, NOW - EVICTION_GRACE_MS + 1000)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect(await count(h.store, "id LIKE 'old-%'")).toBe(0)

		// Now full of recent ones and one older than the grace period: an unused one goes.
		const h2 = await apiHarness()
		await fill(h2.store, 1, NOW - EVICTION_GRACE_MS - 1000, 'aged')
		await fill(h2.store, MAX_PENDING_APPS - 1, NOW - EVICTION_GRACE_MS + 1000)
		expect((await h2.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect(await count(h2.store, "id = 'aged-0'")).toBe(0)
		expect(await count(h2.store)).toBe(MAX_PENDING_APPS)
	})

	it('evicts an app whose only token is an app token, which stops working (accepted risk)', async () => {
		const h = await apiHarness()
		const holder = await registerApp(h, { scopes: 'read' })
		const token = await h.request(
			'/oauth/token',
			json({
				grant_type: 'client_credentials',
				client_id: holder.client_id,
				client_secret: holder.client_secret,
				scope: 'read',
			})
		)
		const { access_token } = await token.json<{ access_token: string }>()
		expect((await h.request('/api/v1/apps/verify_credentials', bearer(access_token))).status).toBe(200)
		await sql(
			h.store,
			'UPDATE oauth_clients SET created_at = ?',
			new Date(NOW - EVICTION_GRACE_MS - 1000).toISOString()
		)
		await fill(h.store, MAX_PENDING_APPS - 1, NOW - EVICTION_GRACE_MS + 1000)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect(await count(h.store, `id = '${holder.client_id}'`)).toBe(0)
		expect((await h.request('/api/v1/apps/verify_credentials', bearer(access_token))).status).toBe(401)
	})

	it('cannot be filled for good with app tokens: registration succeeds again once they age', async () => {
		const h = await apiHarness()
		// An attacker fills the budget with apps that each hold an app token.
		await fill(h.store, MAX_PENDING_APPS, NOW - 1000, 'flood')
		await sql(
			h.store,
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes) SELECT 'h-' || id, 'access', id, 'read' FROM oauth_clients"
		)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(429)
		expect(await count(h.store)).toBe(MAX_PENDING_APPS)
		// An hour later the oldest goes for each new registration; the bound holds.
		h.now.mockReturnValue(NOW + EVICTION_GRACE_MS)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect(await count(h.store)).toBe(MAX_PENDING_APPS)
	})

	it('does not count or remove apps a user has authorized, or the web client', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const used = await registerApp(h)
		const { token } = await login(h, { app: used })
		await signIn(h)
		await sql(h.store, 'UPDATE oauth_clients SET created_at = ?', new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString())
		await fill(h.store, MAX_PENDING_APPS - 1, NOW - EVICTION_GRACE_MS + 1000)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(429)
		expect(await count(h.store, `id = '${used.client_id}'`)).toBe(1)
		expect(await count(h.store, "id = (SELECT value FROM instance_settings WHERE name = 'web_client_id')")).toBe(1)
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(200)
	})

	it('sweeps unused apps after a day and expired codes and sessions from the cron', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const used = await registerApp(h)
		await login(h, { app: used })
		await fill(h.store, 3, NOW - UNUSED_APP_TTL_MS - 1000, 'old')
		await fill(h.store, 2, NOW - 1000, 'new')
		await sql(
			h.store,
			`INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, redirect_uri, expires_at)
			SELECT 'expired', 'code', ?, account_id, 'read', 'https://client.test/callback', ? FROM local_accounts`,
			used.client_id,
			new Date(NOW - 1).toISOString()
		)
		await handleScheduled({ ...env, MAINTENANCE: 'off' } as unknown as Env, {
			build: () => env.CF_VERSION_METADATA.id,
			now: () => NOW,
			store: () => h.store,
		})
		expect(await count(h.store, "id LIKE 'old-%'")).toBe(0)
		expect(await count(h.store, "id LIKE 'new-%'")).toBe(2)
		expect(await count(h.store, `id = '${used.client_id}'`)).toBe(1)
		expect(await sql(h.store, "SELECT token_hash FROM oauth_tokens WHERE token_hash = 'expired'")).toEqual([])
	})
})
