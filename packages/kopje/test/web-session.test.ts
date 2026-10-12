import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, login, registerApp, seedAccount, sql } from './api-helpers'
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
import { returnPath } from '../src/web/session'

// The web UI's sessions (AUTH, WEB-1, WEB-4) and the settings page: sign-in through Access, the opaque session cookie,
// sign-out, expiry and revocation, and the Origin and anti-forgery checks on every state change.

async function withAlice() {
	const h = await apiHarness()
	const aliceId = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	return { ...h, aliceId }
}

function settings(h: Awaited<ReturnType<typeof withAlice>>, browser: Browser) {
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
		const started = await startSignIn(h)
		const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie, [SESSION]: first.session })
		expect(response.status).toBe(303)
		expect(await sessionRows(h)).toHaveLength(1)
		expect((await settings(h, first)).status).toBe(302)
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
	it('accepts only local paths', () => {
		expect(returnPath('/settings')).toBe('/settings')
		expect(returnPath('/@alice?max_id=1')).toBe('/@alice?max_id=1')
		for (const unsafe of [
			'//evil.example',
			'/\\evil.example',
			'/\t/evil.example',
			'https://evil.example/',
			'javascript:alert(1)',
			'evil',
			'',
			'/x\ny',
			`/${'a'.repeat(600)}`,
		]) {
			expect(returnPath(unsafe), unsafe).toBe('/settings')
		}
		expect(returnPath(undefined)).toBe('/settings')
	})

	it('returns after sign-in only to a validated local path', async () => {
		const h = await withAlice()
		for (const [asked, expected] of [
			['/@alice', '/@alice'],
			['//evil.example/x', '/settings'],
			['https://evil.example/', '/settings'],
		] as const) {
			const started = await startSignIn(h, 'alice@example.com', asked)
			const response = await callback(h, started.callback, { [LOGIN]: started.loginCookie })
			expect(response.headers.get('location'), asked).toBe(expected)
		}
	})

	it('ignores a tampered return path in the login cookie', async () => {
		const h = await withAlice()
		const started = await startSignIn(h)
		const [state, verifier] = started.loginCookie.split('.')
		const response = await callback(h, started.callback, { [LOGIN]: `${state}.${verifier}.//evil.example` })
		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe('/settings')
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
