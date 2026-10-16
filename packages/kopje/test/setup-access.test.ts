import { runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import {
	ACCOUNT_ID,
	accessFields,
	accessRecord,
	ADMIN,
	API_TOKEN,
	fragmentsOf,
	pageText,
	readyBrowser,
	SERVICE_TOKEN_CLIENT_ID,
	setupHarness,
	type SetupHarness,
	setupLogin,
	setupPost,
	storeWith,
	completeWizard,
} from './setup-helpers'
import { setCookies, signIn } from './web-helpers'
import { ACCESS_LEASE_MS, ACCESS_SUPERSEDE_GRACE_MS } from '../src/domain/setup'
import { CloudflareApiError, cloudflareApi } from '../src/platform/cloudflare-api'
import type { StoreStub } from '../src/platform/store-client'
import { storeMaintenanceError } from '../src/platform/store-errors'
import { sha256Hex } from '../src/security/tokens'

// Steps 2 and 3 of /setup against a strict fake of the Cloudflare API: the organization check, managed ids and
// adoption, pagination, the Store's coordination of runs (SETUP-2, SETUP-3) and SETUP-4.

afterEach(() => {
	vi.restoreAllMocks()
})

async function settings(h: SetupHarness): Promise<Record<string, string>> {
	const rows = await sql<{ name: string; value: string }>(h.store, 'SELECT name, value FROM instance_settings')
	return Object.fromEntries(rows.map((row) => [row.name, row.value]))
}

const accessPost = (h: SetupHarness, cookie: string, extra: Record<string, string> = {}, token = API_TOKEN) =>
	setupPost(h, cookie, '/setup/access', accessFields(h, token, extra))

const adminPost = (h: SetupHarness, cookie: string, email = ADMIN, username = 'owner') =>
	setupPost(h, cookie, '/setup/admin', { username, email })

function linked(app: Record<string, unknown> | undefined): string[] {
	return ((app?.policies ?? []) as { id: string }[]).map((p) => p.id)
}

describe('/setup Access: what is made', () => {
	it('checks the organization before any write, makes both applications and the policy, and drafts the AUD tags', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		const response = await accessPost(h, browser.cookie)
		expect(response.status).toBe(200)
		const firstWrite = h.cf.calls.findIndex((call) => call.method !== 'GET')
		const org = h.cf.calls.findIndex((call) => call.path === `/accounts/${ACCOUNT_ID}/access/organizations`)
		expect(org).toBeGreaterThanOrEqual(0)
		expect(org).toBeLessThan(firstWrite)
		expect(h.cf.apps.map((app) => [app.name, app.type, app.domain, app.destinations])).toEqual([
			[
				'Kopje kopje.test sign-in',
				'self_hosted',
				'kopje.test/oauth/authorize',
				[{ type: 'public', uri: 'kopje.test/oauth/authorize' }],
			],
			['Kopje kopje.test admin', 'self_hosted', 'kopje.test/admin', [{ type: 'public', uri: 'kopje.test/admin' }]],
		])
		expect(h.cf.policies).toEqual([
			expect.objectContaining({
				name: 'Kopje kopje.test admin',
				decision: 'allow',
				include: [{ email: { email: ADMIN } }],
			}),
		])
		expect(await settings(h)).toEqual({})
		const record = await accessRecord(h)
		expect(record).toMatchObject({ revision: 1, reservation: null, needsReconcile: false, completed: { revision: 1 } })
		expect(record?.managed).toEqual({
			accountId: ACCOUNT_ID,
			adminPolicyId: h.cf.policies[0]?.id,
			signInAppId: h.cf.apps[0]?.id,
			adminAppId: h.cf.apps[1]?.id,
		})
	})

	it('updates the managed objects by id on a run again, adds and drops the CLI policy, and never duplicates', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		await accessPost(h, browser.cookie)
		const ids = h.cf.apps.map((app) => app.id)
		h.cf.calls.length = 0
		const withCli = await accessPost(
			h,
			browser.cookie,
			{ service_token_client_id: SERVICE_TOKEN_CLIENT_ID },
			'fresh-token-0123456789'
		)
		expect(withCli.status).toBe(200)
		expect(h.cf.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/apps'))).toEqual([])
		expect(h.cf.writes().map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/g, ':id')}`)).toEqual([
			`PUT /accounts/${ACCOUNT_ID}/access/policies/:id`,
			`POST /accounts/${ACCOUNT_ID}/access/policies`,
			`PUT /accounts/${ACCOUNT_ID}/access/apps/:id`,
			`PUT /accounts/${ACCOUNT_ID}/access/apps/:id`,
		])
		expect(h.cf.apps.map((app) => app.id)).toEqual(ids)
		const cli = h.cf.policies[1]
		expect(cli).toMatchObject({ decision: 'non_identity', include: [{ service_token: { token_id: 'token-uuid-1' } }] })
		expect(linked(h.cf.apps[1])).toEqual([h.cf.policies[0]?.id, cli?.id])
		expect(new Set(h.cf.calls.map((call) => call.token))).toEqual(new Set(['fresh-token-0123456789']))

		const without = await accessPost(h, browser.cookie)
		expect(without.status).toBe(200)
		expect(linked(h.cf.apps[1])).toEqual([h.cf.policies[0]?.id])
		expect(h.cf.apps).toHaveLength(2)
		expect(h.cf.policies).toHaveLength(2)
	})

	it('refuses a team that is not the selected account’s organization, before any write', async () => {
		const h = await setupHarness()
		h.cf.accounts[0] = { id: ACCOUNT_ID, name: 'Operator', authDomain: 'someone-else.cloudflareaccess.com' }
		const browser = await readyBrowser(h)
		const response = await accessPost(h, browser.cookie)
		expect(response.status).toBe(422)
		expect(await response.text()).toContain('the team is not this account&#39;s Zero Trust organization')
		expect(h.cf.writes()).toEqual([])
		expect(await accessRecord(h)).toMatchObject({ completed: null, needsReconcile: true })
	})

	it('needs the organizations permission, and says so', async () => {
		const h = await setupHarness()
		h.cf.permissions.delete('org')
		const browser = await readyBrowser(h)
		const response = await accessPost(h, browser.cookie)
		expect(response.status).toBe(422)
		expect(await response.text()).toContain('the token lacks a permission this step needs')
		expect(h.cf.writes()).toEqual([])
	})

	it('asks for the account ID when the token reaches more than one account', async () => {
		const h = await setupHarness()
		h.cf.accounts.push({ id: 'f'.repeat(32), name: 'Other', authDomain: 'other.cloudflareaccess.com' })
		const browser = await readyBrowser(h)
		const refused = await accessPost(h, browser.cookie)
		expect(refused.status).toBe(422)
		expect(await refused.text()).toContain('reaches several accounts; enter the account ID')
		expect((await accessPost(h, browser.cookie, { account_id: ACCOUNT_ID })).status).toBe(200)
	})

	it('says what to give the token when it reaches no account', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		const accounts = h.cf.accounts.splice(0)
		const refused = await accessPost(h, browser.cookie)
		expect(refused.status).toBe(422)
		expect(await refused.text()).toContain('reaches no account; give it Account Settings Read, or enter the account ID')
		h.cf.accounts.push(...accounts)
		expect((await accessPost(h, browser.cookie, { account_id: ACCOUNT_ID })).status).toBe(200)
	})
})

describe('/setup Access: listings', () => {
	it('reads every page of a listing, so an object far down is found', async () => {
		const h = await setupHarness()
		for (let i = 0; i < 130; i++) {
			h.cf.policies.push({
				id: crypto.randomUUID(),
				name: `other ${i}`,
				decision: 'allow',
				include: [{ everyone: {} }],
			})
		}
		const ours = {
			id: crypto.randomUUID(),
			name: 'Kopje kopje.test admin',
			decision: 'allow',
			include: [{ everyone: {} }],
		}
		h.cf.policies.push(ours)
		const browser = await readyBrowser(h)
		expect((await accessPost(h, browser.cookie)).status).toBe(200)
		expect(h.cf.policies).toHaveLength(131)
		expect(ours.include).toEqual([{ email: { email: ADMIN } }])
	})

	it('fails rather than act on a listing longer than it reads', async () => {
		const h = await setupHarness()
		for (let i = 0; i < 50 * 20 + 1; i++) {
			h.cf.policies.push({
				id: crypto.randomUUID(),
				name: `other ${i}`,
				decision: 'allow',
				include: [{ everyone: {} }],
			})
		}
		const browser = await readyBrowser(h)
		const response = await accessPost(h, browser.cookie)
		expect(response.status).toBe(422)
		expect(await response.text()).toContain('the listing is longer than Kopje reads')
		expect(h.cf.writes()).toEqual([])
	})
})

describe('/setup Access: objects found by name', () => {
	const app = (name: string, uri: string, policies: { id: string; precedence: number }[] = []) => ({
		id: crypto.randomUUID(),
		name,
		type: 'self_hosted',
		domain: uri,
		destinations: [{ type: 'public', uri }],
		policies,
		aud: 'f'.repeat(64),
	})

	it('adopts the one valid object of each expected name', async () => {
		const h = await setupHarness()
		const existing = app('Kopje kopje.test sign-in', 'kopje.test/oauth/authorize')
		h.cf.apps.push(existing)
		const browser = await readyBrowser(h)
		expect((await accessPost(h, browser.cookie)).status).toBe(200)
		expect(h.cf.apps.map((a) => a.id)[0]).toBe(existing.id)
		expect(h.cf.apps).toHaveLength(2)
		expect((await accessRecord(h))?.managed.signInAppId).toBe(existing.id)
	})

	it('refuses an application of the expected name for another destination, unless adopting deliberately', async () => {
		const h = await setupHarness()
		const foreign = app('Kopje kopje.test sign-in', 'kopje.test/elsewhere')
		h.cf.apps.push(foreign)
		const browser = await readyBrowser(h)
		const refused = await accessPost(h, browser.cookie)
		expect(refused.status).toBe(422)
		expect(await refused.text()).toContain('is not what Kopje expects')
		expect(h.cf.writes()).toEqual([])
		expect(foreign.domain).toBe('kopje.test/elsewhere')

		expect((await accessPost(h, browser.cookie, { mode: 'adopt' })).status).toBe(200)
		expect(foreign.domain).toBe('kopje.test/oauth/authorize')
		expect(h.cf.apps).toHaveLength(2)
	})

	it('refuses ambiguous names, and creates new objects when asked to', async () => {
		const h = await setupHarness()
		h.cf.apps.push(app('Kopje kopje.test admin', 'kopje.test/admin'), app('Kopje kopje.test admin', 'kopje.test/admin'))
		const browser = await readyBrowser(h)
		for (const mode of ['reconcile', 'adopt']) {
			const refused = await accessPost(h, browser.cookie, { mode })
			expect(refused.status, mode).toBe(422)
			expect(await refused.text()).toContain('several objects have this name')
		}
		expect(h.cf.writes()).toEqual([])
		expect((await accessPost(h, browser.cookie, { mode: 'recreate' })).status).toBe(200)
		expect(h.cf.apps).toHaveLength(4)
		const managed = (await accessRecord(h))?.managed
		expect([managed?.signInAppId, managed?.adminAppId]).toEqual([h.cf.apps[2]?.id, h.cf.apps[3]?.id])
		// The run after uses the managed ids, so the duplicates no longer matter.
		expect((await accessPost(h, browser.cookie)).status).toBe(200)
		expect(h.cf.apps).toHaveLength(4)
	})

	it('refuses a reusable policy attached to other applications, unless adopting deliberately', async () => {
		const h = await setupHarness()
		const shared = {
			id: crypto.randomUUID(),
			name: 'Kopje kopje.test admin',
			decision: 'allow',
			include: [{ everyone: {} }],
		}
		h.cf.policies.push(shared)
		h.cf.apps.push(app('Payroll', 'payroll.kopje.test', [{ id: shared.id, precedence: 1 }]))
		const browser = await readyBrowser(h)
		const refused = await accessPost(h, browser.cookie)
		expect(refused.status).toBe(422)
		expect(await refused.text()).toContain('attached to other applications too')
		expect(shared.include).toEqual([{ everyone: {} }])
		expect(h.cf.writes()).toEqual([])
		expect(await pageText(h, browser.cookie)).toContain('did not finish')

		expect((await accessPost(h, browser.cookie, { mode: 'adopt' })).status).toBe(200)
		expect(shared.include).toEqual([{ email: { email: ADMIN } }])
	})

	it('finds an object again by name when its managed id is gone', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		await accessPost(h, browser.cookie)
		h.cf.apps.splice(1, 1)
		expect((await accessPost(h, browser.cookie)).status).toBe(200)
		expect(h.cf.apps.map((a) => a.name)).toEqual(['Kopje kopje.test sign-in', 'Kopje kopje.test admin'])
	})
})

describe('/setup Access: coordination through the Store (SETUP-2, SETUP-3)', () => {
	it('concurrent first runs make one set of objects', async () => {
		const h = await setupHarness()
		const a = await readyBrowser(h)
		const b = await readyBrowser(h)
		const held = h.cf.hold((method, path) => method === 'POST' && path.endsWith('/policies'))
		const first = accessPost(h, a.cookie)
		await held.reached
		const second = await accessPost(h, b.cookie)
		expect(second.status).toBe(422)
		expect(await second.text()).toContain('Another run of this step is in progress')
		held.release()
		expect((await first).status).toBe(200)
		expect(h.cf.apps).toHaveLength(2)
		expect(h.cf.policies).toHaveLength(1)
		expect(await accessRecord(h)).toMatchObject({ revision: 1, reservation: null, completed: { revision: 1 } })
		expect(await pageText(h, b.cookie)).not.toContain('action="/setup/admin"')
	})

	it('only the latest completed run bootstraps: an operator with an older draft for another email cannot', async () => {
		const h = await setupHarness()
		const a = await readyBrowser(h)
		const b = await readyBrowser(h)
		expect((await accessPost(h, a.cookie)).status).toBe(200)
		expect((await accessPost(h, b.cookie, { admin_email: 'other@example.com' })).status).toBe(200)
		expect(await pageText(h, a.cookie)).toContain('Another run of this step replaced the one this browser made')
		const stale = await adminPost(h, a.cookie)
		expect(stale.status).toBe(422)
		expect(await stale.text()).toContain('must complete again first')
		expect(await sql(h.store, 'SELECT * FROM local_accounts')).toEqual([])
		expect(h.cf.policies[0]?.include).toEqual([{ email: { email: 'other@example.com' } }])

		expect((await adminPost(h, b.cookie, 'other@example.com')).status).toBe(303)
		expect((await settings(h)).admin_email).toBe('other@example.com')
	})

	it('a run paused before its reservation makes no external write after bootstrap', async () => {
		const h = await setupHarness()
		const a = await readyBrowser(h)
		const b = await readyBrowser(h)
		await accessPost(h, a.cookie)
		const held = h.cf.hold((_method, url) => url.endsWith('/cdn-cgi/access/certs'))
		const late = accessPost(h, b.cookie, { admin_email: 'mallory@example.com' }, 'late-token-0123456789')
		await held.reached
		expect((await adminPost(h, a.cookie)).status).toBe(303)
		held.release()
		expect((await late).status).toBe(403)
		expect(h.cf.calls.filter((call) => call.token === 'late-token-0123456789')).toEqual([])
		expect(h.cf.policies[0]?.include).toEqual([{ email: { email: ADMIN } }])
	})

	it('bootstrap waits while a run is in progress, and then needs that run’s outcome', async () => {
		const h = await setupHarness()
		const a = await readyBrowser(h)
		const b = await readyBrowser(h)
		await accessPost(h, a.cookie)
		const held = h.cf.hold((method) => method === 'PUT')
		const running = accessPost(h, b.cookie)
		await held.reached
		const waiting = await adminPost(h, a.cookie)
		expect(waiting.status).toBe(422)
		expect(await sql(h.store, 'SELECT * FROM local_accounts')).toEqual([])
		held.release()
		expect((await running).status).toBe(200)
		expect((await adminPost(h, a.cookie)).status).toBe(422)
		expect((await adminPost(h, b.cookie)).status).toBe(303)
	})

	it('a run whose checkpoint answer arrives after its lease dispatches nothing; the next waits out the grace', async () => {
		let release = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let reached = () => {}
		const reachedPromise = new Promise<void>((resolve) => {
			reached = resolve
		})
		let holding = true
		const h = await setupHarness({
			wrapStore: (store) =>
				storeWith(store, {
					checkpointAccess: async (...args: unknown[]) => {
						const answer = await (store.checkpointAccess as (...a: unknown[]) => Promise<unknown>)(...args)
						if (holding) {
							holding = false
							reached()
							await gate
						}
						return answer
					},
				}),
		})
		const a = await readyBrowser(h)
		const b = await readyBrowser(h)
		const slow = accessPost(h, a.cookie, { admin_email: 'a@example.com' }, 'slow-token-0123456789')
		await reachedPromise
		h.advance(ACCESS_LEASE_MS + 1000)
		const early = await accessPost(h, b.cookie, {}, 'quick-token-0123456789')
		expect(early.status).toBe(422)
		expect(await early.text()).toContain('Another run of this step is in progress')
		h.advance(ACCESS_SUPERSEDE_GRACE_MS)
		expect((await accessPost(h, b.cookie, {}, 'quick-token-0123456789')).status).toBe(200)
		expect((await adminPost(h, b.cookie)).status).toBe(303)
		release()
		const stopped = await slow
		expect(stopped.status).toBe(422)
		expect(await stopped.text()).toContain('This run was stopped')
		expect(h.cf.writes().filter((call) => call.token === 'slow-token-0123456789')).toEqual([])
		expect(h.cf.policies.map((p) => p.include)).toEqual([[{ email: { email: ADMIN } }]])
		const record = await accessRecord(h)
		expect(record).toMatchObject({ revision: 2, completed: { revision: 2 }, lateFailure: { revision: 1 } })
		expect((await settings(h)).admin_email).toBe(ADMIN)
	})

	it('an abandoned run leaves the state unresolved, and bootstrap is refused until a run completes', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		await accessPost(h, browser.cookie)
		const sessionHash = await sha256Hex(browser.secret)
		const authority = { kind: 'setup' as const, sessionHash }
		const reserved = await h.store.reserveAccess(BUILD, {
			authority,
			domain: 'kopje.test',
			adminEmail: ADMIN,
			now: NOW,
		})
		expect(reserved.status).toBe('ok')
		h.advance(ACCESS_LEASE_MS + ACCESS_SUPERSEDE_GRACE_MS + 1000)
		expect(await pageText(h, browser.cookie)).toContain('did not finish')
		expect((await adminPost(h, browser.cookie)).status).toBe(422)
		expect((await accessPost(h, browser.cookie)).status).toBe(200)
		expect((await adminPost(h, browser.cookie)).status).toBe(303)
	})

	for (const n of [1, 2, 3, 4]) {
		it(`a failure after external write ${n} of 4 leaves the state unresolved; a run again completes without copies`, async () => {
			const h = await setupHarness()
			const browser = await readyBrowser(h)
			h.cf.failAfterWrite(n)
			const failed = await accessPost(h, browser.cookie, { service_token_client_id: SERVICE_TOKEN_CLIENT_ID })
			expect(failed.status).toBe(422)
			expect(h.cf.writes()).toHaveLength(n)
			expect(await accessRecord(h)).toMatchObject({ reservation: null, needsReconcile: true, completed: null })
			expect(await pageText(h, browser.cookie)).toContain('did not finish')
			expect((await adminPost(h, browser.cookie)).status).toBe(422)

			const again = await accessPost(h, browser.cookie, { service_token_client_id: SERVICE_TOKEN_CLIENT_ID })
			expect(again.status).toBe(200)
			expect(h.cf.policies.map((p) => p.name)).toEqual(['Kopje kopje.test admin', 'Kopje kopje.test admin CLI'])
			expect(h.cf.apps.map((a) => a.name)).toEqual(['Kopje kopje.test sign-in', 'Kopje kopje.test admin'])
			expect(linked(h.cf.apps[1])).toEqual(h.cf.policies.map((p) => p.id))
			expect(await accessRecord(h)).toMatchObject({ needsReconcile: false, completed: { revision: 2 } })
			expect((await adminPost(h, browser.cookie)).status).toBe(303)
			expect((await settings(h)).access_aud).toBe(h.cf.apps[0]?.aud)
		})
	}
})

describe('/setup Access: SETUP-4', () => {
	it('SETUP-4: uses the API token in its own request only, and never stores, logs, renders or redirects it', async () => {
		const logs: unknown[] = []
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args)
			})
		}
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		const responses = [
			await accessPost(h, browser.cookie),
			await setupPost(h, browser.cookie, '/setup/check/bot-fight', { api_token: API_TOKEN }),
			await adminPost(h, browser.cookie),
			await h.request('/setup', { headers: { cookie: browser.cookie } }),
		]
		const texts: string[] = []
		for (const response of responses) {
			texts.push(await response.text(), response.headers.get('location') ?? '', setCookies(response).lines.join('\n'))
		}
		const stored = await runInDurableObject(h.store, (_instance, state) =>
			['kopje_state', 'instance_settings', 'accounts', 'local_accounts']
				.map((table) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()))
				.join('\n')
		)
		expect(fragmentsOf(API_TOKEN, [...texts, JSON.stringify(logs), stored].join('\n'))).toEqual([])
		// Sent only to the API, as a bearer token, never in a URL.
		for (const [input, init] of h.cf.fetch.mock.calls) {
			const request = new Request(input, init)
			expect(request.url).not.toContain(API_TOKEN)
			if (request.headers.get('authorization') !== null) {
				expect(new URL(request.url).host).toBe('api.cloudflare.com')
			}
		}
	})

	it('shows no fragment of the token for an echoed error across a truncation boundary, a thrown name or a redirect', async () => {
		const logs: unknown[] = []
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args)
			})
		}
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		const texts: string[] = []
		const check = async (response: Response, contains: string, status = 422) => {
			const text = await response.text()
			expect(response.status).toBe(status)
			expect(text).toContain(contains)
			texts.push(text, response.headers.get('location') ?? '', setCookies(response).lines.join('\n'))
		}
		h.cf.failNext(403, (token) => `${'x'.repeat(195)}${token}`)
		await check(await accessPost(h, browser.cookie), 'lacks a permission')
		h.cf.throwNext()
		await check(await accessPost(h, browser.cookie), 'could not be reached')
		h.cf.redirectNext()
		await check(await accessPost(h, browser.cookie), 'answered with a redirect')
		expect(
			h.cf.fetch.mock.calls.some(([input]) =>
				String(input instanceof Request ? input.url : input).includes('evil.test')
			)
		).toBe(false)
		h.cf.failNext(403, (token) => `${'x'.repeat(195)}${token}`)
		await check(
			await setupPost(h, browser.cookie, '/setup/check/bot-fight', { api_token: API_TOKEN }),
			'Could not read the setting',
			200
		)
		const stored = await runInDurableObject(h.store, (_instance, state) =>
			JSON.stringify(state.storage.sql.exec('SELECT * FROM kopje_state').toArray())
		)
		const everything = [...texts, JSON.stringify(logs), stored].join('\n')
		expect(fragmentsOf(API_TOKEN, everything)).toEqual([])
	})
})

describe('/setup Access after bootstrap: the admin’s runs', () => {
	// A bootstrapped instance and its admin, signed in to the web UI.
	async function adminRun(wrapStore?: (store: StoreStub) => StoreStub) {
		const h = await setupHarness({ wrapStore })
		await completeWizard(h, await setupLogin(h))
		const admin = await signIn(h.asApi, ADMIN)
		const run = (extra: Record<string, string> = {}, token = 'admin-run-token-0123456789') =>
			accessPost(h, admin.cookie, extra, token)
		return { h, admin, run }
	}

	const holdFirstAppRead = (h: SetupHarness) =>
		h.cf.hold((method, path) => method === 'GET' && /\/apps\/[0-9a-f-]{36}$/.test(path))

	it('stops at the next checkpoint when the admin’s session expires during the run', async () => {
		const { h, admin, run } = await adminRun()
		await sql(
			h.store,
			'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?',
			new Date(NOW + 60_000).toISOString(),
			await sha256Hex(admin.session)
		)
		const held = holdFirstAppRead(h)
		const running = run()
		await held.reached
		h.advance(70_000)
		held.release()
		const stopped = await running
		expect(stopped.status).toBe(422)
		expect(await stopped.text()).toContain('This run was stopped')
		expect(h.cf.writes().filter((call) => call.token === 'admin-run-token-0123456789')).toEqual([])
	})

	for (const [name, end] of [
		[
			'signs out',
			async (h: SetupHarness, cookie: string) => {
				const csrf = /name="csrf" value="([^"]+)"/.exec(await pageText(h, cookie))?.[1] ?? ''
				await h.request('/logout', {
					method: 'POST',
					headers: { cookie, origin: 'https://kopje.test', 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ csrf }).toString(),
				})
			},
		],
		[
			'is suspended',
			async (h: SetupHarness) => {
				await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-10-12T00:00:00.000Z'")
			},
		],
		[
			// The OAuth admin's fail-closed match (adminAccountId): a second account whose email differs only in case.
			'stops being the only match for admin_email',
			async (h: SetupHarness) => {
				await seedAccount(h.store, { username: 'twin', email: ADMIN.toUpperCase() })
			},
		],
	] as const) {
		it(`stops at the next checkpoint when the admin ${name} during the run`, async () => {
			const { h, admin, run } = await adminRun()
			const held = holdFirstAppRead(h)
			const running = run()
			await held.reached
			await end(h, admin.cookie)
			held.release()
			expect((await running).status).toBe(422)
			expect(h.cf.writes().filter((call) => call.token === 'admin-run-token-0123456789')).toEqual([])
		})
	}

	it('recovers from a failed run', async () => {
		const { h, admin, run } = await adminRun()
		h.cf.failAfterWrite(2)
		expect((await run({ service_token_client_id: SERVICE_TOKEN_CLIENT_ID })).status).toBe(422)
		expect(await pageText(h, admin.cookie)).toContain('did not finish')
		expect((await run({ service_token_client_id: SERVICE_TOKEN_CLIENT_ID })).status).toBe(200)
		expect(await pageText(h, admin.cookie)).not.toContain('did not finish')
		expect((await settings(h)).access_service_token_client_id).toBe(SERVICE_TOKEN_CLIENT_ID)
		expect(h.cf.policies).toHaveLength(2)
	})

	it('recovers from an abandoned run once its lease and the grace have passed', async () => {
		const { h, admin, run } = await adminRun()
		const credential = { tokenHash: await sha256Hex(admin.session), scope: 'write:accounts' as const, now: NOW }
		const reserved = await h.store.reserveAccess(BUILD, {
			authority: { kind: 'admin', credential },
			domain: 'kopje.test',
			adminEmail: ADMIN,
			now: NOW,
		})
		expect(reserved.status).toBe('ok')
		expect((await run()).status).toBe(422)
		h.advance(ACCESS_LEASE_MS + ACCESS_SUPERSEDE_GRACE_MS + 1000)
		expect(await pageText(h, admin.cookie)).toContain('did not finish')
		expect((await run()).status).toBe(200)
		expect(h.cf.apps).toHaveLength(2)
	})

	it('recovers from a Store refusal at a checkpoint', async () => {
		let refuse = false
		const { h, admin, run } = await adminRun((store) =>
			storeWith(store, {
				checkpointAccess: async (...args: unknown[]) => {
					if (refuse) {
						refuse = false
						throw storeMaintenanceError('maintenance')
					}
					return (store.checkpointAccess as (...a: unknown[]) => Promise<unknown>)(...args)
				},
			})
		)
		refuse = true
		const writes = h.cf.writes().length
		expect((await run()).status).toBe(422)
		expect(h.cf.writes().length).toBe(writes)
		expect(await pageText(h, admin.cookie)).toContain('did not finish')
		expect((await run()).status).toBe(200)
	})

	it('recovers from a Store refusal at the final completion', async () => {
		let refuse = false
		const { h, admin, run } = await adminRun((store) =>
			storeWith(store, {
				completeAccess: async (...args: unknown[]) => {
					if (refuse) {
						refuse = false
						throw storeMaintenanceError('maintenance')
					}
					return (store.completeAccess as (...a: unknown[]) => Promise<unknown>)(...args)
				},
			})
		)
		refuse = true
		expect((await run()).status).toBe(503)
		expect(await pageText(h, admin.cookie)).toContain('A run of this step is in progress')
		h.advance(ACCESS_LEASE_MS + ACCESS_SUPERSEDE_GRACE_MS + 1000)
		expect(await pageText(h, admin.cookie)).toContain('did not finish')
		expect((await run()).status).toBe(200)
		expect(h.cf.apps).toHaveLength(2)
		expect(h.cf.policies).toHaveLength(1)
	})
})

describe('/setup Access: listing metadata', () => {
	// A listing of pages as the given answers, recording the pages asked for.
	function pages(answers: Record<string, unknown>[]) {
		const asked: string[] = []
		const fetcher = vi.fn<typeof fetch>((input) => {
			const url = new URL(input instanceof Request ? input.url : input.toString())
			asked.push(`${url.searchParams.get('page')}/${url.searchParams.get('per_page')}`)
			const answer = answers[asked.length - 1] ?? { result: [] }
			return Promise.resolve(Response.json({ success: true, errors: [], ...answer }))
		})
		return { api: cloudflareApi('t', fetcher), asked }
	}
	const items = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `${from + i}` }))

	it('follows total_pages past a short page', async () => {
		const { api, asked } = pages([
			{ result: items(2), result_info: { page: 1, per_page: 50, total_pages: 2 } },
			{ result: items(1, 2), result_info: { page: 2, per_page: 50, total_pages: 2 } },
		])
		expect(await api.list('x', '/x', 50)).toHaveLength(3)
		expect(asked).toEqual(['1/50', '2/50'])
	})

	it('follows a clamped page size when total_pages is missing', async () => {
		const { api, asked } = pages([
			{ result: items(10), result_info: { per_page: 10 } },
			{ result: items(10, 10), result_info: { per_page: 10 } },
			{ result: items(3, 20), result_info: { per_page: 10 } },
		])
		expect(await api.list('x', '/x', 50)).toHaveLength(23)
		expect(asked).toHaveLength(3)
	})

	it('reads on after full pages without metadata, and stops at a short or empty one', async () => {
		const full = pages([{ result: items(50) }, { result: items(50, 50) }, { result: [] }])
		expect(await full.api.list('x', '/x', 50)).toHaveLength(100)
		expect(full.asked).toHaveLength(3)
		const short = pages([{ result: items(7) }])
		expect(await short.api.list('x', '/x', 50)).toHaveLength(7)
		expect(short.asked).toHaveLength(1)
	})

	it('reads every page of accounts and service tokens', async () => {
		const h = await setupHarness()
		for (let i = 0; i < 59; i++) {
			h.cf.accounts.push({ id: i.toString(16).padStart(32, 'a'), name: `a${i}`, authDomain: 'x.cloudflareaccess.com' })
		}
		const browser = await readyBrowser(h)
		const refused = await accessPost(h, browser.cookie)
		expect(await refused.text()).toContain('enter the account ID')
		expect(h.cf.calls.filter((call) => call.path === '/accounts')).toHaveLength(2)

		h.cf.accounts.splice(1)
		h.cf.serviceTokens = [
			...Array.from({ length: 120 }, (_, i) => ({ id: `other-${i}`, client_id: `other-${i}.access`, name: 'x' })),
			{ id: 'ours-token', client_id: SERVICE_TOKEN_CLIENT_ID, name: 'cli' },
		]
		expect((await accessPost(h, browser.cookie, { service_token_client_id: SERVICE_TOKEN_CLIENT_ID })).status).toBe(200)
		expect(h.cf.policies[1]?.include).toEqual([{ service_token: { token_id: 'ours-token' } }])
	})
})

describe('/setup Access: validation of what Cloudflare holds and answers', () => {
	const app = (overrides: Record<string, unknown>) => ({
		id: crypto.randomUUID(),
		name: 'Kopje kopje.test sign-in',
		type: 'self_hosted',
		domain: 'kopje.test/oauth/authorize',
		destinations: [{ type: 'public', uri: 'kopje.test/oauth/authorize' }],
		policies: [],
		aud: 'f'.repeat(64),
		...overrides,
	})

	for (const [label, overrides] of [
		['another application type', { type: 'warp' }],
		[
			'an extra destination',
			{
				destinations: [
					{ type: 'public', uri: 'kopje.test/oauth/authorize' },
					{ type: 'public', uri: 'kopje.test/settings' },
				],
			},
		],
	] as const) {
		it(`refuses to take over an application with ${label}`, async () => {
			const h = await setupHarness()
			h.cf.apps.push(app(overrides))
			const browser = await readyBrowser(h)
			const refused = await accessPost(h, browser.cookie)
			expect(refused.status).toBe(422)
			expect(await refused.text()).toContain('is not what Kopje expects')
			expect(h.cf.writes()).toEqual([])
		})
	}

	it('refuses a policy whose app_count is missing, unless adopting', async () => {
		const h = await setupHarness()
		h.cf.omitAppCount = true
		h.cf.policies.push({
			id: crypto.randomUUID(),
			name: 'Kopje kopje.test admin',
			decision: 'allow',
			include: [{ everyone: {} }],
		})
		const browser = await readyBrowser(h)
		const refused = await accessPost(h, browser.cookie)
		expect(await refused.text()).toContain('attached to other applications too')
		expect(h.cf.writes()).toEqual([])
		expect((await accessPost(h, browser.cookie, { mode: 'adopt' })).status).toBe(200)
	})

	it('fails on a written object answered without its id, and a run again finds it', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		h.cf.stripIdNext()
		const failed = await accessPost(h, browser.cookie)
		expect(await failed.text()).toContain('answered with something unexpected')
		expect((await accessPost(h, browser.cookie)).status).toBe(200)
		expect(h.cf.policies).toHaveLength(1)
	})

	it('refuses malformed answers and keeps only valid numeric error codes', async () => {
		const answer = (body: string, status = 200) =>
			cloudflareApi('t', () =>
				Promise.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }))
			)
		const failure = async (call: Promise<unknown>) => {
			const error = await call.then(
				() => null,
				(e: unknown) => e
			)
			expect(error).toBeInstanceOf(CloudflareApiError)
			return error as CloudflareApiError
		}
		expect((await failure(answer('not json').get('x', '/x'))).category).toBe('malformed')
		expect((await failure(answer('{"success":true}').get('x', '/x'))).category).toBe('malformed')
		expect((await failure(answer('{"success":true,"result":{}}').list('x', '/x', 50))).category).toBe('malformed')
		const codes = await failure(
			answer(
				JSON.stringify({
					success: false,
					errors: [
						{ code: 1.5 },
						{ code: -3 },
						{ code: '7003' },
						{ code: 1e12 },
						{ code: 1000, message: 'secret text' },
					],
				}),
				400
			).get('x', '/x')
		)
		expect(codes.codes).toEqual([1000])
		expect(codes.message).toBe('x: the Cloudflare API refused the request [HTTP 400, codes 1000]')
	})
})
