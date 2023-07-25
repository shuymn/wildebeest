import { strict as assert } from 'node:assert/strict'

import * as trends_links from 'wildebeest/functions/api/v1/trends/links'
import * as trends_statuses from 'wildebeest/functions/api/v1/trends/statuses'

import { assertJSON, assertStatus } from '../utils'

describe('Mastodon APIs', () => {
	describe('trends', () => {
		test('trending statuses return empty array', async () => {
			const res = await trends_statuses.onRequest()
			await assertStatus(res, 200)
			assertJSON(res)

			const data = await res.json<any>()
			assert.equal(data.length, 0)
		})

		test('trending links return empty array', async () => {
			const res = await trends_links.onRequest()
			await assertStatus(res, 200)
			assertJSON(res)

			const data = await res.json<any>()
			assert.equal(data.length, 0)
		})
	})
})
