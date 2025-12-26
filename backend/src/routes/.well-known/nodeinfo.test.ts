import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { assertStatus, assertCORS } from '@wildebeest/backend/test/utils'

const domain = 'example.com'

test('well-known returns links', async () => {
	const req = new Request(`https://${domain}/.well-known/nodeinfo`)
	const res = await app.fetch(req)
	await assertStatus(res, 200)
	assertCORS(res, req)

	const data = await res.json<any>()
	assert.equal(data.links.length, 2)
})
