import { strict as assert } from 'node:assert/strict'

import { FollowActivity, LikeActivity, UndoActivity } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { deliverFollowers } from '@wildebeest/backend/activitypub/deliver'
import { ensureAcceptedFollowingIfNotBlocked } from '@wildebeest/backend/mastodon/follow'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { createActivityId, createTestUser, makeDB, makeQueue } from '@wildebeest/backend/test/utils'
import type { DeliverMessageBody } from '@wildebeest/backend/types'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek_undo'
const vapidKeys = {} as JWK

const remoteActorId = 'https://example.com/users/remote'
const otherRemoteActorId = 'https://example.com/users/other'

function mockRemoteActors() {
	globalThis.fetch = async (input) => {
		const url = input instanceof Request ? input.url : input.toString()
		if (url === remoteActorId || url === otherRemoteActorId) {
			return Response.json({
				id: url,
				type: 'Person',
				preferredUsername: url.endsWith('remote') ? 'remote' : 'other',
				inbox: 'https://example.com/inbox',
			})
		}
		throw new Error('unexpected request to ' + url)
	}
}

describe('Undo', () => {
	beforeEach(mockRemoteActors)

	describe('Undo Follow', () => {
		test('removes the remote follower and stops delivering followers-only posts', async () => {
			const db = makeDB()
			const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const remote = await getAndCacheActor(new URL(remoteActorId), db)
			assert(remote)
			assert(await ensureAcceptedFollowingIfNotBlocked(domain, db, remote, local))

			const note = await createPublicStatus(domain, db, local, 'followers only')
			const followersOnly = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Create' as const,
				actor: local.id,
				object: note,
				to: [local.followers.toString()],
				cc: [],
			}

			const before = makeQueue()
			await deliverFollowers(db, userKEK, local, followersOnly, before)
			assert.deepEqual(
				before.messages.map(({ toActorId }: DeliverMessageBody) => toActorId),
				[remoteActorId]
			)

			const activity: UndoActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Undo',
				actor: remote.id,
				object: {
					id: createActivityId('example.com'),
					type: 'Follow',
					actor: remote.id,
					object: local.id,
				} as FollowActivity,
			}
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const row = await db
				.prepare('SELECT count(*) as count FROM actor_following WHERE target_actor_id = ?')
				.bind(local.id.toString())
				.first<{ count: number }>()
			assert.equal(row?.count, 0)

			const after = makeQueue()
			await deliverFollowers(db, userKEK, local, followersOnly, after)
			assert.deepEqual(after.messages, [])
		})

		test('is ignored when the Undo actor is not the follower', async () => {
			const db = makeDB()
			const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const remote = await getAndCacheActor(new URL(remoteActorId), db)
			const other = await getAndCacheActor(new URL(otherRemoteActorId), db)
			assert(remote)
			assert(other)
			assert(await ensureAcceptedFollowingIfNotBlocked(domain, db, remote, local))

			const activity: UndoActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Undo',
				actor: other.id,
				object: {
					id: createActivityId('example.com'),
					type: 'Follow',
					actor: remote.id,
					object: local.id,
				} as FollowActivity,
			}
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const row = await db
				.prepare('SELECT count(*) as count FROM actor_following WHERE target_actor_id = ?')
				.bind(local.id.toString())
				.first<{ count: number }>()
			assert.equal(row?.count, 1)
		})
	})

	describe('Undo Like', () => {
		test('removes the favourite and its notification', async () => {
			const db = makeDB()
			const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const remote = await getAndCacheActor(new URL(remoteActorId), db)
			assert(remote)
			const note = await createPublicStatus(domain, db, local, 'my first status')

			const like: LikeActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId('example.com'),
				type: 'Like',
				actor: remote.id,
				object: note.id,
			}
			await activityHandler.handle(domain, like, db, userKEK, adminEmail, vapidKeys)
			assert(await db.prepare('SELECT 1 FROM actor_favourites').first())
			assert(await db.prepare(`SELECT 1 FROM actor_notifications WHERE type = 'favourite'`).first())

			const activity: UndoActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Undo',
				actor: remote.id,
				object: like,
			}
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			assert.equal(await db.prepare('SELECT 1 FROM actor_favourites').first(), null)
			assert.equal(await db.prepare(`SELECT 1 FROM actor_notifications WHERE type = 'favourite'`).first(), null)
		})

		test('is ignored when the Undo actor is not the liker', async () => {
			const db = makeDB()
			const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const remote = await getAndCacheActor(new URL(remoteActorId), db)
			const other = await getAndCacheActor(new URL(otherRemoteActorId), db)
			assert(remote)
			assert(other)
			const note = await createPublicStatus(domain, db, local, 'my first status')

			const like: LikeActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId('example.com'),
				type: 'Like',
				actor: remote.id,
				object: note.id,
			}
			await activityHandler.handle(domain, like, db, userKEK, adminEmail, vapidKeys)

			const activity: UndoActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: createActivityId(domain),
				type: 'Undo',
				actor: other.id,
				object: like,
			}
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const row = await db.prepare('SELECT actor_id FROM actor_favourites').first<{ actor_id: string }>()
			assert.equal(row?.actor_id.toString(), remote.id.toString())
		})
	})
})
