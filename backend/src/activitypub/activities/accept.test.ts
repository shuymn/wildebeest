import { strict as assert } from 'node:assert/strict'

import { getUserId } from '@wildebeest/backend/accounts'
import { AcceptActivity, FollowActivity } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import { addFollowing } from '@wildebeest/backend/mastodon/follow'
import { makeDB, createTestUser, createActivityId } from '@wildebeest/backend/test/utils'
import { actorToHandle } from '@wildebeest/backend/utils/handle'
import { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek15'
const vapidKeys = {} as JWK

describe('Accept', () => {
	beforeEach(() => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof Request) {
				throw new Error('unexpected request to ' + input.url)
			}
			throw new Error('unexpected request to ' + input.toString())
		}
	})

	test('Accept follow request stores in db', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		await addFollowing(domain, db, actor, actor2)

		const activity: AcceptActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId(domain),
			type: 'Accept',
			actor: getUserId(domain, actorToHandle(actor2)),
			object: {
				type: 'Follow',
				actor: actor.id,
				object: getUserId(domain, actorToHandle(actor)),
			} as FollowActivity,
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const row = await db
			.prepare(`SELECT target_actor_id, state FROM actor_following WHERE actor_id=?`)
			.bind(actor.id.toString())
			.first<{
				target_actor_id: string
				state: string
			}>()
		assert(row)
		assert.equal(row.target_actor_id, 'https://' + domain + '/ap/users/sven2')
		assert.equal(row.state, 'accepted')
	})

	test('Object must be an object', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const activity: any = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			type: 'Accept',
			actor: getApId('https://example.com/actor'),
			object: 'a',
		}

		await assert.rejects(activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys), {
			message: '`activity.object` must be of type object',
		})
	})
})
