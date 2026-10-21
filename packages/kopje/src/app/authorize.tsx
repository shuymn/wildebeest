import { type Context, Hono } from 'hono'

import { type Client, OOB_REDIRECT_URI } from '../domain/oauth'
import { type ApiDeps, storeCall } from '../mastodon/context'
import { Params, railsBlank, readParams } from '../mastodon/params'
import { verifyAccessJwt } from '../security/access-jwt'
import { parseScopes, withinScopes } from '../security/scopes'
import { PKCE_CHALLENGE, sha256Hex } from '../security/tokens'
import { CodePage, ConsentPage, type ConsentFields, MessagePage } from '../web/consent'

// GET /oauth/authorize shows the consent page; POST /oauth/authorize records the decision. This is the only route
// behind Cloudflare Access: both methods verify the Access assertion against the team domain and AUD in
// instance_settings, then resolve its email to a local account. The decision POST must also come from this origin.
// `lang` (Mastodon's page locale) has no effect: the page is English only.

export type AuthorizeDeps = ApiDeps & { fetch: typeof fetch }

type AuthorizeEnv = { Bindings: Env }

const ACCESS_HEADER = 'cf-access-jwt-assertion'
const MAX_STATE = 2000

// No script, no framing, no referrer to other origins: the consent page is static HTML. Not `no-referrer`, under which
// the browser posts the decision with `Origin: null` (see PRIVATE_HEADERS in web.tsx).
const PAGE_HEADERS = {
	'content-security-policy':
		"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
	'x-frame-options': 'DENY',
	'referrer-policy': 'same-origin',
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

type AuthorizationError = { error: string; description: string }

const RESPONSE_MODES = ['query', 'fragment', 'form_post']

// Validates the request against the registered client in two steps (RFC 6749 §4.1.2.1). The client and its redirect
// URI come first, and their errors are shown on the page, never sent to a redirect URI that has not been verified.
// Every later error goes back to the verified redirect URI with the original state (shown on the page for OOB).
function validateRedirect(client: Client, get: (name: string) => string | undefined): string | null {
	const only = client.redirectUris.length === 1 ? client.redirectUris[0] : undefined
	const redirectUri = get('redirect_uri') ?? only
	return redirectUri !== undefined && client.redirectUris.includes(redirectUri) ? redirectUri : null
}

function validate(
	client: Client,
	redirectUri: string,
	state: string | undefined,
	get: (name: string) => string | undefined
): AuthorizationRequest | AuthorizationError {
	const responseType = get('response_type')
	if (responseType !== 'code') {
		return responseType === undefined
			? { error: 'invalid_request', description: 'The response type is missing.' }
			: { error: 'unsupported_response_type', description: 'The response type is not supported.' }
	}
	// Doorkeeper's response modes of the code flow, checked in its order (after response_type); a blank one is query.
	// Every answer goes in the query: Mastodon's consent form carries no mode, and Kopje always shows the form.
	const mode = get('response_mode')
	if (mode !== undefined && !railsBlank(mode) && !RESPONSE_MODES.includes(mode)) {
		return {
			error: 'unsupported_response_mode',
			description: 'The authorization server does not support this response mode.',
		}
	}
	const scopes = parseScopes(get('scope'))
	if (scopes === null || !withinScopes(scopes, client.scopes)) {
		return {
			error: 'invalid_scope',
			description: 'The requested scope is invalid, unknown, or not allowed for this application.',
		}
	}
	const challenge = get('code_challenge')
	if (challenge !== undefined && (get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(challenge))) {
		return { error: 'invalid_request', description: 'Only S256 PKCE challenges are supported.' }
	}
	return { client, redirectUri, scopes, state, codeChallenge: challenge ?? null }
}

// An error after the redirect URI is verified: back to the client, or on the page for OOB.
function authorizationError(
	c: Context,
	redirectUri: string,
	state: string | undefined,
	{ error, description }: AuthorizationError
): Response | Promise<Response> {
	return redirectUri === OOB_REDIRECT_URI
		? message(c, 400, 'Authorization failed', `${error}: ${description}`)
		: redirectTo(redirectUri, { error, error_description: description, state })
}

// RFC 6749 §3.1: each parameter at most once.
const AUTHORIZE_PARAMS = [
	'response_type',
	'response_mode',
	'scope',
	'state',
	'code_challenge',
	'code_challenge_method',
	'decision',
]

type Checked =
	{ request: AuthorizationRequest; email: string; firstParty: boolean } | { response: Response | Promise<Response> }

// Access first, then the client: nothing about registered clients is disclosed to a caller Access did not admit.
async function check(
	c: Context<AuthorizeEnv>,
	deps: AuthorizeDeps,
	params: Params,
	fixed: Record<string, string> = {}
): Promise<Checked> {
	const get = (name: string) => fixed[name] ?? params.get(name)
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
	// A repeated client_id or redirect_uri leaves the callback unverified, so it is answered on the page.
	const redirectUri =
		params.repeated(['client_id', 'redirect_uri']) === undefined ? validateRedirect(context.client, get) : null
	if (redirectUri === null) {
		return {
			response: message(c, 400, 'Invalid request', 'The redirect URI is not registered for this application.'),
		}
	}
	// The state is checked on its own first, so that every later error carries it back (RFC 6749 §4.1.2.1). Only a
	// repeated or too long state is left out: it is the error, and cannot be sent back as the client sent it.
	const sentState = get('state')
	const stateOk = params.repeated(['state']) === undefined && (sentState?.length ?? 0) <= MAX_STATE
	const state = stateOk ? sentState : undefined
	const repeated = params.repeated(AUTHORIZE_PARAMS)
	if (repeated !== undefined) {
		return {
			response: authorizationError(c, redirectUri, state, {
				error: 'invalid_request',
				description: `The ${repeated} parameter is repeated.`,
			}),
		}
	}
	if (!stateOk) {
		return {
			response: authorizationError(c, redirectUri, undefined, {
				error: 'invalid_request',
				description: 'The state parameter is too long.',
			}),
		}
	}
	const request = validate(context.client, redirectUri, state, get)
	if ('error' in request) {
		return { response: authorizationError(c, redirectUri, state, request) }
	}
	return { request, email: identity.email, firstParty: context.firstParty }
}

const NO_ACCOUNT = 'There is no account for this sign-in on this server.'
const SUSPENDED = 'This account has been suspended.'

// The signed-in account cannot authorize (none, or suspended). The client and callback are verified by now, so the
// refusal goes back to the client as access_denied with the state (RFC 6749 §4.1.2.1); OOB shows it on the page.
function accountRefused(
	c: Context,
	request: AuthorizationRequest,
	title: string,
	text: string
): Response | Promise<Response> {
	return request.redirectUri === OOB_REDIRECT_URI
		? message(c, 403, title, text)
		: authorizationError(c, request.redirectUri, request.state, { error: 'access_denied', description: text })
}

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
		const checked = await check(c, deps, new Params([...new URL(c.req.url).searchParams]))
		if ('response' in checked) {
			return checked.response
		}
		const { request, email, firstParty } = checked
		const login = await storeCall(c, deps, (s, b) => s.accountForLogin(b, { email }))
		if (login.status === 'no_account') {
			// TODO(first-login): create the account for this Access identity here once the keyring is available.
			return accountRefused(c, request, 'No account', NO_ACCOUNT)
		}
		if (login.status === 'suspended') {
			return accountRefused(c, request, 'Account suspended', SUSPENDED)
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
				firstParty={firstParty}
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
		const checked = await check(c, deps, params, { response_type: 'code' })
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
				return accountRefused(c, request, 'No account', NO_ACCOUNT)
			case 'suspended':
				return accountRefused(c, request, 'Account suspended', SUSPENDED)
			// The client or its redirect URIs changed after the check: the callback is no longer verified.
			case 'invalid_request':
				return message(c, 400, 'Invalid request', 'The application or its redirect URI changed. Start again.')
		}
	})
	return app
}
