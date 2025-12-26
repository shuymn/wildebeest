import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { ACCESS_CERTS, TEST_JWT } from '@wildebeest/backend/test/test-data'
import { makeDB, assertStatus, createTestClient, assertCORS } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek3'
const accessDomain = 'access.com'
const accessAud = 'abcd'

describe('/oauth/authorize', () => {
	beforeEach(() => {
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
	})

	test('authorize missing params', async () => {
		const db = makeDB()

		{
			const req = new Request('https://example.com/oauth/authorize', { method: 'POST' })
			const res = await app.fetch(req, {
				DATABASE: db,
				userKEK,
				ACCESS_AUTH_DOMAIN: accessDomain,
				ACCESS_AUD: accessAud,
			})
			await assertStatus(res, 401)
		}

		const headers = {
			'Cf-Access-Jwt-Assertion': TEST_JWT,
		}

		{
			const req = new Request('https://example.com/oauth/authorize', { headers, method: 'POST' })
			const res = await app.fetch(req, {
				DATABASE: db,
				userKEK,
				ACCESS_AUTH_DOMAIN: accessDomain,
				ACCESS_AUD: accessAud,
			})
			await assertStatus(res, 400)
		}

		{
			const req = new Request('https://example.com/oauth/authorize?scope=foobar', { headers, method: 'POST' })
			const res = await app.fetch(req, {
				DATABASE: db,
				userKEK,
				ACCESS_AUTH_DOMAIN: accessDomain,
				ACCESS_AUD: accessAud,
			})
			await assertStatus(res, 400)
		}
	})

	test('authorize unsupported response_type', async () => {
		const db = makeDB()

		const headers = {
			'Cf-Access-Jwt-Assertion': TEST_JWT,
		}

		const params = new URLSearchParams({
			redirect_uri: 'https://example.com',
			response_type: 'hein',
			client_id: 'client_id',
		})

		const req = new Request('https://example.com/oauth/authorize?' + params.toString(), { headers, method: 'POST' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			ACCESS_AUTH_DOMAIN: accessDomain,
			ACCESS_AUD: accessAud,
		})
		await assertStatus(res, 400)
	})

	test("authorize redirect_uri doesn't match client redirect_uris", async () => {
		const db = makeDB()
		const client = await createTestClient(db, 'https://redirect.com')

		const params = new URLSearchParams({
			redirect_uri: 'https://example.com/a',
			response_type: 'code',
			client_id: client.id,
		})

		const headers = { 'Cf-Access-Jwt-Assertion': TEST_JWT }

		const req = new Request('https://example.com/oauth/authorize?' + params.toString(), {
			headers,
			method: 'POST',
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			ACCESS_AUTH_DOMAIN: accessDomain,
			ACCESS_AUD: accessAud,
		})
		await assertStatus(res, 422)
	})

	test('authorize redirects with code on success and show first login', async () => {
		const db = makeDB()
		const client = await createTestClient(db)

		const params = new URLSearchParams({
			redirect_uri: client.redirect_uris,
			response_type: 'code',
			client_id: client.id,
			state: 'mock-state',
		})

		const headers = { 'Cf-Access-Jwt-Assertion': TEST_JWT }

		const req = new Request('https://example.com/oauth/authorize?' + params.toString(), {
			headers,
			method: 'POST',
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			ACCESS_AUTH_DOMAIN: accessDomain,
			ACCESS_AUD: accessAud,
		})
		await assertStatus(res, 302)

		const location = new URL(res.headers.get('location') || '')
		assert.equal(
			location.searchParams.get('redirect_uri'),
			encodeURIComponent(`${client.redirect_uris}?code=${client.id}.${TEST_JWT}&state=mock-state`)
		)

		// actor isn't created yet
		const row = await db.prepare('SELECT count(*) as count FROM actors').first<{ count: number }>()
		assert.ok(row)
		assert.equal(row.count, 0)
	})

	test('authorize returns CORS', async () => {
		const db = makeDB()
		const req = new Request('https://example.com/oauth/authorize', {
			method: 'OPTIONS',
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			ACCESS_AUTH_DOMAIN: accessDomain,
			ACCESS_AUD: accessAud,
		})
		await assertStatus(res, 204)
		assertCORS(res, req)
	})
})
