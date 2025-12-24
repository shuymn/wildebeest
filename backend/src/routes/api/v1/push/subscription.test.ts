import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { createSubscription } from 'wildebeest/backend/src/mastodon/subscription'
import {
	makeDB,
	generateVAPIDKeys,
	createTestClient,
	createTestUser,
	assertStatus,
	assertCORS,
} from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek21'
const domain = 'cloudflare.com'

describe('/api/v1/push/subscription', () => {
	test('get non existing subscription', async () => {
		const db = makeDB()
		const vapidKeys = await generateVAPIDKeys()
		const client = await createTestClient(db)
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request('https://example.com/api/v1/push/subscription')
		const res = await app.fetch(req, {
			DATABASE: db,
			VAPID_JWK: JSON.stringify(vapidKeys),
			data: { connectedActor, clientId: client.id },
		})
		await assertStatus(res, 404)
		assertCORS(res, req)
	})

	test('get existing subscription', async () => {
		const db = makeDB()
		const vapidKeys = await generateVAPIDKeys()
		const client = await createTestClient(db)
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
				alerts: {
					follow: false,
					favourite: true,
					reblog: false,
					poll: true,
				},
				policy: 'followed',
			},
		}
		await createSubscription(db, connectedActor, client, data)

		const req = new Request('https://example.com/api/v1/push/subscription')
		const res = await app.fetch(req, {
			DATABASE: db,
			VAPID_JWK: JSON.stringify(vapidKeys),
			data: { connectedActor, clientId: client.id },
		})
		await assertStatus(res, 200)

		const out = await res.json<any>()
		assert.equal(typeof out.id, 'number')
		assert.equal(out.endpoint, data.subscription.endpoint)
		assert.equal(out.alerts.follow, false)
		assert.equal(out.alerts.favourite, true)
		assert.equal(out.alerts.reblog, false)
		assert.equal(out.alerts.poll, true)
		assert.equal(out.policy, 'followed')
	})

	test('create subscription', async () => {
		const db = makeDB()
		const vapidKeys = await generateVAPIDKeys()
		const client = await createTestClient(db)
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
				alerts: {
					poll: false,
					status: true,
				},
			},
		}

		const req = new Request('https://example.com/api/v1/push/subscription', {
			method: 'POST',
			body: JSON.stringify(data),
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			VAPID_JWK: JSON.stringify(vapidKeys),
			data: { connectedActor, clientId: client.id },
		})
		await assertStatus(res, 200)

		const out = await res.json<any>()
		assert.equal(out.alerts.mention, true)
		assert.equal(out.alerts.status, true) // default to true
		assert.equal(out.alerts.poll, false)
		assert.equal(out.policy, 'all') // default policy

		const row: any = await db.prepare('SELECT * FROM subscriptions').first()
		assert.equal(row.actor_id, connectedActor.id.toString())
		assert.equal(row.client_id, client.id)
		assert.equal(row.endpoint, data.subscription.endpoint)
		assert.equal(row.alert_poll, 0)
		assert.equal(row.alert_mention, 1)
		assert.equal(row.alert_status, 1) // default to true
		assert.equal(row.policy, 'all') // default policy
	})

	test('create subscriptions only creates one', async () => {
		const db = makeDB()
		const vapidKeys = await generateVAPIDKeys()
		const client = await createTestClient(db)
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
		await createSubscription(db, connectedActor, client, data)

		const req = new Request('https://example.com/api/v1/push/subscription', {
			method: 'POST',
			body: JSON.stringify(data),
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			VAPID_JWK: JSON.stringify(vapidKeys),
			data: { connectedActor, clientId: client.id },
		})
		await assertStatus(res, 200)

		const row = await db.prepare('SELECT count(*) as count FROM subscriptions').first<{ count: number }>()
		assert.equal(row?.count, 1)
	})
})
