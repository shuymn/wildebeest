import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { createNotification, insertFollowNotification } from 'wildebeest/backend/src/mastodon/notification'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus, assertJSON } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek15'
const domain = 'cloudflare.com'

describe('/api/v1/notifications/[id]', () => {
	test('get single favourite notification', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const fromActor = await createTestUser(domain, db, userKEK, 'from@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'my first status')
		await createNotification(db, 'favourite', actor, fromActor, note)

		const req = new Request(`https://${domain}/api/v1/notifications/1`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })

		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.id, '1')
		assert.equal(data.type, 'favourite')
		assert.equal(data.account.acct, 'from')
		assert.equal(data.status.content, '<p>my first status</p>')
	})

	test('get single follow notification', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const fromActor = await createTestUser(domain, db, userKEK, 'from@cloudflare.com')
		await insertFollowNotification(db, actor, fromActor)

		const req = new Request(`https://${domain}/api/v1/notifications/1`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })

		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.id, '1')
		assert.equal(data.type, 'follow')
		assert.equal(data.account.acct, 'from')
		assert.equal(data.status, undefined)
	})
})
