import { describe, expect, it, vi } from 'vitest'

import { countingStore, harness } from './app-helpers'
import { migratedStore } from './helpers'
import { PRIVATE_PAGE_HEADERS, PUBLIC_PAGE_HEADERS, UNAVAILABLE_PAGE_HEADERS } from '../browser/headers'
import { pageRequest } from '../src/app/negotiation'
import type { StoreStub } from '../src/platform/store-client'
import { StoreUnavailableError } from '../src/platform/store-errors'
import { STYLESHEET } from '../src/web/asset-versions'

// The error pages of app.ts: a browser's page request (pageRequest) gets an HTML 404, 500 or 503 rendered without the
// Store; every other request keeps the API's answer, byte for byte.

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'

// Requests that are not a browser's page request, each refused by one guard of pageRequest, beside the same request
// with no Accept, whose answer pageRequest never changes.
const NOT_PAGES: [string, string, RequestInit][] = [
	['a POST', '/about', { method: 'POST', headers: { accept: BROWSER } }],
	['a JSON Accept', '/about', { headers: { accept: 'application/json' } }],
	['any type', '/about', { headers: { accept: '*/*' } }],
	['HTML less preferred than JSON', '/about', { headers: { accept: 'application/json, text/html;q=0.5' } }],
	['HTML refused', '/about', { headers: { accept: 'text/html;q=0, */*' } }],
	['an ActivityPub Accept naming HTML too', '/about', { headers: { accept: 'text/html, application/activity+json' } }],
	['an API path', '/api/v1/instance', { headers: { accept: BROWSER } }],
	['the admin API', '/admin/nope', { headers: { accept: BROWSER } }],
	['an OAuth endpoint', '/oauth/nope', { headers: { accept: BROWSER } }],
	['a well-known path', '/.well-known/nope', { headers: { accept: BROWSER } }],
	['NodeInfo', '/nodeinfo/nope', { headers: { accept: BROWSER } }],
	['an inbox', '/ap/users/alice/inbox', { headers: { accept: BROWSER } }],
	['media', '/media/nope', { headers: { accept: BROWSER } }],
]

function withoutAccept(init: RequestInit): RequestInit {
	const headers = new Headers(init.headers)
	headers.delete('accept')
	return { ...init, headers }
}

async function bytesOf(response: Response) {
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

function expectPage(html: string, title: string) {
	expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true)
	expect(html).toContain(`<title>${title}</title>`)
	expect(html).toContain(`<link rel="stylesheet" href="${STYLESHEET}"/>`)
	expect(html).not.toContain('<script')
}

describe('a browser page request', () => {
	it.each([
		['GET', '/about', BROWSER, true],
		['HEAD', '/about', BROWSER, true],
		['GET', '/oauth/authorize', BROWSER, true],
		['GET', '/@alice', 'text/html', true],
		['GET', '/about', 'application/xhtml+xml, text/html', true],
		['POST', '/about', BROWSER, false],
		['GET', '/about', undefined, false],
		['GET', '/about', 'application/json', false],
		['GET', '/about', '*/*', false],
		['GET', '/about', 'application/json, text/html;q=0.5', false],
		['GET', '/about', 'text/html;q=0', false],
		['GET', '/@alice', 'text/html, application/ld+json', false],
		['GET', '/api/v1/instance', BROWSER, false],
		['GET', '/admin', BROWSER, false],
		['GET', '/oauth/token', BROWSER, false],
		['GET', '/oauth/revoke', BROWSER, false],
		['GET', '/oauth/userinfo', BROWSER, false],
		['GET', '/oauth/token/info', BROWSER, false],
		['GET', '/.well-known/webfinger', BROWSER, false],
		['GET', '/nodeinfo/2.0', BROWSER, false],
		['GET', '/inbox', BROWSER, false],
		['GET', '/actor/inbox', BROWSER, false],
		['GET', '/ap/users/alice/inbox', BROWSER, false],
		['GET', '/media/r/t/f.png', BROWSER, false],
	])('%s %s with Accept %s: %s', (method, path, accept, expected) => {
		expect(pageRequest(method, path, accept)).toBe(expected)
	})
})

describe('404', () => {
	it('answers a page request the ordinary 404 page and headers, reading nothing of the Store', async () => {
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

	it('keeps the plain answer for every other request', async () => {
		const { request } = harness(await migratedStore())
		const plain = await bytesOf(await request('/nope'))
		expect(plain).toEqual({
			status: 404,
			headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-content-type-options': 'nosniff' },
			body: 'Not Found',
		})
		for (const [name, served, init] of NOT_PAGES) {
			// A path no route serves, so that each reaches app.notFound.
			const path = served === '/about' ? '/nope' : served
			expect(await bytesOf(await request(path, init)), name).toEqual(
				await bytesOf(await request(path, withoutAccept(init)))
			)
		}
		expect(await bytesOf(await request('/nope', { headers: { accept: 'application/json' } }))).toEqual(plain)
		const api = await request('/api/v1/nope', { headers: { accept: BROWSER } })
		expect([api.status, await api.text()]).toEqual([404, '{"error":"Record not found"}'])
	})
})

describe('503', () => {
	const unavailable = () => failingStore(() => new StoreUnavailableError('transient'))

	it('answers a page request an HTML page with the same Retry-After, never kept, without another Store call', async () => {
		const failing = unavailable()
		const { request } = harness(failing.stub)
		const response = await request('/about', { headers: { accept: BROWSER } })
		expect(response.status).toBe(503)
		expect(Object.fromEntries(response.headers)).toEqual(UNAVAILABLE_PAGE_HEADERS)
		const html = await response.text()
		expectPage(html, 'Under maintenance')
		// The route's own call alone: the page reads nothing.
		expect(failing.calls).toEqual(['webAbout'])
	})

	it('keeps the API answer for every other request', async () => {
		const { request } = harness(unavailable().stub)
		const json = await bytesOf(await request('/about'))
		expect(json).toEqual({
			status: 503,
			headers: {
				'content-type': 'application/json',
				'retry-after': '600',
				'x-content-type-options': 'nosniff',
			},
			body: '{"error":"This server is under maintenance. Try again later."}',
		})
		for (const [name, path, init] of NOT_PAGES) {
			expect(await bytesOf(await request(path, init)), name).toEqual(
				await bytesOf(await request(path, withoutAccept(init)))
			)
		}
		// The control: the same path and Accept as a page request is answered the page.
		expect((await request('/api/v1/instance', { headers: { accept: BROWSER } })).headers.get('content-type')).toBe(
			'application/json'
		)
		expect((await request('/about', { headers: { accept: BROWSER } })).headers.get('content-type')).toBe(
			'text/html; charset=UTF-8'
		)
	})
})

describe('500', () => {
	const broken = () => failingStore(() => new Error('boom <secret>'))

	it('answers a page request an HTML page without the error, logged as before, without another Store call', async () => {
		const failing = broken()
		const { request } = harness(failing.stub)
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await request('/about', { headers: { accept: BROWSER } })
			expect(response.status).toBe(500)
			expect(Object.fromEntries(response.headers)).toEqual(PRIVATE_PAGE_HEADERS)
			const html = await response.text()
			expectPage(html, 'Something went wrong')
			expect(html).not.toContain('boom')
			expect(failing.calls).toEqual(['webAbout'])
			expect(logged).toHaveBeenCalledWith(
				expect.objectContaining({ event: 'kopje.error', method: 'GET', route: '/about', status: 500 })
			)
		} finally {
			logged.mockRestore()
		}
	})

	it('keeps the API answer for every other request', async () => {
		const { request } = harness(broken().stub)
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const json = await bytesOf(await request('/about'))
			expect(json).toEqual({
				status: 500,
				headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' },
				body: '{"error":"Internal Server Error"}',
			})
			for (const [name, path, init] of NOT_PAGES) {
				expect(await bytesOf(await request(path, init)), name).toEqual(
					await bytesOf(await request(path, withoutAccept(init)))
				)
			}
		} finally {
			logged.mockRestore()
		}
	})
})
