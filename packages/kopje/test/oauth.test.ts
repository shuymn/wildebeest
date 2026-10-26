import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	type AccessTeam,
	type ApiHarness,
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
import { appToken, plannedRun, remoteAccounts, scansOf, staleStatistics } from './read-helpers'
import { storeWith } from './setup-helpers'
import { WEBSITE_REFUSED } from './status-helpers'
import { accountForLogin, introspectToken } from '../src/domain/oauth'
import { callStore, type StoreStub } from '../src/platform/store-client'
import { pkceChallenge, sha256Hex } from '../src/security/tokens'

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
		const application = {
			id: app.client_id,
			name: 'Test Client',
			website: 'https://client.test',
			scopes: ['read', 'write'],
			redirect_uris: ['https://client.test/callback'],
			vapid_key: '',
			redirect_uri: 'https://client.test/callback',
		}
		expect(app).toEqual({
			...application,
			client_id: expect.any(String),
			client_secret: expect.any(String),
			client_secret_expires_at: 0,
		})

		// A token narrower than the app: verify_credentials answers the application's scopes, not the token's.
		const token = await h.request(
			'/oauth/token',
			form({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret })
		)
		expect(token.status).toBe(200)
		const { access_token, scope } = await token.json<{ access_token: string; scope: string }>()
		expect(scope).toBe('read')

		const verified = await h.request('/api/v1/apps/verify_credentials', bearer(access_token))
		expect(verified.status).toBe(200)
		const body = await verified.json<Record<string, unknown>>()
		expect(body).toEqual(application)
		// An app token has no user.
		const user = await h.request('/api/v1/accounts/verify_credentials', bearer(access_token))
		expect(user.status).toBe(422)
	})

	it("verifies a user token's application, with its scopes rather than the token's", async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'read write follow' })
		const { access_token } = await (
			await exchange(h, app, await authorizationCode(h, app, { scope: 'read' }))
		).json<{ access_token: string }>()
		const verified = await h.request('/api/v1/apps/verify_credentials', bearer(access_token))
		expect(verified.status).toBe(200)
		expect(await verified.json()).toEqual({
			id: app.client_id,
			name: 'Test Client',
			website: 'https://client.test',
			scopes: ['read', 'write', 'follow'],
			redirect_uris: ['https://client.test/callback'],
			vapid_key: '',
			redirect_uri: 'https://client.test/callback',
		})
		expect((await h.request('/api/v1/apps/verify_credentials', bearer('nope'))).status).toBe(401)
	})

	it('defaults the scopes to read and answers two redirect URIs as a list and joined', async () => {
		const h = await apiHarness()
		const response = await h.request(
			'/api/v1/apps',
			json({ client_name: 'Two', redirect_uris: ['https://client.test/a', 'app://b'] })
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			website: null,
			scopes: ['read'],
			redirect_uris: ['https://client.test/a', 'app://b'],
			redirect_uri: 'https://client.test/a\napp://b',
		})
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

	// Mastodon's APP_NAME_LIMIT of 60 characters (app/lib/application_extension.rb:6, :15, v4.5.11), counted in code
	// points: the most a status presents its app's name within (platform/stored-bounds.ts).
	it('accepts a name of 60 characters, astral ones too, and refuses 61', async () => {
		const h = await apiHarness()
		const register = (name: string) =>
			h.request('/api/v1/apps', json({ client_name: name, redirect_uris: 'https://client.test/cb' }))
		for (const character of ['a', '𠀀']) {
			const accepted = await register(character.repeat(60))
			expect(accepted.status, character).toBe(200)
			expect(await accepted.json(), character).toMatchObject({ name: character.repeat(60) })
			const refused = await register(character.repeat(61))
			expect(refused.status, character).toBe(422)
			expect(await refused.json(), character).toEqual({
				error: "Validation failed: Application name can't be blank or longer than 60 characters",
			})
		}
	})

	// isAppWebsite (platform/stored-bounds.ts): the websites a status would not show are refused here too.
	it('refuses a website with a character outside a URL, not http(s), or without a host', async () => {
		const h = await apiHarness()
		for (const [name, website] of WEBSITE_REFUSED.filter(([name]) => name !== 'blank')) {
			const response = await h.request(
				'/api/v1/apps',
				json({ client_name: 'App', redirect_uris: 'https://client.test/cb', website })
			)
			expect(response.status, name).toBe(422)
			expect(await response.json(), name).toEqual({ error: 'Validation failed: Website is invalid' })
		}
		const accepted = await h.request(
			'/api/v1/apps',
			json({ client_name: 'App', redirect_uris: 'https://client.test/cb', website: 'https://Client.TEST/é' })
		)
		expect(await accepted.json()).toMatchObject({ website: 'https://Client.TEST/é' })
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
		// Not no-referrer, in the header or the page: browsers would post the decision with Origin: null.
		expect(consent.headers.get('referrer-policy')).toBe('same-origin')
		const html = await consent.text()
		// Standards mode: the doctype comes first.
		expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true)
		expect(html).toContain('<meta name="referrer" content="same-origin"/>')
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

	it('refuses a decision posted from another origin, a null origin or none (WEB-1)', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const assertion = await h.team.assertion()
		for (const origin of ['https://evil.test', 'null', undefined]) {
			const headers: Record<string, string> = { 'cf-access-jwt-assertion': assertion }
			if (origin !== undefined) {
				headers.origin = origin
			}
			const response = await h.request(
				'/oauth/authorize',
				form(
					{ client_id: app.client_id, redirect_uri: app.redirect_uri, scope: 'read', decision: 'approve' },
					{ headers }
				)
			)
			expect(response.status, String(origin)).toBe(403)
		}
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

	// RFC 6749 §4.1.2.1: the client and callback are verified, so the refusal goes back to the client with the state.
	it('refuses an Access identity without a local account with access_denied at the callback', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		for (const response of [
			await consentPage(h, app, { email: 'bob@example.com', state: 'st' }),
			await decide(h, app, 'approve', { email: 'bob@example.com', state: 'st' }),
		]) {
			expect(response.status).toBe(302)
			const location = new URL(response.headers.get('location')!)
			expect(location.origin + location.pathname).toBe(app.redirect_uri)
			expect(location.searchParams.get('error')).toBe('access_denied')
			expect(location.searchParams.get('state')).toBe('st')
		}
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])
	})

	it('refuses an account suspended between the consent page and approval', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		expect((await consentPage(h, app, { state: 'st' })).status).toBe(200)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		const response = await decide(h, app, 'approve', { state: 'st' })
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location')!)
		expect(location.searchParams.get('error')).toBe('access_denied')
		expect(location.searchParams.get('state')).toBe('st')
		expect(location.searchParams.get('code')).toBeNull()
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])
	})

	it('keeps account refusals on the page for the out-of-band redirect URI', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { redirectUri: 'urn:ietf:wg:oauth:2.0:oob' })
		for (const response of [
			await consentPage(h, app, { email: 'bob@example.com' }),
			await decide(h, app, 'approve', { email: 'bob@example.com' }),
		]) {
			expect(response.status).toBe(403)
			expect(response.headers.get('location')).toBeNull()
		}
	})

	// RFC 6749 §4.1.2.1: the original state goes back with every error, unless state itself is what is wrong.
	it('keeps a unique state in the error for another repeated parameter, and drops only a bad state', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const assertion = await h.team.assertion()
		const authorize = async (pairs: [string, string][]) => {
			const query = new URLSearchParams([
				['response_type', 'code'],
				['client_id', app.client_id],
				['redirect_uri', app.redirect_uri],
				...pairs,
			])
			const response = await h.request(`/oauth/authorize?${query.toString()}`, {
				headers: { 'cf-access-jwt-assertion': assertion },
			})
			expect(response.status).toBe(302)
			return new URL(response.headers.get('location')!).searchParams
		}
		const repeatedScope = await authorize([
			['scope', 'read'],
			['scope', 'write'],
			['state', 'unique123'],
		])
		expect(repeatedScope.get('error')).toBe('invalid_request')
		expect(repeatedScope.get('state')).toBe('unique123')

		const repeatedState = await authorize([
			['scope', 'read'],
			['state', 'a'],
			['state', 'b'],
		])
		expect(repeatedState.get('error')).toBe('invalid_request')
		expect(repeatedState.has('state')).toBe(false)

		const longState = await authorize([
			['scope', 'read'],
			['state', 'x'.repeat(2001)],
		])
		expect(longState.get('error')).toBe('invalid_request')
		expect(longState.has('state')).toBe(false)
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
			form({ grant_type: 'authorization_code', code, redirect_uri: app.redirect_uri }, { headers: basic(app, 'wrong') })
		)
		expect(badBasic.status).toBe(401)
		expect(badBasic.headers.get('www-authenticate')).toMatch(/^Basic /)
		// A Basic value without a colon has no secret: no client, at the token and revoke endpoints alike.
		for (const path of ['/oauth/token', '/oauth/revoke']) {
			const noSecret = await h.request(
				path,
				form(
					{ grant_type: 'authorization_code', code, redirect_uri: app.redirect_uri, token: code },
					{ headers: { authorization: `Basic ${btoa(app.client_id)}` } }
				)
			)
			expect(noSecret.status, path).toBe(401)
			expect(await noSecret.json(), path).toMatchObject({ error: 'invalid_client' })
		}
		// HTTP Basic client authentication works as well.
		const ok = await h.request(
			'/oauth/token',
			form({ grant_type: 'authorization_code', code, redirect_uri: app.redirect_uri }, { headers: basic(app) })
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

describe('duplicate parameters', () => {
	// RFC 6749 §3.1, §3.2: parameters must not be sent more than once; §2.3: one client authentication method only.
	it('refuses repeated scalar parameters at the token and revoke endpoints', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const code = await authorizationCode(h, app)
		const body = (extra: [string, string][]) =>
			new URLSearchParams([
				['grant_type', 'authorization_code'],
				['code', code],
				['client_id', app.client_id],
				['client_secret', app.client_secret],
				['redirect_uri', app.redirect_uri],
				...extra,
			]).toString()
		const post = (path: string, text: string, headers: Record<string, string> = {}) =>
			h.request(path, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
				body: text,
			})
		for (const extra of [[['code', 'other']], [['redirect_uri', app.redirect_uri]], [['grant_type', 'x']]] as [
			string,
			string,
		][][]) {
			const response = await post('/oauth/token', body(extra))
			expect(response.status, JSON.stringify(extra)).toBe(400)
			expect(await response.json()).toMatchObject({ error: 'invalid_request' })
		}
		// The same parameter in the query and the body counts as repeated too.
		const mixed = await post(`/oauth/token?code=${encodeURIComponent(code)}`, body([]))
		expect(mixed.status).toBe(400)
		// Basic and client_secret in the body are two authentication methods.
		const both = await post('/oauth/token', body([]), basic(app))
		expect(both.status).toBe(400)
		expect(await both.json()).toMatchObject({ error: 'invalid_request' })
		// None of these consumed the code.
		expect((await post('/oauth/token', body([]))).status).toBe(200)

		const revoke = await post(
			'/oauth/revoke',
			new URLSearchParams([
				['token', 'a'],
				['token', 'b'],
				['client_id', app.client_id],
				['client_secret', app.client_secret],
			]).toString()
		)
		expect(revoke.status).toBe(400)
		expect(await revoke.json()).toMatchObject({ error: 'invalid_request' })
	})

	it('refuses repeated authorize parameters, and keeps array parameters elsewhere', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const assertion = await h.team.assertion()
		const base: [string, string][] = [
			['response_type', 'code'],
			['client_id', app.client_id],
			['redirect_uri', app.redirect_uri],
			['scope', 'read'],
			['state', 's'],
		]
		const get = (extra: [string, string][]) =>
			h.request(`/oauth/authorize?${new URLSearchParams([...base, ...extra]).toString()}`, {
				headers: { 'cf-access-jwt-assertion': assertion },
			})
		for (const extra of [
			[['scope', 'write']],
			[
				['response_mode', 'query'],
				['response_mode', 'query'],
			],
		] as [string, string][][]) {
			const response = await get(extra)
			expect(response.status, JSON.stringify(extra)).toBe(302)
			expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
		}
		for (const extra of [[['client_id', app.client_id]], [['redirect_uri', 'https://evil.test/']]] as [
			string,
			string,
		][][]) {
			const response = await get(extra)
			expect(response.status, JSON.stringify(extra)).toBe(400)
			expect(response.headers.get('location')).toBeNull()
		}
		// Mastodon's array parameters still work.
		const registered = await h.request('/api/v1/apps', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams([
				['client_name', 'Arrays'],
				['redirect_uris[]', 'https://a.test/cb'],
				['redirect_uris[]', 'https://b.test/cb'],
			]).toString(),
		})
		expect(registered.status).toBe(200)
		expect(await registered.json()).toMatchObject({ redirect_uri: 'https://a.test/cb\nhttps://b.test/cb' })
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

	it('registers and authorizes the profile scope, which reads only verify_credentials', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'profile' })
		const consent = await (await consentPage(h, app, { scope: 'profile' })).text()
		expect(consent).toContain('<code>profile</code>')
		const code = await authorizationCode(h, app, { scope: 'profile' })
		const exchanged = await exchange(h, app, code)
		expect(exchanged.status).toBe(200)
		const { access_token: token, scope } = await exchanged.json<{ access_token: string; scope: string }>()
		expect(scope).toBe('profile')

		// The same answer as a read:accounts token gets.
		const me = await h.request('/api/v1/accounts/verify_credentials', bearer(token))
		expect(me.status).toBe(200)
		const reader = await login(h, { app: await registerApp(h, { scopes: 'read:accounts' }), scope: 'read:accounts' })
		const full = await h.request('/api/v1/accounts/verify_credentials', bearer(reader.token))
		expect(await me.json()).toEqual(await full.json())

		for (const [path, init] of [
			['/api/v1/preferences', {}],
			['/api/v1/timelines/home', {}],
			[`/api/v1/accounts/${h.aliceId}/statuses`, {}],
			['/api/v1/accounts/update_credentials', json({ display_name: 'A' }, { method: 'PATCH' })],
			['/api/v1/push/subscription', {}],
		] as const) {
			const denied = await h.request(path, bearer(token, init))
			expect(denied.status, path).toBe(403)
			expect(await denied.json(), path).toEqual({ error: 'This action is outside the authorized scopes' })
		}
	})

	it('keeps profile apart from read: neither covers the other', async () => {
		const h = await withAlice()
		const reader = await registerApp(h, { scopes: 'read' })
		const refused = await decide(h, reader, 'approve', { scope: 'profile' })
		expect(new URL(refused.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope')
		const both = await registerApp(h, { scopes: 'profile read' })
		const { token } = await login(h, { app: both, scope: 'profile read' })
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(200)
		expect((await h.request('/api/v1/timelines/home', bearer(token))).status).toBe(200)
	})

	it('needs a valid token on protected routes and ignores tokens on public ones', async () => {
		const h = await withAlice()
		expect((await h.request('/api/v1/accounts/verify_credentials')).status).toBe(401)
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer('nope'))).status).toBe(401)
		expect((await h.request(`/api/v1/accounts/${h.aliceId}`, bearer('nope'))).status).toBe(200)
		expect((await h.request(`/api/v1/accounts/${h.aliceId}`)).status).toBe(200)
	})

	it('answers a refused token, but not a refused scope, with a Bearer challenge', async () => {
		const h = await withAlice()
		const challenge =
			'Bearer realm="Doorkeeper", error="invalid_token", error_description="The access token is invalid"'
		for (const [path, init] of [
			['/api/v1/timelines/home', {}],
			['/api/v1/timelines/home', bearer('nope')],
			// An optional route reads no token as anonymous, but refuses an unknown one.
			['/api/v1/timelines/public', bearer('nope')],
		] as const) {
			const response = await h.request(path, init)
			expect(response.status, path).toBe(401)
			expect(response.headers.get('www-authenticate'), path).toBe(challenge)
		}
		const app = await registerApp(h, { scopes: 'profile' })
		const { token } = await login(h, { app, scope: 'profile' })
		const denied = await h.request('/api/v1/timelines/home', bearer(token))
		expect(denied.status).toBe(403)
		expect(denied.headers.get('www-authenticate')).toBeNull()
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
	it('refuses the account and its tokens and unused codes at once, and deletes them in the jobs', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const pending = await authorizationCode(h, app)

		const result = await callStore(() =>
			h.store.suspendAccount(h.env.CF_VERSION_METADATA.id, { accountId: h.aliceId, now: NOW })
		)
		expect(result).toEqual({ suspended: true })
		// The token and the code wait for the tokens job, refused meanwhile (below).
		expect(await sql(h.store, 'SELECT kind FROM oauth_tokens ORDER BY kind')).toEqual([
			{ kind: 'access' },
			{ kind: 'code' },
		])
		await h.store.runInboundJobs(h.env.CF_VERSION_METADATA.id, { now: NOW })
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])
		expect(await sql(h.store, 'SELECT suspended_at FROM local_accounts')).toEqual([
			{ suspended_at: new Date(NOW).toISOString() },
		])

		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(401)
		expect((await exchange(h, app, pending)).status).toBe(400)
		for (const response of [await consentPage(h, app), await decide(h, app, 'approve')]) {
			expect(response.status).toBe(302)
			expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
		}
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

describe('response_mode and lang', () => {
	// The request with `set` replacing or adding parameters, then `extra` appended.
	const authorizeUrl = (app: App, extra: [string, string][], set: Record<string, string> = {}) =>
		`/oauth/authorize?${new URLSearchParams([
			...Object.entries({
				response_type: 'code',
				client_id: app.client_id,
				redirect_uri: app.redirect_uri,
				scope: 'read',
				state: 'st',
				...set,
			}),
			...extra,
		]).toString()}`

	const callback = (response: Response) => {
		expect(response.status).toBe(302)
		const location = response.headers.get('location')!
		expect(location).not.toContain('#')
		return new URL(location).searchParams
	}

	// Mastodon's consent form carries no mode, so its decision answers in the query whatever the mode was.
	it('accepts the three modes and a blank one, and answers the consent form in the query', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const assertion = await h.team.assertion()
		for (const mode of ['query', 'fragment', 'form_post', '', '  ', '\u0085']) {
			const consent = await h.request(authorizeUrl(app, [['response_mode', mode]]), {
				headers: { 'cf-access-jwt-assertion': assertion },
			})
			expect(consent.status, mode).toBe(200)
			expect(await consent.text()).not.toContain('response_mode')
			const params = callback(await decide(h, app, 'approve', { scope: 'read', state: 'st' }))
			expect(params.get('code'), mode).not.toBeNull()
			expect(params.get('state')).toBe('st')
		}
	})

	// Doorkeeper would honour fragment or form_post on a decision posted with them; Kopje answers in the query.
	it('answers a decision posted directly with a mode in the query', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const assertion = await h.team.assertion()
		for (const mode of ['query', 'fragment', 'form_post']) {
			for (const decision of ['approve', 'deny']) {
				const response = await h.request(
					'/oauth/authorize',
					form(
						{
							client_id: app.client_id,
							redirect_uri: app.redirect_uri,
							scope: 'read',
							state: 'st',
							response_mode: mode,
							decision,
						},
						{ headers: { 'cf-access-jwt-assertion': assertion, origin: 'https://kopje.test' } }
					)
				)
				const params = callback(response)
				expect(params.get(decision === 'approve' ? 'code' : 'error'), `${mode} ${decision}`).not.toBeNull()
			}
		}
	})

	it('refuses another mode at the callback with the state, or on the page for OOB', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'read' })
		const assertion = await h.team.assertion()
		const headers = { 'cf-access-jwt-assertion': assertion }
		const refused = {
			error: 'unsupported_response_mode',
			error_description: 'The authorization server does not support this response mode.',
			state: 'st',
		}
		// U+FEFF is not blank to Rails, so it is a mode, and not a supported one.
		for (const mode of ['bogus', 'QUERY', ' query', 'web_message', '\uFEFF']) {
			const response = await h.request(authorizeUrl(app, [['response_mode', mode]]), { headers })
			expect(Object.fromEntries(callback(response)), mode).toEqual(refused)
		}
		const posted = await h.request(
			'/oauth/authorize',
			form(
				{
					client_id: app.client_id,
					redirect_uri: app.redirect_uri,
					scope: 'read',
					state: 'st',
					response_mode: 'bogus',
					decision: 'approve',
				},
				{ headers: { ...headers, origin: 'https://kopje.test' } }
			)
		)
		expect(Object.fromEntries(callback(posted))).toEqual(refused)
		expect(await sql(h.store, 'SELECT 1 FROM oauth_tokens')).toEqual([])

		// Doorkeeper's order: response_type, then response_mode, then scope.
		const type = await h.request(authorizeUrl(app, [['response_mode', 'bogus']], { response_type: 'token' }), {
			headers,
		})
		expect(callback(type).get('error')).toBe('unsupported_response_type')
		const scope = await h.request(authorizeUrl(app, [['response_mode', 'bogus']], { scope: 'nonsense' }), {
			headers,
		})
		expect(callback(scope).get('error')).toBe('unsupported_response_mode')

		const oobApp = await registerApp(h, { scopes: 'read', redirectUri: 'urn:ietf:wg:oauth:2.0:oob' })
		const oob = await h.request(authorizeUrl(oobApp, [['response_mode', 'bogus']]), { headers })
		expect(oob.status).toBe(400)
		expect(oob.headers.get('location')).toBeNull()
		expect(await oob.text()).toContain('unsupported_response_mode')
	})

	it('shows the same consent page whatever lang says, repeated or not', async () => {
		const h = await withAlice()
		const app = await registerApp(h)
		const assertion = await h.team.assertion()
		const headers = { 'cf-access-jwt-assertion': assertion }
		const plain = await (await h.request(authorizeUrl(app, []), { headers })).text()
		for (const extra of [
			[['lang', 'xx']],
			[
				['lang', 'ja'],
				['lang', 'de'],
			],
		] as [string, string][][]) {
			const response = await h.request(authorizeUrl(app, extra), { headers })
			expect(response.status, JSON.stringify(extra)).toBe(200)
			expect(await response.text()).toBe(plain)
		}
	})
})

const challenge = (description: string, error = 'invalid_token') =>
	`Bearer realm="Doorkeeper", error="${error}", error_description="${description}"`

async function expectInvalidToken(response: Response, label: string, description = 'The access token is invalid') {
	expect(response.status, label).toBe(401)
	expect(await response.json(), label).toEqual({
		error: 'invalid_token',
		error_description: description,
		state: 'unauthorized',
	})
	expect(response.headers.get('www-authenticate'), label).toBe(challenge(description))
	expect(response.headers.get('cache-control'), label).toBe('no-store')
}

const basic = (app: App, secret = app.client_secret) => ({
	authorization: `Basic ${btoa(`${app.client_id}:${secret}`)}`,
})

const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('token info', () => {
	it("describes a user token in Doorkeeper's shape, with no CORS", async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const response = await h.request(
			'/oauth/token/info',
			bearer(token, { headers: { origin: 'https://web-client.test' } })
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(response.headers.get('pragma')).toBe('no-cache')
		expect(response.headers.get('access-control-allow-origin')).toBeNull()
		expect(await response.text()).toBe(
			JSON.stringify({
				resource_owner_id: h.aliceId,
				scope: ['read', 'write', 'follow'],
				expires_in: null,
				application: { uid: app.client_id },
				created_at: Math.floor(NOW / 1000),
			})
		)
	})

	it('answers no owner for an app token and the seconds left for an expiring token', async () => {
		const h = await withAlice()
		const app = await appToken(h)
		expect(await (await h.request('/oauth/token/info', bearer(app))).json()).toMatchObject({
			resource_owner_id: null,
			scope: ['read'],
			expires_in: null,
		})
		const { token } = await login(h)
		await sql(
			h.store,
			'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?',
			new Date(NOW + 3600_500).toISOString(),
			await sha256Hex(token)
		)
		expect(await (await h.request('/oauth/token/info', bearer(token))).json()).toMatchObject({ expires_in: 3601 })
	})

	it('refuses a missing, URL-borne, unknown, expired, revoked, suspended or stale token', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		await expectInvalidToken(await h.request('/oauth/token/info'), 'none')
		await expectInvalidToken(await h.request(`/oauth/token/info?access_token=${token}&bearer_token=${token}`), 'query')
		await expectInvalidToken(await h.request('/oauth/token/info', bearer('nope')), 'unknown')

		const expired = (await login(h, { app })).token
		await sql(h.store, 'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?', ago(0), await sha256Hex(expired))
		await expectInvalidToken(await h.request('/oauth/token/info', bearer(expired)), 'expired')

		const revoked = (await login(h, { app })).token
		await h.request(
			'/oauth/revoke',
			form({ token: revoked, client_id: app.client_id, client_secret: app.client_secret })
		)
		await expectInvalidToken(await h.request('/oauth/token/info', bearer(revoked)), 'revoked')

		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', ago(0))
		await expectInvalidToken(await h.request('/oauth/token/info', bearer(token)), 'suspended')
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = NULL, credential_epoch = credential_epoch + 1')
		await expectInvalidToken(await h.request('/oauth/token/info', bearer(token)), 'stale epoch')
	})
})

const REQUEST_NOT_AUTHORIZED =
	'Request need to be authorized. Required parameter for authorizing request is missing or invalid.'

// Doorkeeper's InvalidRequestResponse when introspection names no caller.
async function unauthorized(response: Response, label: string) {
	expect(response.status, label).toBe(400)
	expect(await response.json(), label).toEqual({ error: 'invalid_request', error_description: REQUEST_NOT_AUTHORIZED })
	expect(response.headers.get('www-authenticate'), label).toBe(challenge(REQUEST_NOT_AUTHORIZED, 'invalid_request'))
	expect(response.headers.get('cache-control'), label).toBe('no-store')
}

describe('introspect', () => {
	const introspect = (h: ApiHarness, body: Record<string, string>, headers: Record<string, string> = {}) =>
		h.request('/oauth/introspect', form(body, { headers }))

	const inactive = async (response: Response, label: string) => {
		expect(response.status, label).toBe(200)
		expect(response.headers.get('cache-control'), label).toBe('no-store')
		expect(await response.text(), label).toBe('{"active":false}')
	}

	it("answers a client about its own token in Doorkeeper's shape, by Basic, form or JSON", async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const active = JSON.stringify({
			active: true,
			scope: 'read write follow',
			client_id: app.client_id,
			token_type: 'Bearer',
			exp: 0,
			iat: Math.floor(NOW / 1000),
		})
		for (const response of [
			await introspect(h, { token }, basic(app)),
			await introspect(h, { token, client_id: app.client_id, client_secret: app.client_secret }),
			await h.request('/oauth/introspect', json({ token, client_id: app.client_id, client_secret: app.client_secret })),
			// token_type_hint is ignored: there are no refresh tokens to look up instead.
			await introspect(h, { token, token_type_hint: 'refresh_token' }, basic(app)),
		]) {
			expect(response.status).toBe(200)
			expect(response.headers.get('cache-control')).toBe('no-store')
			expect(response.headers.get('pragma')).toBe('no-cache')
			expect(await response.text()).toBe(active)
		}
		const expiring = (await login(h, { app })).token
		await sql(
			h.store,
			'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?',
			new Date(NOW + 60_000).toISOString(),
			await sha256Hex(expiring)
		)
		expect(await (await introspect(h, { token: expiring }, basic(app))).json()).toMatchObject({
			exp: Math.floor(NOW / 1000) + 60,
		})
	})

	it('answers a client inactive for any token it may not see or that is not valid', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const other = await login(h)
		const code = await authorizationCode(h, app)
		const check = (body: Record<string, string>, label: string) =>
			introspect(h, body, basic(app)).then((response) => inactive(response, label))
		await check({ token: other.token }, 'another client')
		await check({ token: 'nope' }, 'unknown')
		await check({}, 'missing')
		await check({ token: code }, 'a code')

		const expired = (await login(h, { app })).token
		await sql(h.store, 'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?', ago(0), await sha256Hex(expired))
		await check({ token: expired }, 'expired')
		const revoked = (await login(h, { app })).token
		await h.request(
			'/oauth/revoke',
			form({ token: revoked, client_id: app.client_id, client_secret: app.client_secret })
		)
		await check({ token: revoked }, 'revoked')

		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', ago(0))
		await check({ token }, 'suspended')
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = NULL, credential_epoch = credential_epoch + 1')
		await check({ token }, 'stale epoch')
	})

	it('refuses client credentials that fail, and reads none from the query', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		for (const [label, response] of [
			['wrong secret', await introspect(h, { token }, basic(app, 'wrong'))],
			['wrong body secret', await introspect(h, { token, client_id: app.client_id, client_secret: 'wrong' })],
			['no secret', await introspect(h, { token, client_id: app.client_id })],
			[
				'query secret',
				await h.request(
					`/oauth/introspect?client_secret=${app.client_secret}`,
					form({ token, client_id: app.client_id })
				),
			],
		] as const) {
			expect(response.status, label).toBe(401)
			expect(await response.json(), label).toMatchObject({ error: 'invalid_client' })
		}
		// A Basic header with a blank id, or one that does not decode, names no client; a body client_id still does.
		for (const authorization of ['Basic Og==', 'Basic !!!']) {
			await unauthorized(await introspect(h, { token }, { authorization }), authorization)
		}
		// Without a colon the whole value is the id, with no secret (Doorkeeper's from_basic): a failed client.
		const noColon = await introspect(h, { token }, { authorization: `Basic ${btoa(app.client_id)}` })
		expect(noColon.status).toBe(401)
		expect(await noColon.json()).toMatchObject({ error: 'invalid_client' })
		const bodyId = await introspect(h, { token, client_id: app.client_id }, { authorization: 'Basic Og==' })
		expect(bodyId.status).toBe(401)
		expect(await bodyId.json()).toMatchObject({ error: 'invalid_client' })
		// A token in the query is no token: the client's answer is inactive.
		await inactive(await h.request(`/oauth/introspect?token=${token}`, form({}, { headers: basic(app) })), 'query')
	})

	it('lets a bearer caller see other tokens of its own client only', async () => {
		const h = await withAlice()
		const { app, token: caller } = await login(h)
		const { token: sibling } = await login(h, { app })
		const other = await login(h)
		const active = await introspect(h, { token: sibling }, { authorization: `Bearer ${caller}` })
		expect(active.status).toBe(200)
		expect(await active.json()).toMatchObject({ active: true, client_id: app.client_id })
		// A blank client_id (Rails' blank?, U+0085 included) is no client authentication, so the bearer caller is used.
		for (const clientId of [' ', '\u0085']) {
			const blank = await introspect(h, { token: sibling, client_id: clientId }, { authorization: `Bearer ${caller}` })
			expect(await blank.json(), JSON.stringify(clientId)).toMatchObject({ active: true })
		}
		// U+FEFF is not blank: a client without a secret.
		const feff = await introspect(h, { token: sibling, client_id: '\uFEFF' }, { authorization: `Bearer ${caller}` })
		expect(feff.status).toBe(401)
		expect(await feff.json()).toMatchObject({ error: 'invalid_client' })

		for (const [label, body] of [
			['itself', { token: caller }],
			['another client', { token: other.token }],
			['unknown', { token: 'nope' }],
			['missing', {}],
		] as const) {
			await expectInvalidToken(await introspect(h, body, { authorization: `Bearer ${caller}` }), label)
		}

		await sql(h.store, 'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?', ago(0), await sha256Hex(sibling))
		await inactive(await introspect(h, { token: sibling }, { authorization: `Bearer ${caller}` }), 'expired sibling')
		const stale = (await login(h, { app, email: 'alice@example.com' })).token
		const fresh = await appToken(h, app)
		await sql(h.store, 'UPDATE local_accounts SET credential_epoch = credential_epoch + 1')
		await inactive(await introspect(h, { token: stale }, { authorization: `Bearer ${fresh}` }), 'stale sibling')
	})

	it("answers Doorkeeper's errors for a bearer caller that is missing or not valid", async () => {
		const h = await withAlice()
		const { app, token: target } = await login(h)
		const asCaller = (caller: string) => introspect(h, { token: target }, { authorization: `Bearer ${caller}` })
		await unauthorized(await introspect(h, { token: target }), 'no authentication')
		await unauthorized(await asCaller('nope'), 'unknown')
		await unauthorized(
			await h.request(`/oauth/introspect?access_token=${target}`, form({ token: target })),
			'query token'
		)
		const deleted = (await login(h, { app })).token
		await h.request(
			'/oauth/revoke',
			form({ token: deleted, client_id: app.client_id, client_secret: app.client_secret })
		)
		await unauthorized(await asCaller(deleted), 'deleted')

		const expired = (await login(h, { app })).token
		await sql(h.store, 'UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ?', ago(0), await sha256Hex(expired))
		await expectInvalidToken(await asCaller(expired), 'expired', 'The access token expired')
		await expectInvalidToken(await asCaller(await authorizationCode(h, app)), 'a code')

		const caller = (await login(h, { app })).token
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', ago(0))
		await expectInvalidToken(await asCaller(caller), 'suspended')
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = NULL, credential_epoch = credential_epoch + 1')
		await expectInvalidToken(await asCaller(caller), 'stale epoch')
	})

	it('prefers client credentials over a bearer token, and refuses request errors', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const other = await login(h)
		// The other client's bearer would be refused for this target; the client credentials decide.
		const mixed = await introspect(
			h,
			{ token, client_id: app.client_id, client_secret: app.client_secret },
			{ authorization: `Bearer ${other.token}` }
		)
		expect(await mixed.json()).toMatchObject({ active: true, client_id: app.client_id })

		const repeated = await h.request('/oauth/introspect', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', ...basic(app) },
			body: new URLSearchParams([
				['token', token],
				['token', token],
			]).toString(),
		})
		expect(repeated.status).toBe(400)
		expect(await repeated.json()).toMatchObject({ error: 'invalid_request' })
		const both = await introspect(h, { token, client_secret: app.client_secret }, basic(app))
		expect(both.status).toBe(400)
		expect(await both.json()).toMatchObject({ error: 'invalid_request' })
	})

	it('sends no CORS headers', async () => {
		const h = await withAlice()
		const { app, token } = await login(h)
		const origin = { origin: 'https://web-client.test' }
		const preflight = await h.request('/oauth/introspect', {
			method: 'OPTIONS',
			headers: { ...origin, 'access-control-request-method': 'POST' },
		})
		expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
		const response = await introspect(h, { token }, { ...basic(app), ...origin })
		expect(response.status).toBe(200)
		expect(response.headers.get('access-control-allow-origin')).toBeNull()
	})

	it('sends the Store only digests of the tokens', async () => {
		const inputs: unknown[] = []
		const wrap = (store: StoreStub): StoreStub =>
			storeWith(store, {
				introspectToken: (build, input) => {
					inputs.push(input)
					return store.introspectToken(build as string, input as Parameters<StoreStub['introspectToken']>[1])
				},
				inspectToken: (build, input) => {
					inputs.push(input)
					return store.inspectToken(build as string, input as Parameters<StoreStub['inspectToken']>[1])
				},
			})
		const h = await apiHarness({}, { wrapStore: wrap })
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const { app, token: caller } = await login(h)
		const { token: target } = await login(h, { app })
		await introspect(h, { token: target }, { authorization: `Bearer ${caller}` })
		await introspect(h, { token: target, client_id: app.client_id, client_secret: app.client_secret })
		await h.request('/oauth/token/info', bearer(caller))
		expect(inputs).toHaveLength(3)
		const sent = JSON.stringify(inputs)
		for (const value of [caller, target]) {
			expect(sent).not.toContain(value)
		}
		expect(sent).toContain(await sha256Hex(target))
	})
})

describe('login with stale statistics (RES-7)', () => {
	it('reads the local accounts and seeks the account by id, remote accounts grown after ANALYZE', async () => {
		const h = await withAlice()
		await seedAccount(h.store, { username: 'bob', email: 'bob@example.com' })
		const run = () => plannedRun(h, /FROM local_accounts l/, accountForLogin, { email: 'Alice@Example.com' })
		const { before, after } = await staleStatistics(h, {
			capture: () => run(),
			grow: () => remoteAccounts(h, 100, 200),
		})
		expect(after.result).toEqual(before.result)
		expect(after.result).toEqual({ status: 'ok', accountId: h.aliceId, username: 'alice' })
		expect(after.plans).toHaveLength(1)
		const { plan, rows } = after.plans[0]!
		expect(plan).toEqual(['SCAN l', 'SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)'])
		expect(scansOf(plan, ['a'])).toEqual([])
		expect(rows).toBe(before.plans[0]!.rows)
	}, 60_000)
})

describe('token introspection with stale statistics (RES-7)', () => {
	it('reads every token by its primary key, tokens and clients grown after ANALYZE', async () => {
		const h = await withAlice()
		const { app, token: caller } = await login(h)
		const { token: target } = await login(h, { app })
		const callerHash = await sha256Hex(caller)
		const targetHash = await sha256Hex(target)
		const run = (caller: { kind: 'bearer'; tokenHash: string }) =>
			plannedRun(h, /oauth_tokens/, introspectToken, { targetHash, now: NOW, caller })
		const { before, after } = await staleStatistics(h, {
			capture: async () => [
				await run({ kind: 'bearer', tokenHash: callerHash }),
				await run({ kind: 'bearer', tokenHash: await sha256Hex('unknown') }),
			],
			grow: async () => {
				await sql(
					h.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
					INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at)
					SELECT 'grown-' || i, 's', 'Grown', 'https://client.test/cb', NULL, 'read', '2026-10-01T00:00:00.000Z' FROM n`
				)
				await sql(
					h.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
					INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, created_at, epoch)
					SELECT printf('%064d', i), 'access', 'grown-' || i, ?, 'read', '2026-10-01T00:00:00.000Z', 0 FROM n`,
					h.aliceId
				)
			},
		})
		expect(after.map((r) => r.result)).toEqual(before.map((r) => r.result))
		const [found, unknown] = after
		expect(found!.result).toMatchObject({ status: 'ok', token: { clientId: app.client_id } })
		expect(unknown!.result).toEqual({ status: 'unauthorized' })
		const authorizePlan = [
			'SEARCH t USING PRIMARY KEY (token_hash=?)',
			'SEARCH c USING INDEX sqlite_autoindex_oauth_clients_1 (id=?)',
			'SEARCH l USING INDEX sqlite_autoindex_local_accounts_1 (account_id=?) LEFT-JOIN',
		]
		const byKey = ['SEARCH oauth_tokens USING PRIMARY KEY (token_hash=?)']
		// The caller, the target's owner, the target, its details; then a missing caller and its row.
		expect(found!.plans.map((p) => p.plan)).toEqual([authorizePlan, byKey, authorizePlan, byKey])
		expect(unknown!.plans.map((p) => p.plan)).toEqual([authorizePlan, byKey])
		for (const { plans } of after) {
			expect(plans.flatMap((p) => scansOf(p.plan, ['t', 'c', 'l', 'oauth_tokens']))).toEqual([])
		}
	}, 60_000)
})
