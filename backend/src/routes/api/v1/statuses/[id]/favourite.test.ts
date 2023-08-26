import { strict as assert } from 'node:assert/strict'

import * as activities from 'wildebeest/backend/src/activitypub/activities'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { type Note } from 'wildebeest/backend/src/activitypub/objects/note'
import * as statuses_favourite from 'wildebeest/backend/src/routes/api/v1/statuses/[id]/favourite'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/favourite', () => {
	test('favourite status sends Like activity', async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let deliveredActivity: any = null

		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const originalObjectId = 'https://example.com/note123'

		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, local, mastodon_id) VALUES (?, ?, ?, ?, ?, 1, ?)'
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
					to: [activities.PUBLIC_GROUP],
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
			if (request.url === actor.id.toString() + '/inbox') {
				assert.equal(request.method, 'POST')
				const body = await request.json()
				deliveredActivity = body
				return new Response()
			}

			throw new Error('unexpected request to ' + request.url)
		}

		const connectedActor = actor

		const res = await statuses_favourite.handleRequest(db, 'mastodonid1', connectedActor, userKEK, domain)
		await assertStatus(res, 200)

		assert(deliveredActivity)
		assert.equal(deliveredActivity.type, 'Like')
		assert.equal(deliveredActivity.object, originalObjectId)
	})

	test('favourite records in db', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'my first status')

		const connectedActor = actor

		const res = await statuses_favourite.handleRequest(db, note[mastodonIdSymbol]!, connectedActor, userKEK, domain)
		await assertStatus(res, 200)

		const data = await res.json<{ favourited: boolean }>()
		assert.equal(data.favourited, true)

		const row = await db.prepare(`SELECT * FROM actor_favourites`).first<{ actor_id: string; object_id: string }>()
		assert.ok(row)
		assert.equal(row.actor_id, actor.id.toString())
		assert.equal(row.object_id, note.id.toString())
	})
})
