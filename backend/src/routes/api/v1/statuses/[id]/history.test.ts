import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { getObjectByMastodonId, mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { createImage } from '@wildebeest/backend/activitypub/objects/image'
import { acceptFollowing, addFollowing } from '@wildebeest/backend/mastodon/follow'
import { createPrivateStatus, createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus, makeQueue, makeDOCache } from '@wildebeest/backend/test/utils'
import { MastodonStatusEdit } from '@wildebeest/backend/types'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/history', () => {
	test('statuses_history: 404 if status does not exist', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/statuses/1/history`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 404)
	})

	test('statuses_history: should only be generated for Note objects', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const obj = await createImage(domain, db, connectedActor, { url: 'https://example.com/image.jpg' })
		const mastodonId = obj[mastodonIdSymbol]
		assert.ok(mastodonId)

		const row = await getObjectByMastodonId(domain, db, mastodonId)
		assert.ok(row)

		const req = new Request(`https://${domain}/api/v1/statuses/${mastodonId}/history`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 404)
	})

	test('statuses_history: should not be visible to users without view permissions', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const author = await createTestUser(domain, db, userKEK, 'actor1@cloudflare.com')
		const note = await createPrivateStatus(domain, db, author, 'my first status')

		{
			const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/history`)
			const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
			await assertStatus(res, 404)
		}

		await addFollowing(domain, db, connectedActor, author)
		await acceptFollowing(db, connectedActor, author)

		{
			const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/history`)
			const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
			await assertStatus(res, 200)
		}
	})

	test('statuses_history: updating the status creates revisions', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, connectedActor, 'note from actor')

		{
			const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ status: 'new status' }),
			})
			const res = await app.fetch(req, {
				DATABASE: db,
				userKEK,
				QUEUE: queue,
				DO_CACHE: doCache,
				data: { connectedActor },
			})
			await assertStatus(res, 200)
			const data = await res.json<{ content: string }>()
			assert.equal(data.content, '<p>new status</p>')
		}

		{
			const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/history`)
			const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
			await assertStatus(res, 200)

			const data = await res.json<MastodonStatusEdit[]>()
			assert.equal(data.length, 2)
			assert.equal(data[0].content, '<p>note from actor</p>')
			assert.equal(data[1].content, '<p>new status</p>')
			assert.notEqual(data[0].created_at, data[1].created_at)
		}
	})
})
