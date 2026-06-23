import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { type Note } from '@wildebeest/backend/activitypub/objects/note'
import { insertBlock } from '@wildebeest/backend/mastodon/block'
import { acceptFollowing, addFollowing } from '@wildebeest/backend/mastodon/follow'
import { createDirectStatus, createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB, makeDOCache, makeQueue } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_unreblog'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/unreblog', () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	test('unreblog removes reblog', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'unreblog@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'reblogged status')

		const reblogRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/reblog`, { method: 'POST' }),
			{
				DATABASE: db,
				userKEK,
				QUEUE: makeQueue(),
				data: { connectedActor: actor },
			}
		)
		await assertStatus(reblogRes, 200)

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/unreblog`, { method: 'POST' }),
			{
				DATABASE: db,
				DO_CACHE: makeDOCache(),
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(res, 200)
		const data = await res.json<{ reblogged: boolean; reblogs_count: number }>()
		assert.equal(data.reblogged, false)
		assert.equal(data.reblogs_count, 0)

		const outboxRows = await db.prepare('SELECT count(*) as count FROM outbox_objects').first<{ count: number }>()
		assert.equal(outboxRows?.count, 1)
	})

	test('unreblog rejects status hidden by block before mutation', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'blocked-unreblogger@cloudflare.com')
		const author = await createTestUser(domain, db, userKEK, 'blocked-unreblog-author@cloudflare.com')
		const note = await createPublicStatus(domain, db, author, 'blocked unreblog status')

		const reblogRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/reblog`, { method: 'POST' }),
			{ DATABASE: db, QUEUE: makeQueue(), userKEK, data: { connectedActor: actor } }
		)
		await assertStatus(reblogRes, 200)
		await insertBlock(db, author, actor)

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/unreblog`, { method: 'POST' }),
			{
				DATABASE: db,
				DO_CACHE: makeDOCache(),
				QUEUE: makeQueue(),
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(res, 404)

		const row = await db.prepare(`SELECT count(*) as count FROM actor_reblogs`).first<{ count: number }>()
		assert.equal(row?.count, 1)
	})

	test('unreblog local status does not deliver Undo Announce to local author inbox', async () => {
		globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
			const request = new Request(input)
			throw new Error('unexpected request to ' + request.url)
		}

		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'local-unreblogger@cloudflare.com')
		const author = await createTestUser(domain, db, userKEK, 'local-unreblog-author@cloudflare.com')
		const note = await createPublicStatus(domain, db, author, 'local status reblogged by another user')

		const reblogRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/reblog`, { method: 'POST' }),
			{
				DATABASE: db,
				QUEUE: makeQueue(),
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(reblogRes, 200)

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/unreblog`, { method: 'POST' }),
			{
				DATABASE: db,
				DO_CACHE: makeDOCache(),
				QUEUE: makeQueue(),
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(res, 200)
		const data = await res.json<{ reblogged: boolean; reblogs_count: number }>()
		assert.equal(data.reblogged, false)
		assert.equal(data.reblogs_count, 0)
	})

	test('direct unreblog does not deliver Undo Announce activity to followers', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'direct-unreblogger@cloudflare.com')
		const follower = await createTestUser(domain, db, userKEK, 'direct-unreblog-follower@cloudflare.com')
		await addFollowing(domain, db, follower, actor)
		await acceptFollowing(db, follower, actor)
		const note = await createDirectStatus(domain, db, actor, 'direct unreblog status')

		const reblogQueue = makeQueue()
		const reblogRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/reblog`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ visibility: 'direct' }),
			}),
			{ DATABASE: db, QUEUE: reblogQueue, userKEK, data: { connectedActor: actor } }
		)
		await assertStatus(reblogRes, 200)
		assert.equal(reblogQueue.messages.length, 0)

		const unreblogQueue = makeQueue()
		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/unreblog`, { method: 'POST' }),
			{
				DATABASE: db,
				DO_CACHE: makeDOCache(),
				QUEUE: unreblogQueue,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(res, 200)
		assert.equal(unreblogQueue.messages.length, 0)
	})

	test('unreblog remote status sends Undo Announce activity to author', async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const deliveredActivities: any[] = []
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'remote-unreblog@cloudflare.com')
		const remoteActorId = 'https://example.com/users/author'
		const originalObjectId = 'https://example.com/notes/1'
		const localObjectId = 'https://cloudflare.com/ap/o/remote-note-1'

		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id)
				VALUES (?, 'Person', 'author', 'example.com', ?, ?)`
			)
			.bind(
				remoteActorId,
				JSON.stringify({
					id: remoteActorId,
					type: 'Person',
					preferredUsername: 'author',
					inbox: `${remoteActorId}/inbox`,
					outbox: `${remoteActorId}/outbox`,
					following: `${remoteActorId}/following`,
					followers: `${remoteActorId}/followers`,
				}),
				'author-mastodon-id'
			)
			.run()

		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, mastodon_id, local) VALUES (?, ?, ?, ?, ?, ?, 0)'
			)
			.bind(
				localObjectId,
				'Note',
				JSON.stringify({
					id: originalObjectId,
					type: 'Note',
					attributedTo: remoteActorId,
					content: 'remote status',
					source: {
						content: 'remote status',
						mediaType: 'text/markdown',
					},
					to: [PUBLIC_GROUP],
					cc: [],
					attachment: [],
					sensitive: false,
				} satisfies Note),
				remoteActorId,
				originalObjectId,
				'remote-status-mastodon-id'
			)
			.run()
		await addFollowing(domain, db, { id: new URL(remoteActorId) }, actor)
		await acceptFollowing(db, { id: new URL(remoteActorId) }, actor)

		globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
			const request = new Request(input)
			if (request.url === `${remoteActorId}/inbox`) {
				assert.equal(request.method, 'POST')
				deliveredActivities.push(await request.json())
				return new Response()
			}

			throw new Error('unexpected request to ' + request.url)
		}

		const reblogRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/remote-status-mastodon-id/reblog`, { method: 'POST' }),
			{
				DATABASE: db,
				QUEUE: queue,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(reblogRes, 200)

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/remote-status-mastodon-id/unreblog`, { method: 'POST' }),
			{
				DATABASE: db,
				DO_CACHE: makeDOCache(),
				QUEUE: queue,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(res, 200)

		assert.equal(deliveredActivities.length, 2)
		assert.equal(queue.messages.length, 0)
		assert.equal(deliveredActivities[0].type, 'Announce')
		assert.equal(deliveredActivities[1].type, 'Undo')
		assert.equal(deliveredActivities[1].actor, actor.id.toString())
		assert.equal(deliveredActivities[1].object.type, 'Announce')
		assert.equal(deliveredActivities[1].object.actor, actor.id.toString())
		assert.equal(deliveredActivities[1].object.object, originalObjectId)
		assert.deepEqual(deliveredActivities[1].to, deliveredActivities[1].object.to)
		assert.deepEqual(deliveredActivities[1].cc, deliveredActivities[1].object.cc)
	})

	test('unreblog remote status keeps local state when Undo delivery fails', async () => {
		let inboxRequests = 0
		const db = makeDB()
		const queue = makeQueue()
		const actor = await createTestUser(domain, db, userKEK, 'remote-unreblog-delivery-failure@cloudflare.com')
		const remoteActorId = 'https://example.com/users/undo-failure-author'
		const originalObjectId = 'https://example.com/notes/undo-failure'
		const localObjectId = 'https://cloudflare.com/ap/o/undo-failure-note'

		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id)
					VALUES (?, 'Person', 'undo-failure-author', 'example.com', ?, ?)`
			)
			.bind(
				remoteActorId,
				JSON.stringify({
					id: remoteActorId,
					type: 'Person',
					preferredUsername: 'undo-failure-author',
					inbox: `${remoteActorId}/inbox`,
					outbox: `${remoteActorId}/outbox`,
					following: `${remoteActorId}/following`,
					followers: `${remoteActorId}/followers`,
				}),
				'undo-failure-author-mastodon-id'
			)
			.run()

		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, mastodon_id, local) VALUES (?, ?, ?, ?, ?, ?, 0)'
			)
			.bind(
				localObjectId,
				'Note',
				JSON.stringify({
					id: originalObjectId,
					type: 'Note',
					attributedTo: remoteActorId,
					content: 'remote status',
					source: {
						content: 'remote status',
						mediaType: 'text/markdown',
					},
					to: [PUBLIC_GROUP],
					cc: [],
					attachment: [],
					sensitive: false,
				} satisfies Note),
				remoteActorId,
				originalObjectId,
				'undo-failure-status-mastodon-id'
			)
			.run()
		await addFollowing(domain, db, { id: new URL(remoteActorId) }, actor)
		await acceptFollowing(db, { id: new URL(remoteActorId) }, actor)

		globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
			const request = new Request(input)
			if (request.url === `${remoteActorId}/inbox`) {
				inboxRequests += 1
				return inboxRequests === 1 ? new Response() : new Response('temporary failure', { status: 503 })
			}

			throw new Error('unexpected request to ' + request.url)
		}

		const reblogRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/undo-failure-status-mastodon-id/reblog`, { method: 'POST' }),
			{
				DATABASE: db,
				QUEUE: queue,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(reblogRes, 200)

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/undo-failure-status-mastodon-id/unreblog`, { method: 'POST' }),
			{
				DATABASE: db,
				DO_CACHE: makeDOCache(),
				QUEUE: queue,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(res, 200)
		assert.equal(inboxRequests, 2)

		const row = await db.prepare(`SELECT count(*) as count FROM actor_reblogs`).first<{ count: number }>()
		assert.equal(row?.count, 0)
	})
})
