import { strict as assert } from 'node:assert/strict'

import { createSubscription } from 'wildebeest/backend/src/mastodon/subscription'
import { makeDB, createTestUser, createTestClient } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek21'
const domain = 'cloudflare.com'

describe('mastodon/subscription', () => {
	test('subscriptions auto increment', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const data: any = {
			subscription: {
				endpoint: 'https://endpoint.com',
				keys: {
					p256dh: 'p256dh',
					auth: 'auth',
				},
			},
			data: {
				alerts: {},
				policy: 'all',
			},
		}

		const client1 = await createTestClient(db)
		const sub1 = await createSubscription(db, connectedActor, client1, data)
		assert.equal(sub1.id, 1)

		const client2 = await createTestClient(db)
		const sub2 = await createSubscription(db, connectedActor, client2, data)
		assert.equal(sub2.id, 2)

		const client3 = await createTestClient(db)
		const sub3 = await createSubscription(db, connectedActor, client3, data)
		assert.equal(sub3.id, 3)
	})
})
