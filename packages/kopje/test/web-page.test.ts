import { describe, expect, it } from 'vitest'

import {
	fetchWebPage,
	HOP_SUBREQUESTS,
	probeRedirect,
	REDIRECT_PROBE_MAX_STORE_CALLS,
	REDIRECT_PROBE_MAX_SUBREQUESTS,
	WEB_PAGE_BODY_LIMIT,
	WEB_PAGE_MAX_REDIRECTS,
	WEB_PAGE_MAX_STORE_CALLS,
	WEB_PAGE_MAX_SUBREQUESTS,
	WEB_PAGE_PAIR_MAX_STORE_CALLS,
	WEB_PAGE_PAIR_MAX_SUBREQUESTS,
	WEB_PAGE_URL_LIMIT,
	type WebPage,
	type WebPageBudget,
	type WebPageDeps,
	type WebPageFailure,
	webPageUrlRefusal,
} from '../src/federation/web-page'
import { scanHtml } from '../src/platform/html-scan'

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

// A body stream that records a cancel and whether it was pulled after it.
function trackedBody(chunks: Uint8Array[], stall = false) {
	const state = { cancelled: false, pullsAfterCancel: 0 }
	let index = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.cancelled) {
				state.pullsAfterCancel++
			}
			const chunk = chunks[index++]
			if (chunk !== undefined) {
				controller.enqueue(chunk)
			} else if (stall) {
				return new Promise<void>(() => {})
			} else {
				controller.close()
			}
			return undefined
		},
		cancel() {
			state.cancelled = true
		},
	})
	return { body, state }
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
		const { body, state } = trackedBody(Array.from({ length: 64 }, () => chunk))
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
		const stalled = trackedBody([new TextEncoder().encode(BODY)], true)
		const body = fakeDeps({ [PAGE]: () => new Response(stalled.body, { headers: HTML }) })
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
		const tracked: ReturnType<typeof trackedBody>[] = []
		const answer = (status: number, type: string) => () => {
			const body = trackedBody([new TextEncoder().encode(BODY)])
			tracked.push(body)
			return new Response(status === 204 || status === 304 ? null : body.body, {
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
			const tracked = trackedBody([new TextEncoder().encode(BODY)])
			const { deps } = fakeDeps({
				[PAGE]: () => new Response(tracked.body, { headers: { ...HTML, 'content-encoding': encoding } }),
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
		const { deps } = fakeDeps(
			{ [PAGE]: html(body) },
			{
				// The real scanner, held before its second chunk until the call's deadline has passed.
				scan: (bytes, charset, limits, signal) => {
					const running = scanHtml(bytes, charset, limits, signal, async (chunk) => {
						pauses.push(chunk)
						if (chunk === 1) {
							reached.resolve(undefined)
							await held.promise
						}
					})
					running.then(
						() => (settled = 'resolved'),
						() => (settled = 'rejected')
					)
					return running
				},
			}
		)
		const running = fetchWebPage(PAGE, deps, { timeoutMs: 100 })
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
		const tracked = trackedBody([new TextEncoder().encode(BODY)])
		const { deps } = fakeDeps(
			{
				[PAGE]: () => {
					clock += 20_000
					return new Response(tracked.body, { headers: HTML })
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
