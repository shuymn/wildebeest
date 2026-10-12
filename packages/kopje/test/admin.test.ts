import { runInDurableObject } from 'cloudflare:test'

import { beforeAll, describe, expect, it } from 'vitest'

import { accessKeys, accessToken, adminClaims, adminHarness, serviceClaims } from './access-helpers'
import { BUILD, migratedStore, testKernel } from './helpers'
import { ADMIN_EMAIL, dumpViaRpc, seedStore, setAccess, splitDump, TEAM_DOMAIN } from './ops-helpers'
import { StoreAdmin } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'

type Keys = Awaited<ReturnType<typeof accessKeys>>
let keys: Keys
let otherKeys: Keys

beforeAll(async () => {
	keys = await accessKeys('key-1')
	otherKeys = await accessKeys('key-1')
})

const IMPORT_TOKEN = 'import-token-0123456789abcdef0123456789'

async function configuredStore(): Promise<StoreStub> {
	const store = await migratedStore()
	await setAccess(store)
	return store
}

describe('admin authentication', () => {
	it('accepts the admin email and the CLI service token', async () => {
		const { as } = adminHarness(await configuredStore(), keys)
		expect((await as(adminClaims(), '/admin/version')).status).toBe(200)
		expect((await as({ email: ADMIN_EMAIL.toUpperCase() }, '/admin/version')).status).toBe(200)
		expect((await as(serviceClaims(), '/admin/version')).status).toBe(200)
	})

	it('refuses a missing, foreign or malformed token with 401', async () => {
		const { request, as } = adminHarness(await configuredStore(), keys)
		const refused = async (response: Response) => {
			expect(response.status).toBe(401)
			return ((await response.json()) as { error: string }).error
		}
		expect(await refused(await request('/admin/version'))).toMatch(/missing/)
		await refused(await as({ ...adminClaims(), aud: ['another-app'] }, '/admin/version'))
		await refused(await as({ ...adminClaims(), iss: 'https://evil.cloudflareaccess.com' }, '/admin/version'))
		await refused(await as({ ...adminClaims(), exp: Math.floor(Date.now() / 1000) - 60 }, '/admin/version'))
		await refused(await as({ ...adminClaims(), exp: undefined }, '/admin/version'))
		const forged = await accessToken(otherKeys, adminClaims())
		await refused(await request('/admin/version', { headers: { 'Cf-Access-Jwt-Assertion': forged } }))
		const body = forged.split('.')[1]
		const unsigned = `${btoa(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'key-1' })).replace(/=+$/, '')}.${body}.`
		await refused(await request('/admin/version', { headers: { 'Cf-Access-Jwt-Assertion': unsigned } }))
	})

	it('refuses identities that are not the admin with 403', async () => {
		const { as } = adminHarness(await configuredStore(), keys)
		expect((await as({ email: 'someone@kopje.test' }, '/admin/version')).status).toBe(403)
		expect((await as({ common_name: 'other-client.access' }, '/admin/version')).status).toBe(403)
		expect((await as({}, '/admin/version')).status).toBe(403)
	})

	it('refuses everything while Access is not configured', async () => {
		const { as } = adminHarness(await migratedStore(), keys)
		const response = await as(adminClaims(), '/admin/version')
		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({ error: 'Access is not configured for /admin' })
	})

	it('caches the JWKS and refetches it at most once a minute for an unknown key', async () => {
		const { as, request, jwks } = adminHarness(await configuredStore(), keys)
		await as(adminClaims(), '/admin/version')
		await as(adminClaims(), '/admin/version')
		expect(jwks.fetches).toBe(1)
		const rotated = await accessKeys('key-2')
		const token = await accessToken(rotated, adminClaims())
		expect((await request('/admin/version', { headers: { 'Cf-Access-Jwt-Assertion': token } })).status).toBe(401)
		expect(jwks.fetches).toBe(1)
	})

	it('works in full maintenance and with an invalid env, where the rest of the site is closed', async () => {
		const store = await configuredStore()
		const full = adminHarness(store, keys, { MAINTENANCE: 'full' })
		expect((await full.request('/api/v1/instance')).status).toBe(503)
		expect((await full.as(adminClaims(), '/admin/health')).status).toBe(200)

		const invalid = adminHarness(store, keys, { MAINTENANCE: 'sometimes' })
		const health = await invalid.as(adminClaims(), '/admin/health')
		expect(health.status).toBe(200)
		expect(await health.json()).toMatchObject({ ok: false, checks: { env: { ok: false } } })
	})
})

describe('import token', () => {
	const withToken = (init: RequestInit = {}) => ({
		...init,
		headers: { ...(init.headers as Record<string, string>), 'Kopje-Import-Token': IMPORT_TOKEN },
	})

	it('authorizes import into an empty Store without Access settings', async () => {
		const source = await migratedStore()
		await seedStore(source, 0)
		const { header } = splitDump((await dumpViaRpc(source)).text)
		const { request } = adminHarness(await migratedStore(), keys, { IMPORT_TOKEN })
		const begin = await request('/admin/import/begin', withToken({ method: 'POST', body: JSON.stringify({ header }) }))
		expect(begin.status).toBe(200)
		expect(await begin.json()).toMatchObject({ progress: { mode: 'token', lastSeq: 0 } })
		expect((await request('/admin/version', withToken())).status).toBe(200)
	})

	it('is refused when wrong, unset, short, outside import, or once the Store has data or Access', async () => {
		const empty = adminHarness(await migratedStore(), keys, { IMPORT_TOKEN })
		const wrong = await empty.request('/admin/import/progress', {
			headers: { 'Kopje-Import-Token': `${IMPORT_TOKEN}x` },
		})
		expect(wrong.status).toBe(401)
		expect((await empty.request('/admin/sql', withToken({ method: 'POST', body: '{"sql":"SELECT 1"}' }))).status).toBe(
			403
		)
		expect((await empty.request('/admin/dump/start', withToken({ method: 'POST' }))).status).toBe(403)

		const unset = adminHarness(await migratedStore(), keys)
		expect((await unset.request('/admin/import/progress', withToken())).status).toBe(401)
		const short = adminHarness(await migratedStore(), keys, { IMPORT_TOKEN: 'short' })
		expect((await short.request('/admin/import/progress', { headers: { 'Kopje-Import-Token': 'short' } })).status).toBe(
			401
		)

		const configured = adminHarness(await configuredStore(), keys, { IMPORT_TOKEN })
		expect((await configured.request('/admin/import/progress', withToken())).status).toBe(403)
		const withData = await migratedStore()
		await seedStore(withData, 0)
		const used = adminHarness(withData, keys, { IMPORT_TOKEN })
		expect((await used.request('/admin/import/progress', withToken())).status).toBe(403)
	})
})

describe('admin endpoints', () => {
	it('reports health, version, capacity and spool', async () => {
		const store = await configuredStore()
		await seedStore(store, 0)
		const { as } = adminHarness(store, keys)
		expect(await (await as(adminClaims(), '/admin/health')).json()).toMatchObject({
			ok: true,
			maintenance: 'off',
			store: { versionMatch: true, schema: { status: 'current' }, dump: null, import: null, maintenance: false },
		})
		expect(await (await as(adminClaims(), '/admin/version')).json()).toMatchObject({
			worker: { build: BUILD },
			store: { build: BUILD, applied: '0000_initial', expected: '0000_initial' },
		})
		const capacity = (await (await as(adminClaims(), '/admin/capacity')).json()) as {
			databaseSize: number
			tables: { name: string; rows: number }[]
		}
		expect(capacity.databaseSize).toBeGreaterThan(0)
		expect(capacity.tables).toContainEqual({ name: 'statuses', rows: 3 })
		expect(capacity.tables).toContainEqual({ name: 'sqlite_sequence', rows: 1 })
		expect(capacity.tables.some((t) => t.name.startsWith('_cf_'))).toBe(false)
		expect(await (await as(adminClaims(), '/admin/spool')).json()).toEqual({
			parts: 1,
			sets: 1,
			completeSets: 0,
			oldestSpooledAt: 1,
		})
	})

	it('enters and leaves maintenance', async () => {
		const store = await configuredStore()
		const { post } = adminHarness(store, keys)
		expect((await post(adminClaims(), '/admin/maintenance', { on: 'yes' })).status).toBe(400)
		expect(await (await post(adminClaims(), '/admin/maintenance', { on: true })).json()).toEqual({ maintenance: true })
		expect(await store.health(BUILD)).toMatchObject({ maintenance: true, readonly: true })
		await post(adminClaims(), '/admin/maintenance', { on: false })
		expect(await store.health(BUILD)).toMatchObject({ maintenance: false, readonly: false })
	})

	it('runs read-only SQL and refuses anything else', async () => {
		const { post } = adminHarness(await configuredStore(), keys)
		const ok = await post(adminClaims(), '/admin/sql', {
			sql: "SELECT value FROM instance_settings WHERE name = 'admin_email'",
		})
		expect(await ok.json()).toEqual({ columns: ['value'], rows: [[ADMIN_EMAIL]], truncated: false })
		const refused = await post(adminClaims(), '/admin/sql', { sql: 'DELETE FROM instance_settings' })
		expect(refused.status).toBe(400)
		expect(await refused.json()).toMatchObject({ code: 'not-read-only' })
	})

	it('dumps over HTTP with a framed cursor', async () => {
		const store = await configuredStore()
		const { post } = adminHarness(store, keys)
		const started = (await (await post(adminClaims(), '/admin/dump/start')).json()) as {
			cursor: unknown
			headerLine: string
		}
		expect(started.headerLine).toMatch(/^-- kopje-dump-header /)
		const next = await post(adminClaims(), '/admin/dump/next', { cursor: started.cursor })
		expect(next.headers.get('content-type')).toBe('application/octet-stream')
		const bytes = new Uint8Array(await next.arrayBuffer())
		const newline = bytes.indexOf(10)
		const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline))) as { done: boolean; cursor: unknown }
		expect(meta.done).toBe(true)
		expect(new TextDecoder().decode(bytes.subarray(newline + 1))).toMatch(/^INSERT INTO "instance_settings"/)
		const finished = await post(adminClaims(), '/admin/dump/finish', { cursor: meta.cursor })
		expect(await finished.json()).toMatchObject({
			aborted: false,
			trailerText: expect.stringMatching(/kopje-dump-end\n$/),
		})
		const again = await post(adminClaims(), '/admin/dump/next', { cursor: meta.cursor })
		expect(again.status).toBe(404)
	})

	it('needs confirmation to reset and refuses to reset a serving Store', async () => {
		const store = await configuredStore()
		const { post } = adminHarness(store, keys)
		expect((await post(adminClaims(), '/admin/import/reset', {})).status).toBe(400)
		const refused = await post(adminClaims(), '/admin/import/reset', { confirm: true })
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ code: 'reset-refused' })
	})

	it('retries the upgrade', async () => {
		const { post } = adminHarness(await configuredStore(), keys)
		const response = await post(adminClaims(), '/admin/upgrade/retry')
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ ok: true })
	})
})

describe('PITR', () => {
	it('returns the current bookmark and validates times', async () => {
		const { as } = adminHarness(await configuredStore(), keys)
		expect(await (await as(adminClaims(), '/admin/pitr/bookmark')).json()).toMatchObject({
			bookmark: expect.any(String),
			at: null,
		})
		expect((await as(adminClaims(), '/admin/pitr/bookmark?at=yesterday-ish')).status).toBe(400)
		const old = await as(adminClaims(), `/admin/pitr/bookmark?at=${Date.now() - 40 * 24 * 3600 * 1000}`)
		expect(old.status).toBe(400)
		// Miniflare has no PITR back-end; the refusal is reported, not thrown.
		const local = await as(adminClaims(), `/admin/pitr/bookmark?at=${new Date(Date.now() - 1000).toISOString()}`)
		expect(local.status).toBe(503)
		expect(await local.json()).toMatchObject({ code: 'pitr-unavailable' })
	})

	it('maps "no history" of a young database to its own code', async () => {
		const store = await configuredStore()
		await runInDurableObject(store, async (_instance, state) => {
			const fake = {
				storage: {
					sql: state.storage.sql,
					transactionSync: <T>(fn: () => T) => state.storage.transactionSync(fn),
					getBookmarkForTime: () => Promise.reject(new Error('This database has no history.')),
				},
			} as unknown as DurableObjectState
			const admin = new StoreAdmin(fake, testKernel(state), { source: { build: BUILD, version: 't' }, log: () => {} })
			expect(await admin.bookmark(Date.now() - 1000)).toMatchObject({ ok: false, code: 'no-history' })
		})
	})

	it('restores only under MAINTENANCE=full and reports the restart as accepted', async () => {
		const store = await configuredStore()
		const calls: string[] = []
		const restarting = {
			adminGate: (build: string) => store.adminGate(build),
			pitrToBookmark: (build: string, bookmark: string) => {
				calls.push(`${build}:${bookmark}`)
				return Promise.reject(new Error('restoring PITR bookmark'))
			},
		} as unknown as StoreStub
		const open = adminHarness(restarting, keys)
		const refused = await open.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'abc-123' })
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ code: 'maintenance-required' })

		const full = adminHarness(restarting, keys, { MAINTENANCE: 'full' })
		expect((await full.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'not a bookmark!' })).status).toBe(400)
		const accepted = await full.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'abc-123' })
		expect(accepted.status).toBe(202)
		expect(await accepted.json()).toEqual({ status: 'restoring', bookmark: 'abc-123' })
		expect(calls).toEqual([`${BUILD}:abc-123`])
	})

	it('passes other restore failures through', async () => {
		// Miniflare cannot restore, so the real call fails with the platform's message.
		const full = adminHarness(await configuredStore(), keys, { MAINTENANCE: 'full' })
		const failed = await full.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'abc-123' })
		expect(failed.status).toBe(500)
		expect(await failed.json()).toMatchObject({ code: 'internal' })
	})
})

describe('team domain', () => {
	it('uses the issuer and JWKS of the configured team, with or without a scheme', async () => {
		const store = await migratedStore()
		await setAccess(store, { access_team_domain: `https://${TEAM_DOMAIN}/` })
		const { as, jwks } = adminHarness(store, keys)
		expect((await as(adminClaims(), '/admin/version')).status).toBe(200)
		expect(jwks.fetches).toBe(1)
	})
})
