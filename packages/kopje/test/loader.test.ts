import { describe, expect, it } from 'vitest'

import {
	createContextLoader,
	createSafeLoader,
	DOCUMENT_BODY_LIMIT,
	DOCUMENT_TIMEOUT_MS,
	type LoaderDeps,
} from '../src/federation/loader'

const ACTOR = 'https://remote.example/users/bob'
const AP = { 'content-type': 'application/activity+json' }

// A fetch over a route table; it records every request, and a route may set the response's final URL.
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
	const requests: Request[] = []
	const fetch = ((input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input)
		requests.push(request)
		const route = routes[request.url]
		return route === undefined ? Promise.resolve(new Response('missing', { status: 404 })) : Promise.resolve(route())
	}) as typeof globalThis.fetch
	return { fetch, requests }
}

function finalUrl(response: Response, url: string): Response {
	Object.defineProperty(response, 'url', { value: url })
	return response
}

function loader(fetch: typeof globalThis.fetch, extra: Partial<LoaderDeps> = {}) {
	return createSafeLoader({ fetch, checkHost: () => Promise.resolve(), userAgent: 'Kopje/test', ...extra })
}

describe('safe document loader', () => {
	it('loads an https JSON-LD document whose id is on the fetched origin', async () => {
		const { fetch, requests } = fakeFetch({ [ACTOR]: () => Response.json({ id: ACTOR }, { headers: AP }) })
		expect(await loader(fetch)(ACTOR)).toEqual({ contextUrl: null, document: { id: ACTOR }, documentUrl: ACTOR })
		expect(requests[0]?.headers.get('accept')).toContain('application/activity+json')
		expect(requests[0]?.headers.get('user-agent')).toBe('Kopje/test')
	})

	it('serves preloaded JSON-LD contexts without fetching', async () => {
		const { fetch, requests } = fakeFetch({})
		const context = await loader(fetch)('https://www.w3.org/ns/activitystreams')
		expect(context.document).toMatchObject({ '@context': expect.anything() })
		expect(requests).toHaveLength(0)
	})

	it.each([
		['http', 'http://remote.example/users/bob'],
		['localhost', 'https://localhost/users/bob'],
		['a localhost subdomain', 'https://evil.localhost/users/bob'],
		['a single-label host', 'https://intranet/users/bob'],
		['an IPv4 literal', 'https://127.0.0.1/users/bob'],
		['a numeric IPv4 form', 'https://2130706433/users/bob'],
		['a public IPv4 literal', 'https://93.184.216.34/users/bob'],
		['an IPv6 literal', 'https://[::1]/users/bob'],
		['credentials in the URL', 'https://user:pass@remote.example/users/bob'],
	])('refuses %s before fetching', async (_label, url) => {
		const { fetch, requests } = fakeFetch({})
		await expect(loader(fetch)(url)).rejects.toThrow(/Refused/)
		expect(requests).toHaveLength(0)
	})

	it('refuses a host the DNS check rejects (private address)', async () => {
		const { fetch, requests } = fakeFetch({})
		const checkHost = () => Promise.reject(new Error('Invalid or private address: 10.0.0.1'))
		await expect(loader(fetch, { checkHost })(ACTOR)).rejects.toThrow(/private address/)
		expect(requests).toHaveLength(0)
	})

	it('refuses a redirect to another origin without following it', async () => {
		const { fetch, requests } = fakeFetch({
			[ACTOR]: () => new Response(null, { status: 302, headers: { location: 'https://other.example/users/bob' } }),
			'https://other.example/users/bob': () =>
				Response.json({ id: 'https://other.example/users/bob' }, { headers: AP }),
		})
		await expect(loader(fetch)(ACTOR)).rejects.toThrow(/cross-origin redirect/)
		expect(requests.map((r) => r.url)).toEqual([ACTOR])
	})

	it('follows a same-origin redirect and re-checks the host', async () => {
		const next = 'https://remote.example/u/bob'
		const { fetch } = fakeFetch({
			[ACTOR]: () => new Response(null, { status: 301, headers: { location: '/u/bob' } }),
			[next]: () => Response.json({ id: next }, { headers: AP }),
		})
		const checked: string[] = []
		const checkHost = (url: URL) => {
			checked.push(url.href)
			return Promise.resolve()
		}
		expect((await loader(fetch, { checkHost })(ACTOR)).documentUrl).toBe(next)
		expect(checked).toEqual([ACTOR, next])
	})

	it('judges the origin from the final response.url', async () => {
		const { fetch } = fakeFetch({
			[ACTOR]: () =>
				finalUrl(Response.json({ id: 'https://other.example/x' }, { headers: AP }), 'https://other.example/x'),
		})
		await expect(loader(fetch)(ACTOR)).rejects.toThrow(/redirected to https:\/\/other.example/)
	})

	it('refuses a document whose id is on another origin', async () => {
		const { fetch } = fakeFetch({
			[ACTOR]: () => Response.json({ id: 'https://other.example/users/bob' }, { headers: AP }),
		})
		await expect(loader(fetch)(ACTOR)).rejects.toThrow(/is not on https:\/\/remote.example/)
		const { fetch: atId } = fakeFetch({
			[ACTOR]: () => Response.json({ '@id': 'https://other.example/' }, { headers: AP }),
		})
		await expect(loader(atId)(ACTOR)).rejects.toThrow(/is not on/)
		const { fetch: invalid } = fakeFetch({ [ACTOR]: () => Response.json({ id: 'not a url' }, { headers: AP }) })
		await expect(loader(invalid)(ACTOR)).rejects.toThrow(/is not on/)
	})

	it('refuses a body over 1 MiB, declared or streamed', async () => {
		expect(DOCUMENT_BODY_LIMIT).toBe(1024 * 1024)
		const big = `{"id":"${ACTOR}","pad":"${'x'.repeat(DOCUMENT_BODY_LIMIT)}"}`
		const { fetch: declared } = fakeFetch({ [ACTOR]: () => new Response(big, { headers: AP }) })
		await expect(loader(declared)(ACTOR)).rejects.toThrow(/exceeds/)

		let pulled = 0
		const chunk = new Uint8Array(64 * 1024)
		const endless = () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						pulled++
						controller.enqueue(chunk)
					},
				}),
				{ headers: AP }
			)
		const { fetch: streamed } = fakeFetch({ [ACTOR]: endless })
		await expect(loader(streamed)(ACTOR)).rejects.toThrow(/exceeds/)
		expect(pulled).toBeLessThanOrEqual(DOCUMENT_BODY_LIMIT / chunk.byteLength + 2)
	})

	it('gives up on the whole load after the timeout, including a stalled body', async () => {
		expect(DOCUMENT_TIMEOUT_MS).toBe(5000)
		const stalledFetch = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch
		await expect(loader(stalledFetch, { timeoutMs: 20 })(ACTOR)).rejects.toThrow(/Timed out after 20 ms/)

		const stalledBody = () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: AP })
		const { fetch } = fakeFetch({ [ACTOR]: stalledBody })
		await expect(loader(fetch, { timeoutMs: 20 })(ACTOR)).rejects.toThrow(/Timed out/)
	})

	it('refuses non-JSON content and keeps the status of failed fetches', async () => {
		const { fetch: html } = fakeFetch({
			[ACTOR]: () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
		})
		await expect(loader(html)(ACTOR)).rejects.toThrow(/Not an ActivityPub document/)

		const { fetch: gone } = fakeFetch({ [ACTOR]: () => new Response('gone', { status: 410 }) })
		const error = await loader(gone)(ACTOR).catch((e: unknown) => e)
		expect(error).toMatchObject({ message: expect.stringContaining('HTTP 410'), response: { status: 410 } })
	})

	it('signs every request when given a signer', async () => {
		const { fetch, requests } = fakeFetch({ [ACTOR]: () => Response.json({ id: ACTOR }, { headers: AP }) })
		const sign = (request: Request) => {
			const signed = new Request(request)
			signed.headers.set('signature', 'test')
			return Promise.resolve(signed)
		}
		await createSafeLoader({ fetch, checkHost: () => Promise.resolve(), userAgent: 'Kopje/test' }, sign)(ACTOR)
		expect(requests[0]?.headers.get('signature')).toBe('test')
	})

	it('refuses a signal that is already aborted, without fetching', async () => {
		const { fetch, requests } = fakeFetch({ [ACTOR]: () => Response.json({ id: ACTOR }, { headers: AP }) })
		const controller = new AbortController()
		controller.abort(new Error('caller gave up'))
		await expect(loader(fetch)(ACTOR, { signal: controller.signal })).rejects.toThrow('caller gave up')
		expect(requests).toHaveLength(0)
	})

	it('applies a JSON-LD context given in a Link header', async () => {
		const context = 'https://remote.example/contexts/litepub.jsonld'
		const { fetch } = fakeFetch({
			[ACTOR]: () =>
				Response.json(
					{ id: ACTOR },
					{
						headers: {
							'content-type': 'application/activity+json',
							link: `<${context}>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"`,
						},
					}
				),
		})
		expect(await loader(fetch)(ACTOR)).toEqual({ contextUrl: context, document: { id: ACTOR }, documentUrl: ACTOR })
	})

	// GHSA-jhrq-qvrm-qr36: a JSON file uploaded to a remote origin (a media attachment, say) must not pass for an actor or
	// object of that origin. Mastodon's rule (JsonLdHelper#valid_activitypub_content_type?), with the header parsed.
	it.each([
		'application/activity+json',
		'Application/Activity+JSON; charset=utf-8',
		'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
		'application/ld+json;profile=https://www.w3.org/ns/activitystreams',
		'APPLICATION/LD+JSON; charset=utf-8; PROFILE="https://example.com/ext https://www.w3.org/ns/activitystreams"',
	])('accepts an ActivityPub document served as %s', async (contentType) => {
		const { fetch } = fakeFetch({
			[ACTOR]: () => Response.json({ id: ACTOR }, { headers: { 'content-type': contentType } }),
		})
		expect((await loader(fetch)(ACTOR)).document).toEqual({ id: ACTOR })
	})

	it.each([
		'application/json',
		'application/jrd+json',
		'application/ld+json',
		'application/ld+json; profile="https://www.w3.org/ns/activitystreams-evil"',
		'application/ld+json; profile="http://www.w3.org/ns/activitystreams"',
		'application/ld+json; foo="x;profile=https://www.w3.org/ns/activitystreams"',
		'application/activity+jsonx',
		'application/activity+json/x',
		'text/html',
		'',
	])('refuses a document served as %j', async (contentType) => {
		const { fetch } = fakeFetch({
			[ACTOR]: () => Response.json({ id: ACTOR }, { headers: { 'content-type': contentType } }),
		})
		await expect(loader(fetch)(ACTOR)).rejects.toThrow(/Not an ActivityPub document/)
	})

	it.each(['application/ld+json', 'application/json', 'application/activity+json'])(
		'the context loader accepts a JSON-LD context served as %s',
		async (contentType) => {
			const url = 'https://remote.example/contexts/litepub.jsonld'
			const context = { '@context': { toot: 'http://joinmastodon.org/ns#' } }
			const { fetch, requests } = fakeFetch({
				[url]: () => Response.json(context, { headers: { 'content-type': contentType } }),
			})
			const deps = { fetch, checkHost: () => Promise.resolve(), userAgent: 'Kopje/test' }
			expect((await createContextLoader(deps)(url)).document).toEqual(context)
			expect(requests[0]?.headers.get('accept')).toContain('application/ld+json')
		}
	)

	it('the context loader refuses non-JSON content', async () => {
		const url = 'https://remote.example/contexts/x'
		const { fetch } = fakeFetch({ [url]: () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) })
		const deps = { fetch, checkHost: () => Promise.resolve(), userAgent: 'Kopje/test' }
		await expect(createContextLoader(deps)(url)).rejects.toThrow(/Not a JSON-LD context/)
	})

	it('does not follow an alternate-document link', async () => {
		const { fetch, requests } = fakeFetch({
			[ACTOR]: () =>
				Response.json(
					{ id: ACTOR },
					{
						headers: {
							'content-type': 'application/json',
							link: '<https://remote.example/users/bob.json>; rel="alternate"; type="application/activity+json"',
						},
					}
				),
		})
		// Only the context loader lets plain JSON reach Fedify's parser, which is where alternate links are looked for.
		const deps = { fetch, checkHost: () => Promise.resolve(), userAgent: 'Kopje/test' }
		await expect(createContextLoader(deps)(ACTOR)).rejects.toThrow(/alternate/)
		expect(requests).toHaveLength(1)
	})
})
