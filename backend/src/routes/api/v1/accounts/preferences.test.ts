import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { makeDB, createTestUser, assertStatus, assertCORS, assertJSON } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/preferences', () => {
	test('preferences', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'alice@example.com')
		const connectedActor = actor

		const req = new Request(`https://${domain}/api/v1/preferences`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)
		assertCORS(res)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data['posting:default:language'], null)
		assert.equal(data['posting:default:sensitive'], false)
		assert.equal(data['posting:default:visibility'], 'public')
		assert.equal(data['reading:expand:media'], 'default')
		assert.equal(data['reading:expand:spoilers'], false)
	})
})
