import { strict as assert } from 'node:assert/strict'

import { FollowActivity, RejectActivity } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { addFollowing, ensureAcceptedFollowingIfNotBlocked } from '@wildebeest/backend/mastodon/follow'
import { createActivityId, createTestUser, makeDB } from '@wildebeest/backend/test/utils'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek_reject'
const vapidKeys = {} as JWK

const remoteActorId = 'https://example.com/users/remote'
const otherRemoteActorId = 'https://example.com/users/other'

describe('Reject', () => {
	beforeEach(() => {
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
	})

	test('removes the pending following of the rejecting actor', async () => {
		const db = makeDB()
		const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const remote = await getAndCacheActor(new URL(remoteActorId), db)
		assert(remote)
		await addFollowing(domain, db, local, remote)

		const activity: RejectActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId('example.com'),
			type: 'Reject',
			actor: remote.id,
			object: {
				id: createActivityId(domain),
				type: 'Follow',
				actor: local.id,
				object: remote.id,
			} as FollowActivity,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const row = await db
			.prepare('SELECT count(*) as count FROM actor_following WHERE actor_id = ?')
			.bind(local.id.toString())
			.first<{ count: number }>()
		assert.equal(row?.count, 0)
	})

	test('removes an already accepted following of the rejecting actor', async () => {
		const db = makeDB()
		const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const remote = await getAndCacheActor(new URL(remoteActorId), db)
		assert(remote)
		assert(await ensureAcceptedFollowingIfNotBlocked(domain, db, local, remote))

		const activity: RejectActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId('example.com'),
			type: 'Reject',
			actor: remote.id,
			object: {
				id: createActivityId(domain),
				type: 'Follow',
				actor: local.id,
				object: remote.id,
			} as FollowActivity,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const row = await db
			.prepare('SELECT count(*) as count FROM actor_following WHERE actor_id = ?')
			.bind(local.id.toString())
			.first<{ count: number }>()
		assert.equal(row?.count, 0)
	})

	test('is ignored when the Reject actor is not the followee', async () => {
		const db = makeDB()
		const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const remote = await getAndCacheActor(new URL(remoteActorId), db)
		const other = await getAndCacheActor(new URL(otherRemoteActorId), db)
		assert(remote)
		assert(other)
		await addFollowing(domain, db, local, remote)

		const activity: RejectActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId('example.com'),
			type: 'Reject',
			actor: other.id,
			object: {
				id: createActivityId(domain),
				type: 'Follow',
				actor: local.id,
				object: remote.id,
			} as FollowActivity,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const row = await db
			.prepare('SELECT target_actor_id FROM actor_following WHERE actor_id = ?')
			.bind(local.id.toString())
			.first<{ target_actor_id: string }>()
		assert.equal(row?.target_actor_id.toString(), remote.id.toString())
	})
})
