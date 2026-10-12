import { runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { BUILD } from './helpers'
import {
	ACCOUNT_ID,
	accessFields,
	ADMIN,
	API_TOKEN,
	completeWizard,
	fakeImages,
	formToken,
	SERVICE_TOKEN_CLIENT_ID,
	SETUP,
	SETUP_TOKEN,
	setupHarness,
	setupLogin,
	setupPost,
	type SetupHarness,
} from './setup-helpers'
import { setCookies, signIn, cookieHeader, SESSION } from './web-helpers'
import { hostProblem } from '../src/app/setup'
import { handleQueue } from '../src/jobs/queue'
import { handleScheduled } from '../src/jobs/scheduled'
import { ACCESS_SETTINGS } from '../src/platform/access-settings'
import { sha256Hex } from '../src/security/tokens'

afterEach(() => {
	vi.restoreAllMocks()
})

async function settings(h: SetupHarness): Promise<Record<string, string>> {
	const rows = await sql<{ name: string; value: string }>(h.store, 'SELECT name, value FROM instance_settings')
	return Object.fromEntries(rows.map((row) => [row.name, row.value]))
}

async function everyStoredText(h: SetupHarness): Promise<string> {
	return runInDurableObject(h.store, (_instance, state) => {
		const tables = state.storage.sql
			.exec<{
				name: string
			}>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")
			.toArray()
		return tables
			.map(({ name }) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()))
			.join('\n')
	})
}

// Delivers what the wizard put on the Queue to the real consumer.
async function drainQueue(h: SetupHarness) {
	const messages = h.queue.pending.splice(0).map((stored) => ({
		id: stored.id,
		body: stored.body,
		timestamp: stored.timestamp,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}))
	await handleQueue(
		{ messages, queue: 'kopje' } as unknown as MessageBatch,
		h.env,
		inboxDeps(() => h.store)
	)
	return messages
}

describe('/setup sign-in with SETUP_TOKEN', () => {
	it('opens a setup session only with the right token, in a __Host- cookie that is HttpOnly, Secure and Strict', async () => {
		const h = await setupHarness()
		const wrong = await h.request('/setup/login', {
			method: 'POST',
			headers: { origin: 'https://kopje.test', 'content-type': 'application/x-www-form-urlencoded' },
			body: 'token=not-the-token',
		})
		expect(wrong.status).toBe(403)
		expect(setCookies(wrong).lines).toEqual([])

		const response = await h.request('/setup/login', {
			method: 'POST',
			headers: { origin: 'https://kopje.test', 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: SETUP_TOKEN }).toString(),
		})
		expect(response.status).toBe(303)
		// The token never goes into a URL.
		expect(response.headers.get('location')).toBe('/setup')
		const [line = ''] = setCookies(response).lines
		expect(line).toMatch(/^__Host-kopje_setup=/)
		expect(line).toContain('HttpOnly')
		expect(line).toContain('Secure')
		expect(line).toContain('SameSite=Strict')
		expect(line).toContain('Path=/')
		expect(line).not.toContain(SETUP_TOKEN)
		// The Store keeps only the digest of the session id, and nothing of SETUP_TOKEN.
		const secret = setCookies(response).values.get(SETUP) ?? ''
		const stored = await everyStoredText(h)
		expect(stored).not.toContain(secret)
		expect(stored).not.toContain(SETUP_TOKEN)
	})

	it('AUTH-5: refuses when SETUP_TOKEN is unset or shorter than 32 characters', async () => {
		for (const token of [undefined, 'short']) {
			const h = await setupHarness({ overrides: { SETUP_TOKEN: token } })
			const response = await h.request('/setup/login', {
				method: 'POST',
				headers: { origin: 'https://kopje.test', 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ token: token ?? '' }).toString(),
			})
			expect(response.status).toBe(503)
			expect(setCookies(response).lines).toEqual([])
		}
	})

	it('WEB-1: refuses a sign-in posted from another origin, a null origin or none', async () => {
		const h = await setupHarness()
		for (const origin of ['https://evil.test', 'null', null]) {
			const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
			if (origin !== null) {
				headers.origin = origin
			}
			const response = await h.request('/setup/login', {
				method: 'POST',
				headers,
				body: new URLSearchParams({ token: SETUP_TOKEN }).toString(),
			})
			expect(response.status, String(origin)).toBe(403)
			expect(setCookies(response).lines).toEqual([])
		}
	})

	it('WEB-2, WEB-3, WEB-5: is never cached, framed, scripted or opened to other origins', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		for (const [path, cookie] of [
			['/setup', ''],
			['/setup', browser.cookie],
			['/setup/checklist', ''],
		] as const) {
			const response = await h.request(path, { headers: { cookie, origin: 'https://evil.test' } })
			expect(response.status, path).toBe(200)
			expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8')
			expect(response.headers.get('x-content-type-options')).toBe('nosniff')
			expect(response.headers.get('cache-control')).toBe('no-store')
			expect(response.headers.get('x-frame-options')).toBe('DENY')
			expect(response.headers.get('referrer-policy')).toBe('no-referrer')
			const csp = response.headers.get('content-security-policy') ?? ''
			expect(csp).toContain("default-src 'none'")
			expect(csp).toContain("frame-ancestors 'none'")
			expect(csp).not.toContain('script-src')
			expect(response.headers.get('access-control-allow-origin')).toBeNull()
		}
		const preflight = await h.request('/setup/login', {
			method: 'OPTIONS',
			headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
		})
		expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
	})
})

describe('/setup forms', () => {
	const FORMS: [string, Record<string, string>][] = [
		['/setup/domain', { domain: 'kopje.test' }],
		['/setup/access', { team: 'x', admin_email: ADMIN, api_token: API_TOKEN }],
		['/setup/check/images', {}],
		['/setup/check/queue', {}],
		['/setup/check/bot-fight', {}],
		['/setup/admin', { username: 'owner', email: ADMIN }],
		['/setup/logout', {}],
	]

	it('WEB-1, WEB-4: refuse a missing, null or foreign Origin on every form', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const csrf = await formToken(h, browser.cookie)
		for (const [path, fields] of FORMS) {
			for (const origin of [null, 'null', 'https://evil.test', 'http://kopje.test']) {
				const response = await setupPost(h, browser.cookie, path, fields, { origin, csrf })
				expect(response.status, `${path} ${String(origin)}`).toBe(403)
			}
		}
		expect(h.cf.calls).toEqual([])
		expect(h.queue.pending).toEqual([])
		expect((await settings(h)).domain).toBeUndefined()
	})

	it('WEB-4: refuse a missing or wrong anti-forgery token on every form', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const other = await setupLogin(h)
		const foreign = await formToken(h, other.cookie)
		for (const [path, fields] of FORMS) {
			for (const csrf of [null, 'wrong', foreign]) {
				const response = await setupPost(h, browser.cookie, path, fields, { csrf })
				expect(response.status, `${path} ${String(csrf)}`).toBe(403)
			}
		}
		expect(h.cf.calls).toEqual([])
	})

	it('refuse a browser without a setup session', async () => {
		const h = await setupHarness()
		const response = await setupPost(h, '', '/setup/domain', { domain: 'kopje.test' }, { csrf: 'x' })
		expect(response.status).toBe(403)
		expect((await settings(h)).domain).toBeUndefined()
	})
})

describe('/setup step 1: the domain', () => {
	it('confirms the host the request came to, and refuses workers.dev, IP addresses and ports', async () => {
		expect(hostProblem('kopje.test')).toBeNull()
		expect(hostProblem('kopje.example.workers.dev')).toMatch(/workers\.dev/)
		expect(hostProblem('workers.dev')).toMatch(/workers\.dev/)
		expect(hostProblem('192.0.2.1')).not.toBeNull()
		expect(hostProblem('kopje.test:8443')).not.toBeNull()

		const h = await setupHarness()
		const browser = await setupLogin(h)
		const other = await setupPost(h, browser.cookie, '/setup/domain', { domain: 'elsewhere.test' })
		expect(other.status).toBe(422)
		const confirmed = await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		expect(confirmed.status).toBe(303)
		expect(await (await h.request('/setup', { headers: { cookie: browser.cookie } })).text()).toContain(
			'Confirmed: kopje.test'
		)
		// A draft, not configuration: federation stays closed until the bootstrap (SETUP-1).
		expect((await settings(h)).domain).toBeUndefined()
		expect((await h.request('/.well-known/nodeinfo')).status).toBe(503)
	})

	it('refuses to confirm a workers.dev host', async () => {
		const h = await setupHarness()
		const origin = 'https://kopje.example.workers.dev'
		const login = await h.request(
			'/setup/login',
			{
				method: 'POST',
				headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ token: SETUP_TOKEN }).toString(),
			},
			origin
		)
		const cookie = `${SETUP}=${encodeURIComponent(setCookies(login).values.get(SETUP) ?? '')}`
		const page = await (await h.request('/setup', { headers: { cookie } }, origin)).text()
		const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? ''
		expect(page).toContain('workers.dev address cannot be the instance domain')
		const response = await h.request(
			'/setup/domain',
			{
				method: 'POST',
				headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ domain: 'kopje.example.workers.dev', csrf }).toString(),
			},
			origin
		)
		expect(response.status).toBe(422)
	})
})

describe('/setup steps 2 and 3: Access', () => {
	it('checks the team, creates both applications and their policy, and keeps the AUD tags in the draft', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		const response = await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('The Access applications for kopje.test are in place')
		expect(h.cf.apps.map((app) => [app.name, app.domain, app.type])).toEqual([
			['Kopje kopje.test sign-in', 'kopje.test/oauth/authorize', 'self_hosted'],
			['Kopje kopje.test admin', 'kopje.test/admin', 'self_hosted'],
		])
		expect(h.cf.policies).toEqual([
			expect.objectContaining({
				name: 'Kopje kopje.test admin',
				decision: 'allow',
				include: [{ email: { email: ADMIN } }],
			}),
		])
		// The team's key set was read before any API call.
		expect(h.cf.fetch.mock.calls[0]?.[0]).toBe(`https://${h.team.teamDomain}/cdn-cgi/access/certs`)
		// Nothing is configuration before the bootstrap.
		expect(await settings(h)).toEqual({})
	})

	it('reconciles on a run again with a fresh token instead of adding copies', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		const first = h.cf.apps.map((app) => ({ id: app.id, aud: app.aud }))
		h.cf.calls.length = 0
		const again = await setupPost(
			h,
			browser.cookie,
			'/setup/access',
			accessFields(h, 'a-fresh-token-0123456789', { service_token_client_id: SERVICE_TOKEN_CLIENT_ID })
		)
		expect(again.status).toBe(200)
		expect(h.cf.apps.map((app) => ({ id: app.id, aud: app.aud }))).toEqual(first)
		expect(h.cf.apps).toHaveLength(2)
		expect(h.cf.policies.map((p) => p.name)).toEqual(['Kopje kopje.test admin', 'Kopje kopje.test admin CLI'])
		expect(h.cf.policies[1]).toMatchObject({
			decision: 'non_identity',
			include: [{ service_token: { token_id: 'token-uuid-1' } }],
		})
		expect(h.cf.apps[1]?.policies).toEqual([
			{ id: h.cf.policies[0]?.id, precedence: 1 },
			{ id: h.cf.policies[1]?.id, precedence: 2 },
		])
		expect(h.cf.calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
			`/accounts/${ACCOUNT_ID}/access/policies`,
		])
		expect(h.cf.calls.filter((call) => call.method === 'PUT')).toHaveLength(3)
		expect(new Set(h.cf.calls.map((call) => call.token))).toEqual(new Set(['a-fresh-token-0123456789']))
	})

	it('refuses a team whose key set does not answer, without calling the API', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		const response = await setupPost(h, browser.cookie, '/setup/access', { ...accessFields(h), team: 'no-such-team' })
		expect(response.status).toBe(422)
		expect(await response.text()).toContain('does not look like a Zero Trust team')
		expect(h.cf.calls).toEqual([])
	})

	it('asks for the account ID when the token reaches more than one account', async () => {
		const h = await setupHarness()
		h.cf.accounts.push({ id: 'f'.repeat(32), name: 'Other' })
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		const refused = await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		expect(refused.status).toBe(422)
		expect(await refused.text()).toContain('enter the account ID')
		const given = await setupPost(
			h,
			browser.cookie,
			'/setup/access',
			accessFields(h, API_TOKEN, { account_id: ACCOUNT_ID })
		)
		expect(given.status).toBe(200)
	})

	it('SETUP-4: uses the API token in its own request only, and never stores, logs, renders or redirects it', async () => {
		const logs: unknown[] = []
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logs.push(args)
			})
		}
		const h = await setupHarness()
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		// An API error that echoes the token is shown redacted.
		h.cf.failNext(403)
		const failed = await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		const failedText = await failed.text()
		expect(failed.status).toBe(422)
		expect(failedText).toContain('[redacted]')
		const responses = [failed]
		responses.push(await setupPost(h, browser.cookie, '/setup/access', accessFields(h)))
		h.cf.fightMode = true
		responses.push(await setupPost(h, browser.cookie, '/setup/check/bot-fight', { api_token: API_TOKEN }))
		responses.push(await completeWizard(h, browser))
		responses.push(await h.request('/setup', { headers: { cookie: browser.cookie } }))
		for (const response of responses) {
			expect(response.headers.get('location') ?? '').not.toContain(API_TOKEN)
			expect(setCookies(response).lines.join('\n')).not.toContain(API_TOKEN)
		}
		expect(failedText).not.toContain(API_TOKEN)
		for (const response of responses.slice(1)) {
			expect(await response.text()).not.toContain(API_TOKEN)
		}
		expect(await everyStoredText(h)).not.toContain(API_TOKEN)
		expect(JSON.stringify(logs)).not.toContain(API_TOKEN)
		// Sent only to the API, as a bearer token.
		for (const [input, init] of h.cf.fetch.mock.calls) {
			const request = new Request(input, init)
			const carries = request.headers.get('authorization')?.includes(API_TOKEN) === true
			expect(carries ? new URL(request.url).host : 'api.cloudflare.com').toBe('api.cloudflare.com')
			expect(request.url).not.toContain(API_TOKEN)
		}
	})
})

describe('/setup steps 4 to 6: checks', () => {
	it('transforms a tiny image through the binding and charges the instance budget', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const pass = await setupPost(h, browser.cookie, '/setup/check/images')
		expect(await pass.text()).toContain('The Images binding transformed the test image')
		const month = new Date(NOW).toISOString().slice(0, 7)
		expect(await sql(h.store, 'SELECT value FROM kopje_state WHERE name = ?', `images_transforms:${month}`)).toEqual([
			{ value: '1' },
		])

		const quota = await setupHarness({ images: fakeImages(9422) })
		const quotaBrowser = await setupLogin(quota)
		const used = await (await setupPost(quota, quotaBrowser.cookie, '/setup/check/images')).text()
		expect(used).toContain('result warn')
		expect(used).toContain('allowance is used up')

		const broken = await setupHarness({ images: fakeImages(9999) })
		const brokenBrowser = await setupLogin(broken)
		const failed = await (await setupPost(broken, brokenBrowser.cookie, '/setup/check/images')).text()
		expect(failed).toContain('result fail')
		expect(failed).toContain('error 9999')

		const spent = await setupHarness({ overrides: { IMAGES_MONTHLY_TRANSFORMS: '0' } })
		const spentBrowser = await setupLogin(spent)
		expect(await (await setupPost(spent, spentBrowser.cookie, '/setup/check/images')).text()).toContain(
			'budget (IMAGES_MONTHLY_TRANSFORMS) is used up'
		)
	})

	it('shows whether the Queue consumer received the probe, and when the cron last ran', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		let page = await (await h.request('/setup', { headers: { cookie: browser.cookie } })).text()
		expect(page).toContain('No probe message has been sent yet')
		expect(page).toContain('No cron run has been recorded yet')

		expect((await setupPost(h, browser.cookie, '/setup/check/queue')).status).toBe(303)
		expect(h.queue.pending.map((m) => (m.body as { kind: string }).kind)).toEqual(['setup-probe'])
		page = await (await h.request('/setup', { headers: { cookie: browser.cookie } })).text()
		expect(page).toContain('The probe is on its way')

		const [message] = await drainQueue(h)
		expect(message?.ack).toHaveBeenCalled()
		await handleScheduled(h.env, { build: () => h.env.CF_VERSION_METADATA.id, now: () => NOW, store: () => h.store })
		page = await (await h.request('/setup', { headers: { cookie: browser.cookie } })).text()
		expect(page).toContain('The consumer received the probe')
		expect(page).toContain(`The cron last ran at ${new Date(NOW).toISOString()}`)

		// A probe nobody consumed fails after two minutes.
		await setupPost(h, browser.cookie, '/setup/check/queue')
		h.advance(3 * 60 * 1000)
		page = await (await h.request('/setup', { headers: { cookie: browser.cookie } })).text()
		expect(page).toContain('has not been received')
	})

	it('warns about Bot Fight Mode, and reads it when the token can', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const plain = await (await setupPost(h, browser.cookie, '/setup/check/bot-fight')).text()
		expect(plain).toContain('Not checked')
		expect(plain).toContain('blocks federation')

		h.cf.fightMode = true
		const on = await (await setupPost(h, browser.cookie, '/setup/check/bot-fight', { api_token: API_TOKEN })).text()
		expect(on).toContain('Bot Fight Mode is on for this zone')
		h.cf.fightMode = false
		const off = await (await setupPost(h, browser.cookie, '/setup/check/bot-fight', { api_token: API_TOKEN })).text()
		expect(off).toContain('Bot Fight Mode is off.')
		h.cf.fightMode = null
		const unknown = await (
			await setupPost(h, browser.cookie, '/setup/check/bot-fight', { api_token: API_TOKEN })
		).text()
		expect(unknown).toContain('Could not read the setting')
	})
})

describe('/setup step 7: bootstrap', () => {
	it('SETUP-3: writes the domain, the Access configuration and the admin together, then opens federation and sign-in', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const done = await completeWizard(h, browser)
		expect(done.status).toBe(303)
		expect(setCookies(done).lines.join('\n')).toMatch(/__Host-kopje_setup=;/)
		const values = await settings(h)
		expect(values).toMatchObject({
			domain: 'kopje.test',
			[ACCESS_SETTINGS.teamDomain]: h.team.teamDomain,
			access_aud: h.team.aud,
			[ACCESS_SETTINGS.adminAud]: h.cf.apps[1]?.aud,
			[ACCESS_SETTINGS.adminEmail]: ADMIN,
		})
		expect(values[ACCESS_SETTINGS.serviceTokenClientId]).toBeUndefined()
		expect(
			await sql(
				h.store,
				'SELECT a.username, a.uri, a.domain, l.email FROM accounts a JOIN local_accounts l ON l.account_id = a.id'
			)
		).toEqual([{ username: 'owner', uri: 'https://kopje.test/ap/users/owner', domain: null, email: ADMIN }])
		expect((await h.request('/.well-known/nodeinfo')).status).toBe(200)
		expect((await h.request('/ap/users/owner', { headers: { accept: 'application/activity+json' } })).status).toBe(200)
		// The admin signs in through the Access application the wizard made.
		const admin = await signIn(h.asApi, ADMIN)
		expect(admin.session).not.toBe('')
		// Setup sessions are gone.
		expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'setup_session:%'")).toEqual([])
	})

	it('refuses before the Access step, and an email Access does not admit', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		const early = await setupPost(h, browser.cookie, '/setup/admin', { username: 'owner', email: ADMIN })
		expect(early.status).toBe(422)
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		const other = await setupPost(h, browser.cookie, '/setup/admin', { username: 'owner', email: 'x@example.com' })
		expect(other.status).toBe(422)
		expect(await other.text()).toContain('Access admits another email')
		const bad = await setupPost(h, browser.cookie, '/setup/admin', { username: 'no spaces', email: ADMIN })
		expect(bad.status).toBe(422)
		expect(await sql(h.store, 'SELECT * FROM local_accounts')).toEqual([])
		expect(await settings(h)).toEqual({})
	})

	it('SETUP-3: concurrent bootstraps create one admin', async () => {
		const h = await setupHarness()
		const a = await setupLogin(h)
		const b = await setupLogin(h)
		for (const browser of [a, b]) {
			await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
			await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		}
		const [csrfA, csrfB] = await Promise.all([formToken(h, a.cookie), formToken(h, b.cookie)])
		const results = await Promise.all([
			setupPost(h, a.cookie, '/setup/admin', { username: 'first', email: ADMIN }, { csrf: csrfA }),
			setupPost(h, b.cookie, '/setup/admin', { username: 'second', email: ADMIN }, { csrf: csrfB }),
		])
		expect(results.filter((r) => r.status === 303)).toHaveLength(1)
		expect(await sql(h.store, 'SELECT username FROM accounts')).toHaveLength(1)
		expect(await sql(h.store, "SELECT value FROM instance_settings WHERE name = 'domain'")).toEqual([
			{ value: 'kopje.test' },
		])
	})

	it('SETUP-3: refuses when a domain or an account exists already (an import or /admin/config)', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' })
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		await sql(
			h.store,
			"INSERT INTO instance_settings (name, value) VALUES ('access_team_domain', 'x.cloudflareaccess.com')"
		)
		// The Store refuses, whatever the Worker let through.
		const key = { privkey: new Uint8Array([1]), salt: new Uint8Array([2]), pubkey: 'k' }
		const input = {
			sessionHash: await sha256Hex(browser.secret),
			domain: 'kopje.test',
			username: 'owner',
			email: ADMIN,
		}
		expect(await h.store.bootstrapInstance(BUILD, { ...input, key, now: NOW })).toBe('complete')
		const response = await setupPost(
			h,
			browser.cookie,
			'/setup/admin',
			{ username: 'owner', email: ADMIN },
			{ csrf: 'x' }
		)
		expect(response.status).toBe(403)
		expect(await sql(h.store, 'SELECT * FROM local_accounts')).toEqual([])
		expect((await settings(h)).domain).toBeUndefined()
	})
})

describe('/setup after bootstrap (SETUP-2)', () => {
	async function bootstrapped() {
		const h = await setupHarness()
		const leftover = await setupLogin(h)
		const csrf = await formToken(h, leftover.cookie)
		const browser = await setupLogin(h)
		await completeWizard(h, browser)
		return { h, leftover, csrf }
	}

	it('a reused setup token opens nothing', async () => {
		const { h } = await bootstrapped()
		const response = await h.request('/setup/login', {
			method: 'POST',
			headers: { origin: 'https://kopje.test', 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: SETUP_TOKEN }).toString(),
		})
		expect(response.status).toBe(403)
		expect(await response.text()).toContain('Setup complete')
		expect(setCookies(response).lines).toEqual([])
		expect(await (await h.request('/setup')).text()).toContain('Sign in as the admin')
	})

	it('a setup session opened before bootstrap cannot change the domain, the admin or Access', async () => {
		const { h, leftover, csrf } = await bootstrapped()
		const before = await settings(h)
		const calls = h.cf.calls.length
		for (const [path, fields] of [
			['/setup/domain', { domain: 'kopje.test' }],
			['/setup/access', accessFields(h, API_TOKEN, { admin_email: 'mallory@example.com' })],
			['/setup/admin', { username: 'mallory', email: 'mallory@example.com' }],
			['/setup/check/queue', {}],
			['/setup/check/images', {}],
		] as const) {
			const response = await setupPost(h, leftover.cookie, path, fields, { csrf })
			expect(response.status, path).toBe(403)
		}
		expect(await settings(h)).toEqual(before)
		expect(await sql(h.store, 'SELECT username FROM accounts')).toEqual([{ username: 'owner' }])
		expect(h.cf.calls.length).toBe(calls)
		expect(await (await h.request('/setup', { headers: { cookie: leftover.cookie } })).text()).toContain(
			'Setup complete'
		)
	})

	it('shows the status to the admin, runs the checks, and reconciles Access with a new token', async () => {
		const { h } = await bootstrapped()
		const admin = await signIn(h.asApi, ADMIN)
		const page = await h.request('/setup', { headers: { cookie: admin.cookie } })
		const text = await page.text()
		expect(text).toContain('Instance status')
		expect(text).toContain('@owner')
		expect(text).not.toContain('action="/setup/domain"')
		expect(text).not.toContain('action="/setup/admin"')
		const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1] ?? ''
		const post = (path: string, fields: Record<string, string>, origin: string | null = 'https://kopje.test') =>
			setupPost(h, admin.cookie, path, fields, { csrf, origin })

		expect(await (await post('/setup/check/images', {})).text()).toContain('transformed the test image')
		expect(await (await post('/setup/check/bot-fight', {})).text()).toContain('Not checked')
		expect((await post('/setup/domain', { domain: 'kopje.test' })).status).toBe(403)
		expect((await post('/setup/admin', { username: 'x', email: ADMIN })).status).toBe(403)
		expect((await post('/setup/access', accessFields(h), null)).status).toBe(403)

		const apps = h.cf.apps.map((app) => app.id)
		const reconciled = await post(
			'/setup/access',
			accessFields(h, 'another-token-0123456789', {
				admin_email: 'mallory@example.com',
				service_token_client_id: SERVICE_TOKEN_CLIENT_ID,
			})
		)
		expect(reconciled.status).toBe(200)
		expect(h.cf.apps.map((app) => app.id)).toEqual(apps)
		// The policies keep admitting the admin, whatever the form said.
		expect(h.cf.policies[0]).toMatchObject({ include: [{ email: { email: ADMIN } }] })
		const values = await settings(h)
		expect(values[ACCESS_SETTINGS.serviceTokenClientId]).toBe(SERVICE_TOKEN_CLIENT_ID)
		expect(values[ACCESS_SETTINGS.adminEmail]).toBe(ADMIN)
		expect(values.domain).toBe('kopje.test')
	})

	it('refuses a signed-in user who is not the admin', async () => {
		const { h } = await bootstrapped()
		await sql(h.store, "UPDATE instance_settings SET value = 'someone@example.com' WHERE name = 'admin_email'")
		const user = await signIn(h.asApi, ADMIN)
		const text = await (
			await h.request('/setup', { headers: { cookie: cookieHeader({ [SESSION]: user.session }) } })
		).text()
		expect(text).toContain('Setup complete')
		expect(text).not.toContain('name="csrf"')
	})
})
