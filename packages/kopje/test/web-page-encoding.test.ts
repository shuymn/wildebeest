import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

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
