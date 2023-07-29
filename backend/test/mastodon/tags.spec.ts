import { strict as assert } from 'node:assert/strict'

import { createPerson } from 'wildebeest/backend/src/activitypub/actors'
import { createPublicNote } from 'wildebeest/backend/src/activitypub/objects/note'
import { insertHashtags } from 'wildebeest/backend/src/mastodon/hashtag'
import * as tag_id from 'wildebeest/functions/api/v1/tags/[tag]'

import { assertCORS, assertStatus, isUrlValid, makeDB } from '../utils'

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
			const actor = await createPerson(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createPublicNote(domain, db, 'my localnote status', actor, new Set(), [], {
				sensitive: false,
				source: { content: 'my first status', mediaType: 'text/markdown' },
			})
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
