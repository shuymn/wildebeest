import { strict as assert } from 'node:assert/strict'

import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import {
	insertFollowNotification,
	createNotification,
	getNotifications,
	sendLikeNotification,
} from 'wildebeest/backend/src/mastodon/notification'
import { createSubscription } from 'wildebeest/backend/src/mastodon/subscription'
import { arrayBufferToBase64 } from 'wildebeest/backend/src/utils/key-ops'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, createTestClient } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek15'
const domain = 'cloudflare.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const vapidKeys = {} as JWK

function parseCryptoKey(s: string): any {
	const parts = s.split(';')
	const out: any = {}
	for (let i = 0, len = parts.length; i < len; i++) {
		const parts2 = parts[i].split('=')
		out[parts2[0]] = parts2[1]
	}

	return out
}

describe('mastodon/notification', () => {
	test('returns notifications stored in db', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const fromActor = await createTestUser(domain, db, userKEK, 'from@cloudflare.com')

		const note = await createPublicStatus(domain, db, connectedActor, 'my first status')
		await insertFollowNotification(db, connectedActor, fromActor)
		await sleep(10)
		await createNotification(db, 'favourite', connectedActor, fromActor, note)
		await sleep(10)
		await createNotification(db, 'mention', connectedActor, fromActor, note)

		const notifications = await getNotifications(db, connectedActor, domain)

		assert.equal(notifications[0].type, 'mention')
		assert.equal(notifications[0].account.username, 'from')
		assert.equal(notifications[0].status?.id, note[mastodonIdSymbol])

		assert.equal(notifications[1].type, 'favourite')
		assert.equal(notifications[1].account.username, 'from')
		assert.equal(notifications[1].status?.id, note[mastodonIdSymbol])
		assert.equal(notifications[1].status?.account.username, 'sven')

		assert.equal(notifications[2].type, 'follow')
		assert.equal(notifications[2].account.username, 'from')
		assert.equal(notifications[2].status, undefined)
	})

	test('send like notification', async () => {
		const db = await makeDB()

		const clientKeys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify',
		])) as CryptoKeyPair

		globalThis.fetch = async (input: RequestInfo, data: any) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://push.com') {
					assert((data.headers['Authorization'] as string).includes('WebPush'))

					const cryptoKeyHeader = parseCryptoKey(data.headers['Crypto-Key'])
					assert(cryptoKeyHeader.dh)
					assert(cryptoKeyHeader.p256ecdsa)

					// Ensure the data has a valid signature using the client public key
					const sign = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, clientKeys.privateKey, data.body)
					assert(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, clientKeys.publicKey, sign, data.body))

					// TODO: eventually decrypt what the server pushed

					return new Response()
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const client = await createTestClient(db)
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const p256dh = arrayBufferToBase64((await crypto.subtle.exportKey('raw', clientKeys.publicKey)) as ArrayBuffer)
		const auth = arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(16)))

		await createSubscription(db, actor, client, {
			subscription: {
				endpoint: 'https://push.com',
				keys: {
					p256dh,
					auth,
				},
			},
			data: {
				alerts: {},
				policy: 'all',
			},
		})

		const fromActor = await createTestUser(domain, db, userKEK, 'from@cloudflare.com')
		await sendLikeNotification(db, fromActor, actor, 'notifid', 'admin@example.com', vapidKeys)
	})
})
