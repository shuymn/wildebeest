import { type Context, Hono } from 'hono'

import { type Client, OOB_REDIRECT_URI } from '../domain/oauth'
import { type ApiDeps, storeCall } from '../mastodon/context'
import { readParams } from '../mastodon/params'
import { verifyAccessJwt } from '../security/access-jwt'
import { parseScopes, withinScopes } from '../security/scopes'
import { PKCE_CHALLENGE, sha256Hex } from '../security/tokens'
import { CodePage, ConsentPage, type ConsentFields, MessagePage } from '../web/consent'

// GET /oauth/authorize shows the consent page; POST /oauth/authorize records the decision. This is the only route
// behind Cloudflare Access: both methods verify the Access assertion against the team domain and AUD in
// instance_settings, then resolve its email to a local account. The decision POST must also come from this origin.

export type AuthorizeDeps = ApiDeps & { fetch: typeof fetch }

type AuthorizeEnv = { Bindings: Env }

const ACCESS_HEADER = 'cf-access-jwt-assertion'
const MAX_STATE = 2000

// No script, no framing, no referrer: the consent page is static HTML.
const PAGE_HEADERS = {
	'content-security-policy':
		"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
	'cache-control': 'no-store',
}

function page(
	c: Context,
	status: 200 | 400 | 403 | 503,
	body: Parameters<Context['html']>[0]
): Response | Promise<Response> {
	return c.html(body, status, PAGE_HEADERS)
}

function message(c: Context, status: 400 | 403 | 503, title: string, text: string): Response | Promise<Response> {
	return page(c, status, <MessagePage title={title} message={text} />)
}

type AuthorizationRequest = {
	client: Client
	redirectUri: string
	scopes: string[]
	state: string | undefined
	codeChallenge: string | null
}

// Validates the request against the registered client. Errors are shown on the page, never sent to a redirect URI
// that has not been verified.
function validate(client: Client, get: (name: string) => string | undefined): AuthorizationRequest | string {
	if (get('response_type') !== 'code') {
		return 'The response type is not supported.'
	}
	const only = client.redirectUris.length === 1 ? client.redirectUris[0] : undefined
	const redirectUri = get('redirect_uri') ?? only
	if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
		return 'The redirect URI is not registered for this application.'
	}
	const scopes = parseScopes(get('scope'))
	if (scopes === null || !withinScopes(scopes, client.scopes)) {
		return 'The requested scope is invalid, unknown, or not allowed for this application.'
	}
	const challenge = get('code_challenge')
	if (challenge !== undefined && (get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(challenge))) {
		return 'Only S256 PKCE challenges are supported.'
	}
	const state = get('state')
	if (state !== undefined && state.length > MAX_STATE) {
		return 'The state parameter is too long.'
	}
	return { client, redirectUri, scopes, state, codeChallenge: challenge ?? null }
}

type Checked = { request: AuthorizationRequest; email: string } | { response: Response | Promise<Response> }

// Access first, then the client: nothing about registered clients is disclosed to a caller Access did not admit.
async function check(
	c: Context<AuthorizeEnv>,
	deps: AuthorizeDeps,
	get: (name: string) => string | undefined
): Promise<Checked> {
	const clientId = get('client_id') ?? ''
	const context = await storeCall(c, deps, (s, b) => s.authorizeContext(b, { clientId }))
	if (context.access === null) {
		return { response: message(c, 503, 'Login unavailable', 'Login has not been set up on this server yet.') }
	}
	const identity = await verifyAccessJwt(c.req.header(ACCESS_HEADER), context.access, deps)
	if (!identity.ok) {
		console.warn({ event: 'kopje.authorize.access-denied', reason: identity.reason })
		return { response: message(c, 403, 'Access denied', 'Your sign-in could not be verified.') }
	}
	if (context.client === null) {
		return { response: message(c, 400, 'Unknown application', 'The application is not registered on this server.') }
	}
	const request = validate(context.client, get)
	if (typeof request === 'string') {
		return { response: message(c, 400, 'Invalid request', request) }
	}
	return { request, email: identity.email }
}

const NO_ACCOUNT = 'There is no account for this sign-in on this server.'
const SUSPENDED = 'This account has been suspended.'

function redirectTo(uri: string, params: Record<string, string | undefined>): Response {
	const url = new URL(uri)
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(name, value)
		}
	}
	return new Response(null, { status: 302, headers: { location: url.toString(), 'cache-control': 'no-store' } })
}

export function authorizeRoutes(deps: AuthorizeDeps): Hono<AuthorizeEnv> {
	const app = new Hono<AuthorizeEnv>()
	app.get('/oauth/authorize', async (c) => {
		const checked = await check(c, deps, (name) => c.req.query(name))
		if ('response' in checked) {
			return checked.response
		}
		const { request, email } = checked
		const login = await storeCall(c, deps, (s, b) => s.accountForLogin(b, { email }))
		if (login.status === 'no_account') {
			// TODO(first-login): create the account for this Access identity here once the keyring is available.
			return message(c, 403, 'No account', NO_ACCOUNT)
		}
		if (login.status === 'suspended') {
			return message(c, 403, 'Account suspended', SUSPENDED)
		}
		const fields: ConsentFields = {
			client_id: request.client.id,
			redirect_uri: request.redirectUri,
			scope: request.scopes.join(' '),
			state: request.state,
			code_challenge: request.codeChallenge ?? undefined,
			code_challenge_method: request.codeChallenge === null ? undefined : 'S256',
		}
		return page(
			c,
			200,
			<ConsentPage
				appName={request.client.name}
				website={request.client.website}
				username={login.username}
				scopes={request.scopes}
				fields={fields}
			/>
		)
	})

	app.post('/oauth/authorize', async (c) => {
		// The decision form is only ever posted by the consent page of this origin.
		if (c.req.header('origin') !== new URL(c.req.url).origin) {
			return message(c, 403, 'Invalid request', 'The form was not submitted from this server.')
		}
		const form = await readParams(c.req.raw)
		if (!form.ok) {
			return message(c, 400, 'Invalid request', 'The form could not be read.')
		}
		const params = form.params
		const checked = await check(c, deps, (name) => (name === 'response_type' ? 'code' : params.get(name)))
		if ('response' in checked) {
			return checked.response
		}
		const { request, email } = checked
		const oob = request.redirectUri === OOB_REDIRECT_URI
		if (params.get('decision') !== 'approve') {
			return oob
				? message(c, 403, 'Authorization denied', 'You denied access to the application.')
				: redirectTo(request.redirectUri, { error: 'access_denied', state: request.state })
		}
		const code = deps.randomToken()
		const result = await storeCall(c, deps, async (s, b) =>
			s.issueCode(b, {
				email,
				clientId: request.client.id,
				redirectUri: request.redirectUri,
				scopes: request.scopes,
				codeChallenge: request.codeChallenge,
				codeHash: await sha256Hex(code),
				now: deps.now(),
			})
		)
		switch (result.status) {
			case 'ok':
				return oob
					? page(c, 200, <CodePage code={code} />)
					: redirectTo(request.redirectUri, { code, state: request.state })
			case 'no_account':
				return message(c, 403, 'No account', NO_ACCOUNT)
			case 'suspended':
				return message(c, 403, 'Account suspended', SUSPENDED)
			case 'invalid_request':
				return message(c, 400, 'Invalid request', 'The application or its redirect URI changed. Start again.')
		}
	})
	return app
}
