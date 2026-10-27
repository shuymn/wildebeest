import { describe, expect, it, vi } from 'vitest'

import { adminClaims, adminHarness, adminTeam, setTeamAccess } from './access-helpers'
import { apiHarness } from './api-helpers'
import { countingStore, harness } from './app-helpers'
import { BUILD, migratedStore } from './helpers'
import { storeWith } from './setup-helpers'
import { ERROR_PAGE_HEADERS, PUBLIC_PAGE_HEADERS, UNAVAILABLE_PAGE_HEADERS } from '../browser/headers'
import { documentPath, HTML, JSON_TYPE, parseAccept, PLAIN_TEXT, prefersPage, quality } from '../src/app/negotiation'
import type { StoreStub } from '../src/platform/store-client'
import { StoreUnavailableError } from '../src/platform/store-errors'
import { STYLESHEET } from '../src/web/asset-versions'

// The error pages of app.ts (negotiation.ts): a GET or HEAD of a page route that fails (500, 503, the env's
// maintenance included) or of a path outside the document namespaces that no route serves (404) negotiates between the
// HTML page, rendered without the Store, and the API's answer, both varying with Accept. Every other request keeps its
// answer, pinned here as it was before the pages existed.

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'

const MAINTENANCE = '{"error":"This server is under maintenance. Try again later."}'
const INTERNAL = '{"error":"Internal Server Error"}'
const NOSNIFF = { 'x-content-type-options': 'nosniff' }
const DOCUMENT_CORS = { 'access-control-allow-origin': '*' }
const API_CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Link' }

type Bytes = { status: number; headers: Record<string, string>; body: string }

const json503 = (extra: Record<string, string> = {}): Bytes => ({
	status: 503,
	headers: { 'content-type': 'application/json', 'retry-after': '600', ...NOSNIFF, ...extra },
	body: MAINTENANCE,
})
const json500 = (extra: Record<string, string> = {}): Bytes => ({
	status: 500,
	headers: { 'content-type': 'application/json', ...NOSNIFF, ...extra },
	body: INTERNAL,
})
const plain404 = (extra: Record<string, string> = {}): Bytes => ({
	status: 404,
	headers: { 'content-type': 'text/plain; charset=UTF-8', ...NOSNIFF, ...extra },
	body: 'Not Found',
})
const VARY = { vary: 'Accept' }

async function bytesOf(response: Response): Promise<Bytes> {
	return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }
}

// A Store whose every call fails with `error`, recording the calls made.
function failingStore(error: () => Error): { stub: StoreStub; calls: string[] } {
	const calls: string[] = []
	const stub = new Proxy({} as StoreStub, {
		get: (_target, name) =>
			name === 'then'
				? undefined
				: () => {
						calls.push(String(name))
						return Promise.reject(error())
					},
	})
	return { stub, calls }
}

function init(method: string, accept: string | undefined, extra: Record<string, string> = {}, body?: string) {
	return { method, headers: { ...(accept === undefined ? {} : { accept }), ...extra }, body }
}

function expectPage(html: string, title: string) {
	expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true)
	expect(html).toContain(`<title>${title}</title>`)
	expect(html).toContain(`<link rel="stylesheet" href="${STYLESHEET}"/>`)
	expect(html).not.toContain('<script')
	expect(html).not.toContain('data-local')
}

describe('negotiation', () => {
	it.each([
		[BROWSER, JSON_TYPE, true],
		['text/html', PLAIN_TEXT, true],
		['application/xhtml+xml, text/html', JSON_TYPE, true],
		[undefined, JSON_TYPE, false],
		['application/json', JSON_TYPE, false],
		['*/*', JSON_TYPE, false],
		['*/*', PLAIN_TEXT, false],
		['application/json, text/html;q=0.5', JSON_TYPE, false],
		['text/html;q=0, */*', JSON_TYPE, false],
		['text/html, application/ld+json', JSON_TYPE, false],
		['text/html, application/activity+json', PLAIN_TEXT, false],
		// RFC 9110 §12.5.1: the most specific range sets the q, here the one naming the page's charset.
		['text/html;charset=utf-8;q=0, text/html;q=1, application/json;q=0.5', JSON_TYPE, false],
		['text/html;q=0, text/html;charset=UTF-8, application/json;q=0.5', JSON_TYPE, true],
		['text/*;q=0.9, application/json;q=0.5', JSON_TYPE, true],
		['text/*, text/plain;q=0.1', PLAIN_TEXT, true],
		['text/html;level=1, application/json;q=0.5', JSON_TYPE, false],
		// Every range's media parameters must match, a wildcard's included; type specificity ranks before their count.
		['text/html;charset=iso-8859-1, application/json;q=0.5', JSON_TYPE, false],
		['text/*;charset=iso-8859-1, application/json;q=0.5', JSON_TYPE, false],
		['*/*;charset=iso-8859-1, application/json;q=0.5', JSON_TYPE, false],
		['text/*;charset=utf-8, application/json;q=0.5', JSON_TYPE, true],
		['text/*;charset=utf-8;q=0, text/html;q=0.9, application/json;q=0.5', JSON_TYPE, true],
		['text/html, text/html;charset=utf-8;q=0, application/json;q=0.5', JSON_TYPE, false],
		// A malformed q (garbage, empty, out of range, quoted or repeated) leaves its range out.
		['text/html;q=garbage, application/json;q=0.5', JSON_TYPE, false],
		['text/html;charset=utf-8;q=garbage, text/html;q=0.9, application/json;q=0.5', JSON_TYPE, true],
		['text/html;q=1.5, application/json;q=0.5', JSON_TYPE, false],
		['text/html;q=, application/json;q=0.5', JSON_TYPE, false],
		['text/html;charset=utf-8;q=, text/html;q=0.9, application/json;q=0.5', JSON_TYPE, true],
		['text/html;q="1", application/json;q=0.5', JSON_TYPE, false],
		['text/html;q=1;q=0.9, application/json;q=0.5', JSON_TYPE, false],
		// q may stand anywhere among the parameters; every other one must match.
		['text/html;q=1;charset=iso-8859-1, application/json;q=0.5', JSON_TYPE, false],
		['text/html;charset=utf-8;q=0.9;format=flowed, application/json;q=0.5', JSON_TYPE, false],
		['text/*;q=0.9;charset=utf-8, application/json;q=0.5', JSON_TYPE, true],
		// Names, types and charsets in any case; quoted values, a comma inside one included.
		['TEXT/HTML;CHARSET=UTF-8;Q=1, application/json;q=0.5', JSON_TYPE, true],
		['text/html;charset="UTF-8", application/json;q=0.5', JSON_TYPE, true],
		['text/html;charset="utf-8,x", application/json;q=0.5', JSON_TYPE, false],
		// Only spaces and tabs are trimmed; whitespace around "=" makes a parameter, and its range, malformed.
		['\u00a0text/html, application/json;q=0.5', JSON_TYPE, false],
		['\ttext/html , application/json;q=0.5', JSON_TYPE, true],
		['text/html;charset = utf-8;q=0, text/html;q=0.9, application/json;q=0.5', JSON_TYPE, true],
		['text/html;q =0, application/json;q=0.5', JSON_TYPE, false],
	] as const)('Accept %s against %o prefers the page: %s', (accept, document, expected) => {
		expect(prefersPage(accept, document)).toBe(expected)
	})

	it('reads each range with its parameters and q, leaving out what it cannot read', () => {
		expect(
			parseAccept(
				' text/html ; q=0.5 ; charset="a\\"b,c" , , */* ;Q=0, bad, text/plain;x, a/b;q=2, text/xml;=x, text/csv;charset="open'
			)
		).toEqual([
			{ type: 'text', subtype: 'html', params: [['charset', 'a"b,c']], q: 0.5 },
			{ type: '*', subtype: '*', params: [], q: 0 },
		])
	})

	it.each([
		['a parameter without a value', 'text/html;charset='],
		['a value that is no token', 'text/html;x=a/b'],
		['a space before "="', 'text/html;charset =utf-8'],
		['a space after "="', 'text/html;charset= utf-8'],
		['a parameter without "="', 'text/html;charset'],
		['a name that is no token', 'text/html;ch(arset=utf-8'],
		['a type that is no token', 'te xt/html'],
		['no subtype', 'text/'],
		['Unicode whitespace around the type', '\u00a0text/html'],
		['an unterminated quote', 'text/html;charset="utf-8'],
	])('leaves out a range with %s', (_name, accept) => {
		expect(parseAccept(`application/json, ${accept}`)).toEqual([
			{ type: 'application', subtype: 'json', params: [], q: 1 },
		])
	})

	it('takes the q of the most specific matching range', () => {
		expect(quality(parseAccept('*/*;q=0.1, text/*;q=0.2, text/html;q=0.3, text/html;charset=utf-8;q=0.4'), HTML)).toBe(
			0.4
		)
		expect(quality(parseAccept('*/*;q=0.1, text/*;q=0.2'), HTML)).toBe(0.2)
		expect(quality(parseAccept('application/json'), HTML)).toBe(0)
	})

	it.each([
		['/nope', false],
		['/@alice/nope', false],
		['/oauth/authorize', false],
		['/oauth/token', true],
		['/oauth/token/info', true],
		['/api/v1/nope', true],
		['/admin', true],
		['/ap/users/alice/outbox', true],
		['/actor', true],
		['/inbox', true],
		['/users/alice', true],
		['/emojis/1', true],
		['/nodeinfo/2.0', true],
		['/media/r/t/f.png', true],
		['/assets/x.css', true],
		['/health', true],
		['/.well-known/nope', true],
	])('%s is a document path: %s', (path, expected) => {
		expect(documentPath(path)).toBe(expected)
	})
})

describe('404', () => {
	it('answers a browser the ordinary 404 page and headers, reading nothing of the Store', async () => {
		const counted = countingStore(await migratedStore())
		const { request } = harness(counted.stub)
		const response = await request('/nope', { headers: { accept: BROWSER } })
		expect(response.status).toBe(404)
		expect(Object.fromEntries(response.headers)).toEqual(PUBLIC_PAGE_HEADERS)
		const html = await response.text()
		expectPage(html, 'Not found')
		expect(html).toContain('The page you are looking for is not here.')
		expect(counted.calls).toEqual([])
		const head = await request('/nope', { method: 'HEAD', headers: { accept: BROWSER } })
		expect([head.status, head.headers.get('content-type'), await head.text()]).toEqual([
			404,
			'text/html; charset=UTF-8',
			'',
		])
	})

	it.each<[string, string, string, string | undefined, Bytes]>([
		// Negotiated: the plain variant varies with Accept too.
		['no Accept', 'GET', '/nope', undefined, plain404(VARY)],
		['a JSON Accept', 'GET', '/nope', 'application/json', plain404(VARY)],
		['any type', 'HEAD', '/nope', '*/*', { ...plain404(VARY), body: '' }],
		// Not negotiated: today's bytes.
		['a POST', 'POST', '/nope', BROWSER, plain404()],
		['ActivityPub', 'GET', '/ap/nope', BROWSER, plain404()],
		['the instance actor', 'GET', '/actor/nope', BROWSER, plain404()],
		['emoji', 'GET', '/emojis/1/nope', BROWSER, plain404()],
		['assets', 'GET', '/assets/nope.css', BROWSER, plain404()],
		['legacy users', 'GET', '/users/alice', BROWSER, plain404()],
		['an inbox', 'GET', '/inbox', BROWSER, plain404()],
		['media', 'GET', '/media/nope', BROWSER, plain404()],
		['NodeInfo', 'GET', '/nodeinfo/nope', BROWSER, plain404(DOCUMENT_CORS)],
		['well-known', 'GET', '/.well-known/nope', BROWSER, plain404(DOCUMENT_CORS)],
		['an OAuth endpoint', 'GET', '/oauth/nope', BROWSER, plain404()],
		['health', 'GET', '/health/nope', BROWSER, plain404()],
		[
			'the API',
			'GET',
			'/api/v1/nope',
			BROWSER,
			{
				status: 404,
				headers: { 'content-type': 'application/json', ...API_CORS, ...NOSNIFF },
				body: '{"error":"Record not found"}',
			},
		],
	])('keeps the plain answer for %s', async (_name, method, path, accept, expected) => {
		const h = await apiHarness()
		expect(await bytesOf(await h.request(path, init(method, accept)))).toEqual(expected)
	})
})

// Each row's Store fails at the route's first call, so the answer is onError's (the Store was reached), or, for a path
// no route serves, notFound's (the Store was not).
// Each is a GET: a name, the path, the Accept and the answer.
type FailureRow = [string, string, string | undefined, Bytes]

const FAILURES: [string, () => Error, (extra?: Record<string, string>) => Bytes, string][] = [
	['503', () => new StoreUnavailableError('transient'), json503, 'Under maintenance'],
	['500', () => new Error('boom <secret>'), json500, 'Something went wrong'],
]

for (const [status, error, document, title] of FAILURES) {
	describe(status, () => {
		it('answers a page route a browser asks for an HTML page, never kept, without another Store call', async () => {
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
			try {
				for (const path of ['/about', '/oauth/authorize', '/settings', '/@alice', '/tags/walks']) {
					const failing = failingStore(error)
					const response = await harness(failing.stub).request(path, { headers: { accept: BROWSER } })
					expect(response.status, path).toBe(Number(status))
					expect(Object.fromEntries(response.headers), path).toEqual(
						status === '503' ? UNAVAILABLE_PAGE_HEADERS : ERROR_PAGE_HEADERS
					)
					const html = await response.text()
					expectPage(html, title)
					expect(html).not.toContain('boom')
					// The route's own call alone: the page reads nothing.
					expect(failing.calls, path).toHaveLength(1)
				}
			} finally {
				logged.mockRestore()
			}
		})

		it.each<FailureRow>([
			// Negotiated (a page route): the API's answer, varying with Accept.
			['no Accept', '/about', undefined, document(VARY)],
			['a JSON Accept', '/about', 'application/json', document(VARY)],
			['ActivityPub on a profile', '/@alice', 'application/activity+json', document(VARY)],
			[
				'HTML refused by its charset',
				'/about',
				'text/html;charset=utf-8;q=0, text/html, application/json;q=0.5',
				document(VARY),
			],
			['Unicode whitespace before the type', '/about', '\u00a0text/html, application/json;q=0.5', document(VARY)],
			['a wildcard of another charset', '/about', 'text/*;charset=iso-8859-1, application/json;q=0.5', document(VARY)],
			// Not negotiated: today's bytes.
			['an actor outbox', '/ap/users/alice/outbox', BROWSER, document()],
			['the instance actor outbox', '/actor/outbox', BROWSER, document()],
			['an emoji', '/emojis/1', BROWSER, document()],
			['the API', '/api/v1/instance', BROWSER, document(API_CORS)],
		])('keeps the API answer for %s', async (_name, path, accept, expected) => {
			const failing = failingStore(error)
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
			try {
				const response = await harness(failing.stub).request(path, init('GET', accept))
				expect(await bytesOf(response)).toEqual(expected)
				expect(failing.calls.length, 'the route reached the Store').toBeGreaterThan(0)
			} finally {
				logged.mockRestore()
			}
		})

		it('keeps an inbox POST’s answer (spooled when unavailable)', async () => {
			const failing = failingStore(error)
			const h = harness(failing.stub)
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
			try {
				const response = await h.request(
					'/inbox',
					init('POST', BROWSER, { 'content-type': 'application/activity+json' }, '{"type":"Follow"}')
				)
				expect(await bytesOf(response)).toEqual(
					status === '503' ? { status: 202, headers: NOSNIFF, body: '' } : document()
				)
				expect(failing.calls[0]).toBe('inboxGate')
			} finally {
				logged.mockRestore()
			}
		})

		it('keeps a POST to a page route its 404', async () => {
			const failing = failingStore(error)
			const response = await harness(failing.stub).request('/settings', init('POST', BROWSER))
			expect(await bytesOf(response)).toEqual(plain404())
			expect(failing.calls).toEqual([])
		})
	})
}

describe('500', () => {
	it('logs the failure as before', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await harness(failingStore(() => new Error('boom')).stub).request('/about', { headers: { accept: BROWSER } })
			expect(logged).toHaveBeenCalledWith(
				expect.objectContaining({ event: 'kopje.error', method: 'GET', route: '/about', status: 500 })
			)
		} finally {
			logged.mockRestore()
		}
	})
})

// The admin API (its own JSON errors, admin.onError) is no page, under any Accept, and the env's maintenance never
// gates it.
describe('the admin API', () => {
	it.each<[string, () => Error, Bytes]>([
		[
			'unavailable',
			() => new StoreUnavailableError('transient'),
			{
				status: 503,
				headers: { 'content-type': 'application/json', ...NOSNIFF },
				body: '{"error":"store unavailable: transient","code":"transient"}',
			},
		],
		[
			'failing',
			() => new Error('boom'),
			{
				status: 500,
				headers: { 'content-type': 'application/json', ...NOSNIFF },
				body: '{"error":"boom","code":"internal"}',
			},
		],
	])('keeps its JSON for an authenticated request when the Store is %s', async (_name, error, expected) => {
		const team = await adminTeam()
		const store = await migratedStore()
		await setTeamAccess(store, team)
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const { as } = adminHarness(storeWith(store, { capacity: () => Promise.reject(error()) }), team)
			// Authenticated: the same request reaches its handler, the one Store call that fails.
			expect((await as(adminClaims(), '/admin/version', { headers: { accept: BROWSER } })).status).toBe(200)
			const response = await as(adminClaims(), '/admin/capacity', { headers: { accept: BROWSER } })
			expect(await bytesOf(response)).toEqual(expected)
		} finally {
			logged.mockRestore()
		}
	})

	it('keeps its JSON under the env’s maintenance', async () => {
		const team = await adminTeam()
		const store = await migratedStore()
		await setTeamAccess(store, team)
		const { as } = adminHarness(store, team, { MAINTENANCE: 'full' })
		const response = await as(adminClaims(), '/admin/version', { headers: { accept: BROWSER } })
		expect(await bytesOf(response)).toEqual({
			status: 200,
			headers: { 'content-type': 'application/json', ...NOSNIFF },
			// The handler's own answer, the Store's version as it reports it.
			body: JSON.stringify({ worker: { build: BUILD }, store: await store.version(BUILD) }),
		})
	})
})

describe('the env’s maintenance', () => {
	it.each<[string, string, string | undefined, Bytes | 'page']>([
		['a browser on a page route', '/about', BROWSER, 'page'],
		['no Accept on a page route', '/about', undefined, json503(VARY)],
		['the API', '/api/v1/instance', BROWSER, json503(API_CORS)],
		['an actor outbox', '/ap/users/alice/outbox', BROWSER, json503()],
	])('answers %s', async (_name, path, accept, expected) => {
		const failing = failingStore(() => new Error('unreached'))
		const response = await harness(failing.stub, { MAINTENANCE: 'full' }).request(path, init('GET', accept))
		if (expected === 'page') {
			expect(response.status).toBe(503)
			expect(Object.fromEntries(response.headers)).toEqual(UNAVAILABLE_PAGE_HEADERS)
			expectPage(await response.text(), 'Under maintenance')
		} else {
			expect(await bytesOf(response)).toEqual(expected)
		}
		// The gate answered: no route ran.
		expect(failing.calls).toEqual([])
	})
})
