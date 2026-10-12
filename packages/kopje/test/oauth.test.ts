import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	type AccessTeam,
	type App,
	apiHarness,
	authorizationCode,
	bearer,
	consentPage,
	decide,
	exchange,
	form,
	json,
	login,
	registerApp,
	seedAccount,
	sql,
} from './api-helpers'
import { NOW } from './app-helpers'
import { callStore } from '../src/platform/store-client'
import { pkceChallenge } from '../src/security/tokens'

const VERIFIER = 'a'.repeat(20) + '-._~' + 'B'.repeat(30)

async function withAlice() {
	const h = await apiHarness()
	const aliceId = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	return { ...h, aliceId }
}

describe('apps', () => {
	it('registers an app and verifies its credentials with a client token', async () => {
		const h = await apiHarness()
		const app = await registerApp(h, { scopes: 'read write' })
		expect(app).toMatchObject({
			name: 'Test Client',
			website: 'https://client.test',
			redirect_uri: 'https://client.test/callback',
			client_id: expect.any(String),
			client_secret: expect.any(String),
			vapid_key: '',
		})

		const token = await h.request(
			'/oauth/token',
			form({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret })
		)
		expect(token.status).toBe(200)
		const { access_token, scope } = await token.json<{ access_token: string; scope: string }>()
		expect(scope).toBe('read')

		const verified = await h.request('/api/v1/apps/verify_credentials', bearer(access_token))
		expect(verified.status).toBe(200)
		expect(await verified.json()).toEqual({ name: 'Test Client', website: 'https://client.test', vapid_key: '' })
		// An app token has no user.
		const user = await h.request('/api/v1/accounts/verify_credentials', bearer(access_token))
		expect(user.status).toBe(422)
	})

	it('stores only digests of tokens and codes', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		const codeRows = await sql<{ token_hash: string; kind: string }>(
			h.store,
			'SELECT token_hash, kind FROM oauth_tokens'
		)
		expect(codeRows).toEqual([{ token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), kind: 'code' }])
		expect(codeRows[0]!.token_hash).not.toContain(code)

		const { access_token } = await (await exchange(h, app, code)).json<{ access_token: string }>()
		const rows = await sql<{ token_hash: string; kind: string }>(h.store, 'SELECT token_hash, kind FROM oauth_tokens')
		expect(rows).toEqual([{ token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), kind: 'access' }])
		expect(rows[0]!.token_hash).not.toBe(access_token)
	})

	it('refuses invalid registrations', async () => {
		const h = await apiHarness()
		for (const body of [
			{ client_name: '', redirect_uris: 'https://client.test/cb' },
			{ client_name: 'x', redirect_uris: 'not a uri' },
			{ client_name: 'x', redirect_uris: 'https://client.test/cb#frag' },
			{ client_name: 'x', redirect_uris: 'javascript:alert(1)' },
			{ client_name: 'x', redirect_uris: 'https://client.test/cb', scopes: 'read everything' },
		]) {
			const response = await h.request('/api/v1/apps', json(body))
			expect(response.status, JSON.stringify(body)).toBe(422)
			expect(await response.json()).toEqual({ error: expect.stringMatching(/^Validation failed: /) })
		}
	})

	it('accepts form-encoded registrations with an array of redirect URIs', async () => {
		const h = await apiHarness()
		const body = new URLSearchParams([
			['client_name', 'Form Client'],
			['redirect_uris[]', 'urn:ietf:wg:oauth:2.0:oob'],
			['redirect_uris[]', 'app://callback'],
		])
		const response = await h.request('/api/v1/apps', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ redirect_uri: 'urn:ietf:wg:oauth:2.0:oob\napp://callback' })
	})
})

describe('authorize, consent, token, API call', () => {
	it('logs in through Access and calls the API with the token', async () => {
		const h = await withAlice()
		const app = await registerApp(h)

		const consent = await consentPage(h, app, { state: 'xyz<>' })
		expect(consent.status).toBe(200)
		expect(consent.headers.get('content-security-policy')).toContain("script-src 'none'")
		expect(consent.headers.get('x-frame-options')).toBe('DENY')
		const html = await consent.text()
		expect(html).toContain('Test Client')
		expect(html).toContain('@alice')
		expect(html).toContain('name="decision" value="approve"')
		expect(html).toContain('value="xyz&lt;&gt;"')
		expect(html).not.toContain('<script')

		const approved = await decide(h, app, 'approve', { state: 'xyz' })
		expect(approved.status).toBe(302)
		const location = new URL(approved.headers.get('location')!)
		expect(location.origin + location.pathname).toBe('https://client.test/callback')
		expect(location.searchParams.get('state')).toBe('xyz')
		const code = location.searchParams.get('code')!

		const token = await exchange(h, app, code)
		expect(token.status).toBe(200)
		const body = await token.json<{ access_token: string; token_type: string; scope: string; created_at: number }>()
		expect(body).toEqual({
			access_token: expect.any(String),
			token_type: 'Bearer',
			scope: 'read write follow',
			created_at: Math.floor(NOW / 1000),
		})

		const me = await h.request('/api/v1/accounts/verify_credentials', bearer(body.access_token))
		expect(me.status).toBe(200)
		expect(await me.json()).toMatchObject({ id: h.aliceId, username: 'alice', acct: 'alice' })
	})

	it('shows the code for the out-of-band redirect URI', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { redirectUri: 'urn:ietf:wg:oauth:2.0:oob' })
		const response = await decide(h, app, 'approve')
		expect(response.status).toBe(200)
		const code = /<code>([^<]+)<\/code>/.exec(await response.text())?.[1]
		expect(code).toBeDefined()
		expect((await exchange(h, app, code!)).status).toBe(200)
	})

	it('redirects a denial with access_denied and issues no code', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const response = await decide(h, app, 'deny', { state: 's1' })
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location')!)
		expect(Object.fromEntries(location.searchParams)).toEqual({ error: 'access_denied', state: 's1' })
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])
	})

	it('refuses a decision posted from another origin', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const assertion = await h.team.assertion()
		const response = await h.request(
			'/oauth/authorize',
			form(
				{ client_id: app.client_id, redirect_uri: app.redirect_uri, scope: 'read', decision: 'approve' },
				{ headers: { 'cf-access-jwt-assertion': assertion, origin: 'https://evil.test' } }
			)
		)
		expect(response.status).toBe(403)
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])
	})

	it('shows client and redirect URI errors on the page, never at an unverified URI', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'read' })
		const assertion = await h.team.assertion()
		for (const override of [{ redirect_uri: 'https://elsewhere.test/cb' }, { client_id: 'nope' }]) {
			const query = new URLSearchParams({
				response_type: 'code',
				client_id: app.client_id,
				redirect_uri: app.redirect_uri,
				scope: 'read',
				state: 'st',
				...override,
			})
			const response = await h.request(`/oauth/authorize?${query.toString()}`, {
				headers: { 'cf-access-jwt-assertion': assertion },
			})
			expect(response.status, JSON.stringify(override)).toBe(400)
			expect(response.headers.get('location')).toBeNull()
		}
	})

	// RFC 6749 §4.1.2.1: once the client and its redirect URI are verified, errors go back to the client.
	it('redirects later errors to the registered callback with the original state', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'read' })
		const assertion = await h.team.assertion()
		const cases: [Record<string, string>, string][] = [
			[{ scope: 'write' }, 'invalid_scope'],
			[{ scope: 'nonsense' }, 'invalid_scope'],
			[{ code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' }, 'invalid_request'],
			[{ code_challenge: 'x'.repeat(43) }, 'invalid_request'],
			[{ response_type: 'token' }, 'unsupported_response_type'],
		]
		for (const [override, error] of cases) {
			const query = new URLSearchParams({
				response_type: 'code',
				client_id: app.client_id,
				redirect_uri: app.redirect_uri,
				scope: 'read',
				state: 'st 1',
				...override,
			})
			const response = await h.request(`/oauth/authorize?${query.toString()}`, {
				headers: { 'cf-access-jwt-assertion': assertion },
			})
			expect(response.status, JSON.stringify(override)).toBe(302)
			const location = new URL(response.headers.get('location')!)
			expect(location.origin + location.pathname).toBe(app.redirect_uri)
			expect(location.searchParams.get('error'), JSON.stringify(override)).toBe(error)
			expect(location.searchParams.get('state')).toBe('st 1')
			expect(location.searchParams.get('code')).toBeNull()
		}
		// The decision POST validates the same way.
		const denied = await decide(h, app, 'approve', { scope: 'write', state: 'st 2' })
		expect(denied.status).toBe(302)
		expect(Object.fromEntries(new URL(denied.headers.get('location')!).searchParams)).toMatchObject({
			error: 'invalid_scope',
			state: 'st 2',
		})
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])
	})

	// Never an open redirect: only an exact registered URI of a registered client receives a redirect.
	it('never redirects to a URI that is not exactly registered, even for later errors or a denial', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'read', redirectUri: 'https://client.test/callback?keep=1' })
		const assertion = await h.team.assertion()
		const variants = [
			'https://evil.test/callback?keep=1',
			'https://client.test/callback',
			'https://client.test/callback?keep=1&x=2',
			'https://client.test/callback/extra?keep=1',
			'https://client.test/callbackx?keep=1',
			'https://client.test.evil.test/callback?keep=1',
			'http://client.test/callback?keep=1',
			'javascript://client.test/callback?keep=1',
			'https://client.test@evil.test/callback?keep=1',
			'https://evil.test@client.test/callback?keep=1',
			'https://client.test/%63allback?keep=1',
			'https://client.test/x/../callback?keep=1',
			'https://client.test/./callback?keep=1',
			'https://CLIENT.test/callback?keep=1',
			'https://client.test:443/callback?keep=1',
		]
		// scope=write is a later error: with an exact URI it would be redirected.
		for (const redirectUri of variants) {
			const query = new URLSearchParams({
				response_type: 'code',
				client_id: app.client_id,
				redirect_uri: redirectUri,
				scope: 'write',
				state: 's',
			})
			const response = await h.request(`/oauth/authorize?${query.toString()}`, {
				headers: { 'cf-access-jwt-assertion': assertion },
			})
			expect(response.status, redirectUri).toBe(400)
			expect(response.headers.get('location'), redirectUri).toBeNull()

			const denied = await h.request(
				'/oauth/authorize',
				form(
					{ client_id: app.client_id, redirect_uri: redirectUri, scope: 'read', state: 's', decision: 'deny' },
					{ headers: { 'cf-access-jwt-assertion': assertion, origin: 'https://kopje.test' } }
				)
			)
			expect(denied.status, redirectUri).toBe(400)
			expect(denied.headers.get('location'), redirectUri).toBeNull()
		}
		for (const clientId of [undefined, 'unknown']) {
			const query = new URLSearchParams({
				response_type: 'code',
				redirect_uri: app.redirect_uri,
				scope: 'write',
				...(clientId === undefined ? {} : { client_id: clientId }),
			})
			const response = await h.request(`/oauth/authorize?${query.toString()}`, {
				headers: { 'cf-access-jwt-assertion': assertion },
			})
			expect(response.status, String(clientId)).toBe(400)
			expect(response.headers.get('location')).toBeNull()
		}
		// The exact URI gets the error appended with its own query kept, and nothing else changes.
		const exact = await h.request(
			`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: app.redirect_uri, scope: 'write', state: 'a&b=c' }).toString()}`,
			{ headers: { 'cf-access-jwt-assertion': assertion } }
		)
		const location = new URL(exact.headers.get('location')!)
		expect(location.origin + location.pathname).toBe('https://client.test/callback')
		expect(location.searchParams.get('keep')).toBe('1')
		expect(location.searchParams.get('state')).toBe('a&b=c')
		expect(location.searchParams.get('b')).toBeNull()
		expect(location.searchParams.get('error')).toBe('invalid_scope')
	})

	it('shows later errors on the page for the out-of-band redirect URI', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'read', redirectUri: 'urn:ietf:wg:oauth:2.0:oob' })
		const response = await consentPage(h, app, { scope: 'write' })
		expect(response.status).toBe(400)
		expect(response.headers.get('location')).toBeNull()
		expect(await response.text()).toContain('invalid_scope')
	})

	it('refuses an Access identity without a local account', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		expect((await consentPage(h, app, { email: 'bob@example.com' })).status).toBe(403)
		expect((await decide(h, app, 'approve', { email: 'bob@example.com' })).status).toBe(403)
	})

	it('answers 503 until Access is configured', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		await sql(h.store, "DELETE FROM instance_settings WHERE name = 'access_aud'")
		expect((await consentPage(h, app)).status).toBe(503)
	})

	it('lets login through while the server is readonly', async () => {
		const h = await apiHarness({ MAINTENANCE: 'readonly' })
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const { token } = await login(h)
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(200)
		const write = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(token, json({ note: 'x' }, { method: 'PATCH' }))
		)
		expect(write.status).toBe(503)
	})
})

describe('Access assertion', () => {
	async function attempt(claims: Record<string, unknown>, key?: (team: AccessTeam) => JsonWebKey, header = true) {
		const h = await withAlice()
		const app = await registerApp(h)
		const query = new URLSearchParams({
			response_type: 'code',
			client_id: app.client_id,
			redirect_uri: app.redirect_uri,
			scope: 'read',
		})
		const assertion = await h.team.assertion(claims, key?.(h.team))
		const response = await h.request(`/oauth/authorize?${query.toString()}`, {
			headers: header ? { 'cf-access-jwt-assertion': assertion } : {},
		})
		return { response, h }
	}

	it('accepts a valid assertion and caches the JWKS', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		expect((await consentPage(h, app)).status).toBe(200)
		expect((await consentPage(h, app)).status).toBe(200)
		expect(h.team.fetch).toHaveBeenCalledOnce()
	})

	// jose's remote key set keeps time with Date.now(); the clock is moved with it.
	async function clocked(h: Awaited<ReturnType<typeof withAlice>>, app: App) {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
		return async (ms: number, key?: JsonWebKey) => {
			vi.setSystemTime(ms)
			h.now.mockReturnValue(ms)
			const claims = { iat: Math.floor(ms / 1000) - 10, exp: Math.floor(ms / 1000) + 3600 }
			const query = new URLSearchParams({
				response_type: 'code',
				client_id: app.client_id,
				redirect_uri: app.redirect_uri,
				scope: 'read',
			})
			return h.request(`/oauth/authorize?${query.toString()}`, {
				headers: { 'cf-access-jwt-assertion': await h.team.assertion(claims, key) },
			})
		}
	}

	afterEach(() => {
		vi.useRealTimers()
	})

	// Access keeps a rotated-out key valid for 7 days, so a fetched set is trusted that long and no longer.
	it('uses the fetched JWKS while the endpoint fails, for at most 7 days', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const at = await clocked(h, app)
		expect((await at(NOW)).status).toBe(200)
		h.team.fetch.mockImplementation(() => Promise.reject(new Error('unreachable')))
		const day = 24 * 60 * 60 * 1000
		expect((await at(NOW + 2 * 60 * 60 * 1000)).status).toBe(200)
		expect((await at(NOW + 7 * day - 1000)).status).toBe(200)
		expect((await at(NOW + 7 * day + 1000)).status).toBe(403)
	})

	it('picks up a rotated key by its new kid', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const at = await clocked(h, app)
		expect((await at(NOW)).status).toBe(200)
		const next = await h.team.rotate()
		expect((await at(NOW + 60 * 1000, next)).status).toBe(200)
		expect(h.team.fetch).toHaveBeenCalledTimes(2)
	})

	it.each<[string, Record<string, unknown>]>([
		['a wrong audience', { aud: ['someone-else'] }],
		['a wrong issuer', { iss: 'https://other-team.cloudflareaccess.com' }],
		['an expired token', { exp: Math.floor(NOW / 1000) - 3600 }],
		['a token without expiry', { exp: undefined }],
		['a token not valid yet', { nbf: Math.floor(NOW / 1000) + 3600 }],
		['a service token without email', { email: undefined, common_name: 'svc' }],
	])('refuses %s', async (_name, claims) => {
		const { response } = await attempt(claims)
		expect(response.status).toBe(403)
	})

	it('refuses a token signed by another key under the same kid', async () => {
		const { response } = await attempt({}, (team) => team.otherKey)
		expect(response.status).toBe(403)
	})

	it('refuses a request without the assertion', async () => {
		const { response } = await attempt({}, undefined, false)
		expect(response.status).toBe(403)
	})
})

describe('PKCE', () => {
	it('exchanges a code bound to an S256 challenge with the matching verifier', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app, { codeChallenge: await pkceChallenge(VERIFIER) })
		expect((await exchange(h, app, code, { code_verifier: VERIFIER })).status).toBe(200)
	})

	it('refuses a wrong or missing verifier and burns the code', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const challenge = await pkceChallenge(VERIFIER)

		const wrong = await authorizationCode(h, app, { codeChallenge: challenge })
		const failed = await exchange(h, app, wrong, { code_verifier: VERIFIER.replace('a', 'b') })
		expect(failed.status).toBe(400)
		expect(await failed.json()).toMatchObject({ error: 'invalid_grant' })
		expect((await exchange(h, app, wrong, { code_verifier: VERIFIER })).status).toBe(400)

		const missing = await authorizationCode(h, app, { codeChallenge: challenge })
		expect((await exchange(h, app, missing)).status).toBe(400)
	})

	it('refuses a verifier for a code issued without a challenge', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		expect((await exchange(h, app, code, { code_verifier: VERIFIER })).status).toBe(400)
	})
})

describe('token endpoint', () => {
	it('uses a code once', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		expect((await exchange(h, app, code)).status).toBe(200)
		const again = await exchange(h, app, code)
		expect(again.status).toBe(400)
		expect(await again.json()).toMatchObject({ error: 'invalid_grant' })
	})

	it('expires codes after 10 minutes', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		h.now.mockReturnValue(NOW + 10 * 60 * 1000)
		expect((await exchange(h, app, code)).status).toBe(400)
	})

	it('refuses a code for another redirect URI or client', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const other = await registerApp(h)
		const first = await authorizationCode(h, app)
		expect((await exchange(h, app, first, { redirect_uri: 'https://client.test/other' })).status).toBe(400)
		const second = await authorizationCode(h, app)
		const stolen = await exchange(h, other, second)
		expect(stolen.status).toBe(400)
		expect(await stolen.json()).toMatchObject({ error: 'invalid_grant' })
	})

	it('authenticates the client', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		const response = await exchange(h, app, code, { client_secret: 'wrong' })
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toMatch(/^Basic /)
		expect(await response.json()).toMatchObject({ error: 'invalid_client' })
		const badBasic = await h.request(
			'/oauth/token',
			form(
				{ grant_type: 'authorization_code', code, redirect_uri: app.redirect_uri },
				{ headers: { authorization: `Basic ${btoa(`${app.client_id}:wrong`)}` } }
			)
		)
		expect(badBasic.status).toBe(401)
		expect(badBasic.headers.get('www-authenticate')).toMatch(/^Basic /)
		// HTTP Basic client authentication works as well.
		const basic = btoa(`${app.client_id}:${app.client_secret}`)
		const ok = await h.request(
			'/oauth/token',
			form(
				{ grant_type: 'authorization_code', code, redirect_uri: app.redirect_uri },
				{ headers: { authorization: `Basic ${basic}` } }
			)
		)
		expect(ok.status).toBe(200)
	})

	it('accepts JSON bodies and refuses unsupported grants', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		const response = await h.request(
			'/oauth/token',
			json({
				grant_type: 'authorization_code',
				code,
				client_id: app.client_id,
				client_secret: app.client_secret,
				redirect_uri: app.redirect_uri,
			})
		)
		expect(response.status).toBe(200)
		const password = await h.request(
			'/oauth/token',
			json({ grant_type: 'password', client_id: app.client_id, client_secret: app.client_secret })
		)
		expect(password.status).toBe(400)
		expect(await password.json()).toMatchObject({ error: 'unsupported_grant_type' })
	})

	it('refuses client_credentials scopes the app did not register', async () => {
		const h = await apiHarness()
		const app = await registerApp(h, { scopes: 'read' })
		const response = await h.request(
			'/oauth/token',
			form({
				grant_type: 'client_credentials',
				client_id: app.client_id,
				client_secret: app.client_secret,
				scope: 'write',
			})
		)
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ error: 'invalid_scope' })
	})
})

describe('revoke', () => {
	it('revokes a token so it no longer authenticates', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const revoke = (secret: string) =>
			h.request('/oauth/revoke', form({ token, client_id: app.client_id, client_secret: secret }))

		// RFC 7009 §2.2.1: a client authentication failure is RFC 6749 §5.2's invalid_client.
		const refused = await revoke('wrong')
		expect(refused.status).toBe(401)
		expect(refused.headers.get('www-authenticate')).toMatch(/^Basic /)
		expect(await refused.json()).toMatchObject({ error: 'invalid_client' })
		const anonymous = await h.request('/oauth/revoke', form({ token }))
		expect(anonymous.status).toBe(401)
		expect(await anonymous.json()).toMatchObject({ error: 'invalid_client' })
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(200)

		const response = await revoke(app.client_secret)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({})
		const after = await h.request('/api/v1/accounts/verify_credentials', bearer(token))
		expect(after.status).toBe(401)
		expect(await after.json()).toEqual({ error: 'The access token is invalid' })
		// Revoking again (an unknown token) still succeeds.
		expect((await revoke(app.client_secret)).status).toBe(200)
	})

	it('does not revoke a token of another client', async () => {
		const h = await withAlice()
		const { token } = await login(h)
		const other = await registerApp(h)
		await h.request('/oauth/revoke', form({ token, client_id: other.client_id, client_secret: other.client_secret }))
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(200)
	})
})

describe('scopes on routes', () => {
	it('refuses a token without the required scope', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'read:statuses write:accounts' })
		const { token } = await login(h, { app, scope: 'read:statuses write:accounts' })

		const denied = await h.request('/api/v1/accounts/verify_credentials', bearer(token))
		expect(denied.status).toBe(403)
		expect(await denied.json()).toEqual({ error: 'This action is outside the authorized scopes' })
		const allowed = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(token, json({ display_name: 'A' }, { method: 'PATCH' }))
		)
		expect(allowed.status).toBe(200)
	})

	it('lets the legacy follow scope follow, but not read accounts', async () => {
		const h = await withAlice()
		const bob = await seedAccount(h.store, { username: 'bob' })
		const app = await registerApp(h, { scopes: 'follow' })
		const { token } = await login(h, { app, scope: 'follow' })
		expect((await h.request(`/api/v1/accounts/${bob}/follow`, bearer(token, { method: 'POST' }))).status).toBe(200)
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(403)
	})

	it('needs a valid token on protected routes and ignores tokens on public ones', async () => {
		const h = await withAlice()
		expect((await h.request('/api/v1/accounts/verify_credentials')).status).toBe(401)
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer('nope'))).status).toBe(401)
		expect((await h.request(`/api/v1/accounts/${h.aliceId}`, bearer('nope'))).status).toBe(200)
		expect((await h.request(`/api/v1/accounts/${h.aliceId}`)).status).toBe(200)
	})

	it('opens the API and token endpoints to browser clients, errors included', async () => {
		const h = await withAlice()
		const preflight = await h.request('/oauth/token', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://web-client.test',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		})
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
		const denied = await h.request('/api/v1/accounts/verify_credentials', {
			headers: { origin: 'https://web-client.test' },
		})
		expect(denied.status).toBe(401)
		expect(denied.headers.get('access-control-allow-origin')).toBe('*')
		const consent = await consentPage(h, await registerApp(h))
		expect(consent.headers.get('access-control-allow-origin')).toBeNull()
	})
})

describe('suspension', () => {
	it('deletes tokens and unused codes and refuses the account afterwards', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const pending = await authorizationCode(h, app)

		const result = await callStore(() =>
			h.store.suspendAccount(h.env.CF_VERSION_METADATA.id, { accountId: h.aliceId, now: NOW })
		)
		expect(result).toEqual({ suspended: true })
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])
		expect(await sql(h.store, 'SELECT suspended_at FROM local_accounts')).toEqual([
			{ suspended_at: new Date(NOW).toISOString() },
		])

		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(401)
		expect((await exchange(h, app, pending)).status).toBe(400)
		const consent = await consentPage(h, app)
		expect(consent.status).toBe(403)
		expect(await consent.text()).toContain('suspended')
		expect((await decide(h, app, 'approve')).status).toBe(403)
	})

	it('refuses a token that survived the suspension', async () => {
		const h = await withAlice()
		const { token } = await login(h)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		const response = await h.request('/api/v1/accounts/verify_credentials', bearer(token))
		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({ error: 'Your login is currently disabled' })
	})
})
