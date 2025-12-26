import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { makeDB, generateVAPIDKeys, assertStatus, assertCORS, assertJSON } from '@wildebeest/backend/test/utils'

describe('/api/v1/apps', () => {
	test('POST /apps registers client', async () => {
		const db = makeDB()
		const vapidKeys = await generateVAPIDKeys()
		const req = new Request('https://example.com/api/v1/apps', {
			method: 'POST',
			body: '{"redirect_uris":"mastodon://joinmastodon.org/oauth","website":"https://app.joinmastodon.org/ios","client_name":"Mastodon for iOS","scopes":"read write follow push"}',
			headers: {
				'content-type': 'application/json',
			},
		})

		const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		// eslint-disable-next-line unused-imports/no-unused-vars
		const { name, website, redirect_uri, client_id, client_secret, vapid_key, id, ...rest } =
			await res.json<Record<string, string>>()

		assert.equal(name, 'Mastodon for iOS')
		assert.equal(website, 'https://app.joinmastodon.org/ios')
		assert.equal(redirect_uri, 'mastodon://joinmastodon.org/oauth')
		assert.equal(id, '20')
		assert.deepEqual(rest, {})
	})

	test('POST /apps registers client without website', async () => {
		const db = makeDB()
		const vapidKeys = await generateVAPIDKeys()
		const req = new Request('https://example.com/api/v1/apps', {
			method: 'POST',
			body: '{"redirect_uris":"mastodon://example.com/oauth","client_name":"Example mastodon client","scopes":"read write follow push"}',
			headers: {
				'content-type': 'application/json',
			},
		})

		const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		// eslint-disable-next-line unused-imports/no-unused-vars
		const { name, redirect_uri, client_id, client_secret, vapid_key, id, ...rest } =
			await res.json<Record<string, string>>()

		assert.equal(name, 'Example mastodon client')
		assert.equal(redirect_uri, 'mastodon://example.com/oauth')
		assert.equal(id, '20')
		assert.deepEqual(rest, {})
	})

	test('POST /apps returns 422 for malformed requests', async () => {
		// client_name and redirect_uris are required according to https://docs.joinmastodon.org/methods/apps/#form-data-parameters
		const db = makeDB()
		const vapidKeys = await generateVAPIDKeys()
		const headers = { 'content-type': 'application/json' }

		{
			// valid URI
			const req = new Request('https://example.com/api/v1/apps', {
				method: 'POST',
				body: '{"redirect_uris":"urn:ietf:wg:oauth:2.0:oob","client_name":"Mastodon for iOS","scopes":"read write follow push"}',
				headers: headers,
			})

			const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) })
			await assertStatus(res, 200)
		}

		{
			// invalid URI
			const req = new Request('https://example.com/api/v1/apps', {
				method: 'POST',
				body: '{"redirect_uris":"joinmastodon.org/oauth","client_name":"Mastodon for iOS"}',
				headers: headers,
			})
			const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) })
			await assertStatus(res, 422)
		}

		{
			// missing URI
			const req = new Request('https://example.com/api/v1/apps', {
				method: 'POST',
				body: '{"client_name":"Mastodon for iOS"}',
				headers: headers,
			})
			const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) })
			await assertStatus(res, 422)
		}

		{
			// missing Client Name
			const req = new Request('https://example.com/api/v1/apps', {
				method: 'POST',
				body: '{"redirect_uris":"joinmastodon.org/oauth"}',
				headers: headers,
			})
			const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys) })
			await assertStatus(res, 422)
		}
	})
})
