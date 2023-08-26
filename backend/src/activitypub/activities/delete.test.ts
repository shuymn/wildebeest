import { strict as assert } from 'node:assert/strict'

import { DeleteActivity, PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import * as activityHandler from 'wildebeest/backend/src/activitypub/activities/handle'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, createActivityId } from 'wildebeest/backend/test/utils'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek15'
const vapidKeys = {} as JWK

describe('Delete', () => {
	test('delete Note', async () => {
		const db = await makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const originalObjectId = 'https://example.com/note123'

		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, local, mastodon_id) VALUES (?, ?, ?, ?, ?, 1, ?)'
			)
			.bind(
				'https://example.com/object1',
				'Note',
				JSON.stringify({
					id: originalObjectId,
					type: 'Note',
					content: 'my first status',
					to: [PUBLIC_GROUP],
					cc: [],
					attributedTo: actorA.id.toString(),
					attachment: [],
					sensitive: false,
				} satisfies Note),
				actorA.id.toString(),
				originalObjectId,
				'mastodonid1'
			)
			.run()

		const activity: DeleteActivity = {
			type: 'Delete',
			id: createActivityId(domain),
			actor: actorA.id,
			object: getApId(originalObjectId),
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const { count } = await db
			.prepare('SELECT count(*) as count FROM objects')
			.first<{ count: number }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(count, 0)
	})

	test('delete Tombstone', async () => {
		const db = await makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const originalObjectId = 'https://example.com/note456'

		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, local, mastodon_id) VALUES (?, ?, ?, ?, ?, 1, ?)'
			)
			.bind(
				'https://example.com/object1',
				'Note',
				JSON.stringify({
					id: originalObjectId,
					type: 'Note',
					content: 'my first status',
					to: [PUBLIC_GROUP],
					cc: [],
					attributedTo: actorA.id.toString(),
					attachment: [],
					sensitive: false,
				} satisfies Note),
				actorA.id.toString(),
				originalObjectId,
				'mastodonid1'
			)
			.run()

		const activity: DeleteActivity = {
			type: 'Delete',
			id: createActivityId(domain),
			actor: actorA.id,
			object: {
				type: 'Tombstone',
				id: getApId(originalObjectId),
			},
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const { count } = await db
			.prepare('SELECT count(*) as count FROM objects')
			.first<{ count: number }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(count, 0)
	})

	test('reject Note deletion from another Actor', async () => {
		const db = await makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		const originalObjectId = 'https://example.com/note123'

		// ActorB creates a Note
		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, local, mastodon_id) VALUES (?, ?, ?, ?, ?, 1, ?)'
			)
			.bind(
				'https://example.com/object1',
				'Note',
				JSON.stringify({
					id: originalObjectId,
					type: 'Note',
					content: 'my first status',
					to: [PUBLIC_GROUP],
					cc: [],
					attributedTo: actorB.id.toString(),
					attachment: [],
					sensitive: false,
				} satisfies Note),
				actorB.id.toString(),
				originalObjectId,
				'mastodonid1'
			)
			.run()

		const activity: DeleteActivity = {
			type: 'Delete',
			id: createActivityId(domain),
			actor: actorA.id, // ActorA attempts to delete
			object: actorA.id,
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		// Ensure that we didn't actually delete the object
		const { count } = await db
			.prepare('SELECT count(*) as count FROM objects')
			.first<{ count: number }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(count, 1)
	})

	test('ignore deletion of an Actor', async () => {
		const db = await makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

		const activity: DeleteActivity = {
			type: 'Delete',
			id: createActivityId(domain),
			actor: actorA.id,
			object: actorA.id,
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		// Ensure that we didn't actually delete the actor
		const { count } = await db
			.prepare('SELECT count(*) as count FROM actors')
			.first<{ count: number }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(count, 1)
	})

	test('ignore deletion of a local Note', async () => {
		// Deletion of local Note should only be done using Mastodon API
		// (ie ActivityPub client-to-server).

		const db = await makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

		const note = await createPublicStatus(domain, db, actorA, 'my first status')

		const activity: DeleteActivity = {
			type: 'Delete',
			id: createActivityId(domain),
			actor: actorA.id,
			object: note.id,
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const { count } = await db
			.prepare('SELECT count(*) as count FROM objects')
			.first<{ count: number }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(count, 1)
	})
})
