import { strict as assert } from 'node:assert/strict'

import { insertHashtags } from 'wildebeest/backend/src/mastodon/hashtag'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import * as tag_id from 'wildebeest/functions/api/v1/tags/[tag]'

import { assertCORS, assertStatus, createTestUser, isUrlValid, makeDB } from '../utils'

const domain = 'cloudflare.com'
const userKEK = 'test_kek20'

describe('Mastodon APIs', () => {
	describe('tags', () => {
		test('return 404 when non existent tag', async () => {
			const db = await makeDB()
			const res = await tag_id.handleRequestGet(db, domain, 'non-existent-tag')
			assertCORS(res)
			await assertStatus(res, 404)
		})

		test('return tag', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createPublicStatus(domain, db, actor, 'my localnote status')
			await insertHashtags(db, note, ['test'])

			const res = await tag_id.handleRequestGet(db, domain, 'test')
			assertCORS(res)
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.name, 'test')
			assert(isUrlValid(data.url))
		})
	})
})
