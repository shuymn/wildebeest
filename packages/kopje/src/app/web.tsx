import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'

import type { Account, CredentialAccount } from '../domain/accounts'
import type { Authorized, UserCredential } from '../domain/auth'
import type { ProfileImage } from '../domain/media'
import type { Status } from '../domain/status-presenter'
import { SESSION_LIFETIME_MS, WEB_SCOPES } from '../domain/web-session'
import { requireSetup } from '../federation/setup-gate'
import { credentialChanges } from '../mastodon/accounts'
import { type ApiDeps, present, storeCall } from '../mastodon/context'
import { receiveImageUpload } from '../mastodon/media'
import { type Params, readParams } from '../mastodon/params'
import type { Scope } from '../security/scopes'
import { pkceChallenge, sha256Hex } from '../security/tokens'
import { MessagePage, ProfilePage, SettingsPage, StatusPage } from '../web/pages'
import {
	csrfMatches,
	csrfToken,
	decodeLogin,
	encodeLogin,
	LOGIN_COOKIE,
	LOGIN_LIFETIME_S,
	returnPath,
	sameOrigin,
	SESSION_COOKIE,
	stateMatches,
	wantsActivityPub,
} from '../web/session'
import { noticeOf, STRINGS } from '../web/strings'

// The web UI (B5): public profiles and permalinks, sign-in through Access, and the settings page. Posting and reading
// happen in Mastodon clients; this is all the instance serves as HTML besides the consent page.
//
//   - WEB-2: every page has a CSP with no script source, frame-ancestors 'none' and X-Frame-Options DENY; pages of a
//     signed-in user are never cached (no-store); WEB-3: none of these routes sends CORS headers (only the API's
//     paths are opened in app.ts); WEB-5: every answer has its exact type and nosniff.
//   - WEB-1, WEB-4: every POST checks Origin (missing, `null` and foreign answer 403) and the session's anti-forgery
//     token before anything else is read or written; redirects go to validated local paths only.
//   - AUTH: the session is an access token of the web client in an opaque __Host- cookie (domain/web-session.ts),
//     validated by the Store in the transaction of each operation.

export type WebDeps = ApiDeps & {
	// Serves another path of this app for the same request (content negotiation to the ActivityPub documents).
	dispatch: (request: Request, env: Env, ctx: Context['executionCtx']) => Response | Promise<Response>
}

type WebEnv = { Bindings: Env; Variables: { domain: string } }
type WebContext = Context<WebEnv>

const CSP =
	"default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

const FRAMING = { 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' }

// Public pages may be kept briefly; they vary with Accept (the same URL serves ActivityPub documents).
const PUBLIC_HEADERS = {
	...FRAMING,
	'referrer-policy': 'same-origin',
	'cache-control': 'public, max-age=60',
	vary: 'Accept',
}

// Pages of a signed-in user, and every answer of the sign-in flow.
const PRIVATE_HEADERS = { ...FRAMING, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }

type PageStatus = 200 | 400 | 403 | 404 | 410 | 422

function publicPage(c: WebContext, status: PageStatus, body: Parameters<WebContext['html']>[0]) {
	return c.html(body, status, PUBLIC_HEADERS)
}

function privatePage(c: WebContext, status: PageStatus, body: Parameters<WebContext['html']>[0]) {
	return c.html(body, status, PRIVATE_HEADERS)
}

function message(
	c: WebContext,
	status: PageStatus,
	title: string,
	text: string,
	link?: { href: string; text: string }
) {
	return privatePage(c, status, <MessagePage title={title} message={text} link={link} />)
}

function notFound(c: WebContext) {
	return publicPage(c, 404, <MessagePage title={STRINGS.notFoundTitle} message={STRINGS.notFound} />)
}

// A redirect to a local path (never a URL from the request).
function redirect(path: string, status: 302 | 303 = 303): Response {
	return new Response(null, { status, headers: { location: path, 'cache-control': 'no-store' } })
}

function cookieOptions(maxAge: number) {
	return { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge } as const
}

// Deleting a __Host- cookie repeats its prefix, path and Secure.
const CLEARED = { prefix: 'host', path: '/', secure: true } as const

const BACK = { href: '/settings', text: STRINGS.backToSettings }

// `/@alice` or `/@alice@this.domain`; null for another server's account (only local profiles are served).
function localUsername(handle: string, domain: string): string | null {
	const name = handle.replace(/^@/, '')
	const at = name.indexOf('@')
	if (at === -1) {
		return name
	}
	return name.slice(at + 1).toLowerCase() === domain ? name.slice(0, at) : null
}

export function webRoutes(deps: WebDeps): Hono<WebEnv> {
	const app = new Hono<WebEnv>()
	const setup = requireSetup(deps.build, deps.store)

	// The same request for another path of this app, keeping its headers (Accept, signatures).
	const forward = (c: WebContext, path: string) =>
		deps.dispatch(new Request(new URL(path, c.req.url), c.req.raw), c.env, c.executionCtx)

	// ---- public pages

	app.get('/:handle{@[^/]+}', setup, async (c) => {
		const username = localUsername(c.req.param('handle'), c.get('domain'))
		if (username === null || username === '') {
			return notFound(c)
		}
		if (wantsActivityPub(c.req.header('accept'))) {
			// The account first, case-insensitively: the actor endpoint answers only its stored spelling, and serves a
			// suspended actor redacted.
			const account = await storeCall(c, deps, (s, b) =>
				s.lookupAccount(b, { username, domain: null, present: present(c) })
			)
			return account === null
				? withVary(new Response('Not Found', { status: 404 }))
				: withVary(await forward(c, `/ap/users/${encodeURIComponent(account.username)}`))
		}
		const maxId = c.req.query('max_id') ?? null
		const page = await storeCall(c, deps, (s, b) => s.profilePage(b, { username, maxId, present: present(c) }))
		if (page.status === 'not_found') {
			return notFound(c)
		}
		// Mastodon answers a suspended account's profile with 410 Gone.
		if (page.status === 'suspended') {
			return publicPage(c, 410, <MessagePage title={STRINGS.goneTitle} message={STRINGS.gone} />)
		}
		const domain = c.get('domain')
		const actorUri = `https://${domain}/ap/users/${page.account.username}`
		return publicPage(
			c,
			200,
			// The RPC's structured clone types widen the presenters' empty tuples; the values are the presenters'.
			<ProfilePage
				account={page.account as Account}
				statuses={page.statuses as Status[]}
				next={page.next}
				domain={domain}
				actorUri={actorUri}
			/>
		)
	})

	// VIS-4: a status an anonymous viewer may see, or 404 for anything else, alike.
	app.get('/:handle{@[^/]+}/:id', setup, async (c) => {
		const username = localUsername(c.req.param('handle'), c.get('domain'))
		const id = c.req.param('id')
		if (username === null || username === '' || id.length > 64) {
			return notFound(c)
		}
		const page = await storeCall(c, deps, (s, b) => s.statusPage(b, { username, id, present: present(c) }))
		if (page.status === 'not_found') {
			return wantsActivityPub(c.req.header('accept'))
				? withVary(new Response('Not Found', { status: 404 }))
				: notFound(c)
		}
		if (page.status === 'moved') {
			// A legacy id moves to the status's id for good, under the stored username (never the request's text).
			return new Response(null, {
				status: 301,
				headers: { location: `/@${page.username}/${page.id}`, vary: 'Accept', 'cache-control': 'public, max-age=60' },
			})
		}
		if (wantsActivityPub(c.req.header('accept'))) {
			// The object endpoint serves the Note and applies VIS-4 again.
			return withVary(await forward(c, new URL(page.value.uri).pathname))
		}
		return publicPage(
			c,
			200,
			<StatusPage status={page.value as Status} parent={page.parent} domain={c.get('domain')} />
		)
	})

	// ---- sign-in (Access at /oauth/authorize) and sign-out

	app.get('/login', setup, async (c) => {
		const domain = c.get('domain')
		const target = returnPath(c.req.query('return'))
		// The cookies belong to the instance's own host.
		if (new URL(c.req.url).host !== domain) {
			return redirect(`https://${domain}/login?return=${encodeURIComponent(target)}`, 302)
		}
		const redirectUri = `https://${domain}/auth/callback`
		const state = deps.randomToken()
		const verifier = deps.randomToken()
		const challenge = await pkceChallenge(verifier)
		const previous = getCookie(c, SESSION_COOKIE, 'host')
		const clientId = await storeCall(c, deps, (s, b) =>
			s.ensureWebClient(b, { clientId: deps.randomToken(), secret: deps.randomToken(), redirectUri, now: deps.now() })
		)
		const startedWith = previous === undefined ? null : await sha256Hex(previous)
		setCookie(
			c,
			LOGIN_COOKIE,
			encodeLogin({ state, verifier, startedWith, returnTo: target }),
			cookieOptions(LOGIN_LIFETIME_S)
		)
		const query = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: WEB_SCOPES.join(' '),
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		})
		return c.body(null, 302, { location: `/oauth/authorize?${query.toString()}`, 'cache-control': 'no-store' })
	})

	app.get('/auth/callback', setup, async (c) => {
		const login = decodeLogin(getCookie(c, LOGIN_COOKIE, 'host'))
		// The state ties the callback to the sign-in this browser started; without it nothing is exchanged. A stale
		// callback (an older tab's) leaves the login cookie of the newer sign-in in place.
		const state = c.req.query('state')
		if (login === null || state === undefined || !stateMatches(login, state)) {
			return message(c, 400, STRINGS.signInExpiredTitle, STRINGS.signInExpired, {
				href: '/login',
				text: STRINGS.signIn,
			})
		}
		deleteCookie(c, LOGIN_COOKIE, CLEARED)
		const code = c.req.query('code')
		if (code === undefined || c.req.query('error') !== undefined) {
			return message(c, 403, STRINGS.signInCancelledTitle, STRINGS.signInCancelled, {
				href: `/login?return=${encodeURIComponent(login.returnTo)}`,
				text: STRINGS.signIn,
			})
		}
		const token = deps.randomToken()
		const presented = getCookie(c, SESSION_COOKIE, 'host')
		const result = await storeCall(c, deps, async (s, b) =>
			s.startWebSession(b, {
				stateHash: await sha256Hex(state),
				codeHash: await sha256Hex(code),
				redirectUri: `https://${c.get('domain')}/auth/callback`,
				verifierChallenge: await pkceChallenge(login.verifier),
				tokenHash: await sha256Hex(token),
				startedWith: login.startedWith,
				presented: presented === undefined ? null : await sha256Hex(presented),
				family: deps.randomToken(),
				now: deps.now(),
			})
		)
		if (result.status !== 'ok') {
			return message(c, 400, STRINGS.signInFailedTitle, STRINGS.signInFailed, { href: '/login', text: STRINGS.signIn })
		}
		setCookie(c, SESSION_COOKIE, token, cookieOptions(SESSION_LIFETIME_MS / 1000))
		return c.body(null, 303, { location: login.returnTo, 'cache-control': 'no-store' })
	})

	app.post('/logout', setup, async (c) => {
		const checked = await checkForm(c)
		if (checked instanceof Response) {
			return checked
		}
		await storeCall(c, deps, async (s, b) =>
			s.endWebSession(b, { tokenHash: await sha256Hex(checked.session), now: deps.now() })
		)
		deleteCookie(c, SESSION_COOKIE, CLEARED)
		return message(c, 200, STRINGS.signedOutTitle, STRINGS.signedOut, { href: '/login', text: STRINGS.signInAgain })
	})

	// ---- settings

	// The signed-in session, or the answer for a request without one: GETs go to sign in and come back.
	const sessionOf = (c: WebContext): string | null => getCookie(c, SESSION_COOKIE, 'host') ?? null

	const toLogin = (c: WebContext) => {
		deleteCookie(c, SESSION_COOKIE, CLEARED)
		return c.body(null, 302, {
			location: `/login?return=${encodeURIComponent('/settings')}`,
			'cache-control': 'no-store',
		})
	}

	async function credentialOf(session: string, scope: Scope): Promise<UserCredential> {
		return { tokenHash: await sha256Hex(session), scope, now: deps.now() }
	}

	async function renderSettings(c: WebContext, session: string, problems: string[] = []) {
		const credential = await credentialOf(session, 'read:accounts')
		const view = await storeCall(c, deps, (s, b) =>
			s.settingsView(b, { credential, now: deps.now(), present: present(c) })
		)
		if (view.status !== 'ok' || view.value === null) {
			return toLogin(c)
		}
		return privatePage(
			c,
			problems.length === 0 ? 200 : 422,
			<SettingsPage
				account={view.value.account as CredentialAccount}
				authorizations={view.value.authorizations}
				csrf={await csrfToken(session)}
				notice={problems.length === 0 ? noticeOf(c.req.query('notice')) : null}
				problems={problems}
			/>
		)
	}

	app.get('/settings', setup, async (c) => {
		const session = sessionOf(c)
		return session === null ? toLogin(c) : renderSettings(c, session)
	})

	// WEB-1, WEB-4: the Origin first (no body is read for a cross-site post), then the session and its token.
	async function checkForm(c: WebContext): Promise<{ session: string; params: Params } | Response> {
		if (!sameOrigin(c.req.raw)) {
			return message(c, 403, STRINGS.forbiddenTitle, STRINGS.forbidden, BACK)
		}
		const session = sessionOf(c)
		const params = await readForm(c)
		if (params === null) {
			return message(c, 400, STRINGS.invalidFormTitle, STRINGS.invalidForm, BACK)
		}
		if (session === null || !(await csrfMatches(session, params.get('csrf')))) {
			return message(c, 403, STRINGS.forbiddenTitle, STRINGS.forbidden, BACK)
		}
		return { session, params }
	}

	async function readForm(c: WebContext): Promise<Params | null> {
		const result = await readParams(c.req.raw, 64 * 1024)
		return result.ok ? result.params : null
	}

	// An authorized operation's outcome: its value, or the sign-in for a session that is gone.
	function settled<O>(c: WebContext, result: Authorized<O>, then: (value: O) => Response | Promise<Response>) {
		return result.status === 'ok' ? then(result.value) : toLogin(c)
	}

	app.post('/settings/profile', setup, async (c) => {
		const checked = await checkForm(c)
		if (checked instanceof Response) {
			return checked
		}
		const { changes, problems } = credentialChanges(checked.params)
		// Only what the form edits; anything else a forged or stale form sends is ignored.
		const { displayName, note, fields, locked, discoverable, privacy } = changes
		if (problems.length > 0) {
			return renderSettings(c, checked.session, problems)
		}
		const credential = await credentialOf(checked.session, 'write:accounts')
		const result = await storeCall(c, deps, (s, b) =>
			s.updateCredentials(b, {
				credential,
				changes: { displayName, note, fields, locked, discoverable, privacy },
				present: present(c),
			})
		)
		return settled(c, result, () => redirect('/settings?notice=saved'))
	})

	for (const kind of ['avatar', 'header'] as const satisfies ProfileImage[]) {
		app.post(`/settings/${kind}`, setup, async (c) => {
			if (!sameOrigin(c.req.raw)) {
				await c.req.raw.body?.cancel()
				return message(c, 403, STRINGS.forbiddenTitle, STRINGS.forbidden, BACK)
			}
			const session = sessionOf(c)
			if (session === null) {
				await c.req.raw.body?.cancel()
				return message(c, 403, STRINGS.forbiddenTitle, STRINGS.forbidden, BACK)
			}
			const tokenHash = await sha256Hex(session)
			try {
				// B4b's pipeline: the reservation authorizes and counts the attempt before the body is read, and the
				// anti-forgery token is checked before any transformation is spent.
				const outcome = await receiveImageUpload(
					c,
					deps,
					() => ({ tokenHash, scope: 'write:media', now: deps.now() }),
					async (params) =>
						(await csrfMatches(session, params.get('csrf'))) ? null : { status: 403, error: STRINGS.forbidden }
				)
				if (!outcome.ok) {
					return message(c, outcome.status === 403 ? 403 : 422, STRINGS.uploadFailedTitle, outcome.error, BACK)
				}
				const credential = await credentialOf(session, 'write:accounts')
				const set = await storeCall(c, deps, (s, b) =>
					s.setProfileImage(b, { credential, id: outcome.media.id, kind, now: deps.now() })
				)
				return settled(c, set, () => redirect(`/settings?notice=${kind}`))
			} catch (error) {
				// The session ended during the upload.
				if (error instanceof HTTPException && error.status === 401) {
					return toLogin(c)
				}
				throw error
			}
		})
	}

	app.post('/settings/authorizations/revoke', setup, async (c) => {
		const checked = await checkForm(c)
		if (checked instanceof Response) {
			return checked
		}
		const credential = await credentialOf(checked.session, 'write:accounts')
		const clientId = checked.params.get('client_id') ?? ''
		const result = await storeCall(c, deps, (s, b) => s.revokeAuthorization(b, { credential, clientId }))
		return settled(c, result, () => redirect('/settings?notice=revoked'))
	})

	app.post('/settings/sessions/revoke', setup, async (c) => {
		const checked = await checkForm(c)
		if (checked instanceof Response) {
			return checked
		}
		const credential = await credentialOf(checked.session, 'write:accounts')
		const result = await storeCall(c, deps, (s, b) => s.revokeOtherSessions(b, { credential }))
		return settled(c, result, () => redirect('/settings?notice=sessions'))
	})

	return app
}

function withVary(response: Response): Response {
	const copy = new Response(response.body, response)
	copy.headers.append('vary', 'Accept')
	return copy
}
