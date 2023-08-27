import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { makeDB, createTestUser, assertStatus, assertCORS, assertJSON } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/relationships', () => {
	test('relationships missing ids', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request('https://mastodon.example/api/v1/accounts/relationships')
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 400)
	})

	test('relationships with ids', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request('https://mastodon.example/api/v1/accounts/relationships?id[]=first&id[]=second')
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		const data = await res.json<Array<any>>()
		assert.equal(data.length, 2)
		assert.equal(data[0].id, 'first')
		assert.equal(data[0].following, false)
		assert.equal(data[1].id, 'second')
		assert.equal(data[1].following, false)
	})

	test('relationships with one id', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request('https://mastodon.example/api/v1/accounts/relationships?id[]=first')
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		const data = await res.json<any[]>()
		assert.equal(data.length, 1)
		assert.equal(data[0].id, 'first')
		assert.equal(data[0].following, false)
	})

	test('relationships following', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		await addFollowing(domain, db, actor, actor2)
		await acceptFollowing(db, actor, actor2)

		const req = new Request('https://mastodon.example/api/v1/accounts/relationships?id[]=' + actor2[mastodonIdSymbol])
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<any[]>()
		assert.equal(data.length, 1)
		assert.equal(data[0].following, true)
	})

	test('relationships following request', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		await addFollowing(domain, db, actor, actor2)

		const req = new Request('https://mastodon.example/api/v1/accounts/relationships?id[]=' + actor2[mastodonIdSymbol])
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<any[]>()
		assert.equal(data.length, 1)
		assert.equal(data[0].requested, true)
		assert.equal(data[0].following, false)
	})
})
