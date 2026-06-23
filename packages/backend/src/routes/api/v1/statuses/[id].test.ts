import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { createImage } from '@wildebeest/backend/activitypub/objects/image'
import { insertBlock } from '@wildebeest/backend/mastodon/block'
import { insertBookmark } from '@wildebeest/backend/mastodon/bookmark'
import { addFollowing, acceptFollowing } from '@wildebeest/backend/mastodon/follow'
import { insertLike } from '@wildebeest/backend/mastodon/like'
import { createReblog } from '@wildebeest/backend/mastodon/reblog'
import { insertReply } from '@wildebeest/backend/mastodon/reply'
import {
	createDirectStatus,
	createPrivateStatus,
	createPublicStatus,
	createReply,
} from '@wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus, makeCache, makeQueue, makeDOCache } from '@wildebeest/backend/test/utils'
import { MastodonStatus } from '@wildebeest/backend/types'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]', () => {
	test('get status count likes', async () => {
		const db = makeDB()
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
		assert.equal(data.favourites_count, 2)
	})

	test('get status count replies', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'reply-parent@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'reply-child@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'parent status')

		await createReply(domain, db, actor2, note, '@reply-parent@cloudflare.com child reply')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<{ replies_count: unknown }>()
		assert.equal(data.replies_count, 1)
	})

	test('get status with image', async () => {
		const db = makeDB()
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
		const db = makeDB()
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
		assert.equal(data.reblogs_count, 2)
	})

	test('get status includes viewer state', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'viewer-state@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'viewer state status')

		await insertLike(db, actor, note)
		await insertBookmark(db, actor, note)
		await createReblog(db, actor, note, { to: [PUBLIC_GROUP], cc: [], id: 'https://example.com/viewer-state-reblog' })

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<{ favourited: boolean; reblogged: boolean; bookmarked: boolean }>()
		assert.equal(data.favourited, true)
		assert.equal(data.reblogged, true)
		assert.equal(data.bookmarked, true)
	})

	test('get private status as follower', async () => {
		const db = makeDB()
		const author = await createTestUser(domain, db, userKEK, 'private-status-author@cloudflare.com')
		const follower = await createTestUser(domain, db, userKEK, 'private-status-follower@cloudflare.com')
		await addFollowing(domain, db, follower, author)
		await acceptFollowing(db, follower, author)
		const note = await createPrivateStatus(domain, db, author, 'private status')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: follower } })
		await assertStatus(res, 200)
	})

	test('get direct status as recipient', async () => {
		const db = makeDB()
		const author = await createTestUser(domain, db, userKEK, 'direct-status-author@cloudflare.com')
		const recipient = await createTestUser(domain, db, userKEK, 'direct-status-recipient@cloudflare.com')
		const note = await createDirectStatus(domain, db, author, 'direct status', [], { to: [recipient] })

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: recipient } })
		await assertStatus(res, 200)
	})

	test('get private status as non-follower returns 404', async () => {
		const db = makeDB()
		const author = await createTestUser(domain, db, userKEK, 'private-denied-author@cloudflare.com')
		const viewer = await createTestUser(domain, db, userKEK, 'private-denied-viewer@cloudflare.com')
		const note = await createPrivateStatus(domain, db, author, 'private denied status')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: viewer } })
		await assertStatus(res, 404)
	})

	test('get direct status as non-recipient returns 404', async () => {
		const db = makeDB()
		const author = await createTestUser(domain, db, userKEK, 'direct-denied-author@cloudflare.com')
		const recipient = await createTestUser(domain, db, userKEK, 'direct-denied-recipient@cloudflare.com')
		const viewer = await createTestUser(domain, db, userKEK, 'direct-denied-viewer@cloudflare.com')
		const note = await createDirectStatus(domain, db, author, 'direct denied status', [], { to: [recipient] })

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: viewer } })
		await assertStatus(res, 404)
	})

	test('get status as blocked viewer returns 404', async () => {
		const db = makeDB()
		const author = await createTestUser(domain, db, userKEK, 'blocked-status-author@cloudflare.com')
		const viewer = await createTestUser(domain, db, userKEK, 'blocked-status-viewer@cloudflare.com')
		const note = await createPublicStatus(domain, db, author, 'blocked status')
		await insertBlock(db, author, viewer)

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: viewer } })
		await assertStatus(res, 404)
	})

	test('update non-existing status', async () => {
		const db = makeDB()
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
		const db = makeDB()
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
		const db = makeDB()
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
		const db = makeDB()
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
		const db = makeDB()
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
		const db = makeDB()
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
		const db = makeDB()
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
		const db = makeDB()
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

	test('insertReply repairs stale reply parent row and counts', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'reply-repair@cloudflare.com')
		const oldParent = await createPublicStatus(domain, db, actor, 'old parent')
		const newParent = await createPublicStatus(domain, db, actor, 'new parent')
		const reply = await createReply(domain, db, actor, oldParent, '@reply-repair@cloudflare.com reply')

		await insertReply(db, actor, reply, newParent)

		const replyRow = await db
			.prepare('SELECT in_reply_to_id FROM objects WHERE id = ?')
			.bind(reply.id.toString())
			.first<{ in_reply_to_id: string }>()
		assert.equal(replyRow?.in_reply_to_id, newParent.id.toString())

		const actorReply = await db
			.prepare('SELECT in_reply_to_object_id FROM actor_replies WHERE object_id = ?')
			.bind(reply.id.toString())
			.first<{ in_reply_to_object_id: string }>()
		assert.equal(actorReply?.in_reply_to_object_id, newParent.id.toString())

		const oldCount = await db
			.prepare('SELECT replies_count FROM objects WHERE id = ?')
			.bind(oldParent.id.toString())
			.first<{ replies_count: number }>()
		assert.equal(oldCount?.replies_count, 0)
		const newCount = await db
			.prepare('SELECT replies_count FROM objects WHERE id = ?')
			.bind(newParent.id.toString())
			.first<{ replies_count: number }>()
		assert.equal(newCount?.replies_count, 1)
	})

	test('delete reply decrements parent replies count', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const doCache = makeDOCache()

		const actor = await createTestUser(domain, db, userKEK, 'reply-deleter@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'parent status')
		const reply = await createReply(domain, db, actor, note, '@reply-deleter@cloudflare.com reply')
		const replyRow = await db
			.prepare('SELECT in_reply_to_id, in_reply_to_account_id FROM objects WHERE id=?')
			.bind(reply.id.toString())
			.first<{ in_reply_to_id: string | null; in_reply_to_account_id: string | null }>()
		assert.equal(replyRow?.in_reply_to_id, note.id.toString())
		assert.equal(replyRow?.in_reply_to_account_id, actor.id.toString())

		{
			const row = await db
				.prepare('SELECT replies_count FROM objects WHERE id=?')
				.bind(note.id.toString())
				.first<{ replies_count: number }>()
			assert.equal(row?.replies_count, 1)
		}

		const req = new Request(`https://${domain}/api/v1/statuses/${reply[mastodonIdSymbol]}`, { method: 'DELETE' })
		const res = await app.fetch(req, {
			DATABASE: db,
			userKEK,
			QUEUE: queue,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		const row = await db
			.prepare('SELECT replies_count FROM objects WHERE id=?')
			.bind(note.id.toString())
			.first<{ replies_count: number }>()
		assert.equal(row?.replies_count, 0)
	})

	test('delete status regenerates the timeline', async () => {
		const db = makeDB()
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
		const db = makeDB()
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
