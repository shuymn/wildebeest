import { describe, expect, it, vi } from 'vitest'

import { type ApiHarness, apiHarness, bearer, login, registerApp, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import {
	type Browser,
	callback,
	cookieHeader,
	csrfOf,
	LOGIN,
	ORIGIN,
	postForm,
	SESSION,
	setCookies,
	signIn,
	startSignIn,
} from './web-helpers'
import { SESSION_LIFETIME_MS } from '../src/domain/web-session'
import { handleScheduled } from '../src/jobs/scheduled'
import { csrfToken, returnPath } from '../src/web/session'

// The web UI's sessions (AUTH, WEB-1, WEB-4) and the settings page: sign-in through Access, the opaque session cookie,
// sign-out, expiry and revocation, and the Origin and anti-forgery checks on every state change.

async function withAlice() {
	const h = await apiHarness()
	const aliceId = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	return { ...h, aliceId }
}

function settings(h: ApiHarness, browser: Browser) {
	return h.request('/settings', { headers: { cookie: browser.cookie } })
}

async function sessionRows(h: Awaited<ReturnType<typeof withAlice>>) {
	return sql<{ token_hash: string; expires_at: string | null }>(
		h.store,
		`SELECT token_hash, expires_at FROM oauth_tokens
		WHERE client_id = (SELECT value FROM instance_settings WHERE name = 'web_client_id') AND kind = 'access'`
	)
}

describe('sign-in (AUTH)', () => {
	it('signs in through Access and sets an opaque, HttpOnly, Secure, SameSite session cookie', async () => {
		const h = await withAlice()
		const started = await startSignIn(h)
		// /login sets only the short-lived login cookie and sends the browser to the consent page behind Access.
		expect(started.authorize.pathname).toBe('/oauth/authorize')
		expect(started.authorize.searchParams.get('code_challenge_method')).toBe('S256')
		expect(started.authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`)
		const loginLine = setCookies(started.login).lines.find((line) => line.startsWith(`${LOGIN}=`))
		expect(loginLine).toMatch(/; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/)
		// The web client's consent reads as signing in.
		const consent = await started.consent.text()
		expect(consent).toContain('Sign in')
		expect(consent).toContain('@alice')
		expect(started.approved.status).toBe(302)
		expect(started.callback.pathname).toBe('/auth/callback')

		const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie })
		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe('/settings')
		const cookies = setCookies(response)
		const sessionLine = cookies.lines.find((line) => line.startsWith(`${SESSION}=`))
		expect(sessionLine).toMatch(
			new RegExp(`; Max-Age=${SESSION_LIFETIME_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax$`)
		)
		// The login cookie is cleared.
		expect(cookies.lines.find((line) => line.startsWith(`${LOGIN}=`))).toMatch(/Max-Age=0/)
		const session = cookies.values.get(SESSION) ?? ''
		expect(session).toMatch(/^token-/)
		// Stored as a digest only, with a fixed expiry (AUTH-7).
		const rows = await sessionRows(h)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.token_hash).not.toBe(session)
		expect(rows[0]?.expires_at).toBe(new Date(NOW + SESSION_LIFETIME_MS).toISOString())

		const page = await settings(h, { session, cookie: cookieHeader({ [SESSION]: session }) })
		expect(page.status).toBe(200)
		expect(await page.text()).toContain('@alice')
	})

	it('sends a browser without a session to sign in, and back to the settings page', async () => {
		const h = await withAlice()
		const response = await h.request('/settings')
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('/login?return=%2Fsettings')
	})

	it('refuses a callback without the login cookie, or with another state (session fixation, login CSRF)', async () => {
		const h = await withAlice()
		await seedAccount(h.store, { username: 'mallory', email: 'mallory@example.com' })
		// The attacker completes a sign-in of their own and sends the victim the callback URL.
		const attacker = await startSignIn(h, 'mallory@example.com')
		const noCookie = await callback(h, attacker.callback, {})
		expect(noCookie.status).toBe(400)
		expect(setCookies(noCookie).values.get(SESSION)).toBeUndefined()
		// The victim has a sign-in of their own in progress: the state does not match theirs.
		const victim = await startSignIn(h)
		const crossed = await callback(h, attacker.callback, { [LOGIN]: victim.loginCookie })
		expect(crossed.status).toBe(400)
		expect(setCookies(crossed).values.get(SESSION)).toBeUndefined()
		// The victim's state with the attacker's code: the code is bound to the attacker's PKCE challenge.
		const injected = new URL(attacker.callback)
		injected.searchParams.set('state', victim.authorize.searchParams.get('state') ?? '')
		const forged = await callback(h, injected, { [LOGIN]: victim.loginCookie })
		expect(forged.status).toBe(400)
		expect(setCookies(forged).values.get(SESSION)).toBeUndefined()
		expect(await sessionRows(h)).toEqual([])
	})

	it('uses a code once', async () => {
		const h = await withAlice()
		const started = await startSignIn(h)
		expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(303)
		expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(400)
		expect(await sessionRows(h)).toHaveLength(1)
	})

	it('ends the session the browser already had when it signs in again', async () => {
		const h = await withAlice()
		const first = await signIn(h)
		const started = await startSignIn(h, 'alice@example.com', undefined, first)
		const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie, [SESSION]: first.session })
		expect(response.status).toBe(303)
		expect(await sessionRows(h)).toHaveLength(1)
		expect((await settings(h, first)).status).toBe(302)
	})

	it('consumes a sign-in attempt once: a second code for it starts nothing (overlapping callbacks)', async () => {
		const h = await withAlice()
		const started = await startSignIn(h)
		const second = await started.approveAgain()
		expect(second.searchParams.get('code')).not.toBe(started.callback.searchParams.get('code'))
		expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(303)
		expect((await callback(h, second, { [LOGIN]: started.loginCookie })).status).toBe(400)
		expect(await sessionRows(h)).toHaveLength(1)
	})

	it('keeps one session per browser when two sign-ins of it complete', async () => {
		const h = await withAlice()
		const first = await signIn(h)
		const a = await startSignIn(h, 'alice@example.com', undefined, first)
		const b = await startSignIn(h, 'alice@example.com', undefined, first)
		expect((await callback(h, a.callback, { [LOGIN]: a.loginCookie })).status).toBe(303)
		expect((await callback(h, b.callback, { [LOGIN]: b.loginCookie })).status).toBe(303)
		expect(await sessionRows(h)).toHaveLength(1)
	})

	it('leaves the newer sign-in in place when a stale callback arrives', async () => {
		const h = await withAlice()
		const older = await startSignIn(h)
		const newer = await startSignIn(h)
		// The older tab's callback arrives with the newer sign-in's cookie.
		const stale = await callback(h, older.callback, { [LOGIN]: newer.loginCookie })
		expect(stale.status).toBe(400)
		expect(setCookies(stale).lines).toEqual([])
		expect((await callback(h, newer.callback, { [LOGIN]: newer.loginCookie })).status).toBe(303)
	})

	it('installs nothing from a callback that arrives after sign-out', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const started = await startSignIn(h, 'alice@example.com', undefined, browser)
		const csrf = await csrfOf(h, browser)
		expect((await postForm(h, browser, '/logout', { csrf })).status).toBe(200)
		const late = await callback(h, started.callback, { [LOGIN]: started.loginCookie })
		expect(late.status).toBe(400)
		expect(setCookies(late).values.get(SESSION)).toBeUndefined()
		expect(await sessionRows(h)).toEqual([])
	})

	it('signs out the newer session when sign-out carries the session it replaced', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const csrf = await csrfOf(h, browser)
		const started = await startSignIn(h, 'alice@example.com', undefined, browser)
		const replaced = await callback(h, started.callback, { [LOGIN]: started.loginCookie })
		const session = setCookies(replaced).values.get(SESSION) ?? ''
		expect((await settings(h, browser)).status).toBe(302)
		// The sign-out form was rendered for the old session, and is posted after the new one was installed.
		expect((await postForm(h, browser, '/logout', { csrf })).status).toBe(200)
		expect(await sessionRows(h)).toEqual([])
		expect((await settings(h, { session, cookie: cookieHeader({ [SESSION]: session }) })).status).toBe(302)
	})

	it('keeps the sign-out fence when the session expires and is swept before the late callback', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		// The session ends in five minutes; the sign-in starts now, sign-out follows.
		const soon = NOW + 5 * 60 * 1000
		await sql(h.store, "UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'", new Date(soon).toISOString())
		await sql(
			h.store,
			"UPDATE kopje_state SET value = json_set(value, '$.expiresAt', ?) WHERE name LIKE 'web_session:%'",
			soon
		)
		const started = await startSignIn(h, 'alice@example.com', undefined, browser)
		expect((await postForm(h, browser, '/logout', { csrf: await csrfOf(h, browser) })).status).toBe(200)
		const later = NOW + 6 * 60 * 1000
		h.now.mockReturnValue(later)
		await handleScheduled({ ...h.env, MAINTENANCE: 'off' } as unknown as Env, {
			build: () => h.env.CF_VERSION_METADATA.id,
			now: () => later,
			store: () => h.store,
		})
		expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'web_session:%'")).toEqual([])
		const late = await callback(h, started.callback, { [LOGIN]: started.loginCookie })
		expect(late.status).toBe(400)
		expect(await sessionRows(h)).toEqual([])
	})

	it('fences the sign-ins in flight of the sessions "sign out other sessions" ends', async () => {
		const h = await withAlice()
		const a = await signIn(h)
		const b = await signIn(h)
		// Browser B has a code for a new sign-in, not yet exchanged.
		const pending = await startSignIn(h, 'alice@example.com', undefined, b)
		const response = await postForm(h, a, '/settings/sessions/revoke', { csrf: await csrfOf(h, a) })
		expect(response.status).toBe(303)
		const late = await callback(h, pending.callback, { [LOGIN]: pending.loginCookie, [SESSION]: b.session })
		expect(late.status).toBe(400)
		expect(setCookies(late).values.get(SESSION)).toBeUndefined()
		expect(await sessionRows(h)).toHaveLength(1)
		expect((await settings(h, a)).status).toBe(200)
	})

	it('retires every replaced or signed-out session for cookies and bearer use alike', async () => {
		const h = await withAlice()
		const api = (session: string) => h.request('/api/v1/accounts/verify_credentials', bearer(session))
		const first = await signIn(h)
		expect((await api(first.session)).status).toBe(200)
		// Replaced by a new sign-in of the same browser.
		const started = await startSignIn(h, 'alice@example.com', undefined, first)
		const second = setCookies(await callback(h, started.callback, { [LOGIN]: started.loginCookie })).values.get(SESSION)
		expect((await api(first.session)).status).toBe(401)
		expect((await api(second ?? '')).status).toBe(200)
		// Signed out with the replaced session: the newer one goes too.
		await postForm(h, first, '/logout', { csrf: await csrfToken(first.session) })
		expect((await api(second ?? '')).status).toBe(401)
		// Signed out by "sign out other sessions".
		const a = await signIn(h)
		const b = await signIn(h)
		await postForm(h, a, '/settings/sessions/revoke', { csrf: await csrfOf(h, a) })
		expect((await api(b.session)).status).toBe(401)
		// A suspended account's session.
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect((await api(a.session)).status).toBe(403)
		expect((await settings(h, a)).status).toBe(302)
	})

	it('lets no anonymous flood of sign-ins or failed callbacks lock out the owner (RES-6)', async () => {
		const attacker = '203.0.113.66'
		const limiter = {
			limit: vi.fn(({ key }: { key: string }) => Promise.resolve({ success: key !== attacker })),
		}
		const h = await apiHarness({ LOGIN_LIMIT: limiter })
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const fromAttacker = { headers: { 'cf-connecting-ip': attacker } }
		// The attacker's address is limited; the limit keys on the address, never on the account signing in.
		expect((await h.request('/login', fromAttacker)).status).toBe(429)
		// Sign-ins and failed callbacks from elsewhere, aimed at the owner's account.
		const cookies: string[] = []
		for (let i = 0; i < 30; i++) {
			const response = await h.request('/login', { headers: { 'cf-connecting-ip': `198.51.100.${i}` } })
			expect(response.status).toBe(302)
			cookies.push(setCookies(response).values.get(LOGIN) ?? '')
		}
		for (const cookie of cookies) {
			for (const query of ['?code=forged&state=forged', '?error=access_denied&state=forged']) {
				const response = await h.request(`/auth/callback${query}`, {
					headers: { cookie: cookieHeader({ [LOGIN]: cookie }) },
				})
				expect(response.status).toBe(400)
			}
		}
		// Sign-out without a session cannot end anyone's family.
		expect((await h.request('/logout', { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(403)
		const owner = await signIn(h)
		expect((await settings(h, owner)).status).toBe(200)
		// Abandoned attempts expire.
		const attempts = await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'web_login:%'")
		expect(attempts).toHaveLength(30)
		// The owner's attempt was consumed. Ten minutes on, each new sign-in prunes expired ones.
		h.now.mockReturnValue(NOW + 11 * 60 * 1000)
		await h.request('/login')
		await h.request('/login')
		expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name LIKE 'web_login:%'")).toHaveLength(2)
	})

	it('shows a cancelled sign-in and starts no session', async () => {
		const h = await withAlice()
		const started = await startSignIn(h)
		const denied = new URL(started.callback)
		denied.searchParams.delete('code')
		denied.searchParams.set('error', 'access_denied')
		const response = await callback(h, denied, { [LOGIN]: started.loginCookie })
		expect(response.status).toBe(403)
		expect(await sessionRows(h)).toEqual([])
	})

	it('refuses a suspended account at the callback', async () => {
		const h = await withAlice()
		const started = await startSignIn(h)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect((await callback(h, started.callback, { [LOGIN]: started.loginCookie })).status).toBe(400)
		expect(await sessionRows(h)).toEqual([])
	})

	it('expires a session after its lifetime', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		h.now.mockReturnValue(NOW + SESSION_LIFETIME_MS)
		const response = await settings(h, browser)
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('/login?return=%2Fsettings')
	})

	it('does not take an API token for a session', async () => {
		const h = await withAlice()
		const { token } = await login(h, { scope: 'read write' })
		const response = await settings(h, { session: token, cookie: cookieHeader({ [SESSION]: token }) })
		expect(response.status).toBe(302)
	})
})

describe('return paths (WEB-4)', () => {
	it('accepts only local paths (WEB-4: unsafe return path)', () => {
		expect(returnPath('/settings')).toBe('/settings')
		expect(returnPath('/@alice?max_id=1')).toBe('/@alice?max_id=1')
		// An '@' after the single leading slash is part of a local path (a profile), never userinfo.
		expect(returnPath('/@evil.example')).toBe('/@evil.example')
		const unsafe = {
			'absolute URL to another host': 'https://evil.example/',
			'absolute URL with userinfo': 'https://kopje.test@evil.example/',
			'protocol-relative': '//evil.example',
			'protocol-relative with userinfo': '//kopje.test@evil.example/',
			'slash backslash': '/\\evil.example',
			'backslash later': '/settings\\..\\x',
			'javascript:': 'javascript:alert(1)',
			'data:': 'data:text/html,x',
			'no leading slash': 'evil.example',
			empty: '',
			'tab inside //': '/\t/evil.example',
			newline: '/x\ny',
			'control character': '/x\u0000y',
			DEL: '/x\u007fy',
			'encoded slashes': '/%2F%2Fevil.example',
			'encoded slash, lowercase': '/%2f/evil.example',
			'encoded backslash': '/%5Cevil.example',
			'encoded control': '/x%0d%0aLocation:%20//evil.example',
			'encoded dot segment': '/%2e%2e//evil.example',
			'double encoding': '/%252F%252Fevil.example',
			'dot segment to //': '/a/..//evil.example',
			'single dot to //': '/.//evil.example',
			'too long': `/${'a'.repeat(600)}`,
		}
		for (const [name, value] of Object.entries(unsafe)) {
			expect(returnPath(value), name).toBe('/settings')
		}
		expect(returnPath(undefined)).toBe('/settings')
		expect(returnPath(null)).toBe('/settings')
	})

	it('returns after sign-in only to a validated local path', async () => {
		const h = await withAlice()
		for (const [asked, expected] of [
			['/@alice', '/@alice'],
			['//evil.example/x', '/settings'],
			['https://evil.example/', '/settings'],
			['/a/..//evil.example', '/settings'],
			['/%2F%2Fevil.example', '/settings'],
			['javascript:alert(1)', '/settings'],
		] as const) {
			const started = await startSignIn(h, 'alice@example.com', asked)
			const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie })
			expect(response.headers.get('location'), asked).toBe(expected)
		}
	})

	it('trusts nothing but the attempt id from the login cookie (forged attempts, sessions, return paths)', async () => {
		const h = await withAlice()
		await seedAccount(h.store, { username: 'bob', email: 'bob@example.com' })
		const bob = await signIn(h, 'bob@example.com')
		const victim = await startSignIn(h)
		const attacker = await startSignIn(h, 'bob@example.com')
		// Structured or unknown cookie values name no attempt: no return path, session digest or family is read from it.
		for (const forged of [
			`${victim.loginCookie}.//evil.example`,
			`${victim.loginCookie}.${'a'.repeat(64)}./settings`,
			'unknown-attempt-id-000000000000',
		]) {
			const response = await callback(h, victim.callback, { [LOGIN]: forged })
			expect(response.status, forged).toBe(400)
			expect(response.headers.get('location')).toBeNull()
		}
		// Another attempt's cookie with the victim's callback: the state is not that attempt's; neither is consumed.
		const crossed = await callback(h, victim.callback, { [LOGIN]: attacker.loginCookie })
		expect(crossed.status).toBe(400)
		expect(setCookies(crossed).lines).toEqual([])
		// Both attempts still complete with their own cookies, and the return path is the Store's.
		const done = await callback(h, victim.callback, { [LOGIN]: victim.loginCookie })
		expect(done.status).toBe(303)
		expect(done.headers.get('location')).toBe('/settings')
		// Bob's session was never touched.
		expect((await settings(h, bob)).status).toBe(200)
	})
})

// Every state-changing form of the web UI, with what it needs besides the token.
const FORMS: { path: string; fields: Record<string, string> }[] = [
	{ path: '/settings/profile', fields: { display_name: 'Forged' } },
	{ path: '/settings/authorizations/revoke', fields: { client_id: 'x' } },
	{ path: '/settings/sessions/revoke', fields: {} },
	{ path: '/logout', fields: {} },
]

describe('state changes (WEB-1, WEB-4)', () => {
	it('refuses a missing, null or foreign Origin on every form, before anything changes', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const csrf = await csrfOf(h, browser)
		for (const { path, fields } of [
			...FORMS,
			{ path: '/settings/avatar', fields: {} },
			{ path: '/settings/header', fields: {} },
		]) {
			for (const origin of [null, 'null', 'https://evil.example', 'http://kopje.test']) {
				const response = await postForm(h, browser, path, { ...fields, csrf }, origin)
				expect(response.status, `${path} ${origin}`).toBe(403)
				expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8')
			}
		}
		expect(await sql(h.store, 'SELECT display_name FROM accounts')).toEqual([{ display_name: 'Alice' }])
		expect(await sessionRows(h)).toHaveLength(1)
		expect((await settings(h, browser)).status).toBe(200)
	})

	it('refuses a missing or wrong anti-forgery token on every form', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const other = await signIn(h)
		// A token of another session of the same user is not this session's.
		const otherCsrf = await csrfOf(h, other)
		for (const { path, fields } of FORMS) {
			for (const csrf of [undefined, '', 'forged', otherCsrf]) {
				const response = await postForm(h, browser, path, csrf === undefined ? fields : { ...fields, csrf })
				expect(response.status, `${path} ${csrf}`).toBe(403)
			}
		}
		expect(await sql(h.store, 'SELECT display_name FROM accounts')).toEqual([{ display_name: 'Alice' }])
		expect(await sessionRows(h)).toHaveLength(2)
	})

	it('refuses a form without a session', async () => {
		const h = await withAlice()
		const response = await h.request('/settings/profile', {
			method: 'POST',
			headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
			body: 'display_name=x&csrf=x',
		})
		expect(response.status).toBe(403)
	})
})

describe('sign-out and revocation (AUTH)', () => {
	it('signs out, and the cookie authenticates nothing afterwards (reuse after logout)', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const csrf = await csrfOf(h, browser)
		const response = await postForm(h, browser, '/logout', { csrf })
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(setCookies(response).lines.find((line) => line.startsWith(`${SESSION}=`))).toMatch(/Max-Age=0/)
		expect(await sessionRows(h)).toEqual([])
		// The old cookie, replayed.
		expect((await settings(h, browser)).status).toBe(302)
		expect((await postForm(h, browser, '/settings/profile', { csrf, display_name: 'x' })).status).toBe(302)
		expect(await sql(h.store, 'SELECT display_name FROM accounts')).toEqual([{ display_name: 'Alice' }])
		// Nor is it a bearer token any more.
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(browser.session))).status).toBe(401)
	})

	it('signs out the other sessions only', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const other = await signIn(h)
		const page = await (await settings(h, browser)).text()
		expect(page).toContain('1 other web session is active.')
		const response = await postForm(h, browser, '/settings/sessions/revoke', { csrf: await csrfOf(h, browser) })
		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe('/settings?notice=sessions')
		expect((await settings(h, other)).status).toBe(302)
		expect((await settings(h, browser)).status).toBe(200)
	})

	it('ends the sessions of an account that is suspended', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect((await settings(h, browser)).status).toBe(302)
	})

	it('lists the authorized apps and revokes one (AUTH-6: only the viewer’s own)', async () => {
		const h = await withAlice()
		await seedAccount(h.store, { username: 'bob', email: 'bob@example.com' })
		const app = await registerApp(h)
		const alice = await login(h, { app, email: 'alice@example.com' })
		const bob = await login(h, { app, email: 'bob@example.com' })
		const browser = await signIn(h)
		const page = await (await settings(h, browser)).text()
		expect(page).toContain('Test Client')
		expect(page).toContain(`name="client_id" value="${app.client_id}"`)
		// The web client is not listed as an app.
		expect(page).not.toContain('>Kopje</a>')

		const response = await postForm(h, browser, '/settings/authorizations/revoke', {
			client_id: app.client_id,
			csrf: await csrfOf(h, browser),
		})
		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe('/settings?notice=revoked')
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(alice.token))).status).toBe(401)
		// Bob's authorization of the same app stays.
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(bob.token))).status).toBe(200)
		expect(await (await settings(h, browser)).text()).toContain('No apps are authorized.')
	})

	it('does not revoke the web client as an app', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const [client] = await sql<{ value: string }>(
			h.store,
			"SELECT value FROM instance_settings WHERE name = 'web_client_id'"
		)
		await postForm(h, browser, '/settings/authorizations/revoke', {
			client_id: client?.value ?? '',
			csrf: await csrfOf(h, browser),
		})
		expect((await settings(h, browser)).status).toBe(200)
	})
})

describe('settings page', () => {
	it('is never cached, framed or opened to other origins (WEB-2, WEB-3, WEB-5)', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		for (const response of [
			await h.request('/settings', { headers: { cookie: browser.cookie, origin: 'https://evil.example' } }),
			await h.request('/auth/callback', { headers: { origin: 'https://evil.example' } }),
		]) {
			expect(response.headers.get('cache-control')).toBe('no-store')
			expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8')
			expect(response.headers.get('x-content-type-options')).toBe('nosniff')
			expect(response.headers.get('x-frame-options')).toBe('DENY')
			const csp = response.headers.get('content-security-policy') ?? ''
			expect(csp).toContain("default-src 'none'")
			expect(csp).toContain("frame-ancestors 'none'")
			expect(csp).not.toContain('script-src')
			expect(response.headers.get('access-control-allow-origin')).toBeNull()
		}
		const page = await (await settings(h, browser)).text()
		expect(page).not.toContain('<script')
	})

	it('saves the profile: name, bio, fields, locked, discoverable and default visibility', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const fields = new URLSearchParams({
			csrf: await csrfOf(h, browser),
			display_name: 'Alice <Liddell>',
			note: 'Down the <b>rabbit</b> hole',
			'fields_attributes[0][name]': 'Site',
			'fields_attributes[0][value]': 'https://alice.example/',
			'fields_attributes[1][name]': 'Script',
			'fields_attributes[1][value]': 'javascript:alert(1) <script>x</script>',
			'fields_attributes[2][name]': '',
			'fields_attributes[2][value]': '',
			'source[privacy]': 'unlisted',
		})
		// Checkboxes: a checked box posts true before its hidden false.
		fields.append('locked', 'true')
		fields.append('locked', 'false')
		fields.append('discoverable', 'false')
		const response = await postForm(h, browser, '/settings/profile', fields)
		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe('/settings?notice=saved')

		const { token } = await login(h, { scope: 'read' })
		const me = await (
			await h.request('/api/v1/accounts/verify_credentials', bearer(token))
		).json<{
			display_name: string
			note: string
			locked: boolean
			discoverable: boolean
			fields: { name: string; value: string }[]
			source: { privacy: string; fields: { name: string; value: string }[] }
		}>()
		expect(me).toMatchObject({
			display_name: 'Alice <Liddell>',
			note: '<p>Down the &lt;b&gt;rabbit&lt;/b&gt; hole</p>',
			locked: true,
			discoverable: false,
			source: {
				privacy: 'unlisted',
				fields: [
					{ name: 'Site', value: 'https://alice.example/', verified_at: null },
					{ name: 'Script', value: 'javascript:alert(1) <script>x</script>', verified_at: null },
				],
			},
		})
		// HTML-2: values are escaped and only http(s) URLs linked.
		expect(me.fields[0]?.value).toContain('<a href="https://alice.example/"')
		expect(me.fields[1]?.value).toBe('javascript:alert(1) &lt;script&gt;x&lt;/script&gt;')

		const page = await (await h.request('/settings?notice=saved', { headers: { cookie: browser.cookie } })).text()
		expect(page).toContain('Your profile has been saved.')
		expect(page).toContain('value="Alice &lt;Liddell&gt;"')
	})

	it('shows validation problems and saves nothing', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const csrf = await csrfOf(h, browser)
		const response = await postForm(h, browser, '/settings/profile', {
			csrf,
			display_name: 'x'.repeat(31),
			'fields_attributes[0][name]': 'n'.repeat(256),
			'fields_attributes[0][value]': 'v',
		})
		expect(response.status).toBe(422)
		const page = await response.text()
		expect(page).toContain('Display name is too long')
		expect(page).toContain('Fields is too long')
		expect(await sql(h.store, 'SELECT display_name FROM accounts')).toEqual([{ display_name: 'Alice' }])
	})

	it('shows only notices it knows', async () => {
		const h = await withAlice()
		const browser = await signIn(h)
		const page = await (
			await h.request('/settings?notice=%3Cscript%3E', { headers: { cookie: browser.cookie } })
		).text()
		expect(page).not.toContain('class="notice"')
		expect(page).not.toContain('<script')
	})
})
