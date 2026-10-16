import { runInDurableObject } from 'cloudflare:test'

import { beforeEach, describe, expect, it } from 'vitest'

import { adminHarness, adminTeam, serviceClaims, setTeamAccess, type AccessTeam } from './access-helpers'
import {
	type ApiHarness,
	apiHarness,
	bearer,
	form,
	login,
	registerApp,
	seedAccount,
	setSetting,
	sql,
} from './api-helpers'
import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { ADMIN_EMAIL } from './ops-helpers'
import { Db } from '../src/db/sql'
import { oauthAdmin } from '../src/domain/admin-authority'
import {
	ADMIN_PERMISSION,
	ADMIN_PERMISSIONS,
	adminGuarded,
	adminReadOperation,
	adminWriteOperation,
	type UserCredential,
} from '../src/domain/auth'
import { readOperation, writeOperation } from '../src/domain/operation'
import { ROUTES } from '../src/mastodon/routes'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// The Mastodon admin API's authority (R37, VIS-29, AUTH-2): one OAuth admin, the local account whose email matches
// admin_email, failing closed; admin operations check it in their transaction; and every admin route answers as
// Mastodon answers a role without the route's permission until Kopje serves it.

const OWNER = 'owner@example.com'
const ADMIN_SCOPES = 'read admin:read admin:write'

async function userToken(h: ApiHarness, email: string, scope = ADMIN_SCOPES): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	return (await login(h, { app, scope, email })).token
}

async function appToken(h: ApiHarness, scope = 'admin:read admin:write'): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	const response = await h.request(
		'/oauth/token',
		form({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret, scope })
	)
	return (await response.json<{ access_token: string }>()).access_token
}

const matchOf = (store: StoreStub) =>
	runInDurableObject(store, (_instance, state) => oauthAdmin(new Db(state.storage.sql)))

// Admin operations as a route with manage_reports would declare them, with that bit granted (as a later PR grants it)
// or not.
const granted = adminGuarded(readOperation, ADMIN_PERMISSION.manageReports)
const reportsRead = granted(ADMIN_PERMISSION.manageReports, (_db, _input: object, admin) => admin)
const usersRead = granted(ADMIN_PERMISSION.manageUsers, (_db, _input: object, admin) => admin.accountId)
const writes = adminGuarded(writeOperation, ADMIN_PERMISSION.manageReports)(
	ADMIN_PERMISSION.manageReports,
	(db, _input: object, admin) => {
		db.run("INSERT INTO kopje_state (name, value) VALUES ('admin-probe', ?)", admin.accountId)
		return admin.accountId
	}
)

type Operation = typeof reportsRead | typeof writes

async function run(
	store: StoreStub,
	operation: Operation,
	token: string | null,
	scope: UserCredential['scope'] = 'admin:read:reports'
) {
	const credential = token === null ? null : { tokenHash: await sha256Hex(token), scope, now: NOW }
	return runInDurableObject(store, (_instance, state) =>
		(operation.run as (sql: SqlStorage, input: { credential: UserCredential | null }) => unknown)(state.storage.sql, {
			credential,
		})
	)
}

describe('the OAuth admin (adminAccountId)', () => {
	it('is the one local account whose email matches admin_email after trimming and lowercasing', async () => {
		const h = await apiHarness()
		const owner = await seedAccount(h.store, { username: 'owner', email: OWNER })
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		await setSetting(h.store, 'admin_email', `  ${OWNER.toUpperCase()} `)
		expect(await matchOf(h.store)).toEqual({ status: 'ok', username: 'owner', accountId: owner })
		const token = await userToken(h, OWNER)
		expect(await run(h.store, reportsRead, token)).toEqual({
			status: 'ok',
			value: { accountId: owner, clientId: expect.any(String), now: NOW },
		})
	})

	it('is nobody while admin_email is unset or empty', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: OWNER })
		const token = await userToken(h, OWNER)
		expect(await matchOf(h.store)).toEqual({ status: 'unset', username: null, accountId: null })
		expect(await run(h.store, reportsRead, token)).toEqual({ status: 'forbidden' })
		await setSetting(h.store, 'admin_email', '   ')
		expect(await matchOf(h.store)).toEqual({ status: 'unset', username: null, accountId: null })
		expect(await run(h.store, reportsRead, token)).toEqual({ status: 'forbidden' })
	})

	it('is nobody when no local account has the email', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: OWNER })
		// A remote account has no email to match.
		await seedAccount(h.store, { username: 'owner', domain: 'remote.example' })
		await setSetting(h.store, 'admin_email', 'nobody@example.com')
		const token = await userToken(h, OWNER)
		expect(await matchOf(h.store)).toEqual({ status: 'none', username: null, accountId: null })
		expect(await run(h.store, reportsRead, token)).toEqual({ status: 'forbidden' })
	})

	it('is nobody when the match is suspended', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: OWNER })
		await setSetting(h.store, 'admin_email', OWNER)
		const token = await userToken(h, OWNER)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect(await matchOf(h.store)).toEqual({ status: 'suspended', username: 'owner', accountId: null })
		expect(await run(h.store, reportsRead, token)).toEqual({ status: 'suspended' })
	})

	it('is nobody when two accounts match after lowercasing; nothing is picked', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: OWNER })
		await setSetting(h.store, 'admin_email', OWNER)
		const token = await userToken(h, OWNER)
		expect(await run(h.store, reportsRead, token)).toMatchObject({ status: 'ok' })
		await seedAccount(h.store, { username: 'twin', email: 'Owner@Example.com' })
		expect(await matchOf(h.store)).toEqual({ status: 'ambiguous', username: null, accountId: null })
		expect(await run(h.store, reportsRead, token)).toEqual({ status: 'forbidden' })
	})

	it('follows admin_email when it changes: existing tokens lose or gain admin authority at once', async () => {
		const h = await apiHarness()
		const owner = await seedAccount(h.store, { username: 'owner', email: OWNER })
		const alice = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		await setSetting(h.store, 'admin_email', OWNER)
		const ownerToken = await userToken(h, OWNER)
		const aliceToken = await userToken(h, 'alice@example.com')
		expect(await run(h.store, reportsRead, ownerToken)).toMatchObject({ status: 'ok', value: { accountId: owner } })
		expect(await run(h.store, reportsRead, aliceToken)).toEqual({ status: 'forbidden' })

		await setSetting(h.store, 'admin_email', 'alice@example.com')
		expect(await run(h.store, reportsRead, ownerToken)).toEqual({ status: 'forbidden' })
		expect(await run(h.store, reportsRead, aliceToken)).toMatchObject({ status: 'ok', value: { accountId: alice } })
		expect(await run(h.store, writes, ownerToken, 'admin:write:reports')).toEqual({ status: 'forbidden' })
		expect(await run(h.store, writes, aliceToken, 'admin:write:reports')).toEqual({ status: 'ok', value: alice })
		expect(await sql(h.store, "SELECT value FROM kopje_state WHERE name = 'admin-probe'")).toEqual([{ value: alice }])
	})
})

describe('admin operations', () => {
	async function withAdmin() {
		const h = await apiHarness()
		const owner = await seedAccount(h.store, { username: 'owner', email: OWNER })
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		await setSetting(h.store, 'admin_email', OWNER)
		return { h, owner }
	}

	it('refuse anonymous callers, app tokens and other users, even with admin scopes', async () => {
		const { h } = await withAdmin()
		expect(await run(h.store, reportsRead, null)).toEqual({ status: 'forbidden' })
		expect(await run(h.store, reportsRead, await appToken(h))).toEqual({ status: 'forbidden' })
		expect(await run(h.store, reportsRead, await userToken(h, 'alice@example.com'))).toEqual({ status: 'forbidden' })
		expect(await run(h.store, writes, await userToken(h, 'alice@example.com'), 'admin:write:reports')).toEqual({
			status: 'forbidden',
		})
		expect(await sql(h.store, "SELECT value FROM kopje_state WHERE name = 'admin-probe'")).toEqual([])
	})

	it("refuse the admin's token without the route's scope, and an invalid token", async () => {
		const { h } = await withAdmin()
		expect(await run(h.store, reportsRead, await userToken(h, OWNER, 'read write'))).toEqual({
			status: 'insufficient_scope',
		})
		expect(await run(h.store, reportsRead, await userToken(h, OWNER, 'admin:read:accounts'))).toEqual({
			status: 'insufficient_scope',
		})
		expect(await run(h.store, reportsRead, 'not-a-token')).toEqual({ status: 'unauthenticated' })
		expect(await run(h.store, reportsRead, await userToken(h, OWNER, 'admin:read:reports'))).toMatchObject({
			status: 'ok',
		})
	})

	it('refuse the admin a permission Kopje does not grant', async () => {
		const { h } = await withAdmin()
		const token = await userToken(h, OWNER)
		expect(await run(h.store, usersRead, token, 'admin:read:accounts')).toEqual({ status: 'forbidden' })
	})

	it('grant no permission yet (ADMIN_PERMISSIONS = 0), so every admin operation refuses the admin', async () => {
		const { h } = await withAdmin()
		expect(ADMIN_PERMISSIONS).toBe(0)
		const token = await userToken(h, OWNER)
		for (const permission of Object.values(ADMIN_PERMISSION)) {
			const read = adminReadOperation(permission, () => 'read')
			const write = adminWriteOperation(permission, () => 'written')
			expect(await run(h.store, read as Operation, token, 'admin:read')).toEqual({ status: 'forbidden' })
			expect(await run(h.store, write as Operation, token, 'admin:write')).toEqual({ status: 'forbidden' })
		}
	})

	it("leave every account's role the default one", async () => {
		const { h } = await withAdmin()
		const response = await h.request('/api/v1/accounts/verify_credentials', bearer(await userToken(h, OWNER)))
		expect(await response.json()).toMatchObject({
			role: { id: '-99', name: '', permissions: '0', color: '', highlighted: false },
		})
	})
})

describe('admin routes (AUTH-2)', () => {
	const adminRoutes = ROUTES.filter((route) => /^\/api\/v[12]\/admin\//.test(route.path))
	// Kinds Kopje stores none of, found by id before Mastodon's policy runs.
	const UNSTORED = /\/admin\/(domain_blocks|domain_allows|ip_blocks|email_domain_blocks|canonical_email_blocks)\/:id$/
	const TRENDS = /^\/api\/v1\/admin\/trends\/(tags|links|statuses)$/

	const expected = (path: string): { status: number; body: unknown } =>
		TRENDS.test(path)
			? { status: 200, body: [] }
			: UNSTORED.test(path)
				? { status: 404, body: { error: 'Record not found' } }
				: { status: 403, body: { error: 'This action is not allowed' } }

	const tokens = async (h: ApiHarness) => ({
		anonymous: null,
		app: await appToken(h),
		user: await userToken(h, 'alice@example.com'),
		admin: await userToken(h, OWNER),
	})

	it('are all 63 routed, with the answer of a role without the permission', () => {
		expect(adminRoutes).toHaveLength(63)
		const answers = adminRoutes.map((route) => expected(route.path).status)
		expect(answers.filter((status) => status === 200)).toHaveLength(3)
		expect(answers.filter((status) => status === 404)).toHaveLength(14)
		expect(answers.filter((status) => status === 403)).toHaveLength(46)
	})

	it('answer anonymous callers, app tokens, other users and the admin alike', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: OWNER })
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		await setSetting(h.store, 'admin_email', OWNER)
		const callers = await tokens(h)
		for (const route of adminRoutes) {
			const path = route.path.replace(/:\w+/g, '1')
			const want = expected(route.path)
			for (const [who, token] of Object.entries(callers)) {
				const init = { method: route.method }
				const response = await h.request(path, token === null ? init : bearer(token, init))
				expect(response.status, `${route.method} ${route.path} as ${who}`).toBe(want.status)
				expect(await response.json()).toEqual(want.body)
			}
		}
	})

	it("refuse a token without the route's scope, or an invalid one, before answering", async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: OWNER })
		await setSetting(h.store, 'admin_email', OWNER)
		const readOnly = await userToken(h, OWNER, 'read write')
		for (const route of adminRoutes) {
			const path = route.path.replace(/:\w+/g, '1')
			const init = { method: route.method }
			const outside = await h.request(path, bearer(readOnly, init))
			expect(outside.status, `${route.method} ${route.path}`).toBe(403)
			expect(await outside.json()).toEqual({ error: 'This action is outside the authorized scopes' })
			expect((await h.request(path, bearer('not-a-token', init))).status).toBe(401)
		}
		// admin:read does not cover admin:write.
		const reader = await userToken(h, OWNER, 'admin:read')
		const write = await h.request('/api/v1/admin/reports/1/resolve', bearer(reader, { method: 'POST' }))
		expect(await write.json()).toEqual({ error: 'This action is outside the authorized scopes' })
	})
})

describe('GET /admin/health: oauthAdmin', () => {
	let team: AccessTeam

	beforeEach(async () => {
		team = await adminTeam()
	})

	it('says why there is, or is not, an OAuth admin', async () => {
		const store = await migratedStore()
		await setTeamAccess(store, team)
		const { as } = adminHarness(store, team)
		// The CLI's service token, so the admin email may be cleared.
		const health = async () => (await as(serviceClaims(), '/admin/health')).json<{ oauthAdmin: unknown }>()
		expect((await health()).oauthAdmin).toEqual({ status: 'none', username: null })
		await seedAccount(store, { username: 'admin', email: ADMIN_EMAIL })
		expect((await health()).oauthAdmin).toEqual({ status: 'ok', username: 'admin' })
		await seedAccount(store, { username: 'twin', email: ADMIN_EMAIL.toUpperCase() })
		expect((await health()).oauthAdmin).toEqual({ status: 'ambiguous', username: null })
		await sql(store, 'DELETE FROM local_accounts WHERE email = ?', ADMIN_EMAIL.toUpperCase())
		await sql(store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect((await health()).oauthAdmin).toEqual({ status: 'suspended', username: 'admin' })
		await sql(store, "UPDATE instance_settings SET value = '' WHERE name = 'admin_email'")
		expect((await health()).oauthAdmin).toEqual({ status: 'unset', username: null })
	})

	it('is not shown to the import token', async () => {
		const IMPORT_TOKEN = 'import-token-0123456789abcdef0123456789'
		const { request } = adminHarness(await migratedStore(), team, { IMPORT_TOKEN })
		const response = await request('/admin/health', { headers: { 'Kopje-Import-Token': IMPORT_TOKEN } })
		expect(response.status).toBe(200)
		expect(await response.json()).not.toHaveProperty('oauthAdmin')
	})
})
