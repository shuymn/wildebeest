import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { vi } from 'vitest'

import { type AccessTeam, accessTeam } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, SERVICE_CLIENT_ID, setAccess } from './ops-helpers'
import { createApp } from '../src/app/app'
import type { StoreStub } from '../src/platform/store-client'

export type { AccessTeam }

// A team of its own per test (B3's helper): the JWKS cache is per isolate and keyed by team domain.
export const adminTeam = accessTeam

export type Claims = Record<string, unknown>

// A token of the /admin Access application (its own AUD), as Cloudflare issues it.
export function accessToken(team: AccessTeam, claims: Claims = {}, key?: JsonWebKey): Promise<string> {
	return team.assertion({ aud: [ADMIN_AUD], ...claims }, key)
}

export const adminClaims = (): Claims => ({ email: ADMIN_EMAIL, sub: 'user-1' })
// A service token carries common_name and no email.
export const serviceClaims = (): Claims => ({ email: undefined, common_name: SERVICE_CLIENT_ID, sub: '' })

// Writes the Access settings of the /admin application for this team.
export function setTeamAccess(store: StoreStub, team: AccessTeam, overrides: Record<string, string> = {}) {
	return setAccess(store, { access_team_domain: team.teamDomain, ...overrides })
}

// The app with the team's JWKS endpoint served from memory and the clock of the team's tokens.
export function adminHarness(store: StoreStub, team: AccessTeam, overrides: Record<string, unknown> = {}) {
	const testEnv = { ...env, ...overrides } as unknown as Env
	// Doorbells are recorded, never sent: the test pool's Queue would run the real consumer.
	const doorbell = vi.fn(() => Promise.resolve())
	const app = createApp({ build: () => BUILD, now: () => NOW, store: () => store, fetch: team.fetch, doorbell })
	const request = (path: string, init?: RequestInit) =>
		app.fetch(new Request(`https://admin.kopje.test${path}`, init), testEnv, createExecutionContext())
	const as = async (claims: Claims, path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers)
		headers.set('Cf-Access-Jwt-Assertion', await accessToken(team, claims))
		return request(path, { ...init, headers })
	}
	const post = (claims: Claims, path: string, body: unknown = {}) =>
		as(claims, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
	return { app, request, as, post, env: testEnv, doorbell }
}
