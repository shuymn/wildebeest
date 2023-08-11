import { strict as assert } from 'node:assert/strict'

import { myz, readBody } from 'wildebeest/backend/src/utils'
import {
	actorToAcct,
	actorToHandle,
	handleToAcct,
	isLocalHandle,
	parseHandle,
	toRemoteHandle,
} from 'wildebeest/backend/src/utils/handle'
import { signRequest } from 'wildebeest/backend/src/utils/http-signing'
import { generateDigestHeader } from 'wildebeest/backend/src/utils/http-signing-cavage'
import { parseRequest } from 'wildebeest/backend/src/utils/httpsigjs/parser'
import { verifySignature } from 'wildebeest/backend/src/utils/httpsigjs/verifier'
import { generateMastodonId } from 'wildebeest/backend/src/utils/id'
import { generateUserKey, importPublicKey, unwrapPrivateKey } from 'wildebeest/backend/src/utils/key-ops'
import { z } from 'zod'

import { createTestUser, hexToBytes, makeDB } from './utils'

describe('utils', () => {
	test('user key lifecycle', async () => {
		const userKEK = 'userkey'
		const userKeyPair = await generateUserKey(userKEK)
		await unwrapPrivateKey(userKEK, userKeyPair.wrappedPrivKey, userKeyPair.salt)
		await importPublicKey(userKeyPair.pubKey)
	})

	test('request signing', async () => {
		const body = '{"foo": "bar"}'
		const digest = await generateDigestHeader(body)
		const request = new Request('https://example.com', {
			method: 'POST',
			body: body,
			headers: { header1: 'value1', Digest: digest },
		})
		const userKEK = 'userkey'
		const userKeyPair = await generateUserKey(userKEK)
		const privateKey = await unwrapPrivateKey(userKEK, userKeyPair.wrappedPrivKey, userKeyPair.salt)
		const keyid = new URL('https://foo.com/key')
		await signRequest(request, privateKey, keyid)
		assert(request.headers.has('Signature'), 'no signature in signed request')

		const parsedSignature = parseRequest(request)
		const publicKey = await importPublicKey(userKeyPair.pubKey)
		assert(await verifySignature(parsedSignature, publicKey), 'verify signature failed')
	})

	test('handle parsing', async () => {
		let res

		assert.throws(() => parseHandle(''), { message: /invalid handle/ })

		res = parseHandle('@a')
		assert.equal(res.localPart, 'a')
		assert.equal(res.domain, null)

		res = parseHandle('a')
		assert.equal(res.localPart, 'a')
		assert.equal(res.domain, null)

		res = parseHandle('@a@remote.com')
		assert.equal(res.localPart, 'a')
		assert.equal(res.domain, 'remote.com')

		res = parseHandle('a@remote.com')
		assert.equal(res.localPart, 'a')
		assert.equal(res.domain, 'remote.com')

		res = parseHandle('a%40masto.ai')
		assert.equal(res.localPart, 'a')
		assert.equal(res.domain, 'masto.ai')
	})

	test('actor to acct', async () => {
		const domain = 'example.com'
		const userKEK = 'userkey'
		const db = await makeDB()

		let actor = await createTestUser(domain, db, userKEK, 'alice1@cloudflare.com')
		let res = actorToAcct(actor, domain)
		assert.equal(res, 'alice1')

		actor = await createTestUser(domain, db, userKEK, 'alice2@cloudflare.com', { preferredUsername: 'bob' })
		res = actorToAcct(actor, 'cloudflare.com')
		assert.equal(res, 'bob@example.com')
	})

	test('actor to handle', async () => {
		const domain = 'example.com'
		const userKEK = 'userkey'
		const db = await makeDB()

		{
			const actor = await createTestUser(domain, db, userKEK, 'alice1@cloudflare.com')
			const handle = actorToHandle(actor)
			assert.equal(handle.localPart, 'alice1')
			assert.equal(handle.domain, 'example.com')
		}

		{
			const actor = await createTestUser(domain, db, userKEK, 'alice2@cloudflare.com', { preferredUsername: 'bob' })
			const res = actorToHandle(actor)
			assert.equal(res.localPart, 'bob')
			assert.equal(res.domain, 'example.com')
		}
	})

	test('handle is LocalHandle', () => {
		assert.equal(isLocalHandle({ localPart: 'a', domain: null }), true)
		assert.equal(isLocalHandle({ localPart: 'a', domain: 'b' }), false)
	})

	test('handle to RemoteHandle', () => {
		{
			const local = { localPart: 'a', domain: null }
			const res = toRemoteHandle(local, 'b')
			assert.equal(res.localPart, 'a')
			assert.equal(res.domain, 'b')
		}

		{
			const remote = { localPart: 'a', domain: 'b' }
			const res = toRemoteHandle(remote, 'c')
			assert.equal(res.localPart, 'a')
			assert.equal(res.domain, 'b')
		}
	})

	test('handle to acct', () => {
		const handle = { localPart: 'a', domain: 'b' }
		assert.equal(handleToAcct(handle), 'a@b')
	})

	test('read body handles empty body', async () => {
		{
			const req = new Request('https://a.com', { method: 'POST' })
			const result = await readBody(req, { a: z.number().optional() })
			assert.ok(result.success)
		}
		{
			const req = new Request('https://a.com', { method: 'POST' })
			const result = await readBody(req, z.number().optional())
			assert.ok(!result.success)
		}
	})

	test('read body handles JSON', async () => {
		const headers = {
			'content-type': 'application/json;charset=utf-8',
		}
		{
			const body = JSON.stringify({ a: 1 })
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, { a: z.number() })
			assert(result.success)
			assert.equal(result.data.a, 1)
		}
		{
			const body = JSON.stringify({ a: 1, b: '2' })
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, {
				a: z.number(),
				b: z.number(),
			})
			assert.ok(!result.success)
		}
		{
			const body = JSON.stringify({ a: 1, b: ['a', 'b'] })
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, {
				a: z.number(),
				b: z.string().array().length(2).optional(),
				c: z.string().array().length(2).optional(),
			})
			assert.ok(result.success)
		}
	})

	test('read body handles FormData', async () => {
		{
			const body = new FormData()
			body.append('a', '1')

			const headers = {}
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, { a: myz.numeric() })
			assert(result.success)
			assert.equal(result.data.a, 1)
		}
		{
			const body = new FormData()
			body.append('a', 'hello')
			body.append('a', 'world')
			const headers = {}
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, { a: z.string() })
			assert(result.success)
			assert.equal(result.data.a, 'world')
		}
		{
			const body = new FormData()
			body.append('a', '1')
			body.append('b', '2')

			const headers = {}
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, {
				a: myz.numeric(),
				b: z.optional(myz.numeric()),
				c: myz.logical().default(false),
				d: z.optional(myz.numeric()),
			})
			assert(result.success)
			assert.equal(result.data.a, 1)
			assert.equal(result.data.b, 2)
			assert.equal(result.data.c, false)
			assert.equal(result.data.d, undefined)
		}
		{
			const body = new FormData()
			body.append('a[]', '1')
			body.append('a[]', '2')
			body.append('a', '3')

			const headers = {}
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, {
				a: myz.numeric().array().length(2),
			})
			assert(result.success)
			assert.equal(result.data.a.length, 2)
			assert.equal(result.data.a[0], 1)
			assert.equal(result.data.a[1], 2)
		}
	})

	test('read body handles URL encoded', async () => {
		{
			const body = new URLSearchParams({ a: '1' })
			const headers = {
				'content-type': 'application/x-www-form-urlencoded',
			}
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, { a: myz.numeric() })
			assert(result.success)
			assert.equal(result.data.a, 1)
		}
		{
			const body = new URLSearchParams()
			body.append('a[]', 'hello')
			body.append('a[]', 'world')

			const headers = {
				'content-type': 'application/x-www-form-urlencoded',
			}
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, { a: z.array(z.string()) })
			assert(result.success)
			assert.equal(result.data.a.length, 2)
			assert.equal(result.data.a[0], 'hello')
			assert.equal(result.data.a[1], 'world')
		}
		{
			const body = new URLSearchParams({ a: '1', b: '2' })

			const headers = {
				'content-type': 'application/x-www-form-urlencoded',
			}
			const req = new Request('https://a.com', { method: 'POST', headers, body })

			const result = await readBody(req, {
				a: myz.numeric(),
				b: z.optional(myz.numeric()),
				c: z.optional(myz.numeric()),
			})
			assert(result.success)
			assert.equal(result.data.a, 1)
			assert.equal(result.data.b, 2)
			assert.equal(result.data.c, undefined)
		}
	})

	test('generate mastodon id', async () => {
		let count = 0
		Object.defineProperty(globalThis, 'crypto', {
			value: {
				getRandomValues: (b: Uint8Array): Uint8Array => {
					if (count === 0 || count === 1) {
						b.set(hexToBytes('0123456789abcdef0123456789abcdef'))
					} else {
						b.set(hexToBytes('0123456789abcdef0123456789ghijkl'))
					}
					count = count + 1
					return b
				},
				subtle: {
					// eslint-disable-next-line @typescript-eslint/unbound-method
					digest: crypto.subtle.digest,
				},
			},
		})
		const db = await makeDB()

		const id1 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.001Z'))
		assert.equal(id1, '109535204409443108')
		const first = await db
			.prepare(`SELECT value FROM id_sequences WHERE key = 'test_id_seq'`)
			.first<{ value: number }>()
		assert.equal(first?.value, 1)

		const id2 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.002Z'))
		assert.equal(id2, '109535204409475804')
		const second = await db
			.prepare(`SELECT value FROM id_sequences WHERE key = 'test_id_seq'`)
			.first<{ value: number }>()
		assert.equal(second?.value, 2)

		const id3 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.002Z'))
		assert.ok(id3 !== id2)

		const id4 = await generateMastodonId(db, 'test', new Date('2022-12-18T14:42:59.003Z'))
		assert.ok(id4 > id3)
	})
})
