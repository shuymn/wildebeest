import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { getObjectByMastodonId, mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { createImage, Image } from 'wildebeest/backend/src/activitypub/objects/image'
import { makeDB, createTestUser, assertStatus } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek10'
const domain = 'cloudflare.com'

describe('/api/v2/media/[id]', () => {
	test('update image description', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const image = await createImage(domain, db, connectedActor, {
			url: 'https://cloudflare.com/image.jpg',
			description: 'foo bar',
		})

		const req = new Request(`https://${domain}/api/v2/media/${image[mastodonIdSymbol]}`, {
			method: 'PUT',
			body: JSON.stringify({ description: 'new foo bar' }),
			headers: {
				'content-type': 'application/json',
			},
		})

		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)

		const data = await res.json<{ description: unknown }>()
		assert.equal(data.description, 'new foo bar')

		const newImage = await getObjectByMastodonId(domain, db, image[mastodonIdSymbol]!)
		assert.ok(newImage)
		assert.equal((newImage as Image).description, 'new foo bar')
	})
})
