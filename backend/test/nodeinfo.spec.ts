import { strict as assert } from 'node:assert/strict'

import * as nodeinfo from 'wildebeest/routes/.well-known/nodeinfo'
import * as nodeinfo_20 from 'wildebeest/routes/nodeinfo/2.0'
import * as nodeinfo_21 from 'wildebeest/routes/nodeinfo/2.1'

import { assertCORS, assertStatus } from './utils'

const domain = 'example.com'

describe('NodeInfo', () => {
	test('well-known returns links', async () => {
		const res = await nodeinfo.handleRequest(domain)
		await assertStatus(res, 200)
		assertCORS(res)

		const data = await res.json<any>()
		assert.equal(data.links.length, 2)
	})

	test('expose NodeInfo version 2.0', async () => {
		const res = await nodeinfo_20.handleRequest()
		await assertStatus(res, 200)
		assertCORS(res)

		const data = await res.json<any>()
		assert.equal(data.version, '2.0')
	})

	test('expose NodeInfo version 2.1', async () => {
		const res = await nodeinfo_21.handleRequest()
		await assertStatus(res, 200)
		assertCORS(res)

		const data = await res.json<any>()
		assert.equal(data.version, '2.1')
	})
})
