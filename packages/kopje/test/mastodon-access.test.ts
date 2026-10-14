import { describe, expect, it } from 'vitest'

import mastodon from './fixtures/mastodon-4.5.11-api-access.json'
import type { RouteAccess } from '../src/mastodon/access'
import { ROUTES } from '../src/mastodon/routes'
import { grants, type RequiredScope, SCOPES } from '../src/security/scopes'

// Every route of the API table (src/mastodon/routes.ts) asks of its caller what Mastodon's same route asks, read from
// Mastodon's source by scripts/mastodon-scopes.mjs (the fixture's header says how to regenerate it). Compared:
//   token   none (no token read), optional (a token sent is checked), required
//   scopes  the token scopes accepted (null: any valid token): Kopje's required scope with the scopes that cover it
//           (src/security/scopes.ts), Mastodon's doorkeeper list
//   user    whether a token without a user (an app token) is refused
// A route Mastodon does not have, or one that deliberately differs, is listed in EXCEPTIONS with both sides as compared
// and the reason; a change on either side (Kopje's routes or scope hierarchy, a regenerated fixture), or the difference
// going away, fails until the exception is revisited.

type Access = { token: 'none' | 'optional' | 'required'; scopes: string[] | null; user: boolean }

type MastodonRoute = (typeof mastodon.routes)[number]

// Both sides as sides() writes them, and why they differ.
type Exception = { kopje: string; mastodon: string; reason: string }

const EXCEPTIONS: Record<string, Exception> = {
	// Not Mastodon /api routes.
	'POST /oauth/token': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'absent',
		reason: "Doorkeeper's token endpoint, outside /api",
	},
	'POST /oauth/revoke': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'absent',
		reason: "Doorkeeper's revocation endpoint, outside /api",
	},

	// Answers that do not depend on the caller, so no token is read.
	'GET /api/v1/trends': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes any, no user required',
		reason: 'answered empty to everyone; Mastodon filters trends for the viewer',
	},
	'GET /api/v1/trends/tags': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes any, no user required',
		reason: 'answered empty to everyone; Mastodon filters trends for the viewer',
	},
	'GET /api/v1/trends/statuses': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes any, no user required',
		reason: 'answered empty to everyone; Mastodon filters trends for the viewer',
	},
	'GET /api/v1/trends/links': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes any, no user required',
		reason: 'answered empty to everyone; Mastodon filters trends for the viewer',
	},
	'GET /api/v1/instance/domain_blocks': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes any, no user required',
		reason: 'answered "not configured" to everyone; Mastodon may show it to users only',
	},

	// Differences RouteAccess cannot express, enforced elsewhere or left open.
	'GET /api/v1/announcements': {
		kopje: 'required token, scopes any, no user required',
		mastodon: 'required token, scopes any, user required',
		reason: 'any token at the route; placeholders.emptyUserList refuses one without a user',
	},
	'GET /api/v1/statuses/:id/source': {
		kopje: 'required token, scopes read read:statuses, user required',
		mastodon:
			'unresolved (Pundit policy: authorize @status, :show?): required token, scopes read read:statuses, no user required',
		reason: 'RouteAccess has no "scope without a user" form; Mastodon serves app tokens what StatusPolicy#show? allows',
	},
	'GET /api/v1/accounts/relationships': {
		kopje: 'required token, scopes follow read read:follows, user required',
		mastodon: 'required token, scopes read read:follows, user required',
		reason: 'grants() lets `follow` cover read:follows everywhere; Mastodon omits follow here',
	},
	'GET /api/v1/accounts/familiar_followers': {
		kopje: 'required token, scopes follow read read:follows, user required',
		mastodon: 'required token, scopes read read:follows, user required',
		reason: 'grants() lets `follow` cover read:follows everywhere; Mastodon omits follow here',
	},

	// Mastodon's StatusPolicy#show? (Pundit) decides per viewer; Kopje's Store applies the visibility rules.
	'GET /api/v1/statuses/:id': {
		kopje: 'optional token, scopes read read:statuses, no user required',
		mastodon:
			'unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:statuses, no user required',
		reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	},
	'GET /api/v1/statuses/:id/context': {
		kopje: 'optional token, scopes read read:statuses, no user required',
		mastodon:
			'unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:statuses, no user required',
		reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	},
	'GET /api/v1/statuses/:id/history': {
		kopje: 'optional token, scopes read read:statuses, no user required',
		mastodon:
			'unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:statuses, no user required',
		reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	},
	'GET /api/v1/statuses/:id/favourited_by': {
		kopje: 'optional token, scopes read read:accounts, no user required',
		mastodon:
			'unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:accounts, no user required',
		reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	},
	'GET /api/v1/statuses/:id/reblogged_by': {
		kopje: 'optional token, scopes read read:accounts, no user required',
		mastodon:
			'unresolved (Pundit policy: authorize @status, :show?): optional token, scopes read read:accounts, no user required',
		reason: "visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	},

	// Deliberate choices.
	'GET /api/v1/accounts/lookup': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes read read:accounts, no user required',
		reason: 'a stale token is not read (access.ts); Mastodon checks a token sent',
	},
	'GET /api/v1/accounts/:id': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes read read:accounts, no user required',
		reason: 'a stale token is not read (access.ts); Mastodon checks a token sent',
	},
	'GET /api/v1/accounts/:id/followers': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes read read:accounts, no user required',
		reason: 'a stale token is not read (access.ts); Mastodon checks a token sent',
	},
	'GET /api/v1/accounts/:id/following': {
		kopje: 'none token, scopes any, no user required',
		mastodon: 'optional token, scopes read read:accounts, no user required',
		reason: 'a stale token is not read (access.ts); Mastodon checks a token sent',
	},
	'GET /api/v2/search': {
		kopje: 'required token, scopes read read:search, user required',
		mastodon: 'optional token, scopes read read:search, no user required',
		reason: 'anonymous search is refused (routes.ts); Mastodon allows it without resolve or offset',
	},
	'GET /api/v1/timelines/public': {
		kopje: 'optional token, scopes read read:statuses, no user required',
		mastodon:
			'unresolved (require_user! if: "require_auth?"): required token, scopes read read:statuses, user required',
		reason: 'open to anonymous callers; Mastodon requires a user if its feed setting says so',
	},
	'GET /api/v1/timelines/tag/:hashtag': {
		kopje: 'optional token, scopes read read:statuses, no user required',
		mastodon:
			'unresolved (require_user! if: "require_auth?"): required token, scopes read read:statuses, user required',
		reason: 'open to anonymous callers; Mastodon requires a user if its feed setting says so',
	},
}

// The scopes a token may hold to pass the route's scope: every scope Kopje issues that covers it (any one of them if
// the route names several).
function acceptedScopes(required: RequiredScope, covers = grants): string[] {
	const any = typeof required === 'string' ? [required] : required
	return SCOPES.filter((s) => any.some((scope) => covers([s], scope))).toSorted()
}

function kopjeAccess(access: RouteAccess, covers = grants): Access {
	if (access === 'public') {
		return { token: 'none', scopes: null, user: false }
	}
	if (access === 'token') {
		return { token: 'required', scopes: null, user: false }
	}
	const scopes = access.scope === undefined ? null : acceptedScopes(access.scope, covers)
	return access.optional === true
		? { token: 'optional', scopes, user: false }
		: { token: 'required', scopes, user: true }
}

function mastodonAccess(route: MastodonRoute): Access {
	return {
		token: route.token as Access['token'],
		scopes: route.scopes === null ? null : route.scopes.toSorted(),
		user: route.user === true,
	}
}

// Mastodon's route for a method and path, its parameters matched whatever their names.
function mastodonRoute(method: string, path: string): MastodonRoute | undefined {
	const shape = (p: string) => p.replace(/:\w+/g, ':')
	return mastodon.routes.find((route) => route.method === method && shape(route.path) === shape(path))
}

const show = (access: Access) =>
	`${access.token} token, scopes ${access.scopes?.join(' ') ?? 'any'}, ${access.user ? 'user required' : 'no user required'}`

// Both sides of a route as compared: Kopje's, and Mastodon's ('absent', or marked unresolved when it could not be read).
// covers stands in for grants() in the check that the comparison sees a scope grants() lets through.
function sides(route: (typeof ROUTES)[number], covers = grants) {
	const kopje = show(kopjeAccess(route.access, covers))
	const theirs = mastodonRoute(route.method, route.path)
	if (theirs === undefined) {
		return { kopje, mastodon: 'absent', source: `no such route in Mastodon v${mastodon.mastodon}` }
	}
	const access = show(mastodonAccess(theirs))
	return {
		kopje,
		mastodon: theirs.unresolved === undefined ? access : `unresolved (${theirs.unresolved.join('; ')}): ${access}`,
		source: `${theirs.controller}#${theirs.action}`,
	}
}

const describeSides = (name: string, { kopje, mastodon, source }: ReturnType<typeof sides>) =>
	`${name}\n  Kopje:    ${kopje}\n  Mastodon: ${mastodon} (${source})`

describe(`route access matches Mastodon v${mastodon.mastodon}`, () => {
	it.each(ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))('%s', (name, route) => {
		const exception = EXCEPTIONS[name]
		const now = sides(route)
		if (exception === undefined) {
			if (now.kopje !== now.mastodon) {
				expect.fail(`${describeSides(name, now)}\nMatch Mastodon, or add the route to EXCEPTIONS with the reason.`)
			}
			return
		}
		if (now.kopje === now.mastodon) {
			expect.fail(`${name} matches Mastodon now: remove its exception (${exception.reason})`)
		}
		if (now.kopje !== exception.kopje || now.mastodon !== exception.mastodon) {
			expect.fail(
				`${describeSides(name, now)}\nThe exception was written for\n  Kopje:    ${exception.kopje}\n` +
					`  Mastodon: ${exception.mastodon}\nRevisit it (${exception.reason}).`
			)
		}
	})

	it('lists exceptions only for routes of the table', () => {
		const names = new Set(ROUTES.map((route) => `${route.method} ${route.path}`))
		expect(Object.keys(EXCEPTIONS).filter((name) => !names.has(name))).toEqual([])
	})

	it('reads the scopes a route accepts through the scope hierarchy', () => {
		expect(acceptedScopes('read:statuses')).toEqual(['read', 'read:statuses'])
		expect(acceptedScopes('write:blocks')).toEqual(['follow', 'write', 'write:blocks'])
		expect(acceptedScopes('admin:read:accounts')).toEqual(['admin:read', 'admin:read:accounts'])
		expect(acceptedScopes('push')).toEqual(['push'])
		expect(acceptedScopes('profile')).toEqual(['profile'])
		expect(acceptedScopes(['profile', 'read:accounts'])).toEqual(['profile', 'read', 'read:accounts'])
	})

	it('sees a scope the hierarchy wrongly lets through', () => {
		const bookmarks = ROUTES.find((route) => route.method === 'GET' && route.path === '/api/v1/bookmarks')
		expect(bookmarks).toBeDefined()
		const { kopje, mastodon } = sides(bookmarks!)
		expect(kopje).toBe(mastodon)
		const leaky: typeof grants = (granted, required) =>
			grants(granted, required) || (granted.includes('push') && required === 'read:bookmarks')
		expect(sides(bookmarks!, leaky).kopje).toBe(mastodon.replace('scopes read', 'scopes push read'))
	})
})
