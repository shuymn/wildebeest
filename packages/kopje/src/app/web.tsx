import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'

import type { Account, CredentialAccount } from '../domain/accounts'
import type { Authorized, UserCredential } from '../domain/auth'
import { PROFILE_IMAGES } from '../domain/media'
import type { Status } from '../domain/status-presenter'
import { localUsername } from '../domain/web-pages'
import { SESSION_LIFETIME_MS, WEB_SCOPES } from '../domain/web-session'
import { requireSetup } from '../federation/setup-gate'
import { credentialChanges, profileFiles, storeProfileImages } from '../mastodon/accounts'
import { type ApiDeps, present, requestJobsSoon, storeCall } from '../mastodon/context'
import { discardProfileUploads, type ProfileUpload, sweepSoon } from '../mastodon/media'
import { Params, readParams } from '../mastodon/params'
import { PROFILE_IMAGE_LIMIT } from '../platform/images'
import type { Scope } from '../security/scopes'
import { pkceChallenge, sha256Hex } from '../security/tokens'
import {
	AboutPage,
	DocumentPage,
	EMBED_SCRIPT,
	EmbedPage,
	MessagePage,
	ProfilePage,
	SettingsPage,
	StatusPage,
} from '../web/pages'
import {
	csrfMatches,
	csrfToken,
	attemptIdOf,
	LOGIN_COOKIE,
	LOGIN_LIFETIME_S,
	returnPath,
	sameOrigin,
	SESSION_COOKIE,
	wantsActivityPub,
} from '../web/session'
import { noticeOf, STRINGS } from '../web/strings'

// The web UI (B5): public profiles and permalinks, the about page, sign-in through Access, and the settings page.
// Posting and reading happen in Mastodon clients; this is all the instance serves as HTML besides the consent page.
//
//   - WEB-2: every page has a CSP with no script source, frame-ancestors 'none' and X-Frame-Options DENY, except the
//     embed page, which any site may frame and which runs one script; pages of a signed-in user are never cached
//     (no-store); WEB-3: none of these routes sends CORS headers (only the API's
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

// The embed page (Mastodon's StatusesController#embed, which drops X-Frame-Options and frame-ancestors): any site may
// frame it, so it has neither; its one script is named exactly. Kept 180 s, as Mastodon's (expires_in 180).
function embedHeaders(domain: string) {
	return {
		'content-security-policy': `default-src 'none'; script-src https://${domain}${EMBED_SCRIPT}; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'`,
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'same-origin',
		'cache-control': 'public, max-age=180',
	}
}

// Pages of a signed-in user, and every answer of the sign-in flow. `same-origin`, not `no-referrer`: under
// `no-referrer` browsers send `Origin: null` on a same-origin form post (Fetch, "serializing a request origin"), and
// every form here is checked by its Origin (WEB-1). Other origins still get no referrer.
export const PRIVATE_HEADERS = { ...FRAMING, 'referrer-policy': 'same-origin', 'cache-control': 'no-store' }

type PageStatus = 200 | 400 | 403 | 404 | 410 | 422 | 429

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

export function webRoutes(deps: WebDeps): Hono<WebEnv> {
	const app = new Hono<WebEnv>()
	const setup = requireSetup(deps.build, deps.store)

	// The same request for another path of this app, keeping its headers (Accept, signatures).
	const forward = (c: WebContext, path: string) =>
		deps.dispatch(new Request(new URL(path, c.req.url), c.req.raw), c.env, c.executionCtx)

	// ---- public pages

	const profile = async (c: WebContext, tag: string | null) => {
		const handle = c.req.param('handle') ?? ''
		const username = localUsername(handle, c.get('domain'))
		if (username === null && tag !== null) {
			return remoteTagged(c, handle)
		}
		if (username === null || username === '') {
			return notFound(c)
		}
		if (tag === null && wantsActivityPub(c.req.header('accept'))) {
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
		const page = await storeCall(c, deps, (s, b) =>
			s.profilePage(b, { username, maxId, tag, present: present(c), now: deps.now() })
		)
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
				tag={tag}
			/>
		)
	}
	app.get('/about', setup, async (c) => {
		const info = await storeCall(c, deps, (s, b) => s.instanceSettings(b))
		const domain = c.get('domain')
		return publicPage(
			c,
			200,
			<AboutPage
				title={info.title ?? domain}
				domain={domain}
				description={info.description ?? ''}
				contactEmail={info.contactEmail ?? ''}
				rules={info.rules}
				extendedDescription={info.extendedDescription}
				privacyPolicy={info.privacyPolicy}
				termsOfService={info.termsOfService}
			/>
		)
	})
	// The documents the instance endpoints serve (domain/instance.ts), as stored and sanitized at the page's sink; a
	// /:date matches the stored effective date exactly, as GET /api/v1/instance/terms_of_service/:date.
	const documentPage = async (c: WebContext, name: 'privacy_policy' | 'terms_of_service', date?: string) => {
		const source = await storeCall(c, deps, (s, b) => s.instanceDocumentSource(b, { name }))
		if (source === null || (date !== undefined && date !== source.effectiveDate)) {
			return notFound(c)
		}
		const domain = c.get('domain')
		return publicPage(
			c,
			200,
			<DocumentPage
				title={name === 'privacy_policy' ? STRINGS.privacyPolicy : STRINGS.termsOfService}
				domain={domain}
				path={
					name === 'privacy_policy' ? '/privacy-policy' : `/terms-of-service${date === undefined ? '' : `/${date}`}`
				}
				html={source.text}
				updatedAt={source.updatedAt}
				effectiveDate={source.effectiveDate}
			/>
		)
	}
	app.get('/privacy-policy', setup, (c) => documentPage(c, 'privacy_policy'))
	app.get('/terms-of-service', setup, (c) => documentPage(c, 'terms_of_service'))
	app.get('/terms-of-service/:date', setup, (c) => documentPage(c, 'terms_of_service', c.req.param('date')))
	// A remote account's featured hashtag URL (/@username@domain/tagged/:tag, featured-tags.ts taggedUrl): its profile
	// on its own server, while it is available; Kopje shows no remote account's posts by hashtag.
	const remoteTagged = async (c: WebContext, handle: string) => {
		const [username = '', domain = '', ...rest] = handle.replace(/^@/, '').split('@')
		if (username === '' || domain === '' || rest.length > 0) {
			return notFound(c)
		}
		const account = await storeCall(c, deps, (s, b) => s.lookupAccount(b, { username, domain, present: present(c) }))
		if (account === null || account.suspended === true || account.acct === account.username) {
			return notFound(c)
		}
		return new Response(null, { status: 302, headers: { location: account.url } })
	}
	app.get('/:handle{@[^/]+}', setup, (c) => profile(c, null))
	// A featured hashtag's URL (Mastodon's short_account_tag_url): the profile's posts with the hashtag.
	app.get('/:handle{@[^/]+}/tagged/:tag', setup, (c) => profile(c, c.req.param('tag')))

	// VIS-4: a status an anonymous viewer may see, or 404 for anything else, alike.
	app.get('/:handle{@[^/]+}/:id', setup, async (c) => {
		const username = localUsername(c.req.param('handle'), c.get('domain'))
		const id = c.req.param('id')
		if (username === null || username === '' || id.length > 64) {
			return notFound(c)
		}
		const page = await storeCall(c, deps, (s, b) =>
			s.statusPage(b, { username, id, present: present(c), now: deps.now() })
		)
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

	// The status page's status for an iframe (VIS-4, the same read): Mastodon's embed_short_account_status_url, which
	// the oEmbed HTML names (mastodon/oembed.ts). Anything the status page would not show is the same 404, which, like
	// every other page, may not be framed.
	app.get('/:handle{@[^/]+}/:id/embed', setup, async (c) => {
		const domain = c.get('domain')
		const username = localUsername(c.req.param('handle'), domain)
		const id = c.req.param('id')
		if (username === null || username === '' || id.length > 64) {
			return notFound(c)
		}
		const page = await storeCall(c, deps, (s, b) =>
			s.statusPage(b, { username, id, present: present(c), now: deps.now() })
		)
		if (page.status === 'not_found') {
			return notFound(c)
		}
		if (page.status === 'moved') {
			return new Response(null, {
				status: 301,
				headers: { location: `/@${page.username}/${page.id}/embed`, 'cache-control': 'public, max-age=60' },
			})
		}
		return c.html(<EmbedPage status={page.value as Status} domain={domain} />, 200, embedHeaders(domain))
	})

	// ---- sign-in (Access at /oauth/authorize) and sign-out

	app.get('/login', setup, async (c) => {
		const domain = c.get('domain')
		const target = returnPath(c.req.query('return'))
		// The cookies belong to the instance's own host.
		if (new URL(c.req.url).host !== domain) {
			return redirect(`https://${domain}/login?return=${encodeURIComponent(target)}`, 302)
		}
		// RES-6: sign-ins are limited per client IP, the key an anonymous caller controls; nothing here can hold a slot
		// another browser needs.
		const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
		if (!(await c.env.LOGIN_LIMIT.limit({ key: ip })).success) {
			return message(c, 429, STRINGS.signInBusyTitle, STRINGS.signInBusy)
		}
		const redirectUri = `https://${domain}/auth/callback`
		const attempt = deps.randomToken()
		const state = deps.randomToken()
		const challenge = await pkceChallenge(deps.randomToken())
		const previous = getCookie(c, SESSION_COOKIE, 'host')
		const clientId = await storeCall(c, deps, async (s, b) =>
			s.beginWebLogin(b, {
				clientId: deps.randomToken(),
				secret: deps.randomToken(),
				redirectUri,
				attemptHash: await sha256Hex(attempt),
				state,
				challenge,
				returnTo: target,
				startedWith: previous === undefined ? null : await sha256Hex(previous),
				now: deps.now(),
			})
		)
		setCookie(c, LOGIN_COOKIE, attempt, cookieOptions(LOGIN_LIFETIME_S))
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
		const attempt = attemptIdOf(getCookie(c, LOGIN_COOKIE, 'host'))
		const state = c.req.query('state')
		const expired = () =>
			message(c, 400, STRINGS.signInExpiredTitle, STRINGS.signInExpired, { href: '/login', text: STRINGS.signIn })
		if (attempt === null || state === undefined) {
			return expired()
		}
		const code = c.req.query('error') === undefined ? (c.req.query('code') ?? null) : null
		const presented = getCookie(c, SESSION_COOKIE, 'host')
		const token = deps.randomToken()
		const result = await storeCall(c, deps, async (s, b) =>
			s.startWebSession(b, {
				attemptHash: await sha256Hex(attempt),
				state,
				codeHash: code === null ? null : await sha256Hex(code),
				redirectUri: `https://${c.get('domain')}/auth/callback`,
				tokenHash: await sha256Hex(token),
				presented: presented === undefined ? null : await sha256Hex(presented),
				family: deps.randomToken(),
				now: deps.now(),
			})
		)
		// A stale callback (an older tab's) leaves the login cookie of the newer sign-in in place.
		if (result.status === 'state_mismatch') {
			return expired()
		}
		deleteCookie(c, LOGIN_COOKIE, CLEARED)
		switch (result.status) {
			case 'invalid_grant':
				return message(c, 400, STRINGS.signInFailedTitle, STRINGS.signInFailed, {
					href: '/login',
					text: STRINGS.signIn,
				})
			case 'cancelled':
				return message(c, 403, STRINGS.signInCancelledTitle, STRINGS.signInCancelled, {
					href: `/login?return=${encodeURIComponent(returnPath(result.returnTo))}`,
					text: STRINGS.signIn,
				})
			case 'ok':
				setCookie(c, SESSION_COOKIE, token, cookieOptions(SESSION_LIFETIME_MS / 1000))
				return c.body(null, 303, { location: returnPath(result.returnTo), 'cache-control': 'no-store' })
		}
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
		const result = await readParams(c.req.raw, { limit: 64 * 1024 })
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
		const { displayName, note, fields, locked, discoverable, indexable, privacy } = changes
		if (problems.length > 0) {
			return renderSettings(c, checked.session, problems)
		}
		const credential = await credentialOf(checked.session, 'write:accounts')
		const result = await storeCall(c, deps, (s, b) =>
			s.updateCredentials(b, {
				credential,
				changes: { displayName, note, fields, locked, discoverable, indexable, privacy },
				present: present(c),
				now: deps.now(),
			})
		)
		return settled(c, result, (updated) => {
			if (updated.status !== 'ok') {
				return toLogin(c)
			}
			if (updated.accepting) {
				requestJobsSoon(c, deps)
			}
			return redirect('/settings?notice=saved')
		})
	})

	for (const kind of PROFILE_IMAGES) {
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
			// The session is checked before the body is read, so a request without a live session reads no upload.
			const credential = await credentialOf(session, 'write:accounts')
			if ((await storeCall(c, deps, (s, b) => s.checkCredential(b, credential))).status !== 'ok') {
				await c.req.raw.body?.cancel()
				return toLogin(c)
			}
			const read = await readParams(c.req.raw, {
				limit: 64 * 1024,
				files: { names: ['file'], maxBytes: PROFILE_IMAGE_LIMIT },
			})
			if (!read.ok) {
				return message(c, 400, STRINGS.invalidFormTitle, STRINGS.invalidForm, BACK)
			}
			if (!(await csrfMatches(session, read.params.get('csrf')))) {
				return message(c, 403, STRINGS.forbiddenTitle, STRINGS.forbidden, BACK)
			}
			// The API's checks and pipeline (mastodon/accounts.ts), with the page's one file as the image.
			const file = read.params.file('file')
			const files = file === undefined ? 'string' : await profileFiles(new Params([], new Map([[kind, file]])))
			if (files === 'string' || files.problems.length > 0) {
				const problem =
					files === 'string'
						? "Validation failed: File can't be blank"
						: `Validation failed: ${files.problems.join(', ')}`
				return message(c, 422, STRINGS.uploadFailedTitle, problem, BACK)
			}
			const owned: ProfileUpload[] = []
			let committed = false
			try {
				const stored = await storeProfileImages(
					c,
					deps,
					() => ({ ...credential, now: deps.now() }),
					files.images,
					owned
				)
				if ('error' in stored) {
					return message(c, 422, STRINGS.uploadFailedTitle, stored.error, BACK)
				}
				const result = await storeCall(c, deps, (s, b) =>
					s.updateCredentials(b, {
						credential: { ...credential, now: deps.now() },
						changes: {},
						images: stored,
						present: present(c),
						now: deps.now(),
					})
				)
				if (result.status !== 'ok') {
					return toLogin(c)
				}
				if (result.value.status !== 'ok') {
					return message(c, 422, STRINGS.uploadFailedTitle, 'Validation failed: The upload expired', BACK)
				}
				committed = true
				sweepSoon(c, deps)
				return redirect(`/settings?notice=${kind}`)
			} catch (error) {
				// The session ended during the upload.
				if (error instanceof HTTPException && error.status === 401) {
					return toLogin(c)
				}
				throw error
			} finally {
				if (!committed) {
					await discardProfileUploads(c, deps, owned)
				}
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
		const result = await storeCall(c, deps, (s, b) => s.revokeOtherSessions(b, { credential, now: deps.now() }))
		return settled(c, result, () => redirect('/settings?notice=sessions'))
	})

	return app
}

function withVary(response: Response): Response {
	const copy = new Response(response.body, response)
	copy.headers.append('vary', 'Accept')
	return copy
}
