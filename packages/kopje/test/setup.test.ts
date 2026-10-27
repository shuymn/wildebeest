import { runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { seedAccount, sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { ASCII_EMAIL_VARIANT, BUILD, FOLDED_EMAIL, rejectionOf, testKernel, UNICODE_EMAIL_VARIANTS } from './helpers'
import {
	accessFields,
	ADMIN,
	API_TOKEN,
	completeWizard,
	fakeImages,
	formToken,
	pageText,
	readyBrowser,
	SERVICE_TOKEN_CLIENT_ID,
	SETUP,
	SETUP_TOKEN,
	setupHarness,
	setupLogin,
	setupPost,
	type SetupHarness,
} from './setup-helpers'
import { attr, one, parseHtml, query, text } from './web-dom'
import { setCookies, signIn, cookieHeader, SESSION } from './web-helpers'
import { hostProblem } from '../src/app/setup'
import { MAX_SETUP_SESSIONS, SETUP_SESSION_MS, setupView } from '../src/domain/setup'
import { handleQueue } from '../src/jobs/queue'
import { handleScheduled } from '../src/jobs/scheduled'
import { ACCESS_SETTINGS, CONFIG_KEYS } from '../src/platform/access-settings'
import type { StoreStub } from '../src/platform/store-client'
import { storeMaintenanceError } from '../src/platform/store-errors'
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
			// Not no-referrer: browsers would post its forms with Origin: null, which the Origin check refuses.
			expect(response.headers.get('referrer-policy')).toBe('same-origin')
			const csp = response.headers.get('content-security-policy') ?? ''
			expect(csp).toContain("default-src 'none'")
			expect(csp).toContain("frame-ancestors 'none'")
			expect(csp).not.toContain('script-src')
			expect(response.headers.get('access-control-allow-origin')).toBeNull()
			// Before setup there is no domain to show: the header names the product and nothing links /about.
			const doc = parseHtml(await response.text())
			expect(
				query(doc, 'a').filter((a) => attr(a, 'href') === '/about'),
				path
			).toEqual([])
			expect(text(one(doc, 'header')), path).toBe('Kopje')
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
			'<dt>Confirmed</dt><dd>kopje.test</dd>'
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
})

describe('/setup steps 4 to 6: checks', () => {
	it('transforms the tiny image, keeps the outcome, and charges the instance budget once a month', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const month = new Date(NOW).toISOString().slice(0, 7)
		const charged = async () =>
			(
				await sql<{ value: string }>(
					h.store,
					'SELECT value FROM kopje_state WHERE name = ?',
					`images_transforms:${month}`
				)
			)[0]?.value
		const first = await setupPost(h, browser.cookie, '/setup/check/images')
		// Post/redirect/get: a reload of the page shows the outcome without running it again.
		expect(first.status).toBe(303)
		expect(first.headers.get('location')).toBe('/setup')
		expect(await pageText(h, browser.cookie)).toContain('The Images binding transformed the test image')
		expect(await charged()).toBe('1')
		// A recheck in the same month runs, uncharged; so do concurrent ones.
		await Promise.all([
			setupPost(h, browser.cookie, '/setup/check/images'),
			setupPost(h, browser.cookie, '/setup/check/images'),
		])
		expect(await charged()).toBe('1')
		// The next month charges once again.
		h.advance(32 * 24 * 60 * 60 * 1000)
		const next = new Date(NOW + 32 * 24 * 60 * 60 * 1000).toISOString().slice(0, 7)
		await setupPost(h, (await setupLogin(h)).cookie, '/setup/check/images')
		expect(await sql(h.store, 'SELECT value FROM kopje_state WHERE name = ?', `images_transforms:${next}`)).toEqual([
			{ value: '1' },
		])
	})

	it('reports a used-up allowance, a failure with its code, and a spent budget', async () => {
		const quota = await setupHarness({ images: fakeImages(9422) })
		const quotaBrowser = await setupLogin(quota)
		await setupPost(quota, quotaBrowser.cookie, '/setup/check/images')
		const used = await pageText(quota, quotaBrowser.cookie)
		expect(used).toContain('alert warn')
		expect(used).toContain('allowance is used up')

		const broken = await setupHarness({ images: fakeImages(9999) })
		const brokenBrowser = await setupLogin(broken)
		await setupPost(broken, brokenBrowser.cookie, '/setup/check/images')
		const failed = await pageText(broken, brokenBrowser.cookie)
		expect(failed).toContain('alert fail')
		expect(failed).toContain('error 9999')
		expect(failed).not.toContain('legacy Image Resizing billing')

		const legacy = await setupHarness({ images: fakeImages(9432) })
		const legacyBrowser = await setupLogin(legacy)
		await setupPost(legacy, legacyBrowser.cookie, '/setup/check/images')
		const billing = await pageText(legacy, legacyBrowser.cookie)
		expect(billing).toContain('alert fail')
		expect(billing).toContain('legacy Image Resizing billing')

		const spent = await setupHarness({ overrides: { IMAGES_MONTHLY_TRANSFORMS: '0' } })
		const spentBrowser = await setupLogin(spent)
		await setupPost(spent, spentBrowser.cookie, '/setup/check/images')
		expect(await pageText(spent, spentBrowser.cookie)).toContain('budget (IMAGES_MONTHLY_TRANSFORMS) is used up')
	})

	it('shows whether the Queue consumer received the probe, and when the cron last ran', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		let page = await pageText(h, browser.cookie)
		expect(page).toContain('No probe message has been sent yet')
		expect(page).toContain('No cron run has been recorded yet')

		expect((await setupPost(h, browser.cookie, '/setup/check/queue')).status).toBe(303)
		expect(h.queue.pending.map((m) => (m.body as { kind: string }).kind)).toEqual(['setup-probe'])
		expect(await pageText(h, browser.cookie)).toContain('The probe is on its way')

		const [message] = await drainQueue(h)
		expect(message?.ack).toHaveBeenCalled()
		await handleScheduled(h.env, { build: () => BUILD, now: () => NOW, store: () => h.store })
		page = await pageText(h, browser.cookie)
		expect(page).toContain('The consumer received the probe')
		expect(page).toContain(`The cron last ran at ${new Date(NOW).toISOString()}`)

		// A probe nobody consumed fails after two minutes, and so does a stale cron marker.
		await setupPost(h, browser.cookie, '/setup/check/queue')
		h.advance(16 * 60 * 1000)
		page = await pageText(h, browser.cookie)
		expect(page).toContain('has not been received')
		expect(page).toContain('Check the Worker&#39;s cron trigger and that maintenance is off')
	})

	it('marks only the latest probe, and retries a probe the Store could not record', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		await setupPost(h, browser.cookie, '/setup/check/queue')
		const old = h.queue.pending.splice(0)
		await setupPost(h, browser.cookie, '/setup/check/queue')
		h.queue.pending.unshift(...old)
		const [superseded, latest] = await drainQueue(h)
		expect(superseded?.ack).toHaveBeenCalled()
		expect(latest?.ack).toHaveBeenCalled()
		expect(await pageText(h, browser.cookie)).toContain('The consumer received the probe')

		// While the Store refuses writes (maintenance, an upgrade) the message is retried, not acked as lost.
		await setupPost(h, browser.cookie, '/setup/check/queue')
		const pending = h.queue.pending.splice(0)
		const messages = pending.map((stored) => ({ ...stored, ack: vi.fn(), retry: vi.fn() }))
		const unavailable = {
			consumeSetupProbe: () => Promise.reject(storeMaintenanceError('maintenance')),
		} as unknown as StoreStub
		const failing = { ...inboxDeps(() => h.store), store: () => unavailable }
		await handleQueue({ messages, queue: 'kopje' } as unknown as MessageBatch, h.env, failing)
		expect(messages[0]?.retry).toHaveBeenCalled()
		expect(messages[0]?.ack).not.toHaveBeenCalled()
	})

	it('reports a probe that could not be sent', async () => {
		const h = await setupHarness({ overrides: { QUEUE: { send: () => Promise.reject(new Error('no queue')) } } })
		const browser = await setupLogin(h)
		const response = await setupPost(h, browser.cookie, '/setup/check/queue')
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('The probe could not be sent to the Queue')
	})

	it('warns about Bot Fight Mode, and reads it, the stale configuration and Super Bot Fight Mode included', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const plain = await (await setupPost(h, browser.cookie, '/setup/check/bot-fight')).text()
		expect(plain).toContain('Not checked')
		expect(plain).toContain('blocks federation')
		const cases: [Record<string, unknown> | null, string][] = [
			[{ fight_mode: true }, 'Bot Fight Mode is on for this zone'],
			[{ fight_mode: false }, 'Bot Fight Mode is off.'],
			// A paid zone after a plan change: the stale configuration is still in force.
			[{ sbfm_definitely_automated: 'allow', stale_zone_configuration: { fight_mode: true } }, 'is on for this zone'],
			[{ sbfm_definitely_automated: 'managed_challenge' }, 'is on for this zone'],
			[{ sbfm_definitely_automated: 'allow', sbfm_likely_automated: 'allow' }, 'Bot Fight Mode is off.'],
			// Nothing that establishes "off".
			[{}, 'Could not read the setting'],
			[{ enable_js: true }, 'Could not read the setting'],
			[{ fight_mode: false, stale_zone_configuration: { fight_mode: 'yes' } }, 'Could not read the setting'],
			[null, 'Could not read the setting'],
		]
		for (const [settings, expected] of cases) {
			h.cf.botSettings = settings
			const text = await (await setupPost(h, browser.cookie, '/setup/check/bot-fight', { api_token: API_TOKEN })).text()
			expect(text, JSON.stringify(settings)).toContain(expected)
		}
	})
})

describe('/setup sessions', () => {
	it('limits sign-in attempts per address', async () => {
		const h = await setupHarness({ overrides: { LOGIN_LIMIT: { limit: () => Promise.resolve({ success: false }) } } })
		const response = await h.request('/setup/login', {
			method: 'POST',
			headers: { origin: 'https://kopje.test', 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: SETUP_TOKEN }).toString(),
		})
		expect(response.status).toBe(429)
		expect(setCookies(response).lines).toEqual([])
		expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'setup_session:%'")).toEqual([])
	})

	it('expires a session after an hour', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const csrf = await formToken(h, browser.cookie)
		h.advance(SETUP_SESSION_MS + 1)
		expect(await pageText(h, browser.cookie)).toContain('Enter the setup token')
		expect((await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' }, { csrf })).status).toBe(403)
	})

	it('ends the session at logout, for that cookie and in the Store', async () => {
		const h = await setupHarness()
		const browser = await setupLogin(h)
		const csrf = await formToken(h, browser.cookie)
		const out = await setupPost(h, browser.cookie, '/setup/logout', {}, { csrf })
		expect(out.status).toBe(303)
		expect(setCookies(out).lines.join('\n')).toMatch(/__Host-kopje_setup=;/)
		expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'setup_session:%'")).toEqual([])
		expect((await setupPost(h, browser.cookie, '/setup/domain', { domain: 'kopje.test' }, { csrf })).status).toBe(403)
	})

	it(`keeps at most ${MAX_SETUP_SESSIONS} sessions, dropping the oldest`, async () => {
		const h = await setupHarness()
		const browsers = []
		for (let i = 0; i <= MAX_SETUP_SESSIONS; i++) {
			browsers.push(await setupLogin(h))
			h.advance(1000)
		}
		expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'setup_session:%'")).toHaveLength(
			MAX_SETUP_SESSIONS
		)
		expect(await pageText(h, browsers[0]?.cookie ?? '')).toContain('Enter the setup token')
		expect(await pageText(h, browsers[1]?.cookie ?? '')).toContain('Go through the steps in order')
	})

	it('survives a restart of the Worker and of the Store object', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		// Another Worker instance over the same Store, and a fresh kernel over the same storage.
		const restarted = await setupHarness({ store: h.store })
		expect(await pageText(restarted, browser.cookie)).toContain('<dt>Confirmed</dt><dd>kopje.test</dd>')
		const sessionHash = await sha256Hex(browser.secret)
		const view = await runInDurableObject(h.store, (_instance, state) =>
			testKernel(state).execute(BUILD, setupView, {
				authority: { kind: 'setup', sessionHash },
				now: NOW,
			})
		)
		expect(view).toMatchObject({ authorized: true, draft: { domain: 'kopje.test', accessReady: true } })
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
			access_aud: h.cf.signInAud(),
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
		const browser = await readyBrowser(h)
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		const csrf = await formToken(h, browser.cookie)
		const results = await Promise.all(
			['first', 'second', 'third'].map((username) =>
				setupPost(h, browser.cookie, '/setup/admin', { username, email: ADMIN }, { csrf })
			)
		)
		expect(results.filter((r) => r.status === 303)).toHaveLength(1)
		expect(await sql(h.store, 'SELECT username FROM accounts')).toHaveLength(1)
		expect(await sql(h.store, "SELECT value FROM instance_settings WHERE name = 'domain'")).toEqual([
			{ value: 'kopje.test' },
		])
	})

	async function readyForBootstrap() {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h))
		const input = {
			sessionHash: await sha256Hex(browser.secret),
			domain: 'kopje.test',
			username: 'owner',
			email: ADMIN,
			key: { privkey: new Uint8Array([1]), salt: new Uint8Array([2]), pubkey: 'k' },
			now: NOW,
		}
		return { h, browser, input }
	}

	for (const name of CONFIG_KEYS) {
		it(`SETUP-3: refuses when ${name} is configured already (an import or /admin/config)`, async () => {
			const { h, browser, input } = await readyForBootstrap()
			await sql(h.store, 'INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, 'x')
			// The Store refuses, whatever the Worker let through.
			expect(await h.store.bootstrapInstance(BUILD, input)).toBe('complete')
			expect(
				(await setupPost(h, browser.cookie, '/setup/admin', { username: 'owner', email: ADMIN }, { csrf: 'x' })).status
			).toBe(403)
			expect(await sql(h.store, 'SELECT * FROM local_accounts')).toEqual([])
			expect(await sql(h.store, 'SELECT name FROM instance_settings')).toEqual([{ name }])
		})
	}

	it("records the account's registration and its first login with the bootstrap, and nothing when refused", async () => {
		const { h, input } = await readyForBootstrap()
		expect(await h.store.bootstrapInstance(BUILD, input)).toBe('ok')
		const [account] = await sql<{ id: string }>(h.store, 'SELECT id FROM accounts')
		const day = new Date(NOW).toISOString().slice(0, 10)
		expect(await sql(h.store, 'SELECT kind, day, value FROM activity_counts')).toEqual([
			{ kind: 'registrations', day, value: 1 },
		])
		expect(await sql(h.store, 'SELECT day, account_id FROM activity_logins')).toEqual([
			{ day, account_id: account!.id },
		])
		expect(await h.store.bootstrapInstance(BUILD, input)).toBe('complete')
		expect(await sql(h.store, 'SELECT value FROM activity_counts')).toEqual([{ value: 1 }])
	})

	// AUTH-9's rule (platform/login-email.ts sameLoginEmail): the admin's email given at step 7 against step 3's.
	it('SETUP-3: refuses an email other than the Access admin’s by the sign-in’s rule: ASCII case only, no trim', async () => {
		const h = await setupHarness()
		const browser = await readyBrowser(h)
		await setupPost(h, browser.cookie, '/setup/access', accessFields(h, API_TOKEN, { admin_email: FOLDED_EMAIL }))
		const input = {
			sessionHash: await sha256Hex(browser.secret),
			domain: 'kopje.test',
			username: 'owner',
			key: { privkey: new Uint8Array([1]), salt: new Uint8Array([2]), pubkey: 'k' },
			now: NOW,
		}
		for (const email of UNICODE_EMAIL_VARIANTS) {
			expect(await h.store.bootstrapInstance(BUILD, { ...input, email }), email).toBe('email_mismatch')
		}
		expect(await sql(h.store, 'SELECT * FROM local_accounts')).toEqual([])
		expect(await h.store.bootstrapInstance(BUILD, { ...input, email: ASCII_EMAIL_VARIANT })).toBe('ok')
		expect(await sql(h.store, 'SELECT email FROM local_accounts')).toEqual([{ email: ASCII_EMAIL_VARIANT }])
	})

	it('SETUP-3: refuses when a local account exists already', async () => {
		const { h, input } = await readyForBootstrap()
		await seedAccount(h.store, { username: 'imported' })
		expect(await h.store.bootstrapInstance(BUILD, input)).toBe('complete')
		expect(await sql(h.store, 'SELECT name FROM instance_settings')).toEqual([])
		expect(await sql(h.store, 'SELECT username FROM accounts')).toEqual([{ username: 'imported' }])
	})

	// A failure at an insert of the bootstrap's transaction (the account's last, or the login recorded after the
	// registration's count) rolls all of it back, and a later bootstrap succeeds.
	async function failingAt(table: string) {
		const { h, browser, input } = await readyForBootstrap()
		const before = await sql(h.store, 'SELECT name, value FROM kopje_state ORDER BY name')
		await sql(
			h.store,
			`CREATE TRIGGER fail_bootstrap BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`
		)
		expect(String(await rejectionOf(h.store.bootstrapInstance(BUILD, input)))).toContain('injected')
		expect(await sql(h.store, 'SELECT * FROM instance_settings')).toEqual([])
		expect(await sql(h.store, 'SELECT * FROM accounts')).toEqual([])
		expect(await sql(h.store, 'SELECT * FROM activity_counts')).toEqual([])
		expect(await sql(h.store, 'SELECT * FROM activity_logins')).toEqual([])
		expect(await sql(h.store, 'SELECT name, value FROM kopje_state ORDER BY name')).toEqual(before)
		await sql(h.store, 'DROP TRIGGER fail_bootstrap')
		expect((await setupPost(h, browser.cookie, '/setup/admin', { username: 'owner', email: ADMIN })).status).toBe(303)
		expect(await sql(h.store, 'SELECT kind, value FROM activity_counts')).toEqual([{ kind: 'registrations', value: 1 }])
	}

	it('SETUP-3: a failure at the last insert rolls the whole bootstrap back', () => failingAt('local_accounts'))

	it("SETUP-3: a failure at the first login's insert, after the registration is counted, rolls it back", () =>
		failingAt('activity_logins'))
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

		expect((await post('/setup/check/images', {})).status).toBe(303)
		expect(await pageText(h, admin.cookie)).toContain('transformed the test image')
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
