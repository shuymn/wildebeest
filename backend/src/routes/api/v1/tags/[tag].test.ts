import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { insertHashtags } from 'wildebeest/backend/src/mastodon/hashtag'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, assertStatus, assertCORS, createTestUser, isUrlValid } from 'wildebeest/backend/test/utils'

const domain = 'cloudflare.com'
const userKEK = 'test_kek20'

describe('/api/v1/tags/[tag]', () => {
	test('return 404 when non existent tag', async () => {
		const db = makeDB()
		const req = new Request(`https://${domain}/api/v1/tags/non-existent-tag`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 404)
		assertCORS(res, req)
	})

	test('return tag', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const note = await createPublicStatus(domain, db, actor, 'my localnote status')
		await insertHashtags(db, note, ['test'])

		const req = new Request(`https://${domain}/api/v1/tags/test`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)
		assertCORS(res, req)

		const data = await res.json<any>()
		assert.equal(data.name, 'test')
		assert(isUrlValid(data.url))
	})
})
