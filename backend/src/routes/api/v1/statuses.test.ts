import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { getObjectByMastodonId, mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { createImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { type Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { getPublicTimeline, LocalPreference } from 'wildebeest/backend/src/mastodon/timeline'
import { MastodonStatus, MessageType } from 'wildebeest/backend/src/types'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import {
	makeDOCache,
	assertStatus,
	makeDB,
	makeQueue,
	createTestUser,
	assertJSON,
	isUrlValid,
	streamToArrayBuffer,
	makeCache,
} from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'
const cache = makeCache()
const doCache = makeDOCache(cache)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('/api/v1/statuses', () => {
	test('create new status missing params', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'my status' }),
		})

		const res = await app.fetch(req, { data: { connectedActor } })
		await assertStatus(res, 400)
	})

	test('create new status creates Note', async () => {
		const db = makeDB()
		const queue = makeQueue()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor

		const body = {
			status: 'my status <script>evil</script>',
			visibility: 'public',
			sensitive: false,
			media_ids: [],
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<MastodonStatus>()
		assert((data.uri as unknown as string).includes('example.com'))
		assert((data.url as unknown as string).includes(data.id))
		// Required fields from https://github.com/mastodon/mastodon-android/blob/master/mastodon/src/main/java/org/joinmastodon/android/model/Status.java
		assert(data.created_at !== undefined)
		assert(data.account !== undefined)
		assert(data.visibility !== undefined)
		assert(data.spoiler_text !== undefined)
		assert(data.media_attachments !== undefined)
		assert(data.mentions !== undefined)
		assert(data.tags !== undefined)
		assert(data.emojis !== undefined)
		assert(!isUrlValid(data.id))

		const row = await db
			.prepare(
				`
        SELECT
            id,
            ${db.qb.jsonExtract('properties', 'content')} as content,
            original_actor_id,
            original_object_id
        FROM objects
      `
			)
			.first<{ id: string; content: string; original_actor_id: URL; original_object_id: unknown }>()
		assert.ok(row)
		assert.equal(row.content, '<p>my status <p>evil</p></p>') // note the sanitization
		assert.equal(row.original_actor_id.toString(), actor.id.toString())
		assert.equal(row.original_object_id, row.id)
	})

	test('create new status regenerates the timeline and contains post', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = {
			status: 'my status',
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<{ id: unknown }>()

		const cachedData = await cache.get<Array<{ id: unknown }>>(actor.id.toString() + '/timeline/home')
		assert(cachedData)
		assert.equal(cachedData.length, 1)
		assert.equal(cachedData[0].id, data.id)
	})

	test("create new status adds to Actor's outbox", async () => {
		const db = makeDB()
		const queue = makeQueue()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor

		const body = {
			status: 'my status',
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		const row = await db.prepare(`SELECT count(*) as count FROM outbox_objects`).first<{ count: number }>()
		assert.ok(row)
		assert.equal(row.count, 1)
	})

	test('create new status delivers to followers via Queue', async () => {
		const queue = makeQueue()
		const db = makeDB()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const followerA = await createTestUser(domain, db, userKEK, 'followerA@cloudflare.com')
		const followerB = await createTestUser(domain, db, userKEK, 'followerB@cloudflare.com')

		await addFollowing(domain, db, followerA, actor)
		await sleep(10)
		await addFollowing(domain, db, followerB, actor)
		await acceptFollowing(db, followerA, actor)
		await acceptFollowing(db, followerB, actor)

		const body = { status: 'my status', visibility: 'public' }
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		assert.equal(queue.messages.length, 2)

		assert.equal(queue.messages[0].type, MessageType.Deliver)
		assert.equal(queue.messages[0].userKEK, userKEK)
		assert.equal(queue.messages[0].actorId, actor.id.toString())
		assert.equal(queue.messages[0].toActorId, followerA.id.toString())

		assert.equal(queue.messages[1].type, MessageType.Deliver)
		assert.equal(queue.messages[1].userKEK, userKEK)
		assert.equal(queue.messages[1].actorId, actor.id.toString())
		assert.equal(queue.messages[1].toActorId, followerB.id.toString())
	})

	test('create new status with mention delivers ActivityPub Note', async () => {
		let deliveredNote: Note | null = null

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		globalThis.fetch = async (input: RequestInfo, data: any) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://remote.com/.well-known/webfinger?resource=acct%3Asven%40remote.com') {
					return new Response(
						JSON.stringify({
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'https://social.com/users/sven',
								},
							],
						})
					)
				}

				if (input.toString() === 'https://social.com/users/sven') {
					return new Response(
						JSON.stringify({
							id: 'https://social.com/users/sven',
							type: 'Person',
							inbox: 'https://social.com/sven/inbox',
							preferredUsername: 'sven',
						})
					)
				}

				if (input.toString() === 'https://social.com/sven/inbox') {
					assert.equal(data.method, 'POST')
					const body = JSON.parse(data.body)
					deliveredNote = body
					return new Response()
				}
			}

			if (input instanceof Request && input.url === 'https://social.com/sven/inbox') {
				const request = input
				assert.equal(request.method, 'POST')
				const bodyB = await streamToArrayBuffer(request.body as ReadableStream)
				const dec = new TextDecoder()
				const body = JSON.parse(dec.decode(bodyB))
				deliveredNote = body
				return new Response()
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}

		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor

		const body = {
			status: '@sven@remote.com my status',
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		assert(deliveredNote)
		assert.equal((deliveredNote as { type: string }).type, 'Create')
		assert.equal((deliveredNote as { actor: string }).actor, `https://${domain}/ap/users/sven`)
		assert.equal(
			(deliveredNote as { object: { attributedTo: string } }).object.attributedTo,
			`https://${domain}/ap/users/sven`
		)
		assert.equal((deliveredNote as { object: { type: string } }).object.type, 'Note')
		assert((deliveredNote as { object: { to: string[] } }).object.to.includes(PUBLIC_GROUP))
		assert.equal((deliveredNote as { object: { cc: string[] } }).object.cc.length, 2)
	})

	test('create new status with mention add tags on Note', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://cloudflare.com/.well-known/webfinger?resource=acct%3Asven%40cloudflare.com') {
					return new Response(
						JSON.stringify({
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: actor.id,
								},
							],
						})
					)
				}

				if (input.toString() === actor.id.toString()) {
					return new Response(JSON.stringify(actor))
				}
			}

			if (input instanceof Request && input.url === actor.inbox.toString()) {
				return new Response()
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}

		const body = {
			status: 'my status @sven@' + domain,
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		const data = await res.json<{ id: string }>()

		const note = await getObjectByMastodonId<Note>(domain, db, data.id)
		assert.ok(note)
		assert.equal(note.tag?.length, 1)
		assert.equal(note.tag[0].href, actor.id.toString())
		assert.equal(note.tag[0].name, 'sven@' + domain)
	})

	test('create new status with image', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const image = await createImage(domain, db, connectedActor, {
			url: 'https://example.com/image.jpg',
		})

		const body = {
			status: 'my status',
			media_ids: [image[mastodonIdSymbol]],
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		const data = await res.json<{ id: string }>()

		assert(!isUrlValid(data.id))
	})

	test('create new status in reply to', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'my first status')

		const body = {
			status: 'my reply',
			in_reply_to_id: note[mastodonIdSymbol],
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		const data = await res.json<{ id: string }>()

		{
			const row = await db
				.prepare(
					`
                  SELECT ${db.qb.jsonExtract('properties', 'inReplyTo')} as inReplyTo
                  FROM objects
                  WHERE mastodon_id=?
              `
				)
				.bind(data.id)
				.first<{ inReplyTo: string }>()
			assert.ok(row)
			assert.equal(row.inReplyTo, note.id.toString())
		}

		{
			const row = await db.prepare('select * from actor_replies').first<{
				actor_id: string
				in_reply_to_object_id: string
			}>()
			assert.ok(row)
			assert.equal(row.actor_id, actor.id.toString())
			assert.equal(row.in_reply_to_object_id, note.id.toString())
		}
	})

	test('create new status with too many image', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = {
			status: 'my status',
			media_ids: ['id', 'id', 'id', 'id', 'id'],
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 400)
		const data = await res.json<{ error: string }>()
		assert(data.error.includes('Limit exceeded'))
	})

	test('create new status sending multipart and too many image', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = new FormData()
		body.append('status', 'my status')
		body.append('visibility', 'public')
		body.append('media_ids[]', 'id')
		body.append('media_ids[]', 'id')
		body.append('media_ids[]', 'id')
		body.append('media_ids[]', 'id')
		body.append('media_ids[]', 'id')

		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			body,
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 400)
		const data = await res.json<{ error: string }>()
		assert(data.error.includes('Limit exceeded'))
	})

	test('create new status in reply to non existing status', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = {
			status: 'my reply',
			in_reply_to_id: 'hein',
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 404)
	})

	test('create duplicate statuses idempotency', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const idempotencyKey = 'abcd'

		const body = { status: 'my status', visibility: 'public' }
		const makeReq = () =>
			new Request('https://example.com/api/v1/statuses', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': idempotencyKey,
				},
				body: JSON.stringify(body),
			})

		const res1 = await app.fetch(makeReq(), {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		assert.equal(res1.status, 200)
		const data1 = await res1.json()

		const res2 = await app.fetch(makeReq(), {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		assert.equal(res2.status, 200)
		const data2 = await res2.json()

		assert.deepEqual(data1, data2)

		{
			const row = await db.prepare(`SELECT count(*) as count FROM objects`).first<{ count: number }>()
			assert.equal(row?.count, 1)
		}

		{
			const row = await db.prepare(`SELECT count(*) as count FROM idempotency_keys`).first<{ count: number }>()
			assert.equal(row?.count, 1)
		}
	})

	test('hashtag in status adds in note_hashtags table', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = {
			status: 'hey #hi #car',
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		const data = await res.json<{ id: string }>()

		const { results, success } = await db
			.prepare('SELECT value, object_id FROM note_hashtags')
			.all<{ value: string; object_id: string }>()
		assert(success)
		assert(results)
		assert.equal(results.length, 2)
		assert.equal(results[0].value, 'hi')
		assert.equal(results[1].value, 'car')

		const note = await getObjectByMastodonId(domain, db, data.id)
		assert.ok(note)
		assert.equal(results[0].object_id, note.id.toString())
		assert.equal(results[1].object_id, note.id.toString())
	})

	test('reject statuses exceeding limits', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = {
			status: 'a'.repeat(501),
			visibility: 'public',
		}
		const req = new Request('https://example.com/api/v1/statuses', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 422)
		assertJSON(res)
	})

	test('create status with direct visibility', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor1 = await createTestUser(domain, db, userKEK, 'actor1@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'actor2@cloudflare.com')

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let deliveredActivity1: any = null
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let deliveredActivity2: any = null

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof Request) {
				if (input.url === actor1.inbox.toString()) {
					deliveredActivity1 = await input.json()
					return new Response()
				}
				if (input.url === actor2.inbox.toString()) {
					deliveredActivity2 = await input.json()
					return new Response()
				}
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}

		const body = {
			status: '@actor1 @actor2 hey',
			visibility: 'direct',
		}
		const req = new Request(`https://${domain}/api/v1/statuses`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)

		assert(deliveredActivity1)
		assert(deliveredActivity2)
		delete deliveredActivity1.id
		delete deliveredActivity2.id

		assert.deepEqual(deliveredActivity1, deliveredActivity2)
		assert.equal(deliveredActivity1.to.length, 2)
		assert.equal(deliveredActivity1.to[0], actor1.id.toString())
		assert.equal(deliveredActivity1.to[1], actor2.id.toString())
		assert.equal(deliveredActivity1.cc.length, 0)

		// ensure that the private note doesn't show up in public timeline
		const timeline = await getPublicTimeline(domain, db, LocalPreference.NotSet, false, 20)
		assert.equal(timeline.length, 0)
	})

	test('create status with unlisted visibility', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = {
			status: 'something nice',
			visibility: 'unlisted',
		}
		const req = new Request(`https://${domain}/api/v1/statuses`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<MastodonStatus>()
		assert((data.uri as unknown as string).includes(domain))
		assert((data.url as unknown as string).includes(data.id))
		// Required fields from https://github.com/mastodon/mastodon-android/blob/master/mastodon/src/main/java/org/joinmastodon/android/model/Status.java
		assert(data.created_at !== undefined)
		assert(data.account !== undefined)
		assert(data.visibility === 'unlisted', data.visibility)
		assert(data.spoiler_text !== undefined)
		assert(data.media_attachments !== undefined)
		assert(data.mentions !== undefined)
		assert(data.tags !== undefined)
		assert(data.emojis !== undefined)
		assert(!isUrlValid(data.id))

		const row = await db
			.prepare(
				`
      SELECT
          id,
          ${db.qb.jsonExtract('properties', 'content')} as content,
          ${db.qb.jsonExtract('properties', 'to')} as 'to',
          ${db.qb.jsonExtract('properties', 'cc')} as 'cc',
          original_actor_id,
          original_object_id
      FROM objects
    `
			)
			.first<{
				id: string
				content: string
				to: string
				cc: string
				original_actor_id: string
				original_object_id: string
			}>()
		assert.ok(row)
		assert.equal(row.original_actor_id.toString(), actor.id.toString())
		assert.equal(row.original_object_id, row.id)
		assert.equal(row.content, '<p>something nice</p>') // note the sanitization
		assert.deepEqual(JSON.parse(row.to), ['https://' + domain + '/ap/users/sven/followers'])
		assert.deepEqual(JSON.parse(row.cc), [PUBLIC_GROUP])
	})

	test('create status with private visibility', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const body = {
			status: 'something nice',
			visibility: 'private',
		}
		const req = new Request(`https://${domain}/api/v1/statuses`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		const res = await app.fetch(req, {
			DATABASE: db,
			QUEUE: queue,
			userKEK,
			DO_CACHE: doCache,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<MastodonStatus>()
		assert((data.uri as unknown as string).includes(domain))
		assert((data.url as unknown as string).includes(data.id))
		// Required fields from https://github.com/mastodon/mastodon-android/blob/master/mastodon/src/main/java/org/joinmastodon/android/model/Status.java
		assert(data.created_at !== undefined)
		assert(data.account !== undefined)
		assert(data.visibility === 'private', data.visibility)
		assert(data.spoiler_text !== undefined)
		assert(data.media_attachments !== undefined)
		assert(data.mentions !== undefined)
		assert(data.tags !== undefined)
		assert(data.emojis !== undefined)
		assert(!isUrlValid(data.id))

		const row = await db
			.prepare(
				`
      SELECT
          id,
          ${db.qb.jsonExtract('properties', 'content')} as content,
          ${db.qb.jsonExtract('properties', 'to')} as 'to',
          ${db.qb.jsonExtract('properties', 'cc')} as 'cc',
          original_actor_id,
          original_object_id
      FROM objects
    `
			)
			.first<{
				id: string
				content: string
				to: string
				cc: string
				original_actor_id: string
				original_object_id: string
			}>()
		assert.ok(row)
		assert.equal(row.original_actor_id.toString(), actor.id.toString())
		assert.equal(row.original_object_id, row.id)
		assert.equal(row.content, '<p>something nice</p>') // note the sanitization
		assert.deepEqual(JSON.parse(row.to), ['https://' + domain + '/ap/users/sven/followers'])
		assert.deepEqual(JSON.parse(row.cc), [])
	})
})
