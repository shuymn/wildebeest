import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { assertStatus, assertCORS, MockContext } from 'wildebeest/backend/test/utils'

const domain = 'example.com'

test('expose NodeInfo version 2.1', async () => {
	const req = new Request(`https://${domain}/nodeinfo/2.1`)
	const res = await app.fetch(req, {}, new MockContext())
	await assertStatus(res, 200)
	assertCORS(res, req)

	const data = await res.json<any>()
	assert.equal(data.version, '2.1')
})
