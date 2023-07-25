import { strict as assert } from 'node:assert/strict'

import { addPeer } from 'wildebeest/backend/src/activitypub/peers'
import * as peers from 'wildebeest/functions/api/v1/instance/peers'

import { assertStatus, makeDB } from '../utils'

describe('Mastodon APIs', () => {
	describe('instance', () => {
		test('returns peers', async () => {
			const db = await makeDB()
			await addPeer(db, 'a')
			await addPeer(db, 'b')

			const res = await peers.handleRequest(db)
			await assertStatus(res, 200)

			const data = await res.json<Array<string>>()
			assert.equal(data.length, 2)
			assert.equal(data[0], 'a')
			assert.equal(data[1], 'b')
		})
	})
})
