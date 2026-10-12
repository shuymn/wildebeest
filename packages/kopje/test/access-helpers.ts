import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { sign } from 'hono/jwt'

import { BUILD } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, SERVICE_CLIENT_ID, TEAM_DOMAIN } from './ops-helpers'
import { createApp } from '../src/app/app'
import type { StoreStub } from '../src/platform/store-client'
import { createAccessVerifier } from '../src/security/access-jwt'

export const NOW_MS = Date.now()

type KeyPair = {
	publicJwk: JsonWebKey & { kid: string; alg: string }
	privateJwk: JsonWebKey & { kid: string; alg: 'RS256' }
}

export async function accessKeys(kid = 'key-1'): Promise<KeyPair> {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair
	const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
	const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
	return {
		publicJwk: { ...publicJwk, kid, alg: 'RS256' },
		privateJwk: { ...privateJwk, kid, alg: 'RS256' },
	}
}

export type Claims = Record<string, unknown>

// An Access application token as Cloudflare issues it.
export function accessToken(keys: KeyPair, claims: Claims = {}): Promise<string> {
	const now = Math.floor(NOW_MS / 1000)
	return sign(
		{
			aud: [ADMIN_AUD],
			iss: `https://${TEAM_DOMAIN}`,
			iat: now - 10,
			nbf: now - 10,
			exp: now + 600,
			type: 'app',
			...claims,
		},
		keys.privateJwk as unknown as Parameters<typeof sign>[1]
	)
}

export const adminClaims = (): Claims => ({ email: ADMIN_EMAIL, sub: 'user-1' })
export const serviceClaims = (): Claims => ({ common_name: SERVICE_CLIENT_ID, sub: '' })

// The app with a JWKS endpoint served from memory; counts JWKS fetches.
export function adminHarness(store: StoreStub, keys: KeyPair, overrides: Record<string, unknown> = {}) {
	const jwks = { fetches: 0, keys: [keys.publicJwk] as JsonWebKey[] }
	const verifyAccess = createAccessVerifier({
		fetch: (url) => {
			jwks.fetches++
			if (url !== `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
				return Promise.resolve(new Response('not found', { status: 404 }))
			}
			return Promise.resolve(Response.json({ keys: jwks.keys }))
		},
	})
	const testEnv = { ...env, ...overrides } as unknown as Env
	const app = createApp({ build: () => BUILD, now: () => NOW_MS, store: () => store, verifyAccess })
	const request = (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://admin.kopje.test${path}`, init), testEnv, createExecutionContext())
	const as = async (claims: Claims, path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers)
		headers.set('Cf-Access-Jwt-Assertion', await accessToken(keys, claims))
		return request(path, { ...init, headers })
	}
	const post = (claims: Claims, path: string, body: unknown = {}) =>
		as(claims, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
	return { app, request, as, post, jwks, env: testEnv }
}
