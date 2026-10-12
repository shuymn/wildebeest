import { decode, verifyWithJwks } from 'hono/jwt'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'

// Verifies a Cloudflare Access JWT (Cf-Access-Jwt-Assertion) ourselves: with static assets bundled the Worker gets
// no ctx.access. Keys come from the team's JWKS and are cached per isolate.

export type AccessConfig = {
	teamDomain: string | null
	aud: string | null
	adminEmail: string | null
	serviceTokenClientId: string | null
}

export type AccessIdentity = { kind: 'admin'; email: string } | { kind: 'service-token'; clientId: string }

export type AccessCheck = { ok: true; identity: AccessIdentity } | { ok: false; status: 401 | 403; reason: string }

export type AccessVerifierOptions = {
	fetch?: (url: string) => Promise<Response>
	now?: () => number
	// How long fetched keys are trusted, and how soon an unknown kid may trigger a refetch.
	ttlMs?: number
	refetchAfterMs?: number
}

const TEAM_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function normalizeTeamDomain(value: string): string | null {
	const host = value
		.trim()
		.toLowerCase()
		.replace(/^https:\/\//, '')
		.replace(/\/+$/, '')
	return TEAM_DOMAIN.test(host) ? host : null
}

export function createAccessVerifier(options: AccessVerifierOptions = {}) {
	const fetchJwks = options.fetch ?? ((url: string) => fetch(url))
	const now = options.now ?? Date.now
	const ttlMs = options.ttlMs ?? 60 * 60 * 1000
	const refetchAfterMs = options.refetchAfterMs ?? 60 * 1000
	const cache = new Map<string, { keys: HonoJsonWebKey[]; fetchedAt: number }>()

	async function keysFor(team: string, kid: string): Promise<HonoJsonWebKey[]> {
		const cached = cache.get(team)
		const age = cached === undefined ? Infinity : now() - cached.fetchedAt
		const known = cached?.keys.some((key) => key.kid === kid) ?? false
		if (cached !== undefined && age < ttlMs && (known || age < refetchAfterMs)) {
			return cached.keys
		}
		const response = await fetchJwks(`https://${team}/cdn-cgi/access/certs`)
		if (!response.ok) {
			throw new Error(`JWKS fetch failed with ${response.status}`)
		}
		const body = (await response.json()) as { keys?: unknown }
		if (!Array.isArray(body.keys)) {
			throw new Error('JWKS has no keys')
		}
		const keys = body.keys as HonoJsonWebKey[]
		cache.set(team, { keys, fetchedAt: now() })
		return keys
	}

	return async function verifyAccess(token: string | undefined, config: AccessConfig): Promise<AccessCheck> {
		if (token === undefined || token === '') {
			return { ok: false, status: 401, reason: 'missing Cf-Access-Jwt-Assertion' }
		}
		const team = config.teamDomain === null ? null : normalizeTeamDomain(config.teamDomain)
		if (team === null || config.aud === null) {
			return { ok: false, status: 401, reason: 'Access is not configured for /admin' }
		}
		let payload: Record<string, unknown>
		try {
			const { header, payload: claims } = decode(token)
			if (typeof claims.exp !== 'number') {
				return { ok: false, status: 401, reason: 'token has no expiry' }
			}
			const keys = await keysFor(team, header.kid ?? '')
			payload = await verifyWithJwks(token, {
				keys,
				verification: { iss: `https://${team}`, aud: config.aud },
				allowedAlgorithms: ['RS256'],
			})
		} catch (error) {
			const name = error instanceof Error ? error.name : 'error'
			return { ok: false, status: 401, reason: `invalid Access token (${name})` }
		}
		const email = payload.email
		if (typeof email === 'string' && email !== '') {
			if (config.adminEmail !== null && email.toLowerCase() === config.adminEmail.toLowerCase()) {
				return { ok: true, identity: { kind: 'admin', email } }
			}
			return { ok: false, status: 403, reason: 'this identity is not the admin' }
		}
		const commonName = payload.common_name
		if (
			typeof commonName === 'string' &&
			commonName !== '' &&
			config.serviceTokenClientId !== null &&
			commonName === config.serviceTokenClientId
		) {
			return { ok: true, identity: { kind: 'service-token', clientId: commonName } }
		}
		return { ok: false, status: 403, reason: 'this service token is not the admin CLI token' }
	}
}

export type AccessVerifier = ReturnType<typeof createAccessVerifier>

// Constant-time comparison of two secrets (as UTF-8), for IMPORT_TOKEN.
export function timingSafeEqualText(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a)
	const y = new TextEncoder().encode(b)
	let diff = x.length ^ y.length
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
	}
	return diff === 0
}
