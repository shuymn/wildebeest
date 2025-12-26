import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { assertStatus, assertJSON } from '@wildebeest/backend/test/utils'

describe('/api/v1/trends/statuses', () => {
	test('trending statuses return empty array', async () => {
		const req = new Request(`https://example.com/api/v1/trends/statuses`)
		const res = await app.fetch(req)
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.length, 0)
	})
})
