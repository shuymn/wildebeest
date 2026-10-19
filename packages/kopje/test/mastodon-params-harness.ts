import { HonoRequest } from 'hono/request'
import { type MockInstance, vi } from 'vitest'

import {
	type ApiHarness,
	apiHarness,
	bearer,
	form,
	json,
	login,
	registerApp,
	seedAccount,
	setSetting,
} from './api-helpers'
import { NOW } from './app-helpers'
import { PNG_PLAIN } from './fixtures/images'
import mastodon from './fixtures/mastodon-4.5.11-api-access.json'
import { type Read, type ReadMethod, type RouteObservation, sameRoute } from './mastodon-conformance'
import { bytes, mediaForm, TestCodec } from './media-helpers'
import { newClient, VAPID } from './push-helpers'
import type { User } from './status-helpers'
import { formFiles } from '../src/mastodon/media'
import { Params } from '../src/mastodon/params'
import type { Route } from '../src/mastodon/routes'

// The harness of the request-parameter check (test/mastodon-params*.test.ts): a world with one of each resource the
// routes look up, call-through spies on every accessor a handler reads parameters with, and one request per parameter.

// ---- Observation ----

const PARAMS_METHODS = ['get', 'has', 'getAll', 'list', 'objects', 'hasObject'] as const

type Spy = MockInstance<(...args: never[]) => unknown>

// Call-through spies on Params' accessors, Hono's c.req.query/queries, and the upload form's file accessor. Cleared
// before each request (requests run one at a time), restored by restore().
export function observeReads() {
	const spies: [ReadMethod, Spy, number][] = [
		...PARAMS_METHODS.map((m): [ReadMethod, Spy, number] => [m, vi.spyOn(Params.prototype, m) as unknown as Spy, 0]),
		['query', vi.spyOn(HonoRequest.prototype, 'query') as unknown as Spy, 0],
		['queries', vi.spyOn(HonoRequest.prototype, 'queries') as unknown as Spy, 0],
		['file', vi.spyOn(formFiles, 'get') as unknown as Spy, 1],
	]
	return {
		clear(): void {
			for (const [, spy] of spies) {
				spy.mockClear()
			}
		},
		reads(): Read[] {
			return spies.flatMap(([method, spy, at]) =>
				spy.mock.calls.flatMap((args, i): Read[] => {
					const name = (args as unknown[])[at]
					if (typeof name !== 'string') {
						return []
					}
					if (method !== 'objects') {
						return [{ method, name }]
					}
					// The members of the records objects() returned.
					const records = spy.mock.results[i]?.value as Record<string, string>[] | undefined
					return [{ method, name, fields: [...new Set((records ?? []).flatMap((r) => Object.keys(r)))] }]
				})
			)
		},
		restore(): void {
			for (const [, spy] of spies) {
				spy.mockRestore()
			}
		},
	}
}

export type Observer = ReturnType<typeof observeReads>

// ---- The world ----

// Every scope a token can hold, so no route refuses the token for its scope.
const ALL_SCOPES = 'read write follow push profile admin:read admin:write'

const OWNER_EMAIL = 'owner@example.com'

export type World = {
	h: ApiHarness
	owner: User
	bob: User
	// A remote account (carol@remote.example).
	remote: string
	app: Awaited<ReturnType<typeof registerApp>>
	ids: Record<string, string>
	// Sends one API request as `token` (the owner's by default), failing unless it answers 200; its JSON body.
	ok: <T = Record<string, unknown>>(
		method: string,
		path: string,
		body?: Record<string, unknown>,
		token?: string
	) => Promise<T>
}

// The owner (the instance's admin, locked so follows of it are requests), a second local user, remote accounts, and
// one of each resource the routes look up, made through the API where it can make them.
export async function world(): Promise<World> {
	const codec = new TestCodec()
	const h = await apiHarness({ VAPID_JWK: VAPID.env }, { images: () => codec })
	await setSetting(h.store, 'admin_email', OWNER_EMAIL)
	const app = await registerApp(h, { scopes: ALL_SCOPES })
	const user = async (name: string): Promise<User> => {
		const email = name === 'owner' ? OWNER_EMAIL : `${name}@example.com`
		const id = await seedAccount(h.store, { username: name, email })
		return { id, token: (await login(h, { app, email, scope: ALL_SCOPES })).token }
	}
	const owner = await user('owner')
	const bob = await user('bob')
	const call = (method: string, path: string, body?: Record<string, unknown>, token = owner.token) =>
		h.request(path, bearer(token, body === undefined ? { method } : json(body, { method })))
	const ok = async <T>(method: string, path: string, body?: Record<string, unknown>, token = owner.token) => {
		const response = await call(method, path, body, token)
		if (response.status !== 200) {
			throw new Error(`world: ${method} ${path}: ${response.status} ${await response.text()}`)
		}
		return response.json<T>()
	}
	const remote = await seedAccount(h.store, { username: 'carol', domain: 'remote.example' })
	const ids: Record<string, string> = {}
	await ok('PATCH', '/api/v1/accounts/update_credentials', { locked: true })

	ids.status = (
		await ok<{ id: string }>('POST', '/api/v1/statuses', { status: 'hello #kopje', visibility: 'public' })
	).id
	// A status with a poll and one with media, for the reads that show them.
	await ok('POST', '/api/v1/statuses', { status: 'a poll', poll: { options: ['a', 'b'], expires_in: 3600 } })
	await ok('POST', '/api/v1/statuses', { status: 'media', media_ids: [await uploadMedia(h, owner)] })
	ids.unattached = await uploadMedia(h, owner)
	// Bob's poll, for the owner's votes.
	ids.bobPoll = (
		await ok<{ poll: { id: string } }>(
			'POST',
			'/api/v1/statuses',
			{ status: 'bob poll', poll: { options: ['a', 'b'], expires_in: 3600, multiple: true } },
			bob.token
		)
	).poll.id
	// Bob follows the owner (a request: the owner is locked), mentions the owner, and writes them directly.
	await ok('POST', `/api/v1/accounts/${owner.id}/follow`, {}, bob.token)
	ids.bobStatus = (await ok<{ id: string }>('POST', '/api/v1/statuses', { status: '@owner hi' }, bob.token)).id
	await ok('POST', '/api/v1/statuses', { status: '@owner psst', visibility: 'direct' }, bob.token)
	await ok('POST', `/api/v1/accounts/${bob.id}/follow`)
	await ok('POST', `/api/v1/statuses/${ids.bobStatus}/favourite`)
	ids.list = (await ok<{ id: string }>('POST', '/api/v1/lists', { title: 'friends' })).id
	await ok('POST', `/api/v1/lists/${ids.list}/accounts`, { account_ids: [bob.id] })
	ids.filterV1 = (await ok<{ id: string }>('POST', '/api/v1/filters', { phrase: 'spoiler', context: ['home'] })).id
	const filter = await ok<{ id: string; keywords: { id: string }[] }>('POST', '/api/v2/filters', {
		title: 'words',
		context: ['home'],
		keywords_attributes: [{ keyword: 'word' }],
	})
	ids.filter = filter.id
	ids.filterKeyword = filter.keywords[0]?.id ?? ''
	ids.filterStatus = (
		await ok<{ id: string }>('POST', `/api/v2/filters/${filter.id}/statuses`, { status_id: ids.bobStatus })
	).id
	ids.scheduled = (
		await ok<{ id: string }>('POST', '/api/v1/statuses', {
			status: 'later',
			scheduled_at: new Date(NOW + 86_400_000).toISOString(),
		})
	).id
	ids.report = (await ok<{ id: string }>('POST', '/api/v1/reports', { account_id: remote, comment: 'spam' })).id
	ids.featuredTag = (await ok<{ id: string }>('POST', '/api/v1/featured_tags', { name: 'kopje' })).id
	await ok('POST', '/api/v1/domain_blocks', { domain: 'blocked.example' })
	ids.adminDomainBlock = (
		await ok<{ id: string }>('POST', '/api/v1/admin/domain_blocks', {
			domain: 'admin-blocked.example',
			severity: 'noop',
		})
	).id
	await subscribePush(ok)
	const groups = await ok<{ notification_groups: { group_key: string }[] }>('GET', '/api/v2/notifications')
	ids.notification = (await ok<{ id: string }[]>('GET', '/api/v1/notifications'))[0]?.id ?? ''
	ids.groupKey = groups.notification_groups[0]?.group_key ?? ''
	ids.conversation = (await ok<{ id: string }[]>('GET', '/api/v1/conversations'))[0]?.id ?? ''
	return { h, owner, bob, remote, app, ids, ok }
}

async function uploadMedia(h: ApiHarness, user: User): Promise<string> {
	const response = await h.request(
		'/api/v2/media',
		bearer(user.token, { method: 'POST', body: mediaForm(bytes(PNG_PLAIN), {}, 'a.png', 'image/png') })
	)
	if (response.status !== 200) {
		throw new Error(`world: upload: ${response.status} ${await response.text()}`)
	}
	return (await response.json<{ id: string }>()).id
}

async function subscribePush(ok: World['ok']): Promise<void> {
	const client = await newClient()
	await ok('POST', '/api/v1/push/subscription', {
		subscription: { endpoint: 'https://push.example/send/abc', keys: { p256dh: client.p256dh, auth: client.auth } },
	})
}

// A token of the world's app without a user (client_credentials).
export async function appToken(w: World): Promise<string> {
	const response = await w.h.request(
		'/oauth/token',
		form({
			grant_type: 'client_credentials',
			client_id: w.app.client_id,
			client_secret: w.app.client_secret,
			scope: 'read write',
		})
	)
	return (await response.json<{ access_token: string }>()).access_token
}

// ---- Requests ----

// Parameters sent as a file part (multipart): the image fields of Mastodon's media and profile endpoints.
const FILE_PARAMS = new Set(['avatar', 'header', 'file', 'thumbnail'])

type Baseline = {
	// The path with its ids filled.
	path: string
	// Parameters every request of the route sends (the route's own minimum), by name.
	params?: Record<string, string>
	// The bearer token (the owner's by default).
	token?: string
}

export type Recipe = {
	// The baseline of each request, called before every request (baseline and probes) of the route: a recipe of a
	// route that changes its target makes it afresh here.
	baseline?: (w: World) => Baseline | Promise<Baseline>
	// The status the baseline answers, when not 2xx, and why the reads still happen.
	status?: { code: number; reason: string }
}

const leaf = (name: string) => /([^[\]]+)\]?$/.exec(name)?.[1] ?? name

// One request: `params` in the query for GET and DELETE, else in a form body (multipart when a file name is sent).
async function send(
	w: World,
	method: string,
	baseline: Baseline,
	extra: Record<string, string> = {}
): Promise<Response> {
	const params = Object.entries({ ...baseline.params, ...extra })
	const token = baseline.token ?? w.owner.token
	const headers = { authorization: `Bearer ${token}` }
	if (method === 'GET' || method === 'DELETE') {
		const query = new URLSearchParams(params).toString()
		return w.h.request(`${baseline.path}${query === '' ? '' : `?${query}`}`, { method, headers })
	}
	if (params.some(([name]) => FILE_PARAMS.has(leaf(name)))) {
		const body = new FormData()
		for (const [name, value] of params) {
			if (FILE_PARAMS.has(leaf(name))) {
				body.append(name, new File([bytes(PNG_PLAIN)], 'a.png', { type: 'image/png' }))
			} else {
				body.append(name, value)
			}
		}
		return w.h.request(baseline.path, { method, headers, body })
	}
	return w.h.request(baseline.path, {
		method,
		headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params).toString(),
	})
}

// The fixture route Kopje's route matches (parameters matched whatever their names).
export function fixtureRoute(method: string, path: string) {
	return sameRoute(mastodon.routes, method, path)
}

export const routeName = (route: Pick<Route, 'method' | 'path'>) => `${route.method} ${route.path}`

// The baseline, then one request per fixture name with that name added (`1`; a file for FILE_PARAMS), each preceded by
// the recipe's baseline (by default the route with its ids filled); the reads each request made.
export async function observeRoute(
	w: World,
	route: Pick<Route, 'method' | 'path'>,
	names: readonly string[],
	recipe: Recipe,
	observer: Observer
): Promise<RouteObservation> {
	if (names.length === 0) {
		// Nothing to observe: the route's unresolved extraction is still checked.
		return { baseline: { ok: true }, reads: new Map() }
	}
	const baselineOf = async (): Promise<Baseline> =>
		recipe.baseline === undefined ? { path: filledPath(w, route.path) } : recipe.baseline(w)
	const response = await send(w, route.method, await baselineOf())
	const expected = recipe.status?.code
	const good = expected === undefined ? response.status >= 200 && response.status < 300 : response.status === expected
	if (!good) {
		return {
			baseline: { ok: false, detail: `${response.status} ${(await response.text()).slice(0, 200)}` },
			reads: new Map(),
		}
	}
	await response.body?.cancel()
	const reads = new Map<string, Read[]>()
	for (const name of names) {
		const baseline = await baselineOf()
		observer.clear()
		const probe = await send(w, route.method, baseline, { [name]: '1' })
		await probe.body?.cancel()
		reads.set(name, observer.reads())
	}
	return { baseline: { ok: true }, reads }
}

// ---- Path ids ----

// The seeded resource each path parameter names, by the route's path: the first rule whose pattern matches the path
// before the parameter.
const PATH_IDS: [RegExp, (w: World) => string][] = [
	[/^\/api\/v1\/statuses$/, (w) => w.ids.status ?? ''],
	[/^\/api\/v1\/accounts$/, (w) => w.remote],
	[/^\/api\/v1\/tags$/, () => 'kopje'],
	[/^\/api\/v1\/timelines\/tag$/, () => 'kopje'],
	[/^\/api\/v1\/featured_tags$/, (w) => w.ids.featuredTag ?? ''],
	[/^\/api\/v1\/follow_requests$/, (w) => w.bob.id],
	[/^\/api\/v1\/(lists|timelines\/list)$/, (w) => w.ids.list ?? ''],
	[/^\/api\/v1\/filters$/, (w) => w.ids.filterV1 ?? ''],
	[/^\/api\/v2\/filters\/keywords$/, (w) => w.ids.filterKeyword ?? ''],
	[/^\/api\/v2\/filters\/statuses$/, (w) => w.ids.filterStatus ?? ''],
	[/^\/api\/v2\/filters$/, (w) => w.ids.filter ?? ''],
	[/^\/api\/v1\/conversations$/, (w) => w.ids.conversation ?? ''],
	[/^\/api\/v1\/notifications$/, (w) => w.ids.notification ?? ''],
	[/^\/api\/v2\/notifications$/, (w) => w.ids.groupKey ?? ''],
	[/^\/api\/v1\/polls$/, (w) => w.ids.bobPoll ?? ''],
	[/^\/api\/v1\/scheduled_statuses$/, (w) => w.ids.scheduled ?? ''],
	[/^\/api\/v1\/media$/, (w) => w.ids.unattached ?? ''],
	[/^\/api\/v1\/admin\/accounts$/, (w) => w.remote],
	[/^\/api\/v1\/admin\/reports$/, (w) => w.ids.report ?? ''],
	[/^\/api\/v1\/admin\/domain_blocks$/, (w) => w.ids.adminDomainBlock ?? ''],
	[/^\/api\/v1\/suggestions$/, (w) => w.remote],
]

function filledPath(w: World, path: string): string {
	return path.replace(/:(\w+)/g, (_match, _name, offset: number) => {
		const before = path.slice(0, offset - 1)
		const rule = PATH_IDS.find(([pattern]) => pattern.test(before))
		return rule === undefined ? '1' : rule[1](w)
	})
}
