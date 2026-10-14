import { runInDurableObject } from 'cloudflare:test'

import { beforeEach, describe, expect, it } from 'vitest'

import {
	type AccessTeam,
	accessToken,
	adminClaims,
	adminHarness,
	adminTeam,
	serviceClaims,
	setTeamAccess,
} from './access-helpers'
import { NOW } from './app-helpers'
import { BUILD, LATEST_MIGRATION, migratedStore, testKernel } from './helpers'
import { ACCESS, ADMIN_EMAIL, dumpViaRpc, importChunks, seedStore, splitDump } from './ops-helpers'
import { ACCESS_TEAM_DOMAIN } from '../src/domain/oauth'
import { ACCESS_SETTINGS } from '../src/platform/access-settings'
import { StoreAdmin } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'

// A team of its own per test: the shared verifier caches key sets per isolate by team domain.
let team: AccessTeam

beforeEach(async () => {
	team = await adminTeam()
})

const IMPORT_TOKEN = 'import-token-0123456789abcdef0123456789'

async function configuredStore(): Promise<StoreStub> {
	const store = await migratedStore()
	await setTeamAccess(store, team)
	return store
}

describe('admin authentication', () => {
	it('accepts the admin email and the CLI service token', async () => {
		const { as } = adminHarness(await configuredStore(), team)
		expect((await as(adminClaims(), '/admin/version')).status).toBe(200)
		expect((await as({ email: ADMIN_EMAIL.toUpperCase() }, '/admin/version')).status).toBe(200)
		expect((await as(serviceClaims(), '/admin/version')).status).toBe(200)
	})

	it('refuses a missing, foreign or malformed token with 401', async () => {
		const { request, as } = adminHarness(await configuredStore(), team)
		const refused = async (response: Response) => {
			expect(response.status).toBe(401)
			return ((await response.json()) as { error: string }).error
		}
		expect(await refused(await request('/admin/version'))).toMatch(/missing/)
		await refused(await as({ ...adminClaims(), aud: ['another-app'] }, '/admin/version'))
		await refused(await as({ ...adminClaims(), iss: 'https://evil.cloudflareaccess.com' }, '/admin/version'))
		// Beyond the 60 s clock tolerance.
		await refused(await as({ ...adminClaims(), exp: Math.floor(NOW / 1000) - 120 }, '/admin/version'))
		await refused(await as({ ...adminClaims(), exp: undefined }, '/admin/version'))
		const forged = await accessToken(team, adminClaims(), team.otherKey)
		await refused(await request('/admin/version', { headers: { 'Cf-Access-Jwt-Assertion': forged } }))
		const body = forged.split('.')[1]
		const unsigned = `${btoa(JSON.stringify({ alg: 'none', typ: 'JWT', kid: team.kid })).replace(/=+$/, '')}.${body}.`
		await refused(await request('/admin/version', { headers: { 'Cf-Access-Jwt-Assertion': unsigned } }))
	})

	it('refuses identities that are not the admin with 403', async () => {
		const { as } = adminHarness(await configuredStore(), team)
		expect((await as({ email: 'someone@kopje.test' }, '/admin/version')).status).toBe(403)
		expect((await as({ email: undefined, common_name: 'other-client.access' }, '/admin/version')).status).toBe(403)
		expect((await as({ email: undefined }, '/admin/version')).status).toBe(403)
	})

	it('refuses everything while Access is not configured', async () => {
		const { as } = adminHarness(await migratedStore(), team)
		const response = await as(adminClaims(), '/admin/version')
		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({ error: 'Access is not configured for /admin' })
	})

	// Key rotation and the 7-day stale limit belong to the shared verifier and are tested with /oauth/authorize.
	it('verifies through the shared Access verifier and its cached key set', async () => {
		const { as } = adminHarness(await configuredStore(), team)
		expect((await as(adminClaims(), '/admin/version')).status).toBe(200)
		expect((await as(serviceClaims(), '/admin/version')).status).toBe(200)
		expect(team.fetch).toHaveBeenCalledOnce()
	})

	it('shares the team domain setting with /oauth/authorize', () => {
		expect(ACCESS_SETTINGS.teamDomain).toBe(ACCESS_TEAM_DOMAIN)
	})

	it('works in full maintenance and with an invalid env, where the rest of the site is closed', async () => {
		const store = await configuredStore()
		const full = adminHarness(store, team, { MAINTENANCE: 'full' })
		expect((await full.request('/api/v1/instance')).status).toBe(503)
		expect((await full.as(adminClaims(), '/admin/health')).status).toBe(200)

		const invalid = adminHarness(store, team, { MAINTENANCE: 'sometimes' })
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
		const { request } = adminHarness(await migratedStore(), team, { IMPORT_TOKEN })
		const begin = await request('/admin/import/begin', withToken({ method: 'POST', body: JSON.stringify({ header }) }))
		expect(begin.status).toBe(200)
		expect(await begin.json()).toMatchObject({ progress: { mode: 'token', lastSeq: 0 } })
		// Once the import has begun, IMPORT_TOKEN no longer opens anything; its session continues it.
		expect((await request('/admin/version', withToken())).status).toBe(403)
	})

	it('is refused when wrong, unset, short, outside import, or once the Store has data or Access', async () => {
		const empty = adminHarness(await migratedStore(), team, { IMPORT_TOKEN })
		const wrong = await empty.request('/admin/import/progress', {
			headers: { 'Kopje-Import-Token': `${IMPORT_TOKEN}x` },
		})
		expect(wrong.status).toBe(401)
		expect((await empty.request('/admin/sql', withToken({ method: 'POST', body: '{"sql":"SELECT 1"}' }))).status).toBe(
			403
		)
		expect((await empty.request('/admin/dump/start', withToken({ method: 'POST' }))).status).toBe(403)

		const unset = adminHarness(await migratedStore(), team)
		expect((await unset.request('/admin/import/progress', withToken())).status).toBe(401)
		const short = adminHarness(await migratedStore(), team, { IMPORT_TOKEN: 'short' })
		expect((await short.request('/admin/import/progress', { headers: { 'Kopje-Import-Token': 'short' } })).status).toBe(
			401
		)

		const configured = adminHarness(await configuredStore(), team, { IMPORT_TOKEN })
		expect((await configured.request('/admin/import/progress', withToken())).status).toBe(403)
		// With data but no admin access the Store is still in bootstrap (the token may configure it), but an import
		// needs an empty Store.
		const withData = await migratedStore()
		await seedStore(withData, 0)
		const used = adminHarness(withData, team, { IMPORT_TOKEN })
		const header = splitDump((await dumpViaRpc(withData)).text).header
		const begin = await used.request(
			'/admin/import/begin',
			withToken({ method: 'POST', body: JSON.stringify({ header }), headers: { 'content-type': 'application/json' } })
		)
		expect(begin.status).toBe(403)
		expect(await begin.json()).toMatchObject({ code: 'not-bootstrap' })
	})
})

describe('admin endpoints', () => {
	it('reports health, version, capacity and spool', async () => {
		const store = await configuredStore()
		await seedStore(store, 0)
		const { as } = adminHarness(store, team)
		expect(await (await as(adminClaims(), '/admin/health')).json()).toMatchObject({
			ok: true,
			maintenance: 'off',
			store: { versionMatch: true, schema: { status: 'current' }, dump: null, import: null, maintenance: false },
		})
		expect(await (await as(adminClaims(), '/admin/version')).json()).toMatchObject({
			worker: { build: BUILD },
			store: { build: BUILD, applied: LATEST_MIGRATION, expected: LATEST_MIGRATION },
		})
		const capacity = (await (await as(adminClaims(), '/admin/capacity')).json()) as {
			databaseSize: number
			tables: { name: string; rows: number }[]
		}
		expect(capacity.databaseSize).toBeGreaterThan(0)
		expect(capacity.tables).toContainEqual({ name: 'statuses', rows: 3 })
		expect(capacity.tables).toContainEqual({ name: 'mutes', rows: 1 })
		// The AUTOINCREMENT counters of the seeded notifications and mutes.
		expect(capacity.tables).toContainEqual({ name: 'sqlite_sequence', rows: 2 })
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
		const { post } = adminHarness(store, team)
		expect((await post(adminClaims(), '/admin/maintenance', { on: 'yes' })).status).toBe(400)
		expect(await (await post(adminClaims(), '/admin/maintenance', { on: true })).json()).toEqual({ maintenance: true })
		expect(await store.health(BUILD)).toMatchObject({ maintenance: true, readonly: true })
		await post(adminClaims(), '/admin/maintenance', { on: false })
		expect(await store.health(BUILD)).toMatchObject({ maintenance: false, readonly: false })
	})

	it('runs read-only SQL and refuses anything else', async () => {
		const { post } = adminHarness(await configuredStore(), team)
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
		const { post } = adminHarness(store, team)
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
		expect(again.status).toBe(409)
		expect(await again.json()).toMatchObject({ code: 'dump-finished' })
	})

	// A reset now always names an import, so a serving Store (no import) has nothing a reset could apply to.
	it('needs confirmation and an import id to reset, and refuses to reset a serving Store', async () => {
		const store = await configuredStore()
		await seedStore(store, 0)
		const { post } = adminHarness(store, team)
		expect((await post(adminClaims(), '/admin/import/reset', {})).status).toBe(400)
		const unnamed = await post(adminClaims(), '/admin/import/reset', { confirm: true })
		expect(unnamed.status).toBe(400)
		expect(await unnamed.json()).toMatchObject({ code: 'import-id-required' })
		const refused = await post(adminClaims(), '/admin/import/reset', { confirm: true, id: 'no-such-import' })
		expect(refused.status).toBe(404)
		expect(await refused.json()).toMatchObject({ code: 'import-not-found' })
		expect(await store.setupState(BUILD)).toEqual({ complete: true })
	})

	it('retries the upgrade', async () => {
		const { post } = adminHarness(await configuredStore(), team)
		const response = await post(adminClaims(), '/admin/upgrade/retry')
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ ok: true })
	})
})

describe('PITR', () => {
	it('returns the current bookmark and validates times', async () => {
		const { as } = adminHarness(await configuredStore(), team)
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
		const open = adminHarness(restarting, team)
		const refused = await open.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'abc-123' })
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ code: 'maintenance-required' })

		const full = adminHarness(restarting, team, { MAINTENANCE: 'full' })
		expect((await full.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'not a bookmark!' })).status).toBe(400)
		const accepted = await full.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'abc-123' })
		expect(accepted.status).toBe(202)
		expect(await accepted.json()).toEqual({ status: 'restoring', bookmark: 'abc-123' })
		expect(calls).toEqual([`${BUILD}:abc-123`])
	})

	it('passes other restore failures through', async () => {
		// Miniflare cannot restore, so the real call fails with the platform's message.
		const full = adminHarness(await configuredStore(), team, { MAINTENANCE: 'full' })
		const failed = await full.post(adminClaims(), '/admin/pitr/restore', { bookmark: 'abc-123' })
		expect(failed.status).toBe(500)
		expect(await failed.json()).toMatchObject({ code: 'internal' })
	})
})

describe('team domain', () => {
	it('uses the issuer and JWKS of the configured team, with or without a scheme', async () => {
		const store = await migratedStore()
		await setTeamAccess(store, team, { access_team_domain: `https://${team.teamDomain}/` })
		const { as } = adminHarness(store, team)
		expect((await as(adminClaims(), '/admin/version')).status).toBe(200)
		expect(team.fetch).toHaveBeenCalledOnce()
	})
})

describe('import bootstrap over Access', () => {
	it('imports into a Store that holds only its Access settings, and keeps them across a reset', async () => {
		const source = await migratedStore()
		await seedStore(source, 0)
		const { text } = await dumpViaRpc(source)
		const { header, trailer } = splitDump(text)
		const target = await configuredStore()
		const { post, as } = adminHarness(target, team)
		expect((await post(adminClaims(), '/admin/config', { values: { domain: 'kopje.test' } })).status).toBe(200)

		const begun = await post(adminClaims(), '/admin/import/begin', { header })
		expect(begun.status).toBe(200)
		const { progress } = (await begun.json()) as { progress: { id: string } }
		const chunks = await importChunks(text, 1 << 20)
		const teamAccess = { ...ACCESS, teamDomain: team.teamDomain }
		expect(await target.importChunk(BUILD, teamAccess, progress.id, 1, chunks[0]!)).toMatchObject({ ok: true })

		// Reset keeps the Access settings, so the admin can still sign in and import again.
		const reset = await post(adminClaims(), '/admin/import/reset', { confirm: true, id: progress.id })
		expect(reset.status).toBe(200)
		expect(await reset.json()).toMatchObject({ done: true })
		expect((await as(adminClaims(), '/admin/version')).status).toBe(200)

		const again = (await (await post(adminClaims(), '/admin/import/begin', { header })).json()) as {
			progress: { id: string }
		}
		for (const [i, chunk] of chunks.entries()) {
			expect(await target.importChunk(BUILD, teamAccess, again.progress.id, i + 1, chunk)).toMatchObject({ ok: true })
		}
		expect((await post(adminClaims(), '/admin/import/finish', { id: again.progress.id, trailer })).status).toBe(200)
		const verified = await post(adminClaims(), '/admin/import/verify', { id: again.progress.id })
		expect(await verified.json()).toMatchObject({ done: true, report: { ok: true } })
		// The dump had no Access settings; the bootstrap ones are kept, and the admin API still works.
		expect((await as(adminClaims(), '/admin/version')).status).toBe(200)
		expect(await target.setupState(BUILD)).toEqual({ complete: true })
	})
})
