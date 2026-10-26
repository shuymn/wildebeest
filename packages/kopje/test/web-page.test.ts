import { describe, expect, it } from 'vitest'

import { trackedStream } from './stream-helpers'
import {
	createWebPageSink,
	fetchWebImage,
	fetchWebJson,
	fetchWebMedia,
	fetchWebPage,
	HOP_SUBREQUESTS,
	probeRedirect,
	REDIRECT_PROBE_MAX_STORE_CALLS,
	REDIRECT_PROBE_MAX_SUBREQUESTS,
	streamWebMedia,
	WEB_JSON_BODY_LIMIT,
	WEB_MEDIA_TIMEOUT_MS,
	WEB_PAGE_BODY_LIMIT,
	WEB_PAGE_MAX_REDIRECTS,
	WEB_PAGE_MAX_STORE_CALLS,
	WEB_PAGE_MAX_SUBREQUESTS,
	WEB_PAGE_PAIR_MAX_STORE_CALLS,
	WEB_PAGE_PAIR_MAX_SUBREQUESTS,
	WEB_PAGE_URL_LIMIT,
	type WebImage,
	type WebJson,
	type WebMedia,
	type WebMediaStream,
	type WebPage,
	type WebPageBudget,
	type WebPageDeps,
	type WebPageFailure,
	webPageUrlRefusal,
} from '../src/federation/web-page'
import { createScanner } from '../src/platform/html-scan'
import { MAX_JSON_DEPTH, MAX_JSON_NODES } from '../src/platform/json-bounds'

const PAGE = 'https://site.example/profile'
const HTML = { 'content-type': 'text/html; charset=utf-8' }
const BODY = '<title>Site</title><a rel="me" href="https://actor.example/u/a">me</a>'

type Route = (request: Request) => Response | Promise<Response>

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

// Deps over a route table that log every step in order: the domain policy, the DNS check and each request.
function fakeDeps(routes: Record<string, Route>, extra: Partial<WebPageDeps> = {}) {
	const log: string[] = []
	const requests: Request[] = []
	const deps: WebPageDeps = {
		fetch: (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : new Request(input, init)
			requests.push(request)
			log.push(`fetch ${request.method} ${request.url}`)
			const route = routes[request.url]
			return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route(request))
		},
		checkHost: (url) => {
			log.push(`dns ${url.hostname}`)
			return Promise.resolve()
		},
		refusesHost: (host) => {
			log.push(`policy ${host}`)
			return Promise.resolve(false)
		},
		userAgent: 'Kopje/test',
		now: () => Date.now(),
		...extra,
	}
	return { deps, log, requests }
}

const html =
	(body = BODY, headers: Record<string, string> = HTML) =>
	() =>
		new Response(body, { headers })
const redirect =
	(location: string, status = 302) =>
	() =>
		new Response(null, { status, headers: { location } })

function page(result: WebPage | WebPageFailure): WebPage {
	if (!result.ok) {
		throw new Error(`failed: ${JSON.stringify(result)}`)
	}
	return result
}

function failure(result: WebPage | WebPageFailure | { ok: true }): WebPageFailure {
	if (result.ok) {
		throw new Error('expected a failure')
	}
	return result
}

describe('web page sink', () => {
	it('fetches and scans a public page', async () => {
		const { deps } = fakeDeps({ [PAGE]: html() })
		const result = page(await fetchWebPage(`${PAGE}#fragment`, deps))
		expect(result).toMatchObject({
			finalUrl: PAGE,
			redirects: 0,
			status: 200,
			contentType: 'text/html',
			charset: { label: 'utf-8', source: 'header' },
			limitReached: false,
			cost: { subrequests: HOP_SUBREQUESTS, storeCalls: 1, hops: 1 },
		})
		expect(result.scan).toMatchObject({ title: 'Site', relMe: ['https://actor.example/u/a'] })
	})

	it('derives its budgets from the hop count', () => {
		expect(WEB_PAGE_MAX_SUBREQUESTS).toBe(12)
		expect(WEB_PAGE_MAX_STORE_CALLS).toBe(4)
		expect(REDIRECT_PROBE_MAX_SUBREQUESTS).toBe(3)
		expect(REDIRECT_PROBE_MAX_STORE_CALLS).toBe(1)
		expect(WEB_PAGE_PAIR_MAX_SUBREQUESTS).toBe(15)
		expect(WEB_PAGE_PAIR_MAX_STORE_CALLS).toBe(5)
	})

	it.each([
		['not a URL', 'invalid-url'],
		['http://site.example/', 'scheme'],
		['https://user:pass@site.example/', 'credentials'],
		['https://127.0.0.1/', 'ip-literal'],
		['https://2130706433/', 'ip-literal'],
		['https://[::1]/', 'ip-literal'],
		['https://localhost/', 'local-host'],
		['https://a.localhost/', 'local-host'],
		['https://intranet/', 'local-host'],
		['https://site.example:8443/', 'port'],
		['https://site.example./', 'trailing-dot'],
		[`https://site.example/${'a'.repeat(WEB_PAGE_URL_LIMIT)}`, 'url-too-long'],
	])('NET-3: refuses web page URLs that fail the public-host rules before any request (%s)', async (url, reason) => {
		expect(webPageUrlRefusal(url)).toBe(reason)
		const { deps, log } = fakeDeps({})
		expect(failure(await fetchWebPage(url, deps))).toMatchObject({ kind: 'refused', reason, transient: false })
		expect(failure(await probeRedirect(url, deps))).toMatchObject({ kind: 'refused', reason })
		expect(log).toEqual([])
	})

	it('keeps the default port and a long fragment', () => {
		expect(webPageUrlRefusal('https://site.example:443/')).toBeNull()
		expect(webPageUrlRefusal(`https://site.example/#${'f'.repeat(WEB_PAGE_URL_LIMIT)}`)).toBeNull()
	})

	it('NET-3: reads the domain policy and the DNS check before every hop, the HEAD probe included', async () => {
		const { deps, log } = fakeDeps({
			[PAGE]: redirect('https://other.example/next'),
			'https://other.example/next': html(),
			'https://probe.example/': redirect('/elsewhere'),
		})
		page(await fetchWebPage(PAGE, deps))
		expect(log).toEqual([
			'policy site.example',
			'dns site.example',
			`fetch GET ${PAGE}`,
			'policy other.example',
			'dns other.example',
			'fetch GET https://other.example/next',
		])
		log.length = 0
		await probeRedirect('https://probe.example/', deps)
		expect(log).toEqual(['policy probe.example', 'dns probe.example', 'fetch HEAD https://probe.example/'])
	})

	it('refuses a blocked host or one the DNS check refuses, the redirect target included', async () => {
		const blocked = fakeDeps(
			{ [PAGE]: redirect('https://blocked.example/') },
			{ refusesHost: (host) => Promise.resolve(host === 'blocked.example') }
		)
		expect(failure(await fetchWebPage(PAGE, blocked.deps))).toMatchObject({
			kind: 'blocked',
			host: 'blocked.example',
			transient: false,
		})
		expect(blocked.requests.map((r) => r.url)).toEqual([PAGE])
		const privateHost = fakeDeps({}, { checkHost: () => Promise.reject(new Error('private address')) })
		expect(failure(await fetchWebPage(PAGE, privateHost.deps))).toMatchObject({
			kind: 'refused',
			reason: 'host-check',
			transient: true,
		})
		expect(failure(await probeRedirect(PAGE, privateHost.deps))).toMatchObject({ reason: 'host-check' })
		expect(privateHost.requests).toHaveLength(0)
	})

	it('NET-3: follows at most 3 redirects across origins, each hop re-checked and charged', async () => {
		const chain = (length: number): Record<string, Route> => {
			const routes: Record<string, Route> = {}
			for (let i = 0; i < length; i++) {
				routes[`https://h${i}.example/`] = redirect(`https://h${i + 1}.example/`, [301, 302, 303, 307, 308][i % 5])
			}
			routes[`https://h${length}.example/`] = html()
			return routes
		}
		const ok = fakeDeps(chain(WEB_PAGE_MAX_REDIRECTS))
		expect(page(await fetchWebPage('https://h0.example/', ok.deps))).toMatchObject({
			finalUrl: 'https://h3.example/',
			redirects: 3,
			cost: { subrequests: WEB_PAGE_MAX_SUBREQUESTS, storeCalls: WEB_PAGE_MAX_STORE_CALLS, hops: 4 },
		})
		expect(ok.log.filter((line) => line.startsWith('dns'))).toHaveLength(4)
		const tooMany = fakeDeps(chain(WEB_PAGE_MAX_REDIRECTS + 1))
		expect(failure(await fetchWebPage('https://h0.example/', tooMany.deps))).toMatchObject({
			kind: 'redirects',
			host: 'h3.example',
			cost: { hops: 4 },
		})
		expect(tooMany.requests).toHaveLength(4)
		const capped = fakeDeps(chain(2))
		expect(failure(await fetchWebPage('https://h0.example/', capped.deps, { maxRedirects: 1 }))).toMatchObject({
			kind: 'redirects',
		})
		const notLoosened = fakeDeps(chain(4))
		expect(failure(await fetchWebPage('https://h0.example/', notLoosened.deps, { maxRedirects: 10 }))).toMatchObject({
			kind: 'redirects',
		})
	})

	it.each([
		['http://site.example/x', 'scheme'],
		['https://10.0.0.1/', 'ip-literal'],
		['https://localhost/', 'local-host'],
		['https://site.example:8080/', 'port'],
		['https://site.example./', 'trailing-dot'],
		['https://user@site.example/', 'credentials'],
		['https://[', 'bad-location'],
		[`/${'a'.repeat(WEB_PAGE_URL_LIMIT)}`, 'bad-location'],
	])('NET-3: never requests a redirect target that is not public https (%s)', async (location, reason) => {
		const { deps, requests } = fakeDeps({ [PAGE]: redirect(location) })
		expect(failure(await fetchWebPage(PAGE, deps))).toMatchObject({ kind: 'refused', reason })
		expect(requests.map((r) => r.url)).toEqual([PAGE])
	})

	it('NET-3: sends only the allowlisted headers and never lets fetch follow', async () => {
		const { deps, requests } = fakeDeps({ [PAGE]: html() })
		page(await fetchWebPage(PAGE, deps))
		page(await fetchWebPage(PAGE, deps, { acceptLanguage: 'ja, *;q=0.5' }))
		await probeRedirect(PAGE, deps)
		const [plain, localized, head] = requests
		expect([...(plain?.headers ?? [])]).toEqual([
			['accept', 'text/html'],
			['user-agent', 'Kopje/test'],
		])
		expect(localized?.headers.get('accept-language')).toBe('ja, *;q=0.5')
		expect([...(head?.headers ?? [])].map(([name]) => name)).toEqual(['accept', 'user-agent'])
		for (const request of requests) {
			expect(request.redirect).toBe('manual')
			expect(request.body).toBeNull()
		}
		expect(head?.method).toBe('HEAD')
		for (const bad of ['ja\r\nx-evil: 1', 'a'.repeat(129), 'ja,en,fr,de,es,it,pt,nl,sv', '']) {
			await expect(fetchWebPage(PAGE, deps, { acceptLanguage: bad })).rejects.toThrow(TypeError)
		}
		expect(requests).toHaveLength(3)
	})

	it('refuses a response whose URL is not the one requested (a fetch that followed)', async () => {
		const { deps } = fakeDeps({
			[PAGE]: () => {
				const response = new Response(BODY, { headers: HTML })
				Object.defineProperty(response, 'url', { value: 'https://elsewhere.example/' })
				return response
			},
		})
		expect(failure(await fetchWebPage(PAGE, deps))).toMatchObject({ kind: 'refused', reason: 'unexpected-redirect' })
	})

	it('NET-3: counts decoded bytes, stops past the cap and cancels the body', async () => {
		const chunk = new TextEncoder().encode(`${BODY}${' '.repeat(64 * 1024 - BODY.length)}`)
		const { stream: body, state } = trackedStream(Array.from({ length: 64 }, () => chunk))
		// A Content-Length that understates the body is never consulted.
		const { deps } = fakeDeps({ [PAGE]: () => new Response(body, { headers: { ...HTML, 'content-length': '10' } }) })
		const result = page(await fetchWebPage(PAGE, deps))
		expect(result.limitReached).toBe(true)
		expect(result.cost.bytes).toBe(WEB_PAGE_BODY_LIMIT + 1)
		// One rel=me in each 64 KiB chunk of the prefix.
		expect(result.scan.relMe).toHaveLength(WEB_PAGE_BODY_LIMIT / chunk.byteLength)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(state.cancelled).toBe(true)
		expect(state.pullsAfterCancel).toBe(0)
		const small = fakeDeps({ [PAGE]: html() })
		expect(page(await fetchWebPage(PAGE, small.deps, { maxBytes: 20 }))).toMatchObject({
			limitReached: true,
			cost: { bytes: 21 },
			scan: { title: 'Site', relMe: [] },
		})
		const loosened = fakeDeps({ [PAGE]: html() })
		expect(page(await fetchWebPage(PAGE, loosened.deps, { maxBytes: 10 * WEB_PAGE_BODY_LIMIT })).limitReached).toBe(
			false
		)
	})

	it('NET-3: ends the whole call at its deadline, a stalled DNS check or body included', async () => {
		const never = () => new Promise<never>(() => {})
		const dns = fakeDeps({}, { checkHost: never })
		const started = Date.now()
		expect(failure(await fetchWebPage(PAGE, dns.deps, { timeoutMs: 50 }))).toMatchObject({
			kind: 'timeout',
			transient: true,
		})
		expect(dns.requests).toHaveLength(0)
		const policy = fakeDeps({}, { refusesHost: never })
		expect(failure(await probeRedirect(PAGE, policy.deps, { timeoutMs: 50 }))).toMatchObject({ kind: 'timeout' })
		const stalled = trackedStream([new TextEncoder().encode(BODY)], true)
		const body = fakeDeps({ [PAGE]: () => new Response(stalled.stream, { headers: HTML }) })
		expect(failure(await fetchWebPage(PAGE, body.deps, { timeoutMs: 50 }))).toMatchObject({ kind: 'timeout' })
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(stalled.state.cancelled).toBe(true)
		const fetchStall = fakeDeps({ [PAGE]: never })
		expect(failure(await fetchWebPage(PAGE, fetchStall.deps, { deadline: Date.now() + 50 }))).toMatchObject({
			kind: 'timeout',
		})
		expect(fetchStall.requests[0]?.signal.aborted).toBe(true)
		expect(Date.now() - started).toBeLessThan(2000)
	})

	it('NET-3: a domain-policy answer after the deadline starts nothing', async () => {
		let clock = 1_000_000
		const answer = deferred<boolean>()
		const { deps, log } = fakeDeps({ [PAGE]: html() }, { now: () => clock, refusesHost: () => answer.promise })
		const running = fetchWebPage(PAGE, deps, { timeoutMs: 5_000 })
		await Promise.resolve()
		// The clock passes the deadline while the policy is read; the timer has not fired yet.
		clock += 5_000
		answer.resolve(false)
		expect(failure(await running)).toMatchObject({ kind: 'timeout', cost: { storeCalls: 1, subrequests: 0 } })
		expect(log).toEqual([])
	})

	it('NET-3: charges DNS lookups, requests and Store calls against a shared budget without overspending', async () => {
		// Two calls share a budget for one hop and a half: the first holds at its policy read while the second spends.
		const budget: WebPageBudget = { subrequests: HOP_SUBREQUESTS + 2, storeCalls: 2, deadline: Date.now() + 10_000 }
		const gate = deferred<boolean>()
		let first = true
		const { deps, requests } = fakeDeps(
			{ [PAGE]: html(), 'https://two.example/': html() },
			{
				refusesHost: () => {
					if (first) {
						first = false
						return gate.promise
					}
					return Promise.resolve(false)
				},
			}
		)
		const held = fetchWebPage(PAGE, deps, { budget })
		const second = page(await fetchWebPage('https://two.example/', deps, { budget }))
		expect(second.cost).toMatchObject({ subrequests: HOP_SUBREQUESTS, storeCalls: 1 })
		gate.resolve(false)
		expect(failure(await held)).toMatchObject({
			kind: 'budget',
			transient: true,
			cost: { subrequests: 2, storeCalls: 1 },
		})
		expect(budget).toMatchObject({ subrequests: 0, storeCalls: 0 })
		expect(requests.map((r) => r.url)).toEqual(['https://two.example/'])

		// Under a large shared budget, one call still stops at its own ceiling, and spends from the budget only that.
		const large: WebPageBudget = { subrequests: 1000, storeCalls: 1000, deadline: Date.now() + 10_000 }
		const loop = fakeDeps({ [PAGE]: redirect(PAGE) })
		expect(failure(await fetchWebPage(PAGE, loop.deps, { budget: large }))).toMatchObject({ kind: 'redirects' })
		expect(large).toMatchObject({
			subrequests: 1000 - WEB_PAGE_MAX_SUBREQUESTS,
			storeCalls: 1000 - WEB_PAGE_MAX_STORE_CALLS,
		})

		// No refund: a call that times out in its DNS check keeps what it was charged.
		const kept: WebPageBudget = { subrequests: 100, storeCalls: 100, deadline: Date.now() + 10_000 }
		const slow = fakeDeps({}, { checkHost: () => new Promise<never>(() => {}) })
		expect(failure(await fetchWebPage(PAGE, slow.deps, { budget: kept, timeoutMs: 30 }))).toMatchObject({
			kind: 'timeout',
		})
		expect(kept).toMatchObject({ subrequests: 98, storeCalls: 99 })

		// A budget past its deadline starts nothing.
		const spent: WebPageBudget = { subrequests: 100, storeCalls: 100, deadline: Date.now() - 1 }
		const late = fakeDeps({})
		expect(failure(await fetchWebPage(PAGE, late.deps, { budget: spent }))).toMatchObject({ kind: 'timeout' })
		expect(late.log).toEqual([])
	})

	it('NET-3: the HEAD probe never follows and returns the raw Location whatever the status', async () => {
		const long = `/${'a'.repeat(WEB_PAGE_URL_LIMIT)}`
		const { deps, requests } = fakeDeps({
			'https://a.example/': redirect('/relative?x=1#f', 302),
			'https://b.example/': () => new Response(null, { status: 200, headers: { location: 'https://c.example/' } }),
			'https://c.example/': () =>
				new Response('gone', { status: 410, headers: { location: 'http://insecure.example/' } }),
			'https://d.example/': () => new Response(null, { status: 301 }),
			'https://e.example/': redirect(long),
		})
		expect(await probeRedirect('https://a.example/', deps)).toEqual({
			ok: true,
			status: 302,
			location: '/relative?x=1#f',
			cost: {
				subrequests: REDIRECT_PROBE_MAX_SUBREQUESTS,
				storeCalls: REDIRECT_PROBE_MAX_STORE_CALLS,
				hops: 1,
				bytes: 0,
			},
		})
		expect(await probeRedirect('https://b.example/', deps)).toMatchObject({
			status: 200,
			location: 'https://c.example/',
		})
		expect(await probeRedirect('https://c.example/', deps)).toMatchObject({
			status: 410,
			location: 'http://insecure.example/',
		})
		expect(await probeRedirect('https://d.example/', deps)).toMatchObject({ status: 301, location: null })
		expect(await probeRedirect('https://e.example/', deps)).toMatchObject({ status: 302, location: null })
		expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
			'HEAD https://a.example/',
			'HEAD https://b.example/',
			'HEAD https://c.example/',
			'HEAD https://d.example/',
			'HEAD https://e.example/',
		])
	})

	it('NET-3: scans only 200 text/html or application/xhtml+xml and cancels other bodies', async () => {
		const tracked: ReturnType<typeof trackedStream>[] = []
		const answer = (status: number, type: string) => () => {
			const body = trackedStream([new TextEncoder().encode(BODY)])
			tracked.push(body)
			return new Response(status === 204 || status === 304 ? null : body.stream, {
				status,
				headers: { 'content-type': type },
			})
		}
		const { deps } = fakeDeps({
			'https://a.example/': answer(404, 'text/html'),
			'https://b.example/': answer(503, 'text/html'),
			'https://c.example/': answer(200, 'image/png'),
			'https://d.example/': answer(200, 'application/xhtml+xml; charset=utf-8'),
			'https://e.example/': answer(200, 'text/plain'),
			'https://f.example/': answer(300, 'text/html'),
			'https://g.example/': answer(200, 'text/html, image/png'),
			'https://h.example/': answer(429, 'text/html'),
		})
		expect(failure(await fetchWebPage('https://a.example/', deps))).toMatchObject({
			kind: 'status',
			status: 404,
			transient: false,
		})
		expect(failure(await fetchWebPage('https://b.example/', deps))).toMatchObject({ status: 503, transient: true })
		expect(failure(await fetchWebPage('https://h.example/', deps))).toMatchObject({ status: 429, transient: true })
		expect(failure(await fetchWebPage('https://c.example/', deps))).toMatchObject({ kind: 'not-html' })
		expect(page(await fetchWebPage('https://d.example/', deps))).toMatchObject({ contentType: 'application/xhtml+xml' })
		expect(failure(await fetchWebPage('https://e.example/', deps))).toMatchObject({ kind: 'not-html' })
		expect(failure(await fetchWebPage('https://f.example/', deps))).toMatchObject({ kind: 'status', status: 300 })
		expect(failure(await fetchWebPage('https://g.example/', deps))).toMatchObject({ kind: 'not-html' })
		await new Promise((resolve) => setTimeout(resolve, 10))
		// In the order requested: a, b, h, c, d (read whole), e, f, g.
		expect(tracked.map((body) => body.state.cancelled)).toEqual([true, true, true, true, false, true, true, true])
	})

	it('refuses a Content-Encoding the runtime would not decode before reading the body', async () => {
		for (const encoding of ['deflate', 'zstd', 'GZIP', 'gzip,', 'gzip, gzip', 'gzip, br', 'compress', '']) {
			const tracked = trackedStream([new TextEncoder().encode(BODY)])
			const { deps } = fakeDeps({
				[PAGE]: () => new Response(tracked.stream, { headers: { ...HTML, 'content-encoding': encoding } }),
			})
			expect(failure(await fetchWebPage(PAGE, deps))).toMatchObject({
				kind: 'encoding',
				reason: 'unsupported-encoding',
			})
			await Promise.resolve()
			expect(tracked.state.cancelled).toBe(true)
		}
		const identity = fakeDeps({ [PAGE]: html(BODY, { ...HTML, 'content-encoding': 'identity' }) })
		page(await fetchWebPage(PAGE, identity.deps))
	})

	it('NET-3: an unparsable page is a failure with no partial scan', async () => {
		const { deps } = fakeDeps({
			[PAGE]: html('<a rel=me href="https://actor.example/u/a"></a><select><xmp><a rel=me href=y></xmp></select>'),
		})
		const result = failure(await fetchWebPage(PAGE, deps))
		expect(result).toEqual({
			ok: false,
			kind: 'unparsable',
			reason: 'ambiguity',
			host: 'site.example',
			transient: false,
			cost: expect.anything() as unknown,
		})
	})

	it('NET-3: a scan still pumping at the deadline returns timeout, publishes no scan and stops', async () => {
		const reached = deferred<undefined>()
		const held = deferred<undefined>()
		const pauses: number[] = []
		let settled: 'resolved' | 'rejected' | 'pending' = 'pending'
		const body = BODY.repeat(Math.ceil((4 * 64 * 1024) / BODY.length))
		const { deps } = fakeDeps({ [PAGE]: html(body) })
		// The real scanner, held before its second chunk until the call's deadline has passed.
		const heldScanner = createScanner(async (chunk) => {
			pauses.push(chunk)
			if (chunk === 1) {
				reached.resolve(undefined)
				await held.promise
			}
		})
		const sink = createWebPageSink({
			scan: (bytes, charset, limits, signal) => {
				const running = heldScanner(bytes, charset, limits, signal)
				running.then(
					() => (settled = 'resolved'),
					() => (settled = 'rejected')
				)
				return running
			},
		})
		const running = sink.fetchWebPage(PAGE, deps, { timeoutMs: 100 })
		await reached.promise
		const result = failure(await running)
		expect(result).toMatchObject({ kind: 'timeout' })
		expect(Object.keys(result)).not.toContain('scan')
		held.resolve(undefined)
		await new Promise((resolve) => setTimeout(resolve, 50))
		// The scan rejected with the abort and pulled no chunk after it.
		expect(settled).toBe('rejected')
		expect(pauses).toEqual([1])
	})

	it('cancels a response that arrives after the injected clock passed the deadline', async () => {
		let clock = 1_000_000
		const tracked = trackedStream([new TextEncoder().encode(BODY)])
		const { deps } = fakeDeps(
			{
				[PAGE]: () => {
					clock += 20_000
					return new Response(tracked.stream, { headers: HTML })
				},
			},
			{ now: () => clock }
		)
		expect(failure(await fetchWebPage(PAGE, deps))).toMatchObject({ kind: 'timeout' })
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(tracked.state.cancelled).toBe(true)
	})

	it('reports a domain policy that cannot be read as a redacted, transient failure', async () => {
		const { deps, log } = fakeDeps(
			{ [PAGE]: html() },
			{ refusesHost: () => Promise.reject(new Error('Store unavailable: https://site.example/private')) }
		)
		const result = failure(await fetchWebPage(PAGE, deps))
		expect(result).toEqual({
			ok: false,
			kind: 'policy',
			host: 'site.example',
			transient: true,
			cost: { subrequests: 0, storeCalls: 1, hops: 0, bytes: 0 },
		})
		expect(failure(await probeRedirect(PAGE, deps))).toMatchObject({ kind: 'policy' })
		expect(log).toEqual([])
		// A policy that rejects after the deadline is the deadline's failure.
		let clock = 1_000_000
		const late = fakeDeps(
			{},
			{
				now: () => clock,
				refusesHost: () => {
					clock += 20_000
					return Promise.reject(new Error('late'))
				},
			}
		)
		expect(failure(await fetchWebPage(PAGE, late.deps))).toMatchObject({ kind: 'timeout' })
	})

	it('NET-3: failures carry the host only', async () => {
		const secret = 'https://site.example/private/path?token=abc'
		const { deps } = fakeDeps({ [secret]: () => new Response('x', { status: 404, headers: { 'x-secret': 'abc' } }) })
		const result = failure(await fetchWebPage(secret, deps))
		expect(result).toMatchObject({ kind: 'status', host: 'site.example' })
		expect(JSON.stringify(result)).not.toMatch(/private|token|abc/)
		const network = fakeDeps({}, { fetch: () => Promise.reject(new Error(`failed to reach ${secret}`)) })
		const failed = failure(await fetchWebPage(secret, network.deps))
		expect(failed).toMatchObject({ kind: 'network', transient: true, host: 'site.example' })
		expect(JSON.stringify(failed)).not.toMatch(/private|token|abc|reach/)
		expect(failure(await fetchWebPage('https://user:pw@site.example/', deps)).host).toBeNull()
	})

	it('starts nothing for an aborted signal, and ends at an abort', async () => {
		const controller = new AbortController()
		controller.abort()
		const { deps, log } = fakeDeps({ [PAGE]: html() })
		expect(failure(await fetchWebPage(PAGE, deps, { signal: controller.signal }))).toMatchObject({
			kind: 'aborted',
			transient: false,
		})
		expect(log).toEqual([])
		const later = new AbortController()
		const stalled = fakeDeps({}, { checkHost: () => new Promise<never>(() => {}) })
		const running = fetchWebPage(PAGE, stalled.deps, { signal: later.signal })
		setTimeout(() => later.abort(), 10)
		expect(failure(await running)).toMatchObject({ kind: 'aborted' })
		expect(stalled.requests).toHaveLength(0)
	})
})

describe('web page sink: the JSON mode', () => {
	const ENDPOINT = 'https://site.example/oembed?url=x'
	const body =
		(text: BodyInit | null, headers: Record<string, string> = {}, status = 200) =>
		() =>
			new Response(text, { status, headers })
	const json = (result: WebJson | WebPageFailure): WebJson => {
		if (!result.ok) {
			throw new Error(`failed: ${JSON.stringify(result)}`)
		}
		return result
	}

	it('NET-3: parses a 200 of any content type, sending only the User-Agent', async () => {
		for (const type of [null, 'text/html', 'application/json+oembed', 'image/png']) {
			const { deps, requests } = fakeDeps({
				[ENDPOINT]: body('{"version":"1.0"}', type === null ? {} : { 'content-type': type }),
			})
			expect(json(await fetchWebJson(`${ENDPOINT}#f`, deps))).toEqual({
				ok: true,
				finalUrl: ENDPOINT,
				redirects: 0,
				status: 200,
				value: { version: '1.0' },
				cost: { subrequests: HOP_SUBREQUESTS, storeCalls: 1, hops: 1, bytes: 17 },
			})
			expect([...(requests[0]?.headers ?? [])]).toEqual([['user-agent', 'Kopje/test']])
			expect(requests[0]?.redirect).toBe('manual')
		}
	})

	it('NET-3: reads the whole body within WEB_JSON_BODY_LIMIT bytes and refuses one byte more unparsed', async () => {
		const text = (bytes: number) => `"${'a'.repeat(bytes - 2)}"`
		const exact = fakeDeps({ [ENDPOINT]: body(text(WEB_JSON_BODY_LIMIT)) })
		expect(json(await fetchWebJson(ENDPOINT, exact.deps)).value).toHaveLength(WEB_JSON_BODY_LIMIT - 2)
		const { stream, state } = trackedStream(
			Array.from({ length: 4 }, () => new TextEncoder().encode(text(WEB_JSON_BODY_LIMIT / 2)))
		)
		const over = fakeDeps({ [ENDPOINT]: body(stream, { 'content-length': '10' }) })
		expect(failure(await fetchWebJson(ENDPOINT, over.deps))).toMatchObject({
			kind: 'too-large',
			transient: false,
			cost: { bytes: WEB_JSON_BODY_LIMIT + 1 },
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(state.cancelled).toBe(true)
		expect(WEB_JSON_BODY_LIMIT).toBe(65_536)
	})

	it.each([
		['an empty body', ''],
		['invalid JSON', '{"a":'],
		['invalid UTF-8', new Uint8Array([0x22, 0xc3, 0x28, 0x22])],
		['a lone surrogate written raw', new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22])],
	])('fails %s as unparsable json', async (_name, text) => {
		const { deps } = fakeDeps({ [ENDPOINT]: body(text) })
		expect(failure(await fetchWebJson(ENDPOINT, deps))).toMatchObject({ kind: 'unparsable', reason: 'json' })
	})

	it('fails a document past MAX_JSON_NODES or MAX_JSON_DEPTH as unparsable json-bounds, and keeps one at them', async () => {
		const deep = (levels: number) => `${'['.repeat(levels)}${']'.repeat(levels)}`
		const wide = (values: number) => `[${Array.from({ length: values - 1 }, () => '0').join(',')}]`
		for (const [text, kind] of [
			[deep(MAX_JSON_DEPTH), 'ok'],
			[deep(MAX_JSON_DEPTH + 1), 'json-bounds'],
			[wide(MAX_JSON_NODES), 'ok'],
			[wide(MAX_JSON_NODES + 1), 'json-bounds'],
		] as const) {
			const { deps } = fakeDeps({ [ENDPOINT]: body(text) })
			const result = await fetchWebJson(ENDPOINT, deps)
			expect(result.ok ? 'ok' : result.reason, text.slice(0, 20)).toBe(kind)
		}
	})

	it('NET-3: shares the hop rules: each hop admitted and checked, at most 3 redirects, a status, an encoding', async () => {
		const routes: Record<string, Route> = {}
		for (let i = 0; i < WEB_PAGE_MAX_REDIRECTS + 1; i++) {
			routes[`https://h${i}.example/`] = redirect(`https://h${i + 1}.example/`)
		}
		routes['https://h3.example/'] = body('null')
		const ok = fakeDeps(routes)
		expect(json(await fetchWebJson('https://h0.example/', ok.deps))).toMatchObject({
			finalUrl: 'https://h3.example/',
			redirects: 3,
			value: null,
			cost: { subrequests: WEB_PAGE_MAX_SUBREQUESTS, storeCalls: WEB_PAGE_MAX_STORE_CALLS, hops: 4 },
		})
		expect(ok.log).toEqual(
			[0, 1, 2, 3].flatMap((i) => [`policy h${i}.example`, `dns h${i}.example`, `fetch GET https://h${i}.example/`])
		)
		routes['https://h3.example/'] = redirect('https://h4.example/')
		expect(failure(await fetchWebJson('https://h0.example/', fakeDeps(routes).deps))).toMatchObject({
			kind: 'redirects',
		})
		expect(
			failure(
				await fetchWebJson(
					'https://h0.example/',
					fakeDeps({ 'https://h0.example/': redirect('http://h1.example/') }).deps
				)
			)
		).toMatchObject({ kind: 'refused', reason: 'scheme' })
		expect(failure(await fetchWebJson('https://h0.example:8080/', fakeDeps({}).deps))).toMatchObject({
			kind: 'refused',
			reason: 'port',
		})
		expect(failure(await fetchWebJson(ENDPOINT, fakeDeps({ [ENDPOINT]: body('{}', {}, 404) }).deps))).toMatchObject({
			kind: 'status',
			status: 404,
		})
		const blocked = fakeDeps({ [ENDPOINT]: body('{}') }, { refusesHost: () => Promise.resolve(true) })
		expect(failure(await fetchWebJson(ENDPOINT, blocked.deps))).toMatchObject({ kind: 'blocked' })
		expect(blocked.requests).toHaveLength(0)
		const deflate = fakeDeps({ [ENDPOINT]: body('{}', { 'content-encoding': 'deflate' }) })
		expect(failure(await fetchWebJson(ENDPOINT, deflate.deps))).toMatchObject({
			kind: 'encoding',
			reason: 'unsupported-encoding',
		})
		for (const encoding of ['identity', 'gzip', 'br']) {
			// workerd decodes gzip and br on its fetch path (test/web-page-encoding.test.ts); a fake answer is plain.
			const plain = fakeDeps({ [ENDPOINT]: body('{}', { 'content-encoding': encoding }) })
			expect(json(await fetchWebJson(ENDPOINT, plain.deps)).value).toEqual({})
		}
	})

	it('NET-3: charges a shared budget and ends at its deadline', async () => {
		const budget: WebPageBudget = { subrequests: HOP_SUBREQUESTS, storeCalls: 1, deadline: Date.now() + 60_000 }
		const first = fakeDeps({ [ENDPOINT]: body('{}') })
		json(await fetchWebJson(ENDPOINT, first.deps, { budget }))
		expect(budget).toMatchObject({ subrequests: 0, storeCalls: 0 })
		const second = fakeDeps({ [ENDPOINT]: body('{}') })
		expect(failure(await fetchWebJson(ENDPOINT, second.deps, { budget }))).toMatchObject({ kind: 'budget' })
		expect(second.requests).toHaveLength(0)
		const stalled = fakeDeps({ [ENDPOINT]: () => new Promise<never>(() => {}) })
		expect(failure(await fetchWebJson(ENDPOINT, stalled.deps, { timeoutMs: 50 }))).toMatchObject({ kind: 'timeout' })
	})
})

describe('web page sink: the image mode', () => {
	const IMAGE = 'https://img.example/a.png'
	const LIMIT = 1000
	const image = (result: WebImage | WebPageFailure): WebImage => {
		if (!result.ok) {
			throw new Error(`failed: ${JSON.stringify(result)}`)
		}
		return result
	}
	const answer =
		(bytes: BodyInit | null, headers: Record<string, string> = {}, status = 200) =>
		() =>
			new Response(bytes, { status, headers })

	it('NET-3: reads a 200 of any content type within maxBytes, sending only the User-Agent, without a copy', async () => {
		for (const type of [null, 'text/html', 'image/png', 'application/octet-stream']) {
			const { deps, requests } = fakeDeps({
				[IMAGE]: answer(new Uint8Array([1, 2, 3]), type === null ? {} : { 'content-type': type }),
			})
			const got = image(await fetchWebImage(`${IMAGE}#f`, deps, { maxBytes: LIMIT }))
			expect({ ...got, bytes: [...got.bytes] }).toEqual({
				ok: true,
				finalUrl: IMAGE,
				redirects: 0,
				status: 200,
				bytes: [1, 2, 3],
				cost: { subrequests: HOP_SUBREQUESTS, storeCalls: 1, hops: 1, bytes: 3 },
			})
			// A view over the read buffer of maxBytes + 1 bytes, not a copy.
			expect(got.bytes.buffer.byteLength).toBe(LIMIT + 1)
			expect([...(requests[0]?.headers ?? [])]).toEqual([['user-agent', 'Kopje/test']])
			expect(requests[0]?.redirect).toBe('manual')
		}
	})

	it('NET-3: keeps a body of exactly maxBytes and refuses one byte more, cancelling it', async () => {
		const exact = fakeDeps({ [IMAGE]: answer(new Uint8Array(LIMIT)) })
		expect(image(await fetchWebImage(IMAGE, exact.deps, { maxBytes: LIMIT })).bytes.byteLength).toBe(LIMIT)
		const { stream, state } = trackedStream(Array.from({ length: 4 }, () => new Uint8Array(LIMIT / 2)))
		const over = fakeDeps({ [IMAGE]: answer(stream, { 'content-length': '10' }) })
		expect(failure(await fetchWebImage(IMAGE, over.deps, { maxBytes: LIMIT }))).toMatchObject({
			kind: 'too-large',
			transient: false,
			cost: { bytes: LIMIT + 1 },
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(state.cancelled).toBe(true)
	})

	it('NET-3: shares the hop rules, the status rule, the encodings, the budget and the deadline', async () => {
		const routes: Record<string, Route> = {}
		for (let i = 0; i < WEB_PAGE_MAX_REDIRECTS; i++) {
			routes[`https://h${i}.example/`] = redirect(`https://h${i + 1}.example/`)
		}
		routes['https://h3.example/'] = answer(new Uint8Array([9]))
		const ok = fakeDeps(routes)
		expect(image(await fetchWebImage('https://h0.example/', ok.deps, { maxBytes: LIMIT }))).toMatchObject({
			finalUrl: 'https://h3.example/',
			redirects: 3,
			cost: { subrequests: WEB_PAGE_MAX_SUBREQUESTS, storeCalls: WEB_PAGE_MAX_STORE_CALLS, hops: 4 },
		})
		expect(ok.log).toEqual(
			[0, 1, 2, 3].flatMap((i) => [`policy h${i}.example`, `dns h${i}.example`, `fetch GET https://h${i}.example/`])
		)
		routes['https://h3.example/'] = redirect('https://h4.example/')
		expect(
			failure(await fetchWebImage('https://h0.example/', fakeDeps(routes).deps, { maxBytes: LIMIT }))
		).toMatchObject({ kind: 'redirects' })
		for (const [url, reason] of [
			['http://img.example/a.png', 'scheme'],
			['https://img.example:8443/a.png', 'port'],
			['https://127.0.0.1/a.png', 'ip-literal'],
		] as const) {
			const refused = fakeDeps({})
			expect(failure(await fetchWebImage(url, refused.deps, { maxBytes: LIMIT })), url).toMatchObject({
				kind: 'refused',
			})
			expect(refused.log, reason).toEqual([])
		}
		for (const status of [201, 204, 206, 304, 404, 500]) {
			expect(
				failure(await fetchWebImage(IMAGE, fakeDeps({ [IMAGE]: answer(null, {}, status) }).deps, { maxBytes: LIMIT }))
			).toMatchObject({ kind: 'status', status })
		}
		const blocked = fakeDeps({ [IMAGE]: answer('x') }, { refusesHost: () => Promise.resolve(true) })
		expect(failure(await fetchWebImage(IMAGE, blocked.deps, { maxBytes: LIMIT }))).toMatchObject({ kind: 'blocked' })
		expect(blocked.requests).toHaveLength(0)
		const deflate = fakeDeps({ [IMAGE]: answer('x', { 'content-encoding': 'deflate' }) })
		expect(failure(await fetchWebImage(IMAGE, deflate.deps, { maxBytes: LIMIT }))).toMatchObject({
			kind: 'encoding',
		})
		const budget: WebPageBudget = { subrequests: HOP_SUBREQUESTS, storeCalls: 1, deadline: Date.now() + 60_000 }
		image(await fetchWebImage(IMAGE, fakeDeps({ [IMAGE]: answer('x') }).deps, { maxBytes: LIMIT, budget }))
		const second = fakeDeps({ [IMAGE]: answer('x') })
		expect(failure(await fetchWebImage(IMAGE, second.deps, { maxBytes: LIMIT, budget }))).toMatchObject({
			kind: 'budget',
		})
		expect(second.requests).toHaveLength(0)
		const stalled = fakeDeps({ [IMAGE]: () => new Promise<never>(() => {}) })
		expect(failure(await fetchWebImage(IMAGE, stalled.deps, { maxBytes: LIMIT, timeoutMs: 50 }))).toMatchObject({
			kind: 'timeout',
		})
	})
})

describe('web page sink: the media mode', () => {
	const MEDIA = 'https://media.example/a.mp4'
	const LIMIT = 1000
	const answer =
		(body: BodyInit | null, headers: Record<string, string> = {}, status = 200) =>
		() =>
			new Response(body, { status, headers })
	const whole = (result: WebMedia | WebPageFailure): WebMedia => {
		if (!result.ok) {
			throw new Error(`failed: ${JSON.stringify(result)}`)
		}
		return result
	}
	const streamed = (result: WebMediaStream | WebPageFailure): WebMediaStream => {
		if (!result.ok) {
			throw new Error(`failed: ${JSON.stringify(result)}`)
		}
		return result
	}
	const stream = { maxBytes: LIMIT, prefixBytes: 4 }

	it('NET-3: reads a 200 whole within maxBytes and returns every hop host, sending only the User-Agent', async () => {
		const { deps, requests } = fakeDeps({
			[MEDIA]: redirect('https://XN--BCHER-KVA.Example/b'),
			'https://xn--bcher-kva.example/b': redirect('https://cdn.example/c'),
			'https://cdn.example/c': answer(new Uint8Array([1, 2, 3])),
		})
		const got = whole(await fetchWebMedia(MEDIA, deps, { maxBytes: LIMIT }))
		expect(got).toMatchObject({ finalUrl: 'https://cdn.example/c', redirects: 2 })
		expect(got.hosts).toEqual(['media.example', 'xn--bcher-kva.example', 'cdn.example'])
		expect([...got.bytes]).toEqual([1, 2, 3])
		expect(got.bytes.buffer.byteLength).toBe(LIMIT + 1)
		for (const request of requests) {
			expect([...request.headers]).toEqual([['user-agent', 'Kopje/test']])
			expect(request.redirect).toBe('manual')
		}
		// A failure carries the failing hop's host only.
		const failed = fakeDeps({
			[MEDIA]: redirect('https://cdn.example/c'),
			'https://cdn.example/c': answer(null, {}, 404),
		})
		const failure = await fetchWebMedia(MEDIA, failed.deps, { maxBytes: LIMIT })
		expect(failure).toEqual({
			ok: false,
			kind: 'status',
			status: 404,
			host: 'cdn.example',
			transient: false,
			cost: expect.any(Object) as unknown,
		})
	})

	it('NET-3: shares the hop rules, the cap and the encodings with the image mode', async () => {
		const over = fakeDeps({ [MEDIA]: answer(new Uint8Array(LIMIT + 1)) })
		expect(await fetchWebMedia(MEDIA, over.deps, { maxBytes: LIMIT })).toMatchObject({ ok: false, kind: 'too-large' })
		const exact = fakeDeps({ [MEDIA]: answer(new Uint8Array(LIMIT)) })
		expect(whole(await fetchWebMedia(MEDIA, exact.deps, { maxBytes: LIMIT })).bytes.length).toBe(LIMIT)
		const deflate = fakeDeps({ [MEDIA]: answer('x', { 'content-encoding': 'deflate' }) })
		expect(await fetchWebMedia(MEDIA, deflate.deps, { maxBytes: LIMIT })).toMatchObject({ kind: 'encoding' })
		const refused = fakeDeps({})
		expect(await fetchWebMedia('https://127.0.0.1/a', refused.deps, { maxBytes: LIMIT })).toMatchObject({
			kind: 'refused',
			reason: 'ip-literal',
		})
		expect(refused.log).toEqual([])
		const blocked = fakeDeps(
			{ [MEDIA]: redirect('https://blocked.example/') },
			{ refusesHost: (h) => Promise.resolve(h === 'blocked.example') }
		)
		expect(await streamWebMedia(MEDIA, blocked.deps, stream)).toMatchObject({
			kind: 'blocked',
			host: 'blocked.example',
		})
		expect(blocked.requests).toHaveLength(1)
	})

	it('NET-3: allows the whole call WEB_MEDIA_TIMEOUT_MS, where the image mode stops at its own ceiling', async () => {
		expect(WEB_MEDIA_TIMEOUT_MS).toBe(30_000)
		const run = async (mode: 'media' | 'image') => {
			let clock = 1_000_000
			const { deps } = fakeDeps(
				{
					[MEDIA]: () => {
						// The answer arrives 15 s after the call started, by the injected clock.
						clock += 15_000
						return new Response(new Uint8Array([1]))
					},
				},
				{ now: () => clock }
			)
			const options = { maxBytes: LIMIT, timeoutMs: 20_000 }
			return mode === 'media' ? fetchWebMedia(MEDIA, deps, options) : fetchWebImage(MEDIA, deps, options)
		}
		expect(await run('media')).toMatchObject({ ok: true })
		expect(await run('image')).toMatchObject({ ok: false, kind: 'timeout' })
	})

	it('NET-3: streams exactly the declared length after its prefix, asking for identity', async () => {
		const body = Uint8Array.from({ length: 10 }, (_, i) => i)
		const chunks = trackedStream([body.subarray(0, 4), body.subarray(4)])
		const { deps, requests } = fakeDeps({ [MEDIA]: answer(chunks.stream, { 'content-length': '10' }) })
		const got = streamed(await streamWebMedia(MEDIA, deps, stream))
		expect(got).toMatchObject({ finalUrl: MEDIA, length: 10, hosts: ['media.example'] })
		expect([...got.prefix]).toEqual([0, 1, 2, 3])
		expect([...(requests[0]?.headers ?? [])]).toEqual([
			['accept-encoding', 'identity'],
			['user-agent', 'Kopje/test'],
		])
		// The call stays open while the body is read, and is closed once its consumer has read the last byte.
		expect(requests[0]?.signal.aborted).toBe(false)
		expect(new Uint8Array(await new Response(got.body).arrayBuffer())).toEqual(body)
		expect(got.cost.bytes).toBe(10)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(requests[0]?.signal.aborted).toBe(true)
		// A body within its prefix.
		const short = fakeDeps({ [MEDIA]: answer(new Uint8Array([7, 8]), { 'content-length': '2' }) })
		const small = streamed(await streamWebMedia(MEDIA, short.deps, stream))
		expect(new Uint8Array(await new Response(small.body).arrayBuffer())).toEqual(new Uint8Array([7, 8]))
	})

	it.each([
		['no Content-Length', {}, 'no-length'],
		['a list', { 'content-length': '10, 10' }, 'no-length'],
		['a sign', { 'content-length': '+10' }, 'no-length'],
		['an exponent', { 'content-length': '1e3' }, 'no-length'],
		['a length past maxBytes', { 'content-length': String(LIMIT + 1) }, 'too-large'],
		['gzip', { 'content-length': '10', 'content-encoding': 'gzip' }, 'encoding'],
		['br', { 'content-length': '10', 'content-encoding': 'br' }, 'encoding'],
	])('NET-3: the streamed mode refuses %s before reading the body', async (_, headers, kind) => {
		const tracked = trackedStream([new Uint8Array(10)])
		const { deps } = fakeDeps({
			[MEDIA]: () => {
				const response = new Response(tracked.stream, { headers })
				if (!('content-length' in headers)) {
					response.headers.delete('content-length')
				}
				return response
			},
		})
		expect(await streamWebMedia(MEDIA, deps, stream)).toMatchObject({ ok: false, kind, transient: false })
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(tracked.state.cancelled).toBe(true)
		expect(tracked.state.pulls).toBeLessThanOrEqual(1)
	})

	it('NET-3: a streamed body shorter or longer than its length errors, so nothing stores it', async () => {
		const shortPrefix = fakeDeps({
			[MEDIA]: answer(trackedStream([new Uint8Array(2)]).stream, { 'content-length': '10' }),
		})
		expect(await streamWebMedia(MEDIA, shortPrefix.deps, stream)).toMatchObject({ ok: false, kind: 'network' })
		const short = fakeDeps({ [MEDIA]: answer(trackedStream([new Uint8Array(6)]).stream, { 'content-length': '10' }) })
		const cut = streamed(await streamWebMedia(MEDIA, short.deps, stream))
		await expect(new Response(cut.body).arrayBuffer()).rejects.toThrow('network')
		const long = fakeDeps({
			[MEDIA]: answer(trackedStream([new Uint8Array(6), new Uint8Array(6)]).stream, { 'content-length': '10' }),
		})
		const over = streamed(await streamWebMedia(MEDIA, long.deps, stream))
		await expect(new Response(over.body).arrayBuffer()).rejects.toThrow('network')
		expect(long.requests[0]?.signal.aborted).toBe(true)
	})

	it('NET-3: a returned stream errors at the deadline while its consumer is still reading', async () => {
		const tracked = trackedStream([new Uint8Array(4), new Uint8Array(2)], true)
		const { deps, requests } = fakeDeps({ [MEDIA]: answer(tracked.stream, { 'content-length': '100' }) })
		const started = Date.now()
		const got = streamed(await streamWebMedia(MEDIA, deps, { ...stream, deadline: started + 200 }))
		const reader = got.body.getReader()
		expect((await reader.read()).value).toHaveLength(4)
		expect((await reader.read()).value).toHaveLength(2)
		// The next read waits on a body that never ends, and is failed by the deadline.
		await expect(reader.read()).rejects.toThrow('timeout')
		expect(Date.now() - started).toBeLessThan(2000)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(tracked.state.cancelled).toBe(true)
		expect(requests[0]?.signal.aborted).toBe(true)
		// A consumer that is not reading at the deadline finds the stream errored too.
		const idle = trackedStream([new Uint8Array(4)], true)
		const second = fakeDeps({ [MEDIA]: answer(idle.stream, { 'content-length': '100' }) })
		const late = streamed(await streamWebMedia(MEDIA, second.deps, { ...stream, timeoutMs: 100 }))
		await new Promise((resolve) => setTimeout(resolve, 200))
		await expect(new Response(late.body).arrayBuffer()).rejects.toThrow()
		expect(idle.state.cancelled).toBe(true)
	})

	it('ends a returned stream at an abort, and cancels the body when the consumer cancels', async () => {
		const controller = new AbortController()
		const aborted = trackedStream([new Uint8Array(4)], true)
		const first = fakeDeps({ [MEDIA]: answer(aborted.stream, { 'content-length': '100' }) })
		const got = streamed(await streamWebMedia(MEDIA, first.deps, { ...stream, signal: controller.signal }))
		const reader = got.body.getReader()
		await reader.read()
		const pending = reader.read()
		controller.abort()
		await expect(pending).rejects.toThrow('aborted')
		const cancelled = trackedStream([new Uint8Array(4)], true)
		const second = fakeDeps({ [MEDIA]: answer(cancelled.stream, { 'content-length': '100' }) })
		const other = streamed(await streamWebMedia(MEDIA, second.deps, stream))
		await other.body.cancel()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(cancelled.state.cancelled).toBe(true)
		expect(second.requests[0]?.signal.aborted).toBe(true)
	})
})

describe("web page sink: the streamed body's lifetime", () => {
	const MEDIA = 'https://media.example/a.mp4'
	const MiB = 1024 * 1024
	const options = { maxBytes: 8 * MiB, prefixBytes: MiB }
	const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
	const sized = (body: ReadableStream<Uint8Array>, length: number) => () =>
		new Response(body, { headers: { 'content-length': String(length) } })
	// Reads at least `bytes` bytes, or to the end.
	const take = async (reader: ReadableStreamDefaultReader<Uint8Array>, bytes: number) => {
		let read = 0
		while (read < bytes) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			read += value.length
		}
		return read
	}
	const open = async (body: ReadableStream<Uint8Array>, length: number, timeoutMs = 200) => {
		const { deps, requests } = fakeDeps({ [MEDIA]: sized(body, length) })
		const got = await streamWebMedia(MEDIA, deps, { ...options, timeoutMs })
		if (!got.ok) {
			throw new Error(`failed: ${JSON.stringify(got)}`)
		}
		return { got, call: () => requests[0]?.signal }
	}

	it('NET-3: an idle consumer of a small body gets an error at the deadline, though upstream ended', async () => {
		const tracked = trackedStream([new Uint8Array(100)])
		const { got, call } = await open(tracked.stream, 100)
		const reader = got.body.getReader()
		await pause(400)
		expect(call()?.aborted).toBe(true)
		await expect(reader.read()).rejects.toThrow()
		await expect(reader.closed).rejects.toThrow()
	})

	it('NET-3: an idle consumer of a large body gets an error at the deadline, and upstream is cancelled', async () => {
		const tracked = trackedStream([new Uint8Array(MiB), new Uint8Array(MiB)])
		const { got, call } = await open(tracked.stream, 2 * MiB)
		const reader = got.body.getReader()
		await pause(400)
		expect(tracked.state.cancelled).toBe(true)
		expect(call()?.aborted).toBe(true)
		await expect(reader.read()).rejects.toThrow()
		await expect(reader.closed).rejects.toThrow()
	})

	it('NET-3: a consumer pausing before the final chunk past the deadline gets an error, not the rest', async () => {
		const tracked = trackedStream([new Uint8Array(MiB), new Uint8Array(MiB)])
		const { got } = await open(tracked.stream, 2 * MiB, 300)
		const reader = got.body.getReader()
		let read = 0
		while (read < MiB) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			read += value.length
		}
		await pause(500)
		await expect(
			(async () => {
				for (let r = await reader.read(); !r.done; r = await reader.read()) {
					read += r.value.length
				}
			})()
		).rejects.toThrow()
		expect(read).toBeLessThan(2 * MiB)
	})

	it('ends the call and cancels upstream when the consumer cancels before reading', async () => {
		const tracked = trackedStream([new Uint8Array(MiB), new Uint8Array(MiB)])
		const { got, call } = await open(tracked.stream, 2 * MiB, 10_000)
		await got.body.cancel()
		await pause(20)
		expect(tracked.state.cancelled).toBe(true)
		expect(call()?.aborted).toBe(true)
	})

	it('settles a pending read and closed when the consumer cancels during a stalled upstream read', async () => {
		// The prefix, then an upstream that never answers again.
		const tracked = trackedStream([new Uint8Array(MiB)], true)
		const { got, call } = await open(tracked.stream, 2 * MiB, 10_000)
		const reader = got.body.getReader()
		expect(await take(reader, MiB)).toBe(MiB)
		const pending = reader.read()
		await pause(20)
		await reader.cancel()
		// Both settle (workerd rejects a read pending at a cancel, where the Streams spec resolves it as done).
		const settled = (promise: Promise<unknown>) =>
			Promise.race([
				promise.then(
					() => 'settled',
					() => 'settled'
				),
				pause(1000).then(() => 'pending'),
			])
		expect(await settled(pending)).toBe('settled')
		expect(await settled(reader.closed)).toBe('settled')
		await pause(20)
		expect(tracked.state.cancelled).toBe(true)
		expect(call()?.aborted).toBe(true)
	})

	it('errors the body, and ends the call, when upstream errors mid-stream', async () => {
		let sent = false
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true
					controller.enqueue(new Uint8Array(MiB))
					return
				}
				controller.error(new Error('reset by https://secret.example/'))
			},
		})
		const { got, call } = await open(failing, 2 * MiB, 10_000)
		const reader = got.body.getReader()
		expect(await take(reader, MiB)).toBe(MiB)
		// At once, as the network failure, not at the 10 s deadline.
		const started = Date.now()
		await expect(reader.read()).rejects.toThrow('network')
		await expect(reader.closed).rejects.toThrow('network')
		expect(Date.now() - started).toBeLessThan(2000)
		expect(call()?.aborted).toBe(true)
	})

	it('releases everything on success: the call closes at once and a later deadline fails nothing', async () => {
		const tracked = trackedStream([new Uint8Array(MiB), new Uint8Array(MiB)])
		const { got, call } = await open(tracked.stream, 2 * MiB, 300)
		const reader = got.body.getReader()
		let read = 0
		for (let r = await reader.read(); !r.done; r = await reader.read()) {
			read += r.value.length
		}
		expect(read).toBe(2 * MiB)
		await pause(20)
		// Closed by the success, well before the deadline.
		expect(call()?.aborted).toBe(true)
		await pause(400)
		await expect(reader.closed).resolves.toBeUndefined()
		expect(got.cost.bytes).toBe(2 * MiB)
	})
})
