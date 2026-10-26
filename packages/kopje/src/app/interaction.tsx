import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'

import { siteGate, loginPath, type WebEnv } from './web'
import { PRIVATE_HEADERS } from './web-headers'
import type { UserCredential } from '../domain/auth'
import type { FollowOutcome } from '../domain/interaction'
import type { Resolved } from '../domain/remote-statuses'
import { INTERACTION_PATH, interactionTarget } from '../domain/web-session'
import { afterResponse, type ApiDeps, present, requestJobsSoon, storeCall } from '../mastodon/context'
import { Params, readParams } from '../mastodon/params'
import { errorFields } from '../platform/error-message'
import { sha256Hex } from '../security/tokens'
import { InteractionPage, InteractionResultPage } from '../web/pages/interaction'
import { MessagePage } from '../web/pages/message'
import { csrfMatches, csrfToken, sameOrigin, SESSION_COOKIE } from '../web/session'
import { STRINGS } from '../web/strings'

// /authorize_interaction (design §8): where another server's "follow" or "interact" button sends a person with an
// account here (the subscribe template of WebFinger, federation/federation.ts), and where Kopje's own follow handoff
// leads on other Kopje servers.
//
//   - GET renders guidance and the look-up form, prefilled with `uri` (or Mastodon's `acct`) when interactionTarget
//     accepts it. It reads only the site facts (one Store call), and fetches, stores and follows nothing, signed in or
//     not (WEB-4).
//   - Both POSTs check the Origin first, then read the form (64 KiB), then the session and its anti-forgery token
//     (WEB-1, WEB-4). Without a session the look-up goes to sign in and returns to the form: the target travels in the
//     sign-in attempt (domain/web-session.ts), never in the return path.
//   - The look-up refuses a session that is gone or lacks write:follows (AUTH-8) before anything is fetched, then
//     fetches through the resolver (federation/resolve.ts: ID-2, NET-1, NET-3, VIS-30), and stores and shows it in one
//     Store call that authorizes the session again (domain/interaction.ts), with a fresh `now`.
//   - The follow goes through the follow service, and wakes delivery once it has committed (design amendment A4); the
//     look-up asks for the quote-verification round search resolution asks for. A refused request wakes nothing.
//   - WEB-2, WEB-3, WEB-5: every page has the private pages' headers (no-store, no script, no framing), and every
//     redirect is no-store.

export type InteractionDeps = ApiDeps & {
	// Rings the delivery doorbell (app.ts): a follow of a remote account records a Follow to deliver.
	doorbell?: (env: Env) => Promise<void>
}

type InteractionContext = Context<WebEnv>

type PageStatus = 200 | 400 | 403

const FOLLOW_PATH = `${INTERACTION_PATH}/follow`
const FORM_LIMIT = 64 * 1024
const SCOPE = 'write:follows'

const NONE: Resolved = { kind: 'none' }

function page(c: InteractionContext, status: PageStatus, body: Parameters<InteractionContext['html']>[0]) {
	return c.html(body, status, PRIVATE_HEADERS)
}

const LOOK_UP_ANOTHER = { href: INTERACTION_PATH, text: STRINGS.interact.lookUpAnother }

function message(c: InteractionContext, status: PageStatus, title: string, text: string) {
	return page(c, status, <MessagePage chrome={c.get('site')} title={title} message={text} link={LOOK_UP_ANOTHER} />)
}

// To sign in, and back to the look-up form with its target. A session the Store refused is dropped.
function toLogin(c: InteractionContext, target: string | null, drop: boolean): Response {
	if (drop) {
		deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true })
	}
	return c.body(null, 303, { location: loginPath(INTERACTION_PATH, target), 'cache-control': 'no-store' })
}

type Checked = { session: string; params: Params; target: string | null }

// WEB-1, WEB-4: the Origin before the body is read, then the session and its token. Without a session: sign in.
async function checkForm(c: InteractionContext): Promise<Checked | Response> {
	if (!sameOrigin(c.req.raw)) {
		await c.req.raw.body?.cancel()
		return message(c, 403, STRINGS.errors.forbiddenTitle, STRINGS.errors.forbidden)
	}
	const read = await readParams(c.req.raw, { limit: FORM_LIMIT })
	if (!read.ok) {
		return message(c, 400, STRINGS.errors.invalidFormTitle, STRINGS.errors.invalidForm)
	}
	const target = interactionTarget(read.params.get('uri'))
	const session = getCookie(c, SESSION_COOKIE, 'host') ?? null
	if (session === null) {
		return toLogin(c, target, false)
	}
	if (!(await csrfMatches(session, read.params.get('csrf')))) {
		return message(c, 403, STRINGS.errors.forbiddenTitle, STRINGS.errors.forbidden)
	}
	return { session, params: read.params, target }
}

const OUTCOMES: Record<FollowOutcome, { title: string; text: string }> = {
	followed: { title: STRINGS.interact.followedTitle, text: STRINGS.interact.followed },
	requested: { title: STRINGS.interact.requestedTitle, text: STRINGS.interact.requested },
	already_requested: { title: STRINGS.interact.requestedTitle, text: STRINGS.interact.alreadyRequested },
	refused: { title: STRINGS.interact.refusedTitle, text: STRINGS.interact.refused },
	not_found: { title: STRINGS.interact.notFoundTitle, text: STRINGS.interact.notFound },
}

export function interactionRoutes(deps: InteractionDeps): Hono<WebEnv> {
	const app = new Hono<WebEnv>()
	const setup = siteGate(deps)

	// The credential of the session, its `now` taken when it is called: after any network await (engineering.md).
	const credentialOf = async (session: string): Promise<UserCredential> => ({
		tokenHash: await sha256Hex(session),
		scope: SCOPE,
		now: deps.now(),
	})

	app.get(INTERACTION_PATH, setup, async (c) => {
		const session = getCookie(c, SESSION_COOKIE, 'host') ?? null
		return page(
			c,
			200,
			<InteractionPage
				site={c.get('site')}
				uri={interactionTarget(c.req.query('uri') ?? c.req.query('acct')?.replace(/^acct:/, '')) ?? ''}
				csrf={session === null ? null : await csrfToken(session)}
			/>
		)
	})

	app.post(INTERACTION_PATH, setup, async (c) => {
		const checked = await checkForm(c)
		if (checked instanceof Response) {
			return checked
		}
		const { session, target } = checked
		if (target === null) {
			return message(c, 200, STRINGS.interact.notFoundTitle, STRINGS.interact.notFound)
		}
		// Refused before anything is fetched: a session that is gone, or one issued without write:follows.
		const check = await storeCall(c, deps, async (s, b) => s.checkCredential(b, await credentialOf(session)))
		if (check.status !== 'ok') {
			return toLogin(c, target, true)
		}
		const resolved = deps.resolve === undefined ? NONE : await deps.resolve(c.env, target)
		const result = await storeCall(c, deps, async (s, b) =>
			s.resolveInteraction(b, {
				credential: await credentialOf(session),
				query: target,
				resolved,
				now: deps.now(),
				origin: new URL(c.req.url).origin,
				present: present(c),
			})
		)
		if (result.status !== 'ok') {
			return toLogin(c, target, true)
		}
		// The stored status's quote is verified by the job rounds (federation/quotes.ts), as after search resolution.
		if (result.value.quotesDue) {
			requestJobsSoon(c, deps)
		}
		const found = result.value.target
		if (found.kind === 'not_found') {
			return message(c, 200, STRINGS.interact.notFoundTitle, STRINGS.interact.notFound)
		}
		return page(
			c,
			200,
			<InteractionResultPage site={c.get('site')} target={found} uri={target} csrf={await csrfToken(session)} />
		)
	})

	app.post(FOLLOW_PATH, setup, async (c) => {
		const checked = await checkForm(c)
		if (checked instanceof Response) {
			return checked
		}
		const { session, params, target } = checked
		const result = await storeCall(c, deps, async (s, b) =>
			s.webFollow(b, {
				credential: await credentialOf(session),
				target: params.get('account_id') ?? '',
				now: deps.now(),
			})
		)
		if (result.status !== 'ok') {
			return toLogin(c, target, true)
		}
		const outcome = result.value
		// A follow or request may have recorded a Follow to deliver: ring once it has committed, as app.ts does after an
		// API write. A lost ring only delays it until the cron.
		const ring = outcome === 'followed' || outcome === 'requested' ? deps.doorbell?.(c.env) : undefined
		if (ring !== undefined) {
			afterResponse(
				c,
				ring.catch((error: unknown) => {
					console.error({ event: 'kopje.delivery.doorbell.failed', ...errorFields(error) })
				})
			)
		}
		const { title, text } = OUTCOMES[outcome]
		return message(c, 200, title, text)
	})

	return app
}
