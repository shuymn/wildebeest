import { strict as assert } from 'node:assert/strict'

import { LikeActivity } from 'wildebeest/backend/src/activitypub/activities'
import * as activityHandler from 'wildebeest/backend/src/activitypub/activities/handle'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { createActivityId, createTestUser, makeDB } from 'wildebeest/backend/test/utils'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek15'
const vapidKeys = {} as JWK

describe('Like', () => {
	test('records like in db', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		const note = await createPublicStatus(domain, db, actorA, 'my first status')

		const activity: LikeActivity = {
			type: 'Like',
			id: createActivityId(domain),
			actor: actorB.id,
			object: note.id,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db.prepare('SELECT * FROM actor_favourites').first<{ actor_id: URL; object_id: URL }>()
		assert.ok(entry)
		assert.equal(entry.actor_id.toString(), actorB.id.toString())
		assert.equal(entry.object_id.toString(), note.id.toString())
	})

	test('creates notification', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		const note = await createPublicStatus(domain, db, actorA, 'my first status')

		const activity: LikeActivity = {
			type: 'Like',
			id: createActivityId(domain),
			actor: actorB.id,
			object: note.id,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db.prepare('SELECT * FROM actor_notifications').first<{
			type: string
			actor_id: URL
			from_actor_id: URL
		}>()
		assert.ok(entry)
		assert.equal(entry.type, 'favourite')
		assert.equal(entry.actor_id.toString(), actorA.id.toString())
		assert.equal(entry.from_actor_id.toString(), actorB.id.toString())
	})

	test('records like in db', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		const note = await createPublicStatus(domain, db, actorA, 'my first status')

		const activity: LikeActivity = {
			type: 'Like',
			id: createActivityId(domain),
			actor: actorB.id,
			object: note.id,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db.prepare('SELECT * FROM actor_favourites').first<{
			actor_id: URL
			object_id: URL
		}>()
		assert.ok(entry)
		assert.equal(entry.actor_id.toString(), actorB.id.toString())
		assert.equal(entry.object_id.toString(), note.id.toString())
	})
})
