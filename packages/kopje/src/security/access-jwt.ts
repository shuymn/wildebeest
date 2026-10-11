import { verifyWithJwks } from 'hono/jwt'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import { decodeHeader } from 'hono/utils/jwt/jwt'
import { JwtTokenAudience, JwtTokenIssuer } from 'hono/utils/jwt/types'

// Verifies the Cf-Access-Jwt-Assertion header that Cloudflare Access adds in front of /oauth/authorize. The Worker
// verifies it itself: with static assets bundled, ctx.access is not available. The team domain and AUD come from
// instance_settings (written by /setup), never from env.

export type AccessSettings = { teamDomain: string; aud: string }

export type AccessDeps = { fetch: typeof fetch; now: () => number }

export type AccessResult = { ok: true; email: string } | { ok: false; reason: string }

type Jwks = { keys: HonoJsonWebKey[]; fetchedAt: number }

// Access rotates its signing keys every six weeks and publishes the next key in advance, so a cached set stays valid
// for a long time. A token with an unknown kid refreshes the set, at most once per REFRESH_MS per team.
const JWKS_TTL_MS = 60 * 60 * 1000
const REFRESH_MS = 30 * 1000
const JWKS_FETCH_TIMEOUT_MS = 5000
const CLOCK_SKEW_S = 60

// Per isolate, keyed by team domain.
const jwksCache = new Map<string, Jwks>()

// Accepts "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/".
export function teamHost(teamDomain: string): string {
	return teamDomain
		.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '')
}

export async function verifyAccessJwt(
	token: string | undefined,
	settings: AccessSettings,
	deps: AccessDeps
): Promise<AccessResult> {
	if (token === undefined || token === '') {
		return { ok: false, reason: 'missing assertion' }
	}
	const host = teamHost(settings.teamDomain)
	let kid: string | undefined
	try {
		kid = decodeHeader(token).kid
	} catch {
		return { ok: false, reason: 'malformed assertion' }
	}
	let jwks = await loadJwks(host, deps, false)
	if (kid !== undefined && !jwks.keys.some((key) => key.kid === kid)) {
		jwks = await loadJwks(host, deps, true)
	}
	let payload: Record<string, unknown>
	try {
		payload = await verifyWithJwks(token, {
			keys: jwks.keys,
			allowedAlgorithms: ['RS256'],
			// Time claims are checked below against the injected clock.
			verification: { iss: `https://${host}`, aud: settings.aud, exp: false, nbf: false, iat: false },
		})
	} catch (error) {
		// hono's messages can include the token itself, so only the kind of failure is passed on.
		const reason =
			error instanceof JwtTokenAudience
				? 'audience'
				: error instanceof JwtTokenIssuer
					? 'issuer'
					: 'signature or format'
		return { ok: false, reason: `invalid ${reason}` }
	}
	const now = Math.floor(deps.now() / 1000)
	if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S <= now) {
		return { ok: false, reason: 'expired' }
	}
	if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > now) {
		return { ok: false, reason: 'not yet valid' }
	}
	// Service tokens carry no email; only people log in.
	if (typeof payload.email !== 'string' || payload.email === '') {
		return { ok: false, reason: 'no email' }
	}
	return { ok: true, email: payload.email }
}

async function loadJwks(host: string, deps: AccessDeps, refresh: boolean): Promise<Jwks> {
	const now = deps.now()
	const cached = jwksCache.get(host)
	if (cached !== undefined && now - cached.fetchedAt < (refresh ? REFRESH_MS : JWKS_TTL_MS)) {
		return cached
	}
	try {
		const response = await deps.fetch(`https://${host}/cdn-cgi/access/certs`, {
			signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
		})
		if (!response.ok) {
			throw new Error(`JWKS answered ${response.status}`)
		}
		const body: unknown = await response.json()
		const keys = (body as { keys?: unknown }).keys
		if (!Array.isArray(keys)) {
			throw new Error('JWKS has no keys')
		}
		const jwks = { keys: keys as HonoJsonWebKey[], fetchedAt: now }
		jwksCache.set(host, jwks)
		return jwks
	} catch (error) {
		// Keep using a stale set rather than locking everyone out while the certs endpoint is unreachable.
		if (cached !== undefined) {
			return cached
		}
		throw error
	}
}
