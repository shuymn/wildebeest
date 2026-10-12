import { type ApiContext, type ApiHandler, authorized, credential, storeCall, vapidKey } from './context'
import { mastodonError } from './errors'
import { type Params, readParams } from './params'
import { OOB_REDIRECT_URI } from '../domain/oauth'
import { DEFAULT_SCOPES, parseScopes } from '../security/scopes'
import { PKCE_VERIFIER, pkceChallenge, sha256Hex } from '../security/tokens'

// App registration and the OAuth token endpoints. /oauth/authorize (behind Access) lives in app/authorize.ts.

const MAX_NAME = 255
const MAX_REDIRECT_URIS = 10
const MAX_URI = 2000

export const registerApp: ApiHandler = async (c, deps) => {
	const result = await readParams(c.req.raw)
	if (!result.ok) {
		return mastodonError(result.status, 'Malformed request body')
	}
	const p = result.params
	const name = (p.get('client_name') ?? '').trim()
	const redirectUris = p.getAll('redirect_uris').flatMap((value) => value.split(/\s+/).filter((uri) => uri !== ''))
	const scopes = parseScopes(p.get('scopes'))
	const website = (p.get('website') ?? '').trim()
	const problems: string[] = []
	if (name === '' || name.length > MAX_NAME) {
		problems.push("Application name can't be blank or longer than 255 characters")
	}
	if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS || !redirectUris.every(validRedirectUri)) {
		problems.push('Redirect URI must be an absolute URI.')
	}
	if (scopes === null) {
		problems.push('Scopes are invalid')
	}
	if (website !== '' && !validWebsite(website)) {
		problems.push('Website is invalid')
	}
	if (problems.length > 0 || scopes === null) {
		return mastodonError(422, `Validation failed: ${problems.join(', ')}`)
	}
	const clientId = deps.randomToken()
	const secret = deps.randomToken()
	const client = await storeCall(c, deps, (s, b) =>
		s.registerApp(b, {
			clientId,
			secret,
			name,
			redirectUris: [...new Set(redirectUris)],
			website: website === '' ? null : website,
			scopes,
			now: deps.now(),
		})
	)
	return c.json({
		id: client.id,
		name: client.name,
		website: client.website,
		redirect_uri: client.redirectUris.join('\n'),
		client_id: clientId,
		client_secret: secret,
		vapid_key: vapidKey(c.env),
	})
}

export const verifyApp: ApiHandler = async (c, deps) => {
	const token = credential(c, deps)
	const { client } = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, token)))
	return c.json({ name: client.name, website: client.website, vapid_key: vapidKey(c.env) })
}

// Absolute, no fragment (RFC 6749 §3.1.2), and not a script URL. Custom schemes of native apps are allowed.
export function validRedirectUri(uri: string): boolean {
	if (uri === OOB_REDIRECT_URI) {
		return true
	}
	const url = uri.length > MAX_URI ? null : parseUrl(uri)
	return url !== null && url.hash === '' && !['javascript:', 'data:', 'vbscript:', 'file:'].includes(url.protocol)
}

function validWebsite(uri: string): boolean {
	const url = uri.length > MAX_URI ? null : parseUrl(uri)
	return url !== null && ['http:', 'https:'].includes(url.protocol)
}

function parseUrl(uri: string): URL | null {
	try {
		return new URL(uri)
	} catch {
		return null
	}
}

// RFC 6749 §5.2 error responses.
function oauthError(
	status: number,
	error: string,
	description: string,
	headers: Record<string, string> = {}
): Response {
	return Response.json(
		{ error, error_description: description },
		{ status, headers: { 'cache-control': 'no-store', pragma: 'no-cache', ...headers } }
	)
}

// A failed client authentication, at /oauth/token and (RFC 7009 §2.2.1) at /oauth/revoke: 401 with the
// authentication scheme the endpoint accepts.
const INVALID_CLIENT = () =>
	oauthError(401, 'invalid_client', 'Client authentication failed due to unknown client or invalid secret.', {
		'www-authenticate': 'Basic realm="oauth", charset="UTF-8"',
	})
const INVALID_GRANT = () =>
	oauthError(400, 'invalid_grant', 'The provided authorization grant is invalid, expired, revoked or was already used.')

const TOKEN_PARAMS = ['grant_type', 'code', 'redirect_uri', 'code_verifier', 'scope', 'client_id', 'client_secret']
const REVOKE_PARAMS = ['token', 'token_type_hint', 'client_id', 'client_secret']

// A request error found before anything else: a repeated scalar parameter, or more than one client authentication
// method (RFC 6749 §2.3: Basic and client_secret in the body).
function requestError(c: ApiContext, p: Params, scalars: readonly string[]): Response | null {
	const repeated = p.repeated(scalars)
	if (repeated !== undefined) {
		return oauthError(400, 'invalid_request', `The ${repeated} parameter is repeated.`)
	}
	if (/^Basic\s/i.test(c.req.header('authorization') ?? '') && p.get('client_secret') !== undefined) {
		return oauthError(400, 'invalid_request', 'Only one client authentication method can be used.')
	}
	return null
}

// client_secret_post or client_secret_basic.
function clientCredentials(c: ApiContext, p: Params): { clientId: string; clientSecret: string } | null {
	const basic = /^Basic\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')
	if (basic?.[1] !== undefined) {
		try {
			const decoded = atob(basic[1])
			const colon = decoded.indexOf(':')
			if (colon !== -1) {
				return {
					clientId: decodeURIComponent(decoded.slice(0, colon)),
					clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
				}
			}
		} catch {
			return null
		}
		return null
	}
	const clientId = p.get('client_id')
	const clientSecret = p.get('client_secret')
	return clientId === undefined || clientSecret === undefined ? null : { clientId, clientSecret }
}

export const tokenHandler: ApiHandler = async (c, deps) => {
	const result = await readParams(c.req.raw)
	if (!result.ok) {
		return oauthError(result.status, 'invalid_request', 'The request body could not be read.')
	}
	const p = result.params
	const invalid = requestError(c, p, TOKEN_PARAMS)
	if (invalid !== null) {
		return invalid
	}
	const client = clientCredentials(c, p)
	if (client === null) {
		return INVALID_CLIENT()
	}
	const token = deps.randomToken()
	const tokenHash = await sha256Hex(token)
	const now = deps.now()
	const grantType = p.get('grant_type')
	let outcome
	if (grantType === 'authorization_code') {
		const code = p.get('code')
		const redirectUri = p.get('redirect_uri')
		const verifier = p.get('code_verifier')
		if (code === undefined || redirectUri === undefined) {
			return oauthError(400, 'invalid_request', 'code and redirect_uri are required.')
		}
		if (verifier !== undefined && !PKCE_VERIFIER.test(verifier)) {
			return INVALID_GRANT()
		}
		const codeHash = await sha256Hex(code)
		const verifierChallenge = verifier === undefined ? null : await pkceChallenge(verifier)
		outcome = await storeCall(c, deps, (s, b) =>
			s.exchangeCode(b, { ...client, codeHash, redirectUri, verifierChallenge, tokenHash, now })
		)
	} else if (grantType === 'client_credentials') {
		const scopes = parseScopes(p.get('scope'), DEFAULT_SCOPES)
		if (scopes === null) {
			return oauthError(400, 'invalid_scope', 'The requested scope is invalid, unknown, or malformed.')
		}
		outcome = await storeCall(c, deps, (s, b) => s.issueAppToken(b, { ...client, scopes, tokenHash, now }))
	} else {
		return oauthError(
			400,
			'unsupported_grant_type',
			'The authorization grant type is not supported by the authorization server.'
		)
	}
	switch (outcome.status) {
		case 'ok':
			return c.json(
				{
					access_token: token,
					token_type: 'Bearer',
					scope: outcome.scopes.join(' '),
					created_at: Math.floor(now / 1000),
				},
				200,
				{ 'cache-control': 'no-store', pragma: 'no-cache' }
			)
		case 'invalid_client':
			return INVALID_CLIENT()
		case 'invalid_grant':
			return INVALID_GRANT()
		case 'invalid_scope':
			return oauthError(400, 'invalid_scope', 'The requested scope is invalid, unknown, or malformed.')
	}
}

// RFC 7009. The client must authenticate (a failure is invalid_client, §2.2.1); an unknown token is still a success.
export const revokeHandler: ApiHandler = async (c, deps) => {
	const result = await readParams(c.req.raw)
	if (!result.ok) {
		return oauthError(result.status, 'invalid_request', 'The request body could not be read.')
	}
	const invalid = requestError(c, result.params, REVOKE_PARAMS)
	if (invalid !== null) {
		return invalid
	}
	const client = clientCredentials(c, result.params)
	const token = result.params.get('token')
	if (client === null) {
		return INVALID_CLIENT()
	}
	if (token === undefined) {
		return oauthError(400, 'invalid_request', 'token is required.')
	}
	const tokenHash = await sha256Hex(token)
	const outcome = await storeCall(c, deps, (s, b) => s.revokeToken(b, { ...client, tokenHash }))
	if (outcome.status === 'invalid_client') {
		return INVALID_CLIENT()
	}
	return c.json({})
}
