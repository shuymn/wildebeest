import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { addPeer } from 'wildebeest/backend/src/activitypub/peers'
import { makeDB, assertStatus } from 'wildebeest/backend/test/utils'

describe('/api/v1/instance/peers', () => {
	test('returns peers', async () => {
		const db = await makeDB()
		await addPeer(db, 'a')
		await addPeer(db, 'b')

		const req = new Request('https://example.com/api/v1/instance/peers')
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<Array<string>>()
		assert.equal(data.length, 2)
		assert.equal(data[0], 'a')
		assert.equal(data[1], 'b')
	})
})
