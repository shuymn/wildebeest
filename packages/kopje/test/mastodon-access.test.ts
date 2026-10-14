import { describe, expect, it } from 'vitest'

import mastodon from './fixtures/mastodon-4.5.11-api-access.json'
import type { RouteAccess } from '../src/mastodon/access'
import { ROUTES } from '../src/mastodon/routes'
import { grants, type Scope, SCOPES } from '../src/security/scopes'

// Every route of the API table (src/mastodon/routes.ts) asks of its caller what Mastodon's same route asks, read from
// Mastodon's source by scripts/mastodon-scopes.mjs (the fixture's header says how to regenerate it). Compared:
//   token   none (no token read), optional (a token sent is checked), required
//   scopes  the token scopes accepted (null: any valid token): Kopje's required scope with the scopes that cover it
//           (src/security/scopes.ts), Mastodon's doorkeeper list
//   user    whether a token without a user (an app token) is refused
// A route Mastodon does not have, or one that deliberately differs, is listed in EXCEPTIONS with the access it has and
// the reason; a change to that access, or the difference going away, fails until the exception is revisited.

type Access = { token: 'none' | 'optional' | 'required'; scopes: string[] | null; user: boolean }

type MastodonRoute = (typeof mastodon.routes)[number]

const EXCEPTIONS: Record<string, readonly [RouteAccess, string]> = {
	// Not Mastodon /api routes.
	'POST /oauth/token': ['public', "Doorkeeper's token endpoint, outside /api"],
	'POST /oauth/revoke': ['public', "Doorkeeper's revocation endpoint, outside /api"],

	// Answers that do not depend on the caller, so no token is read.
	'GET /api/v1/trends': ['public', 'answered empty to everyone; Mastodon filters trends for the viewer'],
	'GET /api/v1/trends/tags': ['public', 'answered empty to everyone; Mastodon filters trends for the viewer'],
	'GET /api/v1/trends/statuses': ['public', 'answered empty to everyone; Mastodon filters trends for the viewer'],
	'GET /api/v1/trends/links': ['public', 'answered empty to everyone; Mastodon filters trends for the viewer'],
	'GET /api/v1/instance/domain_blocks': [
		'public',
		'answered "not configured" to everyone; Mastodon may show it to users only',
	],

	// Differences RouteAccess cannot express, enforced elsewhere or left open.
	'GET /api/v1/announcements': [
		'token',
		'any token at the route; placeholders.emptyUserList refuses one without a user',
	],
	'GET /api/v1/statuses/:id/source': [
		{ scope: 'read:statuses' },
		'RouteAccess has no "scope without a user" form; Mastodon serves app tokens what StatusPolicy#show? allows',
	],
	'GET /api/v1/accounts/relationships': [
		{ scope: 'read:follows' },
		'grants() lets `follow` cover read:follows everywhere; Mastodon omits follow here',
	],
	'GET /api/v1/accounts/familiar_followers': [
		{ scope: 'read:follows' },
		'grants() lets `follow` cover read:follows everywhere; Mastodon omits follow here',
	],
	'GET /api/v1/accounts/verify_credentials': [
		{ scope: 'read:accounts' },
		"Kopje has no `profile` scope (Mastodon 4.3+'s identity-only scope)",
	],

	// Mastodon's StatusPolicy#show? (Pundit) decides per viewer; Kopje's Store applies the visibility rules.
	'GET /api/v1/statuses/:id': [
		{ scope: 'read:statuses', optional: true },
		"visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	],
	'GET /api/v1/statuses/:id/context': [
		{ scope: 'read:statuses', optional: true },
		"visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	],
	'GET /api/v1/statuses/:id/history': [
		{ scope: 'read:statuses', optional: true },
		"visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	],
	'GET /api/v1/statuses/:id/favourited_by': [
		{ scope: 'read:accounts', optional: true },
		"visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	],
	'GET /api/v1/statuses/:id/reblogged_by': [
		{ scope: 'read:accounts', optional: true },
		"visibility is the Store's (Mastodon: Pundit StatusPolicy#show?, unresolved)",
	],

	// Deliberate choices.
	'GET /api/v1/accounts/lookup': ['public', 'a stale token is not read (access.ts); Mastodon checks a token sent'],
	'GET /api/v1/accounts/:id': ['public', 'a stale token is not read (access.ts); Mastodon checks a token sent'],
	'GET /api/v1/accounts/:id/followers': [
		'public',
		'a stale token is not read (access.ts); Mastodon checks a token sent',
	],
	'GET /api/v1/accounts/:id/following': [
		'public',
		'a stale token is not read (access.ts); Mastodon checks a token sent',
	],
	'GET /api/v2/search': [
		{ scope: 'read:search' },
		'anonymous search is refused (routes.ts); Mastodon allows it without resolve or offset',
	],
	'GET /api/v1/timelines/public': [
		{ scope: 'read:statuses', optional: true },
		'open to anonymous callers; Mastodon requires a user if its feed setting says so',
	],
	'GET /api/v1/timelines/tag/:hashtag': [
		{ scope: 'read:statuses', optional: true },
		'open to anonymous callers; Mastodon requires a user if its feed setting says so',
	],
}

// The scopes a token may hold to pass the route's scope: every scope Kopje issues that covers it.
function acceptedScopes(scope: Scope, covers = grants): string[] {
	return SCOPES.filter((s) => covers([s], scope)).toSorted()
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
	`token ${access.token}, scopes ${access.scopes === null ? 'any' : access.scopes.join(' ')}, user ${access.user ? 'required' : 'not required'}`

// Why a route's access is not Mastodon's, or undefined when it is.
// covers stands in for grants() in the check that the comparison sees a scope grants() lets through.
function difference(route: (typeof ROUTES)[number], covers = grants): string | undefined {
	const name = `${route.method} ${route.path}`
	const theirs = mastodonRoute(route.method, route.path)
	if (theirs === undefined) {
		return `${name}: Mastodon v${mastodon.mastodon} has no such route`
	}
	if (theirs.unresolved !== undefined) {
		return `${name}: Mastodon's access could not be read (${theirs.unresolved.join('; ')})`
	}
	const ours = kopjeAccess(route.access, covers)
	const expected = mastodonAccess(theirs)
	if (JSON.stringify(ours) === JSON.stringify(expected)) {
		return undefined
	}
	return `${name}\n  Kopje:    ${show(ours)}\n  Mastodon: ${show(expected)} (${theirs.controller}#${theirs.action})`
}

describe(`route access matches Mastodon v${mastodon.mastodon}`, () => {
	it.each(ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))('%s', (name, route) => {
		const exception = EXCEPTIONS[name]
		const found = difference(route)
		if (exception === undefined) {
			if (found !== undefined) {
				expect.fail(`${found}\nMatch Mastodon, or add the route to EXCEPTIONS with the reason.`)
			}
			return
		}
		const [access, reason] = exception
		if (JSON.stringify(route.access) !== JSON.stringify(access)) {
			expect.fail(
				`${name}: its access changed from the exception's ${JSON.stringify(access)} to ${JSON.stringify(route.access)}\n` +
					`${found ?? 'It matches Mastodon now.'}\nRevisit the exception (${reason}).`
			)
		}
		if (found === undefined) {
			expect.fail(`${name} matches Mastodon now: remove its exception (${reason})`)
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
	})

	it('sees a scope the hierarchy wrongly lets through', () => {
		const bookmarks = ROUTES.find((route) => route.method === 'GET' && route.path === '/api/v1/bookmarks')
		expect(bookmarks).toBeDefined()
		expect(difference(bookmarks!)).toBeUndefined()
		const leaky: typeof grants = (granted, required) =>
			grants(granted, required) || (granted.includes('push') && required === 'read:bookmarks')
		expect(difference(bookmarks!, leaky)).toContain('scopes push read read:bookmarks')
	})
})
