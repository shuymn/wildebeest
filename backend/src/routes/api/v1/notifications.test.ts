import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { makeDB, createTestUser, makeCache, makeDOCache } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek15'
const domain = 'cloudflare.com'

describe('/api/v1/notifications', () => {
	test('returns notifications stored in KV cache', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const cache = makeCache()
		await cache.put(connectedActor.id.toString() + '/notifications', 12345)
		const doCache = makeDOCache(cache)

		const req = new Request(`https://${domain}/api/v1/notifications`)
		const res = await app.fetch(req, { DATABASE: db, DO_CACHE: doCache, data: { connectedActor } })
		assert.equal(await res.json(), 12345)
	})
})
