import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { type Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, makeQueue, createTestUser, assertStatus } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/reblog', () => {
	test('reblog records in db', async () => {
		const db = await makeDB()
		const queue = makeQueue()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor
		const note = await createPublicStatus(domain, db, actor, 'my first status')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/reblog`, {
			method: 'POST',
			body: JSON.stringify({ visibility: 'public' }),
		})
		const res = await app.fetch(req, { DATABASE: db, QUEUE: queue, userKEK, data: { connectedActor } })
		await assertStatus(res, 200)

		const data = await res.json<{ reblogged: unknown }>()
		assert.equal(data.reblogged, true)

		const row = await db.prepare(`SELECT * FROM actor_reblogs`).first<{ actor_id: string; object_id: string }>()
		assert.ok(row)
		assert.equal(row.actor_id, actor.id.toString())
		assert.equal(row.object_id, note.id.toString())
	})

	test('reblog status adds in actor outbox', async () => {
		const db = await makeDB()
		const queue = makeQueue()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor
		const note = await createPublicStatus(domain, db, actor, 'my first status')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/reblog`, {
			method: 'POST',
			body: JSON.stringify({ visibility: 'public' }),
		})
		const res = await app.fetch(req, { DATABASE: db, QUEUE: queue, userKEK, data: { connectedActor } })
		await assertStatus(res, 200)

		const row = await db.prepare(`SELECT * FROM outbox_objects`).first<{ actor_id: string; object_id: string }>()
		assert.ok(row)
		assert.equal(row.actor_id, actor.id.toString())
		assert.equal(row.object_id, note.id.toString())
	})

	test('reblog remote status status sends Announce activity to author', async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let deliveredActivity: any = null

		const db = await makeDB()
		const queue = makeQueue()

		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor
		const originalObjectId = 'https://example.com/note123'

		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, mastodon_id, local) VALUES (?, ?, ?, ?, ?, ?, 0)'
			)
			.bind(
				'https://example.com/object1',
				'Note',
				JSON.stringify({
					attributedTo: actor.id.toString(),
					id: '1',
					type: 'Note',
					content: 'my first status',
					source: {
						content: 'my first status',
						mediaType: 'text/markdown',
					},
					to: [PUBLIC_GROUP],
					cc: [],
					attachment: [],
					sensitive: false,
				} satisfies Note),
				actor.id.toString(),
				originalObjectId,
				'mastodonid1'
			)
			.run()

		globalThis.fetch = async (input: RequestInfo) => {
			const request = new Request(input)
			if (request.url === 'https://cloudflare.com/ap/users/sven/inbox') {
				assert.equal(request.method, 'POST')
				const body = await request.json()
				deliveredActivity = body
				return new Response()
			}

			throw new Error('unexpected request to ' + request.url)
		}

		const req = new Request(`https://${domain}/api/v1/statuses/mastodonid1/reblog`, {
			method: 'POST',
			body: JSON.stringify({ visibility: 'public' }),
		})
		const res = await app.fetch(req, { DATABASE: db, QUEUE: queue, userKEK, data: { connectedActor } })
		await assertStatus(res, 200)

		assert.ok(deliveredActivity)
		assert.equal(deliveredActivity.type, 'Announce')
		assert.equal(deliveredActivity.actor, actor.id.toString())
		assert.equal(deliveredActivity.object, originalObjectId)
	})
})
