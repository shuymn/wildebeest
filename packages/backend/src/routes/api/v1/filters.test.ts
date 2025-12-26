import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { assertStatus, assertJSON, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/filters', () => {
	test('view filters return empty array', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'alice@example.com')

		const req = new Request(`https://${domain}/api/v1/filters`)
		const res = await app.fetch(req, { data: { connectedActor } })
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.length, 0)
	})
})
