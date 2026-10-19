import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { bearer } from './api-helpers'
import { PNG_PLAIN } from './fixtures/images'
import mastodon from './fixtures/mastodon-4.5.11-api-access.json'
import { covers, paramFailures } from './mastodon-conformance'
import { PARAM_EXCEPTIONS, UNRESOLVED_PARAMS } from './mastodon-params-exceptions'
import {
	appToken,
	defaultBaseline,
	fixtureRoute,
	type Observer,
	observeReads,
	observeRoute,
	type Recipe,
	routeName,
	type World,
	world,
} from './mastodon-params-harness'
import { bytes, mediaForm } from './media-helpers'
import { newClient } from './push-helpers'
import { ROUTES } from '../src/mastodon/routes'

// Every request parameter Mastodon's same route reads (the fixture's params, read from Mastodon's source by
// scripts/mastodon-scopes.mjs) is read by Kopje's route: one request per parameter, observed through call-through spies
// on the accessors handlers read parameters with (test/mastodon-params-harness.ts). A name not read is a failure unless
// PARAM_EXCEPTIONS lists it (test/mastodon-params-exceptions.ts); an exception that no longer applies fails until it is
// removed. Out of reach: a parameter read and then dropped or misapplied (left to audits, see the script's header).

let unique = 0
const fresh = (prefix: string) => `${prefix}${++unique}`

// A new public status of the owner, for routes that consume theirs.
async function newStatus(w: World): Promise<string> {
	return (await w.ok<{ id: string }>('POST', '/api/v1/statuses', { status: fresh('status ') })).id
}

const NOT_SERVED = {
	code: 403,
	reason: 'not served: refused as Mastodon refuses a role without the permission (mastodon/admin.ts notAllowed)',
}
const NO_RECORD = { code: 404, reason: 'not served: no record exists (mastodon/admin.ts recordNotFound)' }

// Baselines beyond the default (the route with its ids filled, no parameters): the parameters a route needs to answer
// 2xx, fresh targets for routes that consume theirs, and the answer of routes that do not serve the feature.
const RECIPES: Record<string, Recipe> = {
	'POST /api/v1/apps': {
		baseline: () => ({
			path: '/api/v1/apps',
			params: { client_name: 'probe', redirect_uris: 'https://client.test/callback' },
		}),
	},
	'GET /api/oembed': {
		baseline: (w) => ({ path: '/api/oembed', params: { url: `https://kopje.test/@owner/${w.ids.status}` } }),
	},
	'POST /api/v1/featured_tags': {
		baseline: () => ({ path: '/api/v1/featured_tags', params: { name: fresh('tag') } }),
	},
	'GET /api/v1/accounts/search': { baseline: () => ({ path: '/api/v1/accounts/search', params: { q: 'carol' } }) },
	'GET /api/v1/accounts/lookup': {
		baseline: () => ({ path: '/api/v1/accounts/lookup', params: { acct: 'carol@remote.example' } }),
	},
	'GET /api/v1/domain_blocks/preview': {
		baseline: () => ({ path: '/api/v1/domain_blocks/preview', params: { domain: 'remote.example' } }),
	},
	'POST /api/v1/domain_blocks': {
		baseline: () => ({ path: '/api/v1/domain_blocks', params: { domain: `${fresh('d')}.example` } }),
	},
	'POST /api/v1/statuses': { baseline: () => ({ path: '/api/v1/statuses', params: { status: fresh('probe ') } }) },
	'PUT /api/v1/statuses/:id': {
		baseline: (w) => ({ path: `/api/v1/statuses/${w.ids.status}`, params: { status: fresh('edited ') } }),
	},
	'PATCH /api/v1/statuses/:id': {
		baseline: (w) => ({ path: `/api/v1/statuses/${w.ids.status}`, params: { status: fresh('edited ') } }),
	},
	'DELETE /api/v1/statuses/:id': { baseline: async (w) => ({ path: `/api/v1/statuses/${await newStatus(w)}` }) },
	'POST /api/v1/lists': { baseline: () => ({ path: '/api/v1/lists', params: { title: fresh('list ') } }) },
	'POST /api/v1/filters': {
		baseline: () => ({ path: '/api/v1/filters', params: { phrase: fresh('phrase'), 'context[]': 'home' } }),
	},
	'POST /api/v2/filters': {
		baseline: () => ({ path: '/api/v2/filters', params: { title: fresh('filter'), 'context[]': 'home' } }),
	},
	'POST /api/v2/filters/:filter_id/keywords': {
		baseline: (w) => ({ path: `/api/v2/filters/${w.ids.filter}/keywords`, params: { keyword: fresh('word') } }),
	},
	'POST /api/v2/filters/:filter_id/statuses': {
		baseline: async (w) => ({
			path: `/api/v2/filters/${w.ids.filter}/statuses`,
			params: { status_id: await newStatus(w) },
		}),
	},
	'POST /api/v1/reports': { baseline: (w) => ({ path: '/api/v1/reports', params: { account_id: w.remote } }) },
	'POST /api/v1/admin/accounts/:account_id/action': {
		baseline: (w) => ({ path: `/api/v1/admin/accounts/${w.remote}/action`, params: { type: 'none' } }),
	},
	'POST /api/v1/admin/domain_blocks': {
		baseline: () => ({
			path: '/api/v1/admin/domain_blocks',
			params: { domain: `${fresh('d')}.example`, severity: 'noop' },
		}),
	},
	'POST /api/v1/polls/:id/votes': {
		// A poll is voted once: a new poll of Bob's for each request.
		baseline: async (w) => {
			const status = await w.ok<{ poll: { id: string } }>(
				'POST',
				'/api/v1/statuses',
				{ status: fresh('poll '), poll: { options: ['a', 'b'], expires_in: 3600 } },
				w.bob.token
			)
			return { path: `/api/v1/polls/${status.poll.id}/votes`, params: { 'choices[]': '0' } }
		},
	},
	'POST /api/v1/media': { baseline: () => ({ path: '/api/v1/media', params: { file: '' } }) },
	'POST /api/v2/media': { baseline: () => ({ path: '/api/v2/media', params: { file: '' } }) },
	'GET /api/v2/search': { baseline: () => ({ path: '/api/v2/search', params: { q: 'carol' } }) },
	'POST /api/v1/push/subscription': {
		baseline: async () => {
			const client = await newClient()
			return {
				path: '/api/v1/push/subscription',
				params: {
					'subscription[endpoint]': 'https://push.example/send/abc',
					'subscription[keys][p256dh]': client.p256dh,
					'subscription[keys][auth]': client.auth,
				},
			}
		},
	},
	// Placeholders and features Kopje does not serve: the answer they give.
	'GET /api/v1/timelines/link': {
		baseline: () => ({ path: '/api/v1/timelines/link', params: { url: 'https://news.example/a' } }),
		status: { code: 404, reason: 'no trending links (mastodon/placeholders.ts linkTimeline)' },
	},
	'POST /api/v1/emails/confirmations': {
		status: { code: 403, reason: 'no sign-ups (MD-1): no user was signed up through an app' },
	},
	'POST /api/v1/accounts': {
		baseline: async (w) => ({ path: '/api/v1/accounts', token: await appToken(w) }),
		status: { code: 403, reason: 'registration through the API is closed (MD-1)' },
	},
	'POST /api/v1/admin/domain_allows': { status: NOT_SERVED },
	'GET /api/v1/admin/ip_blocks': { status: NOT_SERVED },
	'POST /api/v1/admin/ip_blocks': { status: NOT_SERVED },
	'PUT /api/v1/admin/ip_blocks/:id': { status: NO_RECORD },
	'PATCH /api/v1/admin/ip_blocks/:id': { status: NO_RECORD },
	'GET /api/v1/admin/email_domain_blocks': { status: NOT_SERVED },
	'POST /api/v1/admin/email_domain_blocks': { status: NOT_SERVED },
	'GET /api/v1/admin/canonical_email_blocks': { status: NOT_SERVED },
	'POST /api/v1/admin/canonical_email_blocks': { status: NOT_SERVED },
	'POST /api/v1/admin/canonical_email_blocks/test': { status: NOT_SERVED },
	'GET /api/v1/admin/trends/links/publishers': { status: NOT_SERVED },
	'GET /api/v1/admin/tags': { status: NOT_SERVED },
	'PUT /api/v1/admin/tags/:id': { status: NOT_SERVED },
	'PATCH /api/v1/admin/tags/:id': { status: NOT_SERVED },
}

let w: World
let observer: Observer

beforeAll(async () => {
	w = await world()
}, 60_000)

beforeEach(() => {
	observer = observeReads()
})

afterEach(() => {
	observer.restore()
})

// The routes Kopje serves that the fixture has.
const served = ROUTES.flatMap((route) => {
	const theirs = fixtureRoute(route.method, route.path)
	return theirs === undefined ? [] : [[routeName(route), route, theirs] as const]
})

describe(`request parameters match Mastodon v${mastodon.mastodon}`, () => {
	it('observes the reads of a real request through the spies', async () => {
		observer.clear()
		await (await w.h.request('/api/v1/timelines/home?limit=1', bearer(w.owner.token))).body?.cancel()
		expect(observer.reads()).toContainEqual({ method: 'get', name: 'limit' })
		observer.clear()
		await (await w.h.request('/api/v1/accounts/lookup?acct=carol@remote.example')).body?.cancel()
		expect(observer.reads()).toContainEqual({ method: 'query', name: 'acct' })
		observer.clear()
		const form = mediaForm(bytes(PNG_PLAIN), {}, 'a.png', 'image/png')
		await (await w.h.request('/api/v2/media', bearer(w.owner.token, { method: 'POST', body: form }))).body?.cancel()
		expect(observer.reads()).toContainEqual({ method: 'file', name: 'file' })
		// A read the coverage rule takes for the name it returns.
		expect(observer.reads().some((read) => covers(read, 'description'))).toBe(true)
	})

	it.each(served)(
		'%s',
		async (name, route, theirs) => {
			const names = theirs.params?.names ?? []
			const recipe = RECIPES[name] ?? {}
			const observation = await observeRoute(w, route, names, recipe, observer, defaultBaseline(route))
			const failures = paramFailures({
				names,
				unresolved: theirs.params?.unresolved ?? [],
				observation,
				exceptions: PARAM_EXCEPTIONS[name],
				acknowledged: UNRESOLVED_PARAMS[name]?.reasons,
			})
			expect(failures).toEqual([])
		},
		60_000
	)

	it('lists exceptions, acknowledgements and recipes only for routes of the table that the fixture has', () => {
		const names = new Set(served.map(([name]) => name))
		const stale = [...Object.keys(PARAM_EXCEPTIONS), ...Object.keys(UNRESOLVED_PARAMS), ...Object.keys(RECIPES)].filter(
			(name) => !names.has(name)
		)
		expect(stale).toEqual([])
	})
})
