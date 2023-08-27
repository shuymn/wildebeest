import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { createClientCredential } from 'wildebeest/backend/src/mastodon/client'
import { VAPIDPublicKey } from 'wildebeest/backend/src/mastodon/subscription'
import { TEST_JWT } from 'wildebeest/backend/test/test-data'
import {
	makeDB,
	generateVAPIDKeys,
	assertStatus,
	assertCORS,
	assertJSON,
	createTestClient,
	createTestUser,
} from 'wildebeest/backend/test/utils'

const domain = 'example.com'
const userKEK = 'test-kek'

describe('/api/v1/apps/verify_credentials', () => {
	test('GET /verify_credentials returns public VAPID key for known clients', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')

		const testScope = 'test abcd'
		const client = await createTestClient(db, 'https://localhost', testScope)
		const vapidKeys = await generateVAPIDKeys()

		{
			const headers = { authorization: 'Bearer ' + client.id + '.' + TEST_JWT }
			const req = new Request('https://example.com/api/v1/apps/verify_credentials', { headers })
			const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys), data: { connectedActor } })
			await assertStatus(res, 200)
			assertCORS(res, req)
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
			const req = new Request('https://example.com/api/v1/apps/verify_credentials', { headers })
			const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys), data: { connectedActor } })
			await assertStatus(res, 200)
			assertCORS(res, req)
			assertJSON(res)

			const jsonResponse = await res.json<{ name: unknown; website: unknown; vapid_key: unknown }>()
			const publicVAPIDKey = VAPIDPublicKey(vapidKeys)
			assert.equal(jsonResponse.name, 'test client')
			assert.equal(jsonResponse.website, 'https://cloudflare.com')
			assert.equal(jsonResponse.vapid_key, publicVAPIDKey)
		}
	})

	test('GET /verify_credentials returns 401 for unauthorized clients', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')

		const vapidKeys = await generateVAPIDKeys()
		const headers = { authorization: 'Bearer APPID.' + TEST_JWT }
		const req = new Request('https://example.com/api/v1/apps/verify_credentials', { headers })
		const res = await app.fetch(req, { DATABASE: db, VAPID_JWK: JSON.stringify(vapidKeys), data: { connectedActor } })
		await assertStatus(res, 401)
		expect(await res.text()).toMatch(/the access token is invalid/)
	})
})
