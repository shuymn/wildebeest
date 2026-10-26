import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { harness } from './app-helpers'
import { migratedStore } from './helpers'
import { keyOfRemotePath, REMOTE_SERVED_TYPES, remoteFileKey, remoteMediaPath } from '../src/platform/media-files'
import { REMOTE_MEDIA_TYPES } from '../src/platform/stored-bounds'
import { byteRange } from '../src/web/media'

// GET and HEAD /media/r/<token>/<file> (web/media.ts serveRemoteMedia): only remote/ keys, the stored type checked
// against the extension, exact headers, ranges, conditional answers, and no Store read.

const TOKEN = 'R'.repeat(43)
const BODY = Uint8Array.from({ length: 100 }, (_, i) => i)

async function served(path = `/media/r/${TOKEN}/full.png`, init: RequestInit = {}) {
	const store = await migratedStore()
	const h = harness(store, { MAINTENANCE: 'readonly' })
	return h.request(path, init)
}

describe('remote media keys', () => {
	it('serves the same type map the cache stores, under remote/ only', () => {
		expect(Object.fromEntries(REMOTE_SERVED_TYPES)).toEqual(REMOTE_MEDIA_TYPES)
		expect(remoteFileKey(TOKEN, 'still')).toBe(`remote/${TOKEN}/still`)
		expect(remoteMediaPath(TOKEN, 'full', 'image/png')).toBe(`/media/r/${TOKEN}/full.png`)
		expect(() => remoteFileKey('../x', 'full')).toThrow()
		for (const [token, file] of [
			[TOKEN, 'full.html'],
			[TOKEN, 'full.svg'],
			[TOKEN, 'small.png'],
			[TOKEN, 'original.png'],
			[TOKEN, '../full.png'],
			['short', 'full.png'],
			[`${TOKEN}/..`, 'full.png'],
			[TOKEN, 'full.ogg'],
		] as const) {
			expect(keyOfRemotePath(token, file), `${token} ${file}`).toBeNull()
		}
	})

	it.each([
		['bytes=0-9', { offset: 0, length: 10 }],
		['bytes=10-', { offset: 10 }],
		['bytes=-5', { suffix: 5 }],
		['bytes=5-4', null],
		['bytes=0-1,3-4', null],
		['items=0-1', null],
		['bytes=-', null],
	])('reads the range %s', (header, range) => {
		expect(byteRange(header)).toEqual(range)
	})
})

describe('serveRemoteMedia', () => {
	it('serves a stored file with exact headers, in maintenance and with no Store read', async () => {
		await env.MEDIA.put(`remote/${TOKEN}/full`, BODY, { httpMetadata: { contentType: 'image/png' } })
		const response = await served()
		expect(response.status).toBe(200)
		expect(Object.fromEntries(response.headers)).toEqual({
			'content-type': 'image/png',
			'content-length': '100',
			etag: expect.any(String) as unknown,
			'accept-ranges': 'bytes',
			'cache-control': 'public, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cross-origin-resource-policy': 'cross-origin',
			'access-control-allow-origin': '*',
		})
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BODY)
	})

	it('answers 404 for a type mismatch, an unknown key and a path outside remote/', async () => {
		await env.MEDIA.put(`remote/${TOKEN}/still`, BODY, { httpMetadata: { contentType: 'text/html' } })
		expect((await served(`/media/r/${TOKEN}/still.png`)).status).toBe(404)
		await env.MEDIA.put(`remote/${'S'.repeat(43)}/full`, BODY, { httpMetadata: { contentType: 'image/png' } })
		expect((await served(`/media/r/${'S'.repeat(43)}/full.gif`)).status).toBe(404)
		expect((await served(`/media/r/${'Q'.repeat(43)}/full.png`)).status).toBe(404)
		expect((await served(`/media/r/x/full.png`)).status).toBe(404)
	})

	it('answers ranges with 206, an unsatisfiable one with 416, and a multi-part one with the whole file', async () => {
		await env.MEDIA.put(`remote/${TOKEN}/full`, BODY, { httpMetadata: { contentType: 'image/png' } })
		const ranged = async (range: string) => served(undefined, { headers: { range } })
		for (const [range, status, contentRange, length] of [
			['bytes=0-9', 206, 'bytes 0-9/100', 10],
			['bytes=10-', 206, 'bytes 10-99/100', 90],
			['bytes=-5', 206, 'bytes 95-99/100', 5],
			['bytes=100-', 416, 'bytes */100', 0],
			['bytes=-0', 416, 'bytes */100', 0],
			['bytes=0-1,5-6', 200, null, 100],
		] as const) {
			const response = await ranged(range)
			expect(response.status, range).toBe(status)
			expect(response.headers.get('content-range'), range).toBe(contentRange)
			expect((await response.arrayBuffer()).byteLength, range).toBe(length)
		}
	})

	it('answers HEAD without a body, and 304 to a matching If-None-Match', async () => {
		await env.MEDIA.put(`remote/${TOKEN}/full`, BODY, { httpMetadata: { contentType: 'image/png' } })
		const head = await served(undefined, { method: 'HEAD' })
		expect(head.status).toBe(200)
		expect(head.headers.get('content-length')).toBe('100')
		const etag = head.headers.get('etag')!
		expect((await served(undefined, { headers: { 'if-none-match': etag } })).status).toBe(304)
		expect((await served(undefined, { method: 'HEAD', headers: { 'if-none-match': etag } })).status).toBe(304)
		expect((await served(undefined, { headers: { 'if-none-match': '"other"' } })).status).toBe(200)
	})
})
