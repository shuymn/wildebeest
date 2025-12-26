import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { PUBLIC_GROUP, UpdateActivity } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { Actor } from '@wildebeest/backend/activitypub/actors'
import { ApObject, getAndCacheObject, getApId, mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { Note } from '@wildebeest/backend/activitypub/objects/note'
import { makeDB, createActivityId, createTestUser, assertStatus } from '@wildebeest/backend/test/utils'
import { MastodonStatusEdit } from '@wildebeest/backend/types'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek15'
const vapidKeys = {} as JWK

describe('Update', () => {
	test('Object must be an object', async () => {
		const db = makeDB()

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const activity: any = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			type: 'Update',
			actor: 'https://example.com/actor',
			object: 'a',
		}

		await assert.rejects(activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys), {
			message: '`activity.object` must be of type object',
		})
	})

	test('Object must exist', async () => {
		const db = makeDB()

		const activity: UpdateActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId(domain),
			type: 'Update',
			actor: getApId('https://example.com/actor'),
			object: {
				id: getApId('https://example.com/note2'),
				type: 'Note',
				content: 'test note',
			},
		}

		await assert.rejects(activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys), {
			message: 'object https://example.com/note2 does not exist',
		})
	})

	test('Object must have the same origin', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const object: ApObject = {
			id: getApId('https://example.com/note2'),
			type: 'Note',
			content: 'test note',
		}

		const obj = await getAndCacheObject(domain, db, object, actor)
		assert.notEqual(obj, null, 'could not create object')

		const activity: UpdateActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId(domain),
			type: 'Update',
			actor: getApId('https://example.com/actor'),
			object: object,
		}

		await assert.rejects(activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys), {
			message: 'actor.id mismatch when updating object',
		})
	})

	test('Object(Note) is updated', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const note: Note = {
			id: 'https://example.com/note2',
			type: 'Note',
			attributedTo: actor.id,
			attachment: [],
			content: 'test note<script>alert("evil")</script>',
			to: [PUBLIC_GROUP],
			cc: [],
			sensitive: false,
		}

		const { object: obj } = await getAndCacheObject(domain, db, note, actor)
		assert.ok(obj, 'could not create object')

		const now = new Date('2023-08-16T16:22:14.190Z').toISOString()
		const newNote: Note = {
			...note,
			content: 'new test note<script>alert("evil")</script>',
			updated: now,
		}

		const activity: UpdateActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId(domain),
			type: 'Update',
			actor: actor.id,
			object: newNote,
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const updatedObject = await db
			.prepare('SELECT id, properties FROM objects WHERE original_object_id=?')
			.bind(note.id.toString())
			.first<{ id: string; properties: string }>()
		assert(updatedObject)
		assert.equal(JSON.parse(updatedObject.properties).content, newNote.content)

		{
			const res = await app.fetch(new Request(`https://${domain}/api/v1/statuses/${obj[mastodonIdSymbol]}/history`), {
				DATABASE: db,
				data: { connectedActor: actor },
			})
			await assertStatus(res, 200)

			const data = await res.json<MastodonStatusEdit[]>()
			assert.equal(data.length, 2)
			assert.equal(data[0].content, 'test note<p>alert("evil")</p>')
			assert.equal(data[1].content, 'new test note<p>alert("evil")</p>')
			assert.notEqual(data[0].created_at, data[1].created_at)
		}

		{
			// duplicate update
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)
			const res = await db
				.prepare('SELECT count(*) as count FROM object_revisions WHERE object_id=?')
				.bind(updatedObject.id)
				.first<{ count: number }>()
			assert.ok(res)
			assert.equal(res.count, 1)
		}
	})

	test('Object(Actor) is updated', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const newObject: Actor = {
			...actor,
			summary: 'new summary',
		}

		const activity: UpdateActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId(domain),
			type: 'Update',
			actor: actor.id,
			object: newObject,
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const updatedObject = await db
			.prepare('SELECT properties FROM actors WHERE id=?')
			.bind(actor.id.toString())
			.first<{ properties: string }>()
		assert.ok(updatedObject)
		assert.equal(JSON.parse(updatedObject.properties).content, newObject.content)
	})
})
