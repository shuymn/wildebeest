import { strict as assert } from 'node:assert/strict'

import * as middleware_main from 'wildebeest/backend/src/middleware/main'

import { ACCESS_CERTS, TEST_JWT } from './test-data'
import { assertCORS, assertStatus, createTestUser, isUrlValid, makeDB } from './utils'

const userKEK = 'test_kek12'
const domain = 'cloudflare.com'
const accessDomain = 'access.com'
const accessAud = 'abcd'

describe('middleware', () => {
	test('CORS on OPTIONS', async () => {
		const request = new Request('https://example.com', { method: 'OPTIONS' })
		const ctx: any = {
			request,
		}

		const res = await middleware_main.main(ctx)
		await assertStatus(res, 200)
		assertCORS(res)
	})

	test('test no identity', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/certs') {
					return new Response(JSON.stringify(ACCESS_CERTS))
				}

				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/get-identity') {
					return new Response('', { status: 404 })
				}
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}

		const db = await makeDB()

		const headers = { authorization: 'Bearer APPID.' + TEST_JWT }
		const request = new Request('https://example.com', { headers })
		const ctx: any = {
			env: { DATABASE: db },
			data: {},
			request,
		}

		const res = await middleware_main.main(ctx)
		await assertStatus(res, 401)
	})

	test('test user not found', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/certs') {
					return new Response(JSON.stringify(ACCESS_CERTS))
				}

				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/get-identity') {
					return new Response(
						JSON.stringify({
							email: 'some@cloudflare.com',
						})
					)
				}
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}

		const db = await makeDB()

		const headers = { authorization: 'Bearer APPID.' + TEST_JWT }
		const request = new Request('https://example.com', { headers })
		const ctx: any = {
			env: { DATABASE: db },
			data: {},
			request,
		}

		const res = await middleware_main.main(ctx)
		await assertStatus(res, 401)
	})

	test('success passes data and calls next', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/certs') {
					return new Response(JSON.stringify(ACCESS_CERTS))
				}

				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/get-identity') {
					return new Response(
						JSON.stringify({
							email: 'sven@cloudflare.com',
						})
					)
				}
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}

		const db = await makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const headers = { authorization: 'Bearer APPID.' + TEST_JWT }
		const request = new Request('https://example.com', { headers })
		const ctx: any = {
			next: () => new Response(),
			data: {},
			env: { DATABASE: db, ACCESS_AUD: accessAud, ACCESS_AUTH_DOMAIN: accessDomain },
			request,
		}

		const res = await middleware_main.main(ctx)
		await assertStatus(res, 200)
		assert(!ctx.data.connectedUser)
		assert(isUrlValid(ctx.data.connectedActor.id))
		assert.equal(ctx.env.ACCESS_AUTH_DOMAIN, accessDomain)
		assert.equal(ctx.env.ACCESS_AUD, accessAud)
	})
})
