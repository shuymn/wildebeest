import { strict as assert } from 'node:assert/strict'

import { createClientCredential } from 'wildebeest/backend/src/mastodon/client'
import { VAPIDPublicKey } from 'wildebeest/backend/src/mastodon/subscription'
import * as apps from 'wildebeest/functions/api/v1/apps'
import * as verify_app from 'wildebeest/functions/api/v1/apps/verify_credentials'

import { TEST_JWT } from '../test-data'
import { assertCORS, assertJSON, assertStatus, createTestClient, generateVAPIDKeys, makeDB } from '../utils'

describe('Mastodon APIs', () => {
	describe('/apps', () => {
		test('POST /apps registers client', async () => {
			const db = await makeDB()
			const vapidKeys = await generateVAPIDKeys()
			const request = new Request('https://example.com', {
				method: 'POST',
				body: '{"redirect_uris":"mastodon://joinmastodon.org/oauth","website":"https://app.joinmastodon.org/ios","client_name":"Mastodon for iOS","scopes":"read write follow push"}',
				headers: {
					'content-type': 'application/json',
				},
			})

			const res = await apps.onRequestPost({
				request,
				env: { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)
			assertCORS(res)
			assertJSON(res)

			// eslint-disable-next-line unused-imports/no-unused-vars
			const { name, website, redirect_uri, client_id, client_secret, vapid_key, id, ...rest } = await res.json<
				Record<string, string>
			>()

			assert.equal(name, 'Mastodon for iOS')
			assert.equal(website, 'https://app.joinmastodon.org/ios')
			assert.equal(redirect_uri, 'mastodon://joinmastodon.org/oauth')
			assert.equal(id, '20')
			assert.deepEqual(rest, {})
		})

		test('POST /apps registers client without website', async () => {
			const db = await makeDB()
			const vapidKeys = await generateVAPIDKeys()
			const request = new Request('https://example.com', {
				method: 'POST',
				body: '{"redirect_uris":"mastodon://example.com/oauth","client_name":"Example mastodon client","scopes":"read write follow push"}',
				headers: {
					'content-type': 'application/json',
				},
			})

			const res = await apps.onRequestPost({
				request,
				env: { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)
			assertCORS(res)
			assertJSON(res)

			// eslint-disable-next-line unused-imports/no-unused-vars
			const { name, redirect_uri, client_id, client_secret, vapid_key, id, ...rest } = await res.json<
				Record<string, string>
			>()

			assert.equal(name, 'Example mastodon client')
			assert.equal(redirect_uri, 'mastodon://example.com/oauth')
			assert.equal(id, '20')
			assert.deepEqual(rest, {})
		})

		test('POST /apps returns 422 for malformed requests', async () => {
			// client_name and redirect_uris are required according to https://docs.joinmastodon.org/methods/apps/#form-data-parameters
			const db = await makeDB()
			const vapidKeys = await generateVAPIDKeys()
			const headers = { 'content-type': 'application/json' }

			const validURIException = new Request('https://example.com', {
				method: 'POST',
				body: '{"redirect_uris":"urn:ietf:wg:oauth:2.0:oob","client_name":"Mastodon for iOS","scopes":"read write follow push"}',
				headers: headers,
			})
			let res = await apps.onRequestPost({
				request: validURIException,
				env: { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const invalidURIRequest = new Request('https://example.com', {
				method: 'POST',
				body: '{"redirect_uris":"joinmastodon.org/oauth","client_name":"Mastodon for iOS"}',
				headers: headers,
			})
			res = await apps.onRequestPost({
				request: invalidURIRequest,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 422)

			const missingURIRequest = new Request('https://example.com', {
				method: 'POST',
				body: '{"client_name":"Mastodon for iOS"}',
				headers: headers,
			})
			res = await apps.onRequestPost({
				request: missingURIRequest,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 422)

			const missingClientNameRequest = new Request('https://example.com', {
				method: 'POST',
				body: '{"redirect_uris":"joinmastodon.org/oauth"}',
				headers: headers,
			})
			res = await apps.onRequestPost({
				request: missingClientNameRequest,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 422)
		})

		test('GET /verify_credentials returns public VAPID key for known clients', async () => {
			const db = await makeDB()
			const testScope = 'test abcd'
			const client = await createTestClient(db, 'https://localhost', testScope)
			const vapidKeys = await generateVAPIDKeys()

			{
				const headers = { authorization: 'Bearer ' + client.id + '.' + TEST_JWT }
				const req = new Request('https://example.com/api/v1/verify_credentials', { headers })
				const res = await verify_app.onRequestGet({
					request: req,
					env: { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) },
				} as any)
				await assertStatus(res, 200)
				assertCORS(res)
				assertJSON(res)

				const jsonResponse = await res.json<{ name: unknown; website: unknown; vapid_key: unknown }>()
				const publicVAPIDKey = VAPIDPublicKey(vapidKeys)
				assert.equal(jsonResponse.name, 'test client')
				assert.equal(jsonResponse.website, 'https://cloudflare.com')
				assert.equal(jsonResponse.vapid_key, publicVAPIDKey)
			}
			{
				const [secret] = await createClientCredential(db, client.id, client.scopes)
				const headers = { authorization: 'Bearer ' + secret }
				const req = new Request('https://example.com/api/v1/verify_credentials', { headers })
				const res = await verify_app.onRequestGet({
					request: req,
					env: { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) },
				} as any)
				await assertStatus(res, 200)
				assertCORS(res)
				assertJSON(res)

				const jsonResponse = await res.json<{ name: unknown; website: unknown; vapid_key: unknown }>()
				const publicVAPIDKey = VAPIDPublicKey(vapidKeys)
				assert.equal(jsonResponse.name, 'test client')
				assert.equal(jsonResponse.website, 'https://cloudflare.com')
				assert.equal(jsonResponse.vapid_key, publicVAPIDKey)
			}
		})

		test('GET /verify_credentials returns 403 for unauthorized clients', async () => {
			const db = await makeDB()
			const vapidKeys = await generateVAPIDKeys()

			const headers = { authorization: 'Bearer APPID.' + TEST_JWT }

			const req = new Request('https://example.com/api/v1/verify_credentials', { headers })

			const res = await verify_app.onRequestGet({
				request: req,
				env: { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) },
			} as any)
			await assertStatus(res, 401)
		})
	})
})
