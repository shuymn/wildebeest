import { strict as assert } from 'node:assert/strict'

import { Activity, FollowActivity } from 'wildebeest/backend/src/activitypub/activities'
import * as activityHandler from 'wildebeest/backend/src/activitypub/activities/handle'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import * as ap_followers from 'wildebeest/functions/ap/users/[id]/followers'
import * as ap_followers_page from 'wildebeest/functions/ap/users/[id]/followers/page'
import * as ap_following from 'wildebeest/functions/ap/users/[id]/following'
import * as ap_following_page from 'wildebeest/functions/ap/users/[id]/following/page'

import { assertStatus, createActivityId, createTestUser, makeDB } from '../utils'

const userKEK = 'test_kek10'
const domain = 'cloudflare.com'
const adminEmail = 'admin@example.com'
const vapidKeys = {} as JWK

describe('ActivityPub', () => {
	describe('Follow', () => {
		let receivedActivity: Activity | null = null

		beforeEach(() => {
			receivedActivity = null

			globalThis.fetch = async (input: RequestInfo) => {
				const request = new Request(input)
				if (request.url === `https://${domain}/ap/users/sven2/inbox`) {
					assert.equal(request.method, 'POST')
					const data = await request.json<Activity>()
					receivedActivity = data
					return new Response('')
				}

				throw new Error('unexpected request to ' + request.url)
			}
		})

		test('Receive follow with Accept reply', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

			const activity: Activity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Follow',
				actor: actor2.id,
				object: actor.id,
			}

			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const row = await db
				.prepare(`SELECT target_actor_id, state FROM actor_following WHERE actor_id=?`)
				.bind(actor2.id.toString())
				.first<{
					target_actor_id: string
					state: string
				}>()
			assert(row)
			assert.equal(row.target_actor_id, actor.id.toString())
			assert.equal(row.state, 'accepted')

			assert(receivedActivity)
			assert.equal(receivedActivity.type, 'Accept')
			assert.equal(getApId(receivedActivity.actor).toString(), actor.id.toString())
			assert.equal(
				getApId((receivedActivity.object as FollowActivity).actor).toString(),
				getApId(activity.actor).toString()
			)
			assert.equal((receivedActivity.object as FollowActivity).type, activity.type)
		})

		test('list actor following', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
			await addFollowing(domain, db, actor, actor2)
			await acceptFollowing(db, actor, actor2)
			await addFollowing(domain, db, actor, actor3)
			await acceptFollowing(db, actor, actor3)

			const res = await ap_following.handleRequest(domain, db, 'sven')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.type, 'OrderedCollection')
			assert.equal(data.totalItems, 2)
		})

		test('list actor following page', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
			await addFollowing(domain, db, actor, actor2)
			await acceptFollowing(db, actor, actor2)
			await addFollowing(domain, db, actor, actor3)
			await acceptFollowing(db, actor, actor3)

			const res = await ap_following_page.handleRequest(domain, db, 'sven')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.type, 'OrderedCollectionPage')
			assert.equal(data.orderedItems[0], `https://${domain}/ap/users/sven2`)
			assert.equal(data.orderedItems[1], `https://${domain}/ap/users/sven3`)
		})

		test('list actor follower', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			await addFollowing(domain, db, actor2, actor)
			await acceptFollowing(db, actor2, actor)

			const res = await ap_followers.handleRequest(domain, db, 'sven')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.type, 'OrderedCollection')
			assert.equal(data.totalItems, 1)
		})

		test('list actor follower page', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			await addFollowing(domain, db, actor2, actor)
			await acceptFollowing(db, actor2, actor)

			const res = await ap_followers_page.handleRequest(domain, db, 'sven')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.type, 'OrderedCollectionPage')
			assert.equal(data.orderedItems[0], `https://${domain}/ap/users/sven2`)
		})

		test('creates a notification', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

			const activity: Activity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Follow',
				actor: actor2.id,
				object: actor.id,
			}

			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const entry = await db.prepare('SELECT * FROM actor_notifications').first<{
				type: string
				actor_id: string
				from_actor_id: string
			}>()
			assert.ok(entry)
			assert.equal(entry.type, 'follow')
			assert.equal(entry.actor_id.toString(), actor.id.toString())
			assert.equal(entry.from_actor_id.toString(), actor2.id.toString())
		})

		test('ignore when trying to follow multiple times', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

			const activity: Activity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Follow',
				actor: actor2.id,
				object: actor.id,
			}

			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			// Even if we followed multiple times, only one row should be present.
			const { count } = await db
				.prepare(`SELECT count(*) as count FROM actor_following`)
				.first<{ count: number }>()
				.then((row) => {
					assert.ok(row)
					return row
				})
			assert.equal(count, 1)
		})
	})
})
