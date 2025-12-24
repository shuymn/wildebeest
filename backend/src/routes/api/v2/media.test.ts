import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import {
	getObjectByMastodonId,
	mastodonIdSymbol,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { makeDB, createTestUser, assertStatus, assertJSON, isUrlValid } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek10'
const CF_ACCOUNT_ID = 'testaccountid'
const CF_API_TOKEN = 'testtoken'
const domain = 'cloudflare.com'

describe('/api/v2/media', () => {
	test('upload image creates object', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			const request = new Request(input)
			if (request.url.toString() === 'https://api.cloudflare.com/client/v4/accounts/testaccountid/images/v1') {
				return new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'abcd',
							variants: ['https://example.com/' + file.name + '/usercontent'],
						},
					})
				)
			}
			throw new Error('unexpected request to ' + request.url)
		}

		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const file = new File(['abc'], 'image.jpeg', { type: 'image/jpeg' })

		const body = new FormData()
		body.set('file', file)

		const req = new Request('https://example.com/api/v2/media', {
			method: 'POST',
			body,
		})
		const res = await app.fetch(req, { DATABASE: db, CF_ACCOUNT_ID, CF_API_TOKEN, data: { connectedActor } })
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<{ id: string; url: string; preview_url: string }>()
		assert(!isUrlValid(data.id))
		assert(isUrlValid(data.url))
		assert(isUrlValid(data.preview_url))

		const obj = await getObjectByMastodonId(domain, db, data.id)
		assert(obj)
		assert(obj[mastodonIdSymbol])
		assert.equal(obj.type, 'Image')
		assert.equal(obj[originalActorIdSymbol], connectedActor.id.toString())
	})
})
