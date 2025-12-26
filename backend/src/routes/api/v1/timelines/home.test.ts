import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { makeDB, createTestUser, makeCache, makeDOCache } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek6'
const domain = 'cloudflare.com'

describe('/api/v1/timelines/home', () => {
	test('home returns cache', async () => {
		const db = makeDB()
		const cache = makeCache()
		const doCache = makeDOCache(cache)

		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		await cache.put(connectedActor.id.toString() + '/timeline/home', 12345)

		const req = new Request(`https://${domain}/api/v1/timelines/home`)
		const res = await app.fetch(req, { DO_CACHE: doCache, data: { connectedActor } })
		assert.equal(await res.json(), 12345)
	})

	test('home returns empty if not in cache', async () => {
		const db = makeDB()
		const cache = makeCache()
		const doCache = makeDOCache(cache)

		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/timelines/home`)
		const res = await app.fetch(req, { DO_CACHE: doCache, data: { connectedActor } })
		const posts = await res.json<unknown[]>()

		assert.equal(posts.length, 0)
	})
})
