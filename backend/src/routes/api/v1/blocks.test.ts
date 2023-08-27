import { strict as assert } from 'node:assert/strict'

import blocks from 'wildebeest/backend/src/routes/api/v1/blocks'
import { assertStatus, assertJSON } from 'wildebeest/backend/test/utils'

describe('/api/v1/blocks', () => {
	test('blocks returns an empty array', async () => {
		const res = await blocks.request('/')
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.length, 0)
	})
})
