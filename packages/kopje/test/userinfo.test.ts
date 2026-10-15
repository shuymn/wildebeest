import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, form, login, registerApp, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { scopedToken } from './read-helpers'
import { SCOPES } from '../src/security/scopes'

// GET and POST /oauth/userinfo (Mastodon 4.5's OAuth::UserinfoController) and the authorization server metadata that
// names it (/.well-known/oauth-authorization-server).

const BEARER_CHALLENGE =
	'Bearer realm="Doorkeeper", error="invalid_token", error_description="The access token is invalid"'

async function withAlice() {
	const h = await apiHarness()
	const aliceId = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	return { ...h, aliceId }
}

const METHODS = [
	['GET', {}],
	['POST', { method: 'POST' }],
] as const

describe('/oauth/userinfo', () => {
	it.each(METHODS)('answers %s with the claims of the token’s account', async (_method, init) => {
		const h = await withAlice()
		const token = await scopedToken(h, 'profile')
		const response = await h.request('/oauth/userinfo', bearer(token, init))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toMatch(/^application\/json/)
		expect(await response.json()).toEqual({
			iss: 'https://kopje.test/',
			sub: 'https://kopje.test/ap/users/alice',
			name: 'Alice',
			preferred_username: 'alice',
			profile: 'https://kopje.test/@alice',
			picture: 'https://kopje.test/assets/avatar.png',
		})
	})

	it('shows the name, profile and avatar as verify_credentials does', async () => {
		const h = await withAlice()
		await sql(
			h.store,
			"UPDATE accounts SET display_name = 'Alice A.', avatar_url = 'https://media.kopje.test/a.png' WHERE id = ?",
			h.aliceId
		)
		const token = await scopedToken(h, 'profile')
		const claims = await (await h.request('/oauth/userinfo', bearer(token))).json()
		const account = await (
			await h.request('/api/v1/accounts/verify_credentials', bearer(token))
		).json<{
			display_name: string
			username: string
			url: string
			avatar: string
		}>()
		expect(claims).toMatchObject({
			name: account.display_name,
			preferred_username: account.username,
			profile: account.url,
			picture: account.avatar,
		})
		expect(account).toMatchObject({ display_name: 'Alice A.', avatar: 'https://media.kopje.test/a.png' })
	})

	it.each(['read', 'read:accounts', 'write'])('refuses a token with %s and not profile', async (scope) => {
		const h = await withAlice()
		const token = await scopedToken(h, scope)
		for (const [, init] of METHODS) {
			const response = await h.request('/oauth/userinfo', bearer(token, init))
			expect(response.status).toBe(403)
			expect(response.headers.get('www-authenticate')).toBeNull()
			expect(await response.json()).toEqual({ error: 'This action is outside the authorized scopes' })
		}
	})

	it('refuses a missing or unknown token with a Bearer challenge', async () => {
		const h = await withAlice()
		for (const [, init] of METHODS) {
			for (const request of [init, bearer('nope', init)]) {
				const response = await h.request('/oauth/userinfo', request)
				expect(response.status).toBe(401)
				expect(response.headers.get('www-authenticate')).toBe(BEARER_CHALLENGE)
				expect(await response.json()).toEqual({ error: 'The access token is invalid' })
			}
		}
	})

	it('refuses an app token, which has no account', async () => {
		const h = await withAlice()
		const app = await registerApp(h, { scopes: 'profile' })
		const issued = await h.request(
			'/oauth/token',
			form({
				grant_type: 'client_credentials',
				scope: 'profile',
				client_id: app.client_id,
				client_secret: app.client_secret,
			})
		)
		const { access_token } = await issued.json<{ access_token: string }>()
		const response = await h.request('/oauth/userinfo', bearer(access_token))
		expect(response.status).toBe(422)
		expect(await response.json()).toEqual({ error: 'This method requires an authenticated user' })
	})

	it('refuses a suspended account, whatever the token’s scopes', async () => {
		const h = await withAlice()
		const tokens = [await scopedToken(h, 'profile'), await scopedToken(h, 'read')]
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		for (const token of tokens) {
			const response = await h.request('/oauth/userinfo', bearer(token))
			expect(response.status).toBe(403)
			expect(await response.json()).toEqual({ error: 'Your login is currently disabled' })
		}
	})

	it('is open to browser clients, errors included', async () => {
		const h = await withAlice()
		const preflight = await h.request('/oauth/userinfo', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://web-client.test',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'authorization',
			},
		})
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
		const denied = await h.request('/oauth/userinfo', { headers: { origin: 'https://web-client.test' } })
		expect(denied.status).toBe(401)
		expect(denied.headers.get('access-control-allow-origin')).toBe('*')
	})
})

describe('/.well-known/oauth-authorization-server', () => {
	it('describes the endpoints, scopes and flows Kopje supports', async () => {
		const h = await withAlice()
		const response = await h.request('/.well-known/oauth-authorization-server', {
			headers: { origin: 'https://web-client.test' },
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toMatch(/^application\/json/)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(await response.json()).toEqual({
			issuer: 'https://kopje.test/',
			authorization_endpoint: 'https://kopje.test/oauth/authorize',
			token_endpoint: 'https://kopje.test/oauth/token',
			revocation_endpoint: 'https://kopje.test/oauth/revoke',
			userinfo_endpoint: 'https://kopje.test/oauth/userinfo',
			scopes_supported: SCOPES,
			response_types_supported: ['code'],
			response_modes_supported: ['query'],
			grant_types_supported: ['authorization_code', 'client_credentials'],
			token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
			code_challenge_methods_supported: ['S256'],
			service_documentation: 'https://docs.joinmastodon.org/',
			app_registration_endpoint: 'https://kopje.test/api/v1/apps',
		})
	})

	it('names endpoints that answer as it says', async () => {
		const h = await withAlice()
		const metadata = await (await h.request('/.well-known/oauth-authorization-server')).json<Record<string, string>>()
		const path = (name: string) => new URL(metadata[name] ?? '').pathname
		const app = await registerApp(h, { scopes: 'profile' })
		expect(path('app_registration_endpoint')).toBe('/api/v1/apps')
		const { token } = await login(h, { app, scope: 'profile' })
		expect((await h.request(path('userinfo_endpoint'), bearer(token))).status).toBe(200)
		const revoked = await h.request(
			path('revocation_endpoint'),
			form({ token, client_id: app.client_id, client_secret: app.client_secret })
		)
		expect(revoked.status).toBe(200)
		expect((await h.request(path('userinfo_endpoint'), bearer(token))).status).toBe(401)
	})
})
