import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, form, login, registerApp, seedAccount, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { storeWith } from './setup-helpers'
import { community } from './status-helpers'
import { instanceActorUri } from '../src/domain/activities'
import { ADMIN_ACCOUNT_CANDIDATES, adminAccountOperations, listAdminAccounts } from '../src/domain/admin-accounts'
import { ADMIN_PERMISSION, ADMIN_PERMISSIONS, adminGuarded } from '../src/domain/auth'
import { readOperation, writeOperation } from '../src/domain/operation'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// The Mastodon admin API's accounts (R37, VIS-29; Api::V1::Admin::AccountsController, Api::V2::Admin::AccountsController,
// AccountFilter and REST::Admin::AccountSerializer of Mastodon 4.5.11). Their routes need manage_users, which Kopje
// grants now that local suspension is served (admin-suspension.test.ts). A role without it is refused: the same
// operations built over a guard that lacks the bit (adminGuarded) are put in the Store's place to show it.

const OWNER = 'owner@example.com'
const SCOPES = 'read write admin:read admin:write'

const WITHOUT = ADMIN_PERMISSIONS & ~ADMIN_PERMISSION.manageUsers
const withoutUsers = adminAccountOperations(adminGuarded(readOperation, WITHOUT), adminGuarded(writeOperation, WITHOUT))

// The Store with the accounts operations of a role that lacks manage_users.
function revoke(store: StoreStub): StoreStub {
	const via =
		(operation: { run: (sql: SqlStorage, input: never) => unknown }) =>
		(_build: unknown, input: unknown): Promise<unknown> =>
			runInDurableObject(store, (_instance, state) => operation.run(state.storage.sql, input as never))
	return storeWith(store, {
		adminAccounts: via(withoutUsers.listAdminAccounts),
		adminAccount: via(withoutUsers.getAdminAccount),
		actOnAdminAccount: via(withoutUsers.actOnAdminAccount),
	})
}

type AdminAccountBody = Record<string, unknown> & {
	id: string
	username: string
	domain: string | null
	email: string | null
	suspended: boolean
	role: { id: string; name: string; permissions: string } | null
	account: { id: string; suspended?: boolean }
}

async function appToken(h: ApiHarness): Promise<string> {
	const scope = 'admin:read admin:write'
	const app = await registerApp(h, { scopes: scope })
	const response = await h.request(
		'/oauth/token',
		form({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret, scope })
	)
	return (await response.json<{ access_token: string }>()).access_token
}

async function userToken(h: ApiHarness, email: string, scope: string): Promise<string> {
	const app = await registerApp(h, { scopes: scope })
	return (await login(h, { app, scope, email })).token
}

async function call(h: ApiHarness, path: string, token: string | null, method = 'GET') {
	const response = await h.request(path, token === null ? { method } : bearer(token, { method }))
	return { status: response.status, link: response.headers.get('Link'), body: (await response.json()) as unknown }
}

// The owner (the OAuth admin), alice and bob (local, holding admin scopes too), zed (local, suspended); carol and erin
// on remote.example (erin's deletion has started), dave on other.example. `granted` false takes manage_users away.
async function world(granted = true) {
	const h = await community(['owner', 'alice', 'bob'], 'read write', granted ? {} : { wrapStore: revoke })
	await setSetting(h.store, 'admin_email', OWNER)
	const zed = await seedAccount(h.store, { username: 'zed', email: 'zed@example.com', displayName: 'Zed' })
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		zed
	)
	await sql(h.store, "UPDATE accounts SET display_name = 'Alice Liddell' WHERE id = ?", h.users.alice.id)
	const carol = await seedAccount(h.store, { username: 'carol', domain: 'remote.example', displayName: 'Carol' })
	const erin = await seedAccount(h.store, { username: 'erin', domain: 'remote.example', displayName: 'Erin' })
	await sql(h.store, 'UPDATE accounts SET deleted_at = ? WHERE id = ?', new Date(NOW).toISOString(), erin)
	const dave = await seedAccount(h.store, { username: 'dave', domain: 'other.example', displayName: 'Alicia' })
	const ids = {
		owner: h.users.owner.id,
		alice: h.users.alice.id,
		bob: h.users.bob.id,
		zed,
		carol,
		erin,
		dave,
	}
	const admin = await userToken(h, OWNER, SCOPES)
	return { h, ids, admin, alice: await userToken(h, 'alice@example.com', SCOPES) }
}

type Ids = Awaited<ReturnType<typeof world>>['ids']

// The ids of a list answer, which must be newest first.
function idsOf(body: unknown): string[] {
	const ids = (body as AdminAccountBody[]).map((account) => account.id)
	expect(ids).toEqual([...ids].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)))
	return ids
}

// The named accounts' ids, newest first.
const expected = (ids: Ids, names: (keyof Ids)[]) =>
	names.map((name) => ids[name]).sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1))

const logRows = (store: StoreStub) =>
	sql<{ account_id: string | null; action: string; target_type: string; target_id: string }>(
		store,
		'SELECT account_id, action, target_type, target_id FROM admin_actions ORDER BY id'
	)

const ROUTES: { method: string; path: (id: string) => string; scope: 'read' | 'write'; served: number }[] = [
	{ method: 'GET', path: () => '/api/v1/admin/accounts', scope: 'read', served: 200 },
	{ method: 'GET', path: () => '/api/v2/admin/accounts', scope: 'read', served: 200 },
	{ method: 'GET', path: (id) => `/api/v1/admin/accounts/${id}`, scope: 'read', served: 200 },
	{ method: 'POST', path: (id) => `/api/v1/admin/accounts/${id}/enable`, scope: 'write', served: 200 },
	{ method: 'POST', path: (id) => `/api/v1/admin/accounts/${id}/unsilence`, scope: 'write', served: 200 },
	{ method: 'POST', path: (id) => `/api/v1/admin/accounts/${id}/unsensitive`, scope: 'write', served: 200 },
	// Every account is approved: Mastodon's policy refuses approve and reject (UserPolicy#approve?, #reject?).
	{ method: 'POST', path: (id) => `/api/v1/admin/accounts/${id}/approve`, scope: 'write', served: 403 },
	{ method: 'POST', path: (id) => `/api/v1/admin/accounts/${id}/reject`, scope: 'write', served: 403 },
]

describe('admin account routes: who is answered', () => {
	it('serve the admin once manage_users is granted, and refuse a non-admin, an app token and an anonymous caller', async () => {
		const { h, ids, admin, alice } = await world()
		const app = await appToken(h)
		for (const route of ROUTES) {
			const path = route.path(ids.alice)
			const answer = await call(h, path, admin, route.method)
			expect(answer.status, `${route.method} ${path}`).toBe(route.served)
			if (route.served === 403) {
				expect(answer.body).toEqual({ error: 'This action is not allowed' })
			}
			for (const token of [alice, app, null]) {
				expect(await call(h, path, token, route.method), `${route.method} ${path}`).toMatchObject({
					status: 403,
					body: { error: 'This action is not allowed' },
				})
			}
		}
		// Only the admin's three no-ops wrote.
		expect((await logRows(h.store)).map((row) => [row.account_id, row.action])).toEqual([
			[ids.owner, 'enable'],
			[ids.owner, 'unsilence'],
			[ids.owner, 'unsensitive'],
		])
	})

	it("refuse a token without the route's scope before anything else", async () => {
		const { h, ids } = await world()
		const read = await userToken(h, OWNER, 'read admin:read:reports admin:write')
		const write = await userToken(h, OWNER, 'read admin:read admin:write:reports')
		for (const route of ROUTES) {
			const token = route.scope === 'read' ? read : write
			expect(await call(h, route.path(ids.alice), token, route.method)).toMatchObject({
				status: 403,
				body: { error: 'This action is outside the authorized scopes' },
			})
		}
		// The narrow scopes of the route are enough.
		const narrow = await userToken(h, OWNER, 'admin:read:accounts admin:write:accounts')
		for (const route of ROUTES) {
			expect((await call(h, route.path(ids.alice), narrow, route.method)).status).toBe(route.served)
		}
	})

	it('refuse the admin too without manage_users, reading and writing nothing', async () => {
		const { h, ids, admin } = await world(false)
		expect(ADMIN_PERMISSIONS & ADMIN_PERMISSION.manageUsers).toBe(ADMIN_PERMISSION.manageUsers)
		for (const route of ROUTES) {
			expect(await call(h, route.path(ids.alice), admin, route.method)).toMatchObject({
				status: 403,
				body: { error: 'This action is not allowed' },
			})
		}
		expect(await logRows(h.store)).toEqual([])
	})
})

describe('the admin account entity (REST::Admin::AccountSerializer)', () => {
	it("shows a local account's email and role, a remote account's nulls, and an unavailable one as suspended", async () => {
		const { h, ids, admin } = await world()
		const show = async (id: string) => (await call(h, `/api/v1/admin/accounts/${id}`, admin)).body as AdminAccountBody
		expect(await show(ids.alice)).toEqual({
			id: ids.alice,
			username: 'alice',
			domain: null,
			created_at: expect.any(String),
			email: 'alice@example.com',
			ip: null,
			confirmed: true,
			suspended: false,
			silenced: false,
			sensitized: false,
			disabled: false,
			approved: true,
			locale: null,
			invite_request: null,
			ips: [],
			account: expect.objectContaining({ id: ids.alice, username: 'alice', acct: 'alice' }),
			role: { id: '-99', name: '', permissions: '0', color: '', highlighted: false },
		})
		expect((await show(ids.owner)).role).toEqual({
			id: '3',
			name: 'Owner',
			permissions: String(ADMIN_PERMISSIONS),
			color: '',
			highlighted: true,
		})
		expect(await show(ids.carol)).toMatchObject({
			domain: 'remote.example',
			email: null,
			confirmed: null,
			disabled: null,
			approved: null,
			role: null,
			suspended: false,
		})
		expect(await show(ids.zed)).toMatchObject({ suspended: true, account: { suspended: true } })
		expect(await show(ids.erin)).toMatchObject({ suspended: true, account: { suspended: true } })
		expect(await call(h, '/api/v1/admin/accounts/999999999999999999', admin)).toMatchObject({
			status: 404,
			body: { error: 'Record not found' },
		})
	})

	it('has no row for the instance actor, so no list shows it', async () => {
		const { h, ids, admin } = await world()
		expect(await sql(h.store, 'SELECT id FROM accounts WHERE uri = ?', instanceActorUri('kopje.test'))).toEqual([])
		expect(idsOf((await call(h, '/api/v2/admin/accounts', admin)).body)).toEqual(
			expected(ids, ['owner', 'alice', 'bob', 'zed', 'carol', 'erin', 'dave'])
		)
	})
})

describe('the admin account actions that change nothing', () => {
	it('log enable, unsilence and unsensitive and return the account; enable needs a local account', async () => {
		const { h, ids, admin } = await world()
		const act = (id: string, action: string) => call(h, `/api/v1/admin/accounts/${id}/${action}`, admin, 'POST')
		expect(await act(ids.alice, 'enable')).toMatchObject({ status: 200, body: { id: ids.alice, disabled: false } })
		expect(await act(ids.carol, 'unsilence')).toMatchObject({ status: 200, body: { id: ids.carol, silenced: false } })
		expect(await act(ids.carol, 'unsensitive')).toMatchObject({ status: 200, body: { sensitized: false } })
		// require_local_account!: a remote account is refused; an id that is no account's is not found.
		expect(await act(ids.carol, 'enable')).toMatchObject({ status: 403, body: { error: 'This action is not allowed' } })
		expect(await act('999999999999999999', 'unsilence')).toMatchObject({ status: 404 })
		expect(await logRows(h.store)).toEqual([
			{ account_id: ids.owner, action: 'enable', target_type: 'Account', target_id: ids.alice },
			{ account_id: ids.owner, action: 'unsilence', target_type: 'Account', target_id: ids.carol },
			{ account_id: ids.owner, action: 'unsensitive', target_type: 'Account', target_id: ids.carol },
		])
	})

	it('refuse approve and reject for every account, the admin own included, and find the account first', async () => {
		const { h, ids, admin } = await world()
		for (const action of ['approve', 'reject']) {
			for (const id of [ids.alice, ids.owner, ids.carol]) {
				expect(await call(h, `/api/v1/admin/accounts/${id}/${action}`, admin, 'POST')).toMatchObject({
					status: 403,
					body: { error: 'This action is not allowed' },
				})
			}
			expect((await call(h, `/api/v1/admin/accounts/999999999999999999/${action}`, admin, 'POST')).status).toBe(404)
		}
		expect(await logRows(h.store)).toEqual([])
	})
})

describe('the admin account list: filters (AccountFilter)', () => {
	it("v1 lists active local accounts by default, and reads v1's names", async () => {
		const { h, ids, admin } = await world()
		const list = async (query: string) => idsOf((await call(h, `/api/v1/admin/accounts${query}`, admin)).body)
		expect(await list('')).toEqual(expected(ids, ['owner', 'alice', 'bob']))
		expect(await list('?local=true')).toEqual(expected(ids, ['owner', 'alice', 'bob']))
		// remote wins over local; the last state sent wins.
		expect(await list('?remote=true')).toEqual(expected(ids, ['carol', 'dave']))
		expect(await list('?local=true&remote=true')).toEqual(expected(ids, ['carol', 'dave']))
		expect(await list('?suspended=true')).toEqual(expected(ids, ['zed']))
		expect(await list('?remote=true&suspended=true')).toEqual(expected(ids, ['erin']))
		expect(await list('?active=true&suspended=true')).toEqual(expected(ids, ['zed']))
		expect(await list('?staff=true')).toEqual(expected(ids, ['owner']))
		for (const state of ['pending', 'disabled', 'silenced']) {
			expect(await list(`?${state}=true`)).toEqual([])
		}
		// sensitized is permitted by v1 but not one of the states it translates: ignored.
		expect(await list('?sensitized=true')).toEqual(expected(ids, ['owner', 'alice', 'bob']))
		// A blank value is not sent.
		expect(await list('?remote=&suspended=')).toEqual(expected(ids, ['owner', 'alice', 'bob']))
		expect(await list('?username=@ALI')).toEqual(expected(ids, ['alice']))
		expect(await list('?display_name=alice%20l')).toEqual(expected(ids, ['alice']))
		expect(await list('?email=%20Alice@')).toEqual(expected(ids, ['alice']))
		expect(await list('?ip=127.0.0.1')).toEqual([])
		// by_domain within the remote accounts (origin=remote is dropped for it), and nothing local.
		expect(await list('?remote=true&by_domain=Other.example')).toEqual(expected(ids, ['dave']))
		// by_domain replaces the origin's condition on the domain (v1's default local one included): that domain's
		// active accounts, or with a state, that state's.
		expect(await list('?by_domain=other.example')).toEqual(expected(ids, ['dave']))
		expect(await list('?by_domain=remote.example')).toEqual(expected(ids, ['carol']))
		expect(await list('?local=true&by_domain=remote.example&suspended=true')).toEqual(expected(ids, ['erin']))
		expect(await list('?remote=true&display_name=ali')).toEqual(expected(ids, ['dave']))
	})

	it("v2 reads v2's names without defaults, and answers 400 to an unknown origin or status", async () => {
		const { h, ids, admin } = await world()
		const list = async (query: string) => idsOf((await call(h, `/api/v2/admin/accounts${query}`, admin)).body)
		const all = expected(ids, ['owner', 'alice', 'bob', 'zed', 'carol', 'erin', 'dave'])
		expect(await list('')).toEqual(all)
		expect(await list('?origin=local')).toEqual(expected(ids, ['owner', 'alice', 'bob', 'zed']))
		expect(await list('?origin=remote&status=active')).toEqual(expected(ids, ['carol', 'dave']))
		expect(await list('?status=suspended')).toEqual(expected(ids, ['zed', 'erin']))
		expect(await list('?permissions=staff')).toEqual(expected(ids, ['owner']))
		expect(await list('?permissions=other')).toEqual(all)
		expect(await list('?role_ids[]=-99')).toEqual(expected(ids, ['alice', 'bob', 'zed']))
		expect(await list('?role_ids[]=3&role_ids[]=-99')).toEqual(expected(ids, ['owner', 'alice', 'bob', 'zed']))
		// role_ids as a scalar too (Array(value)), alone or with the array form.
		expect(await list('?role_ids=3')).toEqual(expected(ids, ['owner']))
		expect(await list('?role_ids=-99')).toEqual(expected(ids, ['alice', 'bob', 'zed']))
		expect(await list('?role_ids=1')).toEqual([])
		expect(await list('?role_ids=3&role_ids[]=-99')).toEqual(expected(ids, ['owner', 'alice', 'bob', 'zed']))
		// A scalar role_ids is a v2 name: the v1 names sent with it are not read (else suspended would give zed alone).
		expect(await list('?role_ids=-99&local=true&suspended=true')).toEqual(expected(ids, ['alice', 'bob', 'zed']))
		expect(await list('?role_ids[]=-99&remote=true&suspended=true')).toEqual(expected(ids, ['alice', 'bob', 'zed']))
		// by_domain replaces either origin's condition on the domain; an unknown origin is still refused.
		expect(await list('?origin=local&by_domain=other.example')).toEqual(expected(ids, ['dave']))
		expect(await list('?origin=remote&by_domain=other.example')).toEqual(expected(ids, ['dave']))
		expect(await call(h, '/api/v2/admin/accounts?origin=elsewhere&by_domain=other.example', admin)).toMatchObject({
			status: 400,
			body: { error: 'Unknown origin: elsewhere' },
		})
		for (const nothing of ['?role_ids[]=1', '?status=sensitized', '?status=pending', '?ip=::1', '?invited_by=1']) {
			expect(await list(nothing), nothing).toEqual([])
		}
		expect(await list('?username=c')).toEqual(expected(ids, ['carol']))
		expect(await list('?by_domain=remote.example')).toEqual(expected(ids, ['carol', 'erin']))
		expect(await list('?by_domain=remote.example&username=e')).toEqual(expected(ids, ['erin']))
		expect(await list('?origin=remote&by_domain=remote.example&status=active')).toEqual(expected(ids, ['carol']))
		// A v2 name present: the v1 names are not read.
		expect(await list('?origin=local&remote=true&suspended=true')).toEqual(
			expected(ids, ['owner', 'alice', 'bob', 'zed'])
		)
		expect(await call(h, '/api/v2/admin/accounts?origin=elsewhere', admin)).toMatchObject({
			status: 400,
			body: { error: 'Unknown origin: elsewhere' },
		})
		expect(await call(h, '/api/v2/admin/accounts?status=frozen', admin)).toMatchObject({
			status: 400,
			body: { error: 'Unknown status: frozen' },
		})
	})

	it('answers 400 as Mastodon does, before the policy, but after the token', async () => {
		const { h, alice } = await world()
		for (const token of [alice, null]) {
			expect(await call(h, '/api/v2/admin/accounts?origin=elsewhere', token)).toMatchObject({
				status: 400,
				body: { error: 'Unknown origin: elsewhere' },
			})
		}
		expect((await call(h, '/api/v2/admin/accounts?origin=elsewhere', 'not-a-token')).status).toBe(401)
	})

	// Fedilab sends v1's names to /api/v2/admin/accounts (MastodonAdminService#getAccounts, AdminActionActivity's
	// filter dialog): its defaults are local, remote and all five states; each choice sets the names below.
	it("reads Fedilab's v1 names sent to v2", async () => {
		const { h, ids, admin } = await world()
		const list = async (query: string) => idsOf((await call(h, `/api/v2/admin/accounts?${query}`, admin)).body)
		const states = 'active=true&pending=true&disabled=true&silenced=true&suspended=true'
		const all = expected(ids, ['owner', 'alice', 'bob', 'zed', 'carol', 'erin', 'dave'])
		expect(await list(`local=true&remote=true&${states}&limit=40`)).toEqual(all)
		// The dialog's "all" states: active, suspended and pending.
		expect(await list('local=true&remote=true&active=true&suspended=true&pending=true')).toEqual(all)
		expect(await list(`local=true&${states}`)).toEqual(expected(ids, ['owner', 'alice', 'bob', 'zed']))
		expect(await list(`remote=true&${states}`)).toEqual(expected(ids, ['carol', 'erin', 'dave']))
		expect(await list('local=true&remote=true&active=true')).toEqual(
			expected(ids, ['owner', 'alice', 'bob', 'carol', 'dave'])
		)
		expect(await list('local=true&remote=true&suspended=true')).toEqual(expected(ids, ['zed', 'erin']))
		expect(await list('remote=true&suspended=true')).toEqual(expected(ids, ['erin']))
		for (const state of ['pending', 'disabled', 'silenced']) {
			expect(await list(`local=true&remote=true&${state}=true`)).toEqual([])
		}
		expect(await list(`local=true&remote=true&${states}&staff=true`)).toEqual(expected(ids, ['owner']))
		expect(await list(`local=true&remote=true&${states}&username=da`)).toEqual(expected(ids, ['dave']))
		expect(await list(`local=true&remote=true&${states}&display_name=Ali`)).toEqual(expected(ids, ['alice', 'dave']))
		expect(await list(`local=true&remote=true&${states}&email=bob`)).toEqual(expected(ids, ['bob']))
		expect(await list(`local=true&remote=true&${states}&by_domain=remote.example`)).toEqual(
			expected(ids, ['carol', 'erin'])
		)
		expect(await list(`local=true&remote=true&${states}&ip=10.0.0.1`)).toEqual([])
		const [, second] = all
		expect(await list(`local=true&remote=true&${states}&max_id=${second}&limit=2`)).toEqual(all.slice(2, 4))
	})
})

describe('the admin account list: pages', () => {
	// `count` remote accounts on many.example, named m0, m1, ...
	async function many(store: StoreStub, count: number) {
		await sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('%018d', 900000000000000000 + i),
				'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
			count
		)
	}

	it('follows next with a strictly decreasing max_id to the end, every page full until the last', async () => {
		const { h, admin } = await world()
		await many(h.store, 25)
		let path: string | null = '/api/v2/admin/accounts?by_domain=many.example&limit=10'
		const pages: string[][] = []
		let previous: bigint | null = null
		while (path !== null) {
			const answer = await call(h, path.replace('https://kopje.test', ''), admin)
			expect(answer.status).toBe(200)
			const ids = idsOf(answer.body)
			pages.push(ids)
			const next = /<([^>]+)>; rel="next"/.exec(answer.link ?? '')?.[1] ?? null
			if (next !== null) {
				const url = new URL(next)
				expect([...url.searchParams.keys()]).toEqual(['by_domain', 'limit', 'max_id'])
				const cursor = BigInt(url.searchParams.get('max_id')!)
				expect(cursor).toBe(BigInt(ids.at(-1)!))
				if (previous !== null) {
					expect(cursor < previous).toBe(true)
				}
				previous = cursor
			}
			path = next
		}
		expect(pages.map((page) => page.length)).toEqual([10, 10, 5])
		expect(new Set(pages.flat()).size).toBe(25)
	})

	it('offers prev with min_id, which reads the newer accounts above it', async () => {
		const { h, admin } = await world()
		await many(h.store, 25)
		const first = await call(h, '/api/v2/admin/accounts?by_domain=many.example&limit=10', admin)
		const firstIds = idsOf(first.body)
		const second = await call(
			h,
			`/api/v2/admin/accounts?by_domain=many.example&limit=10&max_id=${firstIds.at(-1)}`,
			admin
		)
		const prev = /<([^>]+)>; rel="prev"/.exec(second.link ?? '')?.[1]
		expect(new URL(prev!).searchParams.get('min_id')).toBe(idsOf(second.body)[0])
		const back = await call(h, prev!.replace('https://kopje.test', ''), admin)
		expect(idsOf(back.body)).toEqual(firstIds)
		expect(back.link).toContain('rel="next"')
	})

	it("carries Fedilab's v1 names on v2's Link, and v1's own names on v1's", async () => {
		const { h, admin } = await world()
		// The effective roles: a scalar role_ids is carried as role_ids[].
		const roles = await call(h, '/api/v2/admin/accounts?role_ids=-99&limit=1', admin)
		const nextRoles = new URL(/<([^>]+)>; rel="next"/.exec(roles.link ?? '')![1]!)
		expect([...nextRoles.searchParams.entries()]).toEqual([
			['limit', '1'],
			['max_id', idsOf(roles.body)[0]!],
			['role_ids[]', '-99'],
		])
		const followed = await call(h, nextRoles.pathname + nextRoles.search, admin)
		expect(followed.body as AdminAccountBody[]).toHaveLength(1)
		expect((followed.body as AdminAccountBody[])[0]!.role).toMatchObject({ id: '-99' })
		const v2 = await call(h, '/api/v2/admin/accounts?local=true&remote=true&active=true&limit=1', admin)
		const next2 = new URL(/<([^>]+)>; rel="next"/.exec(v2.link ?? '')![1]!)
		expect(next2.pathname).toBe('/api/v2/admin/accounts')
		expect([...next2.searchParams.keys()]).toEqual(['active', 'limit', 'local', 'max_id', 'remote'])
		const v1 = await call(h, '/api/v1/admin/accounts?remote=true&limit=1&origin=local', admin)
		const next1 = new URL(/<([^>]+)>; rel="next"/.exec(v1.link ?? '')![1]!)
		expect([...next1.searchParams.keys()]).toEqual(['limit', 'max_id', 'remote'])
	})

	it('answers 422 to a search range of more than the candidate cap, and pages a narrower one', async () => {
		const { h, admin } = await world()
		await many(h.store, ADMIN_ACCOUNT_CANDIDATES + 1)
		for (const query of ['username=m', 'by_domain=many.example', 'remote=true&username=m&by_domain=many.example']) {
			expect(await call(h, `/api/v2/admin/accounts?${query}`, admin), query).toMatchObject({
				status: 422,
				body: { error: 'search term too broad; add a filter or a longer prefix' },
			})
		}
		const narrow = await call(h, '/api/v2/admin/accounts?username=m200', admin)
		expect(narrow.status).toBe(200)
		expect(idsOf(narrow.body)).toHaveLength(2)
		// The walks of every account are not candidate sets.
		expect((await call(h, '/api/v2/admin/accounts?origin=remote&limit=5', admin)).status).toBe(200)
	}, 60_000)
})

describe('the admin account list: a converted display name of any length (RES-2)', () => {
	// A converted row keeps legacy's display name, of any length: the filter matches its prefix in SQL and reads no
	// name, and the entity shows it cut.
	it('matches the prefix of a huge display name without reading it, and shows it cut', async () => {
		const { h, ids, admin } = await world()
		const huge = `Alice${'x'.repeat(1_500_000)}`
		await sql(h.store, 'UPDATE accounts SET display_name = ? WHERE id IN (?, ?)', huge, ids.carol, ids.erin)
		const list = async (query: string) => (await call(h, `/api/v2/admin/accounts?${query}`, admin)).body
		// The display name drives the read (its index range), and is a residual of the suspended accounts' read.
		const searched = (await list('origin=remote&display_name=ali')) as AdminAccountBody[]
		expect(idsOf(searched)).toEqual(expected(ids, ['carol', 'erin', 'dave']))
		const named = (await list('origin=remote&status=suspended&display_name=alicex')) as AdminAccountBody[]
		expect(idsOf(named)).toEqual(expected(ids, ['erin']))
		expect(await list('origin=remote&status=suspended&display_name=alicey')).toEqual([])
		const shown = searched.find((account) => account.id === ids.carol)!.account as unknown as { display_name: string }
		expect(shown.display_name).toBe(huge.slice(0, 2048))
		const longest = await runInDurableObject(h.store, async (_instance, state) => {
			let most = 0
			const real = state.storage.sql
			const counting = {
				exec: (query: string, ...params: SqlStorageValue[]) => {
					const cursor = real.exec(query, ...params)
					const measure = (rows: Record<string, SqlStorageValue>[]) => {
						for (const value of rows.flatMap((row) => Object.values(row))) {
							most = Math.max(most, typeof value === 'string' ? value.length : 0)
						}
						return rows
					}
					return { toArray: () => measure(cursor.toArray()), one: () => measure([cursor.one()])[0]! }
				},
			} as unknown as SqlStorage
			listAdminAccounts.run(counting, {
				credential: { tokenHash: await sha256Hex(admin), scope: 'admin:read:accounts', now: NOW },
				filter: {
					origin: 'remote',
					status: 'suspended',
					roleIds: null,
					username: null,
					byDomain: null,
					displayName: 'alicex',
					email: null,
					ip: null,
					invitedBy: null,
				},
				page: { limit: 100 },
				present: { origin: 'https://kopje.test' },
			})
			return most
		})
		// No string read is longer than a presented display name.
		expect(longest).toBeLessThanOrEqual(2048)
	})
})
