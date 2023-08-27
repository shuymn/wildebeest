import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { MessageType } from 'wildebeest/backend/src/types'
import { signRequest } from 'wildebeest/backend/src/utils/http-signing'
import { generateDigestHeader } from 'wildebeest/backend/src/utils/http-signing-cavage'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import { assertStatus, createTestUser, makeDB } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek5'
const vapidKeys = {} as JWK
const domain = 'cloudflare.com'

describe('Inbox', () => {
	test('send Note to non existent user', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === connectedActor.id.toString()) {
					return new Response(JSON.stringify({ publicKey: connectedActor.publicKey }))
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const queue = {
			async send() {
				return
			},
			async sendBatch() {
				throw new Error('unimplemented')
			},
		}

		const body = JSON.stringify({})
		const req = new Request(`https://${domain}/ap/users/sven/inbox`, {
			method: 'POST',
			body,
			headers: {
				Digest: await generateDigestHeader(body),
			},
		})
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await signRequest(req, signingKey, new URL(connectedActor.id))
		const res = await app.fetch(req, { DATABASE: db, QUEUE: queue, userKEK, VAPID_JWK: JSON.stringify(vapidKeys) })
		await assertStatus(res, 404)
	})

	test('send activity sends message in queue', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === actor.id.toString()) {
					return new Response(JSON.stringify({ publicKey: actor.publicKey }))
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		let msg: any = null

		const queue = {
			async send(v: any) {
				msg = v
			},
			async sendBatch() {
				throw new Error('unimplemented')
			},
		}

		const body = JSON.stringify({ type: 'some activity' })
		const req = new Request(`https://${domain}/ap/users/sven/inbox`, {
			method: 'POST',
			body,
			headers: {
				Digest: await generateDigestHeader(body),
			},
		})
		const signingKey = await getSigningKey(userKEK, db, actor)
		await signRequest(req, signingKey, new URL(actor.id))
		const res = await app.fetch(req, { DATABASE: db, QUEUE: queue, userKEK, VAPID_JWK: JSON.stringify(vapidKeys) })
		await assertStatus(res, 200)

		assert(msg)
		assert.equal(msg.type, MessageType.Inbox)
		assert.equal(msg.actorId, actor.id.toString())
		assert.equal(msg.activity.type, 'some activity')
	})
})
