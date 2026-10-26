import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'

import { PRIVATE_HEADERS } from './web-headers'
import type { Authorized, UserCredential } from '../domain/auth'
import { PROFILE_IMAGES } from '../domain/media'
import type { Site } from '../domain/web-pages/site'
import { SESSION_LIFETIME_MS, WEB_SCOPES } from '../domain/web-session'
import { notSetUp } from '../federation/setup-gate'
import { credentialChanges, profileFiles, storeProfileImages } from '../mastodon/accounts'
import { noteActivitySoon } from '../mastodon/activity'
import { type ApiDeps, present, requestJobsSoon, storeCall } from '../mastodon/context'
import { discardProfileUploads, type ProfileUpload, sweepSoon } from '../mastodon/media'
import { Params, readParams } from '../mastodon/params'
import { PROFILE_IMAGE_LIMIT } from '../platform/images'
import type { Scope } from '../security/scopes'
import { pkceChallenge, sha256Hex } from '../security/tokens'
import type { Chrome } from '../web/components/layout'
import { MessagePage } from '../web/pages/message'
import { SettingsPage } from '../web/pages/settings'
import {
	csrfMatches,
	csrfToken,
	attemptIdOf,
	LOGIN_COOKIE,
	LOGIN_LIFETIME_S,
	returnPath,
	sameOrigin,
	SESSION_COOKIE,
} from '../web/session'
import { noticeOf, STRINGS } from '../web/strings'

// The web UI's signed-in part (B5): sign-in through Access and the settings page. Posting and reading happen in
// Mastodon clients; the public pages are app/public-pages.tsx, and the consent page app/authorize.tsx.
//
//   - WEB-2, WEB-3, WEB-5: the header sets of app/web-headers.ts.
//   - WEB-1, WEB-4: every POST checks Origin (missing, `null` and foreign answer 403) and the session's anti-forgery
//     token before anything else is read or written; redirects go to validated local paths only.
//   - AUTH: the session is an access token of the web client in an opaque __Host- cookie (domain/web-session.ts),
//     validated by the Store in the transaction of each operation.

type WebEnv = { Bindings: Env; Variables: { domain: string; site: Site } }
type WebContext = Context<WebEnv>

type PageStatus = 200 | 400 | 403 | 404 | 410 | 422 | 429

function privatePage(c: WebContext, status: PageStatus, body: Parameters<WebContext['html']>[0]) {
	return c.html(body, status, PRIVATE_HEADERS)
}

// The header and footer: the site facts the gate read.
function chromeOf(c: WebContext): Chrome {
	return c.get('site')
}

function message(
	c: WebContext,
	status: PageStatus,
	title: string,
	text: string,
	link?: { href: string; text: string }
) {
	return privatePage(c, status, <MessagePage chrome={chromeOf(c)} title={title} message={text} link={link} />)
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

const BACK = { href: '/settings', text: STRINGS.settings.backToSettings }

// The gate of these pages: the site facts in one Store call, as requireSetup reads the domain (503 before setup), so
// their header and footer are those of the public pages.
function siteGate(deps: ApiDeps) {
	return createMiddleware<WebEnv>(async (c, next) => {
		const gate = await storeCall(c, deps, (s, b) => s.webSite(b))
		if (gate.status === 'not_set_up') {
			return notSetUp(c)
		}
		c.set('domain', gate.site.domain)
		c.set('site', gate.site)
		await next()
	})
}

export function webRoutes(deps: ApiDeps): Hono<WebEnv> {
	const app = new Hono<WebEnv>()
	const setup = siteGate(deps)

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
			return message(c, 429, STRINGS.signIn.busyTitle, STRINGS.signIn.busy)
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
			message(c, 400, STRINGS.signIn.expiredTitle, STRINGS.signIn.expired, {
				href: '/login',
				text: STRINGS.signIn.signIn,
			})
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
				return message(c, 400, STRINGS.signIn.failedTitle, STRINGS.signIn.failed, {
					href: '/login',
					text: STRINGS.signIn.signIn,
				})
			case 'cancelled':
				return message(c, 403, STRINGS.signIn.cancelledTitle, STRINGS.signIn.cancelled, {
					href: `/login?return=${encodeURIComponent(returnPath(result.returnTo))}`,
					text: STRINGS.signIn.signIn,
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
		return message(c, 200, STRINGS.signIn.signedOutTitle, STRINGS.signIn.signedOut, {
			href: '/login',
			text: STRINGS.signIn.signInAgain,
		})
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
		// Activity (mastodon/activity.ts): the page served by GET /settings only, never a refused form's re-render.
		if (problems.length === 0) {
			noteActivitySoon(c, deps, credential.tokenHash)
		}
		return privatePage(
			c,
			problems.length === 0 ? 200 : 422,
			<SettingsPage
				chrome={chromeOf(c)}
				account={view.value.account}
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
			return message(c, 403, STRINGS.errors.forbiddenTitle, STRINGS.errors.forbidden, BACK)
		}
		const session = sessionOf(c)
		const params = await readForm(c)
		if (params === null) {
			return message(c, 400, STRINGS.errors.invalidFormTitle, STRINGS.errors.invalidForm, BACK)
		}
		if (session === null || !(await csrfMatches(session, params.get('csrf')))) {
			return message(c, 403, STRINGS.errors.forbiddenTitle, STRINGS.errors.forbidden, BACK)
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
				return message(c, 403, STRINGS.errors.forbiddenTitle, STRINGS.errors.forbidden, BACK)
			}
			const session = sessionOf(c)
			if (session === null) {
				await c.req.raw.body?.cancel()
				return message(c, 403, STRINGS.errors.forbiddenTitle, STRINGS.errors.forbidden, BACK)
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
				return message(c, 400, STRINGS.errors.invalidFormTitle, STRINGS.errors.invalidForm, BACK)
			}
			if (!(await csrfMatches(session, read.params.get('csrf')))) {
				return message(c, 403, STRINGS.errors.forbiddenTitle, STRINGS.errors.forbidden, BACK)
			}
			// The API's checks and pipeline (mastodon/accounts.ts), with the page's one file as the image.
			const file = read.params.file('file')
			const files = file === undefined ? 'string' : await profileFiles(new Params([], new Map([[kind, file]])))
			if (files === 'string' || files.problems.length > 0) {
				const problem =
					files === 'string'
						? "Validation failed: File can't be blank"
						: `Validation failed: ${files.problems.join(', ')}`
				return message(c, 422, STRINGS.errors.uploadFailedTitle, problem, BACK)
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
					return message(c, 422, STRINGS.errors.uploadFailedTitle, stored.error, BACK)
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
					return message(c, 422, STRINGS.errors.uploadFailedTitle, 'Validation failed: The upload expired', BACK)
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
