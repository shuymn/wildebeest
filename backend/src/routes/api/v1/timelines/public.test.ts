import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { createImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { insertLike } from 'wildebeest/backend/src/mastodon/like'
import { createReblog } from 'wildebeest/backend/src/mastodon/reblog'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus, assertJSON, assertCORS } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek6'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const domain = 'cloudflare.com'

describe('/api/v1/timelines/public', () => {
	test('public returns Notes', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

		const statusFromActor = await createPublicStatus(domain, db, actor, 'status from actor', [], {
			published: '2021-01-01T00:00:00.000Z',
		})
		await sleep(10)
		await createPublicStatus(domain, db, actor2, 'status from actor2', [], { published: '2021-01-01T00:00:00.001Z' })

		await insertLike(db, actor, statusFromActor)
		await createReblog(db, actor, statusFromActor, {
			to: [PUBLIC_GROUP],
			cc: [],
			id: 'https://example.com/activity',
		})

		{
			const req = new Request(`https://${domain}/api/v1/timelines/public`)
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)
			assertJSON(res)
			assertCORS(res, req)

			const data = await res.json<any>()
			assert.equal(data.length, 3)
			assert(data[0].id)
			assert.equal(data[0].content, '')
			assert.equal(data[0].account.username, 'sven')
			assert.equal(data[0].reblog.content, '<p>status from actor</p>')
			assert.equal(data[0].reblog.account.username, 'sven')

			assert.equal(data[1].content, '<p>status from actor2</p>')
			assert.equal(data[1].account.username, 'sven2')

			assert.equal(data[2].content, '<p>status from actor</p>')
			assert.equal(data[2].account.username, 'sven')
			assert.equal(data[2].favourites_count, 1)
			assert.equal(data[2].reblogs_count, 1)
		}

		// if we request only remote objects nothing should be returned
		{
			const req = new Request(`https://${domain}/api/v1/timelines/public?remote=true`)
			const res = await app.fetch(req, { DATABASE: db })
			assert.equal(res.status, 200)
			assertJSON(res)
			assertCORS(res, req)
			const data = await res.json<any[]>()
			assert.equal(data.length, 0)
		}
	})

	test('public includes attachment', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const properties = { url: 'https://example.com/image.jpg' }
		const mediaAttachments = [await createImage(domain, db, actor, properties)]
		await createPublicStatus(domain, db, actor, 'status from actor', mediaAttachments)

		const req = new Request(`https://${domain}/api/v1/timelines/public`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.length, 1)
		assert.equal(data[0].media_attachments.length, 1)
		assert.equal(data[0].media_attachments[0].type, 'image')
		assert.equal(data[0].media_attachments[0].url, properties.url)
	})

	test('public timeline uses published_date', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		await createPublicStatus(domain, db, actor, 'note1', [], { published: '2021-01-01T00:00:00.001Z' })
		await createPublicStatus(domain, db, actor, 'note2', [], { published: '2021-01-01T00:00:00.000Z' })
		await createPublicStatus(domain, db, actor, 'note3', [], { published: '2021-01-01T00:00:00.002Z' })

		const req = new Request(`https://${domain}/api/v1/timelines/public`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data[0].content, '<p>note3</p>')
		assert.equal(data[1].content, '<p>note1</p>')
		assert.equal(data[2].content, '<p>note2</p>')
	})
})
