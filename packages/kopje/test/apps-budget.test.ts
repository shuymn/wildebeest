import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import {
	apiHarness,
	authorizationCode,
	bearer,
	exchange,
	form,
	json,
	login,
	registerApp,
	seedAccount,
	sql,
} from './api-helpers'
import { NOW } from './app-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { csrfOf, postForm, signIn } from './web-helpers'
import {
	EVICTION_GRACE_MS,
	issueCode,
	MAX_PENDING_APPS,
	OAUTH_SWEEP_BATCH,
	registerApp as registerAppOperation,
	sweepOAuth,
	UNUSED_APP_TTL_MS,
} from '../src/domain/oauth'
import { handleScheduled } from '../src/jobs/scheduled'
import type { StoreStub } from '../src/platform/store-client'

// RES-6 for POST /api/v1/apps: a per-IP rate limit (the Rate Limiting binding) and a storage budget of
// never-authorized apps, with expiry of unused ones (Kopje's own) and a visible refusal; an authorized app is kept.

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

	it('keeps an app that holds only a user’s code not yet exchanged, and the code still exchanges', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		await sql(h.store, 'UPDATE oauth_clients SET created_at = ?', new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString())
		await fill(h.store, MAX_PENDING_APPS, NOW - EVICTION_GRACE_MS - 1000)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1)
		expect((await exchange(h, app, code)).status).toBe(200)
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

	// RES-6: an app a user authorized stays registered after every token is gone, as Mastodon never removes one; a
	// client that kept its client_id signs in with it again, and its statuses keep showing it.
	it('keeps an app whose authorization was revoked past the sweep, and authorizes it again by the same client_id', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const app = await registerApp(h)
		const { token } = await login(h, { app, scope: 'read write' })
		const posted = await h.request('/api/v1/statuses', bearer(token, json({ status: 'hello' })))
		const { id } = await posted.json<{ id: string }>()
		const browser = await signIn(h)
		const revoked = await postForm(h, browser, '/settings/authorizations/revoke', {
			client_id: app.client_id,
			csrf: await csrfOf(h, browser),
		})
		expect(revoked.status).toBe(303)
		expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1)
		expect(await sql(h.store, 'SELECT token_hash FROM oauth_tokens WHERE client_id = ?', app.client_id)).toEqual([])
		await sql(h.store, 'UPDATE oauth_clients SET created_at = ?', new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString())
		// A never-authorized app of the same age, which the sweep removes: the sweep ran over both.
		await fill(h.store, 1, NOW - 2 * UNUSED_APP_TTL_MS, 'old')
		const swept = await runInDurableObject(h.store, (_instance, state) =>
			sweepOAuth.run(state.storage.sql, { now: NOW })
		)
		expect(swept).toEqual({ apps: 1, tokens: 0, webState: 0 })
		expect(await count(h.store, "id LIKE 'old-%'")).toBe(0)
		expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1)
		const again = await login(h, { app })
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(again.token))).status).toBe(200)
		const shown = await (await h.request(`/api/v1/statuses/${id}`)).json<{ application: unknown }>()
		expect(shown.application).toEqual({ name: 'Test Client', website: 'https://client.test' })
	})

	it('never evicts an app authorized and then revoked, and still evicts a never-authorized one', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const app = await registerApp(h)
		const { token } = await login(h, { app })
		const revoked = await h.request(
			'/oauth/revoke',
			form({ token, client_id: app.client_id, client_secret: app.client_secret })
		)
		expect(revoked.status).toBe(200)
		expect(await sql(h.store, 'SELECT token_hash FROM oauth_tokens WHERE client_id = ?', app.client_id)).toEqual([])
		// The revoked app is the oldest of all, past the day and the grace, and every pending slot is taken.
		await sql(h.store, 'UPDATE oauth_clients SET created_at = ?', new Date(NOW - 2 * UNUSED_APP_TTL_MS).toISOString())
		await fill(h.store, MAX_PENDING_APPS, NOW - EVICTION_GRACE_MS - 1000)
		expect((await h.request('/api/v1/apps', json(APP))).status).toBe(200)
		expect(await count(h.store, `id = '${app.client_id}'`)).toBe(1)
		// The oldest never-authorized app went in its place.
		expect(await count(h.store, "id = 'filler-0'")).toBe(0)
		expect(await count(h.store, "id LIKE 'filler-%'")).toBe(MAX_PENDING_APPS - 1)
	})
})

// RES-7 for the budget's statements: authorized apps, each with a user's token, grown after ANALYZE, are never read.
// Every input at its worst: MAX_PENDING_APPS pending apps (the budget full), each older than the day and holding an app
// token, so the expiry pass reads every one and removes none and eviction runs; the web client not yet authorized, so
// it is a pending candidate too.
describe('app budget reads with stale statistics (RES-6, RES-7)', () => {
	const AUTHORIZED = 3 * MAX_PENDING_APPS

	it('walks the pending apps by their partial index and marks an app by its key', { timeout: 60_000 }, async () => {
		const h = await apiHarness()
		const alice = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		await fill(h.store, 2, NOW - 2 * UNUSED_APP_TTL_MS, 'small')
		await sql(h.store, "INSERT INTO instance_settings (name, value) VALUES ('web_client_id', 'small-0')")
		const pattern = /oauth_clients/
		const { after } = await staleStatistics(h, {
			capture: async (phase) => ({
				registered: await plannedRun(
					h,
					pattern,
					registerAppOperation,
					{
						clientId: `new-${phase}`,
						secret: 's',
						name: 'n',
						redirectUris: ['https://n.example/cb'],
						website: null,
						scopes: ['read'],
						now: NOW,
					},
					true
				),
				swept: await plannedRun(h, pattern, sweepOAuth, { now: NOW }, true),
				marked: await plannedRun(
					h,
					pattern,
					issueCode,
					{
						clientId: `new-${phase}`,
						redirectUri: 'https://n.example/cb',
						scopes: ['read'],
						codeChallenge: null,
						email: 'alice@example.com',
						codeHash: `code-${phase}`,
						now: NOW,
					},
					true
				),
			}),
			grow: async () => {
				await sql(h.store, "DELETE FROM oauth_clients WHERE id LIKE 'new-%' OR id = 'small-1'")
				await sql(
					h.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes, created_at, authorized)
					SELECT 'authorized-' || i, 's', 'a', 'https://a.example/cb', 'read', ?2, 1 FROM n`,
					AUTHORIZED,
					new Date(NOW - 3 * UNUSED_APP_TTL_MS).toISOString()
				)
				await sql(
					h.store,
					`INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
					SELECT 'u-' || id, 'access', id, ?, 'read' FROM oauth_clients WHERE authorized = 1`,
					alice
				)
				// MAX_PENDING_APPS beside the web client (small-0), which the budget does not count: it is full.
				await fill(h.store, MAX_PENDING_APPS, NOW - 2 * UNUSED_APP_TTL_MS, 'pending')
				await sql(
					h.store,
					`INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes)
					SELECT 'a-' || id, 'access', id, 'read' FROM oauth_clients WHERE authorized = 0`
				)
			},
		})
		expect(after.registered.result).toMatchObject({ status: 'ok' })
		// The budget was full: the expiry pass removed none (each holds an app token), and eviction took the oldest.
		expect(await count(h.store, "id = 'pending-0'")).toBe(0)
		expect(await count(h.store, "id LIKE 'authorized-%'")).toBe(AUTHORIZED)
		expect(after.swept.result).toEqual({ apps: 0, tokens: 0, webState: 0 })
		expect(after.marked.result).toEqual({ status: 'ok' })
		expect(await count(h.store, "id = 'new-after' AND authorized = 1")).toBe(1)

		const kind = (query: string) =>
			query.startsWith('SELECT COUNT')
				? 'count'
				: query.startsWith('INSERT')
					? 'insert'
					: query.startsWith('UPDATE')
						? 'mark'
						: !query.startsWith('DELETE')
							? 'read'
							: query.includes('ORDER BY')
								? 'evict'
								: query.includes('LIMIT')
									? 'sweep'
									: 'expire'
		const statements = [...after.registered.plans, ...after.swept.plans, ...after.marked.plans]
		// Three counts (before the expiry pass, before eviction, after it), the expiry pass, eviction, the insert and
		// its read; the sweep; issueCode's client read and its mark.
		expect(statements.map((p) => kind(p.query))).toEqual([
			'count',
			'expire',
			'count',
			'evict',
			'count',
			'insert',
			'read',
			'sweep',
			'read',
			'mark',
		])
		// Then the sweep's other worst: its batch filled with unused apps (their app tokens gone, one more aged app), each
		// removed by its key.
		await sql(h.store, "DELETE FROM oauth_tokens WHERE token_hash LIKE 'a-%'")
		await fill(h.store, 1, NOW - 2 * UNUSED_APP_TTL_MS, 'extra')
		const drained = await plannedRun(h, pattern, sweepOAuth, { now: NOW }, true)
		expect(drained.result).toEqual({ apps: OAUTH_SWEEP_BATCH, tokens: 0, webState: 0 })
		expect(await count(h.store, "id LIKE 'authorized-%'")).toBe(AUTHORIZED)
		statements.push(...drained.plans)
		for (const statement of statements) {
			const k = kind(statement.query)
			if (k === 'count' || k === 'expire' || k === 'evict' || k === 'sweep') {
				expect(statement.plan.join(' | '), statement.query).toMatch(/USING (?:COVERING )?INDEX oauth_clients_pending/)
				expect(scansOf(statement.plan, ['oauth_clients', 'oauth_tokens', 'u']), statement.query).toEqual([])
				// Per pending candidate (MAX_PENDING_APPS and the web client): its index entry and, in the expiry pass and
				// the sweep, one seek of its tokens (the first hit ends it); a removed one at most four more (its row by key,
				// its index entries and the foreign-key check of its tokens); the web client's setting is one seek. Measured
				// 502, 1,004 and 3,002 (the drained sweep), the same with ten times as many authorized apps: none is read.
				expect(statement.rows, statement.query).toBeLessThanOrEqual(6 * (MAX_PENDING_APPS + 1) + 2)
			} else {
				expect(statement.plan, statement.query).toEqual(
					statement.query.startsWith('INSERT')
						? []
						: ['SEARCH oauth_clients USING INDEX sqlite_autoindex_oauth_clients_1 (id=?)']
				)
				expect(statement.rows, statement.query).toBeLessThanOrEqual(1)
			}
		}
	})
})
