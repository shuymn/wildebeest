import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose'

// Verifies the Cf-Access-Jwt-Assertion header that Cloudflare Access adds in front of /oauth/authorize, with jose.
// The Worker verifies it itself: with static assets bundled, ctx.access is not available. The team domain and AUD
// come from instance_settings (written by /setup), never from env.

export type AccessSettings = { teamDomain: string; aud: string }

export type AccessDeps = { fetch: typeof fetch; now: () => number }

export type AccessResult = { ok: true; email: string } | { ok: false; reason: string }

// Access rotates its signing keys every six weeks, publishes the next key in advance, and keeps a rotated-out key
// valid for 7 days. So a fetched key set is used for at most 7 days: after that it must be fetched again, and if the
// certs endpoint fails then, authentication is refused. A token with an unknown kid refetches the set sooner, at most
// once per cooldown (jose's remote set does both).
const JWKS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const JWKS_COOLDOWN_MS = 30 * 1000
const JWKS_FETCH_TIMEOUT_MS = 5000
const CLOCK_SKEW_S = 60

// Per isolate, keyed by team host.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

// Accepts "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/".
export function teamHost(teamDomain: string): string {
	return teamDomain
		.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '')
}

function keySet(host: string, deps: AccessDeps): ReturnType<typeof createRemoteJWKSet> {
	let set = keySets.get(host)
	if (set === undefined) {
		set = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`), {
			cacheMaxAge: JWKS_MAX_AGE_MS,
			cooldownDuration: JWKS_COOLDOWN_MS,
			timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
			[customFetch]: (url, options) => deps.fetch(url, options),
		})
		keySets.set(host, set)
	}
	return set
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
	let payload
	try {
		;({ payload } = await jwtVerify(token, keySet(host, deps), {
			algorithms: ['RS256'],
			issuer: `https://${host}`,
			audience: settings.aud,
			requiredClaims: ['exp'],
			clockTolerance: CLOCK_SKEW_S,
			currentDate: new Date(deps.now()),
		}))
	} catch (error) {
		// Only the kind of failure is passed on; messages can carry claim values.
		return { ok: false, reason: error instanceof errors.JOSEError ? error.code : 'unavailable' }
	}
	// Service tokens carry no email; only people log in.
	if (typeof payload.email !== 'string' || payload.email === '') {
		return { ok: false, reason: 'no email' }
	}
	return { ok: true, email: payload.email }
}
