import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { assertStatus, assertCORS } from 'wildebeest/backend/test/utils'

const domain = 'example.com'

test('expose NodeInfo version 2.0', async () => {
	const req = new Request(`https://${domain}/nodeinfo/2.0`)
	const res = await app.fetch(req)
	await assertStatus(res, 200)
	assertCORS(res, req)

	const data = await res.json<any>()
	assert.equal(data.version, '2.0')
})
