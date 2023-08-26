import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { assertStatus, assertJSON, assertCORS, assertCache } from 'wildebeest/backend/test/utils'

describe('/api/v1/custom_emojis', () => {
	test('returns an empty array', async () => {
		const req = new Request('https://example.com/api/v1/custom_emojis')
		const res = await app.fetch(req)
		await assertStatus(res, 200)
		assertJSON(res)
		assertCORS(res)
		assertCache(res, 300)

		const data = await res.json<any>()
		assert.equal(data.length, 0)
	})
})
