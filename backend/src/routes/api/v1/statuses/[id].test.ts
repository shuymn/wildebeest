import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { createImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { addFollowing, acceptFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { insertLike } from 'wildebeest/backend/src/mastodon/like'
import { createReblog } from 'wildebeest/backend/src/mastodon/reblog'
import { MastodonStatus } from 'wildebeest/backend/src/types'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus, makeCache, makeQueue, makeDOCache } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]', () => {
	test('get status count likes', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'my first status')

		await insertLike(db, actor2, note)
		await insertLike(db, actor3, note)

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<{ favourites_count: unknown }>()
		// FIXME: temporarly disable favourites counts
		assert.equal(data.favourites_count, 0)
	})

	test('get status with image', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const properties = { url: 'https://example.com/image.jpg' }
		const mediaAttachments = [await createImage(domain, db, actor, properties)]
		const note = await createPublicStatus(domain, db, actor, 'my first status', mediaAttachments)

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<{ media_attachments: Array<{ url: unknown; preview_url: unknown; type: unknown }> }>()
		assert.equal(data.media_attachments.length, 1)
		assert.equal(data.media_attachments[0].url, properties.url)
		assert.equal(data.media_attachments[0].preview_url, properties.url)
		assert.equal(data.media_attachments[0].type, 'image')
	})

	test('get status count reblogs', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'my first status')

		await createReblog(db, actor2, note, {
			to: [PUBLIC_GROUP],
			cc: [],
			id: 'https://example.com/activity1',
		})
		await createReblog(db, actor3, note, {
			to: [PUBLIC_GROUP],
			cc: [],
			id: 'https://example.com/activity2',
		})

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<{ reblogs_count: unknown }>()
		// FIXME: temporarly disable reblogs counts
		assert.equal(data.reblogs_count, 0)
	})

	test('update non-existing status', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const mastodonId = 'abcd'

		const req = new Request(`https://${domain}/api/v1/statuses/${mastodonId}`, { method: 'PUT' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 404)
	})

	test('update status from a different actor', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor2, 'note from actor2')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`, { method: 'PUT' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 404)
	})

	test('update status update DB rows', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, connectedActor, 'note from actor')

		{
			const row = await db
				.prepare(
					`SELECT
            json_extract(properties, '$.content') as content,
            json_extract(properties, '$.source.content') as source_content,
            json_extract(properties, '$.tag') as tag,
            json_extract(properties, '$.spoiler_text') as spoiler_text,
            json_extract(properties, '$.sensitive') as sensitive,
            json_extract(properties, '$.updated') as updated
          FROM objects WHERE id = ?`
				)
				.bind(note.id.toString())
				.first<{
					content: string
					source_content: string
					tag: string
					spoiler_text: string | null
					sensitive: 0 | 1
					updated: string | null
				}>()
			assert.equal(row?.content, '<p>note from actor</p>')
			assert.equal(row?.source_content, 'note from actor')
			assert.equal(row?.tag, '[]')
			assert.equal(row?.spoiler_text, null)
			assert.equal(row?.sensitive, 0)
			assert.equal(row?.updated, null)
		}

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				status: '@sven new status',
				spoiler_text: 'new spoiler',
				sensitive: true,
				// TODO: test media_ids
			}),
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 200)
		{
			const row = await db
				.prepare(
					`SELECT
            json_extract(properties, '$.content') as content,
            json_extract(properties, '$.source.content') as source_content,
            json_extract(properties, '$.tag') as tag,
            json_extract(properties, '$.spoiler_text') as spoiler_text,
            json_extract(properties, '$.sensitive') as sensitive,
            json_extract(properties, '$.updated') as updated
          FROM objects WHERE id = ?`
				)
				.bind(note.id.toString())
				.first<{
					content: string
					source_content: string
					tag: string
					spoiler_text: string | null
					sensitive: 0 | 1
					updated: string | null
				}>()
			assert.equal(row?.content, '<p>@sven new status</p>')
			assert.equal(row?.source_content, '@sven new status')
			assert.equal(
				row?.tag,
				JSON.stringify([{ type: 'Mention', href: 'https://cloudflare.com/ap/users/sven', name: 'sven' }])
			)
			assert.equal(row?.spoiler_text, 'new spoiler')
			assert.equal(row?.sensitive, 1)
			assert.ok(row?.updated)
		}
	})

	test('update status regenerates the timeline', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const cache = makeCache()
		const doCache = makeDOCache(cache)

		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, connectedActor, 'note from actor')

		// Poison the timeline
		await cache.put(connectedActor.id.toString() + '/timeline/home', 'funny value')

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

		// ensure that timeline has been regenerated after the update
		const timeline = await cache.get<MastodonStatus[]>(connectedActor.id.toString() + '/timeline/home')
		assert.ok(timeline)
		assert.equal(timeline.length, 1)
		assert.equal(timeline[0].content, '<p>new status</p>')
	})

	test('update status sends to followers', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'note from actor')

		await addFollowing(domain, db, actor2, actor)
		await acceptFollowing(db, actor2, actor)
		await addFollowing(domain, db, actor3, actor)
		await acceptFollowing(db, actor3, actor)

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
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		assert.equal(queue.messages.length, 2)
		assert.equal(queue.messages[0].activity.type, 'Update')
		assert.equal(queue.messages[0].actorId, actor.id.toString())
		assert.equal(queue.messages[0].toActorId, actor2.id.toString())
		assert.equal(queue.messages[0].activity.object.content, '<p>new status</p>')
		assert.equal(queue.messages[1].activity.type, 'Update')
		assert.equal(queue.messages[1].actorId, actor.id.toString())
		assert.equal(queue.messages[1].toActorId, actor3.id.toString())
		assert.equal(queue.messages[1].activity.object.content, '<p>new status</p>')
	})

	test('delete non-existing status', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const mastodonId = 'abcd'

		const req = new Request(`https://${domain}/api/v1/statuses/${mastodonId}`, { method: 'DELETE' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 404)
	})

	test('delete status from a different actor', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor2, 'note from actor2')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`, { method: 'DELETE' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 404)
	})

	test('delete status remove DB rows', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'note from actor')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`, { method: 'DELETE' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		{
			const row = await db.prepare(`SELECT count(*) as count FROM outbox_objects`).first<{ count: number }>()
			assert.equal(row?.count, 0)
		}
		{
			const row = await db.prepare(`SELECT count(*) as count FROM objects`).first<{ count: number }>()
			assert.equal(row?.count, 0)
		}
	})

	test('delete status regenerates the timeline', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const cache = makeCache()
		const doCache = makeDOCache(cache)

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'note from actor')

		// Poison the timeline
		await cache.put(actor.id.toString() + '/timeline/home', 'funny value')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`, { method: 'DELETE' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		// ensure that timeline has been regenerated after the deletion
		// and that timeline is empty
		const timeline = await cache.get<unknown[]>(actor.id.toString() + '/timeline/home')
		assert(timeline)
		assert.equal(timeline.length, 0)
	})

	test('delete status sends to followers', async () => {
		const db = await makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'note from actor')

		await addFollowing(domain, db, actor2, actor)
		await acceptFollowing(db, actor2, actor)
		await addFollowing(domain, db, actor3, actor)
		await acceptFollowing(db, actor3, actor)

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`, { method: 'DELETE' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		assert.equal(queue.messages.length, 2)
		assert.equal(queue.messages[0].activity.type, 'Delete')
		assert.equal(queue.messages[0].actorId, actor.id.toString())
		assert.equal(queue.messages[0].toActorId, actor2.id.toString())
		assert.equal(queue.messages[1].activity.type, 'Delete')
		assert.equal(queue.messages[1].actorId, actor.id.toString())
		assert.equal(queue.messages[1].toActorId, actor3.id.toString())
	})
})
