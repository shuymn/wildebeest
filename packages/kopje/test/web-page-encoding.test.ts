import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { fetchWebPage, WEB_PAGE_BODY_LIMIT, type WebPageDeps } from '../src/federation/web-page'

// Compressed web pages through workerd's fetch path, served with exact bytes from Node (test-node/web-page-fixtures.ts).

const fixtures = (env as unknown as { WEB_PAGE_FIXTURES: Fetcher }).WEB_PAGE_FIXTURES

function fixture(path: string): Promise<Response> {
	return fixtures.fetch(new Request(`https://fixtures.example${path}`, { redirect: 'manual' }))
}

async function bytesOf(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer())
}

const GZIP_MAGIC = [0x1f, 0x8b]

describe('workerd Content-Encoding facts', () => {
	it.each(['gzip', 'br'])('decodes a body whose Content-Encoding is exactly %s', async (name) => {
		const response = await fixture(`/${name === 'gzip' ? 'gzip' : 'br'}`)
		expect(response.headers.get('content-encoding')).toBe(name)
		expect(new TextDecoder().decode(await bytesOf(response))).toContain('<title>compressed</title>')
	})

	it.each(['GZIP', 'gzip,', 'x-gzip', 'gzip, identity'])(
		'passes a gzip body labelled %j through undecoded',
		async (value) => {
			const response = await fixture(`/gzip?encoding=${encodeURIComponent(value)}`)
			expect(response.headers.get('content-encoding')).toBe(value)
			expect([...(await bytesOf(response)).subarray(0, 2)]).toEqual(GZIP_MAGIC)
		}
	)

	it('passes a doubly gzipped body labelled "gzip, gzip" through undecoded', async () => {
		const response = await fixture('/gzip-gzip')
		expect([...(await bytesOf(response)).subarray(0, 2)]).toEqual(GZIP_MAGIC)
	})

	it.each([
		['deflate', [0x78]],
		['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
	])('passes a %s body through undecoded', async (name, magic) => {
		const response = await fixture(`/${name}`)
		expect([...(await bytesOf(response)).subarray(0, magic.length)]).toEqual(magic)
	})

	it.each(['corrupt-gzip', 'corrupt-br'])('fails reading a %s body', async (name) => {
		const response = await fixture(`/${name}`)
		await expect(response.arrayBuffer()).rejects.toThrow()
	})

	it('closes the upstream connection when a decoded body is cancelled', async () => {
		const id = crypto.randomUUID()
		const response = await fixture(`/stall?id=${id}`)
		const reader = (response.body as ReadableStream<Uint8Array>).getReader()
		const { value } = await reader.read()
		expect(new TextDecoder().decode(value)).toContain('<title>compressed</title>')
		await reader.cancel()
		let closed = false
		for (let i = 0; i < 100 && !closed; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20))
			closed = (await (await fixture(`/closed?id=${id}`)).json()) === true
		}
		expect(closed).toBe(true)
	})
})

const deps: WebPageDeps = {
	// For the suite only: production deps.fetch is the global fetch (federation/web-page.ts).
	fetch: (input: RequestInfo | URL, init?: RequestInit) => fixtures.fetch(new Request(input, init)),
	checkHost: () => Promise.resolve(),
	refusesHost: () => Promise.resolve(false),
	userAgent: 'Kopje/test',
	now: () => Date.now(),
}

async function closedUpstream(id: string): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		if ((await (await fixture(`/closed?id=${id}`)).json()) === true) {
			return true
		}
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	return false
}

describe('web page sink over compressed bodies', () => {
	it("NET-3: decodes compressed bodies through workerd's fetch path and cancels them at the cap", async () => {
		for (const path of ['/gzip', '/br']) {
			const result = await fetchWebPage(`https://fixtures.example${path}`, deps)
			expect(result).toMatchObject({
				ok: true,
				limitReached: false,
				scan: { title: 'compressed', relMe: ['https://actor.example/u/a'] },
			})
		}
		// 16 MiB of zeros in about 16 KiB of gzip: read up to the cap and one byte, decoded.
		expect(await fetchWebPage('https://fixtures.example/bomb', deps)).toMatchObject({
			ok: true,
			limitReached: true,
			cost: { bytes: WEB_PAGE_BODY_LIMIT + 1 },
			scan: { relMe: ['https://actor.example/u/a'] },
		})
		// A body that never ends: cancelled at the cap, which closes the upstream connection.
		const id = crypto.randomUUID()
		expect(await fetchWebPage(`https://fixtures.example/stall?id=${id}`, deps, { maxBytes: 4096 })).toMatchObject({
			ok: true,
			limitReached: true,
			cost: { bytes: 4097 },
		})
		expect(await closedUpstream(id)).toBe(true)
	})

	it('fails a corrupt gzip or br body as a network failure, with no scan', async () => {
		for (const path of ['/corrupt-gzip', '/corrupt-br']) {
			expect(await fetchWebPage(`https://fixtures.example${path}`, deps)).toMatchObject({
				ok: false,
				kind: 'network',
				transient: true,
			})
		}
	})

	it.each([
		'/deflate',
		'/zstd',
		'/gzip-gzip',
		`/gzip?encoding=GZIP`,
		`/gzip?encoding=${encodeURIComponent('gzip,')}`,
		`/gzip-gzip?encoding=${encodeURIComponent('gzip,gzip')}`,
		`/gzip?encoding=x-gzip`,
	])('refuses %s, which workerd passes through undecoded', async (path) => {
		expect(await fetchWebPage(`https://fixtures.example${path}`, deps)).toMatchObject({
			ok: false,
			kind: 'encoding',
			reason: 'unsupported-encoding',
		})
	})

	it('cancels a stalled body at the deadline, closing the upstream connection', async () => {
		const id = crypto.randomUUID()
		const result = await fetchWebPage(`https://fixtures.example/stall?id=${id}&zeros=0`, deps, { timeoutMs: 300 })
		expect(result).toMatchObject({ ok: false, kind: 'timeout' })
		expect(await closedUpstream(id)).toBe(true)
	})
})
