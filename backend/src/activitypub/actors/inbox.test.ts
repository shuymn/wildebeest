import { strict as assert } from 'node:assert/strict'

import * as ap_inbox from 'wildebeest/backend/src/routes/ap/users/[id]/inbox'
import { MessageType } from 'wildebeest/backend/src/types'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import { assertStatus, createTestUser, makeDB } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek5'
const vapidKeys = {} as JWK
const domain = 'cloudflare.com'

describe('Inbox', () => {
	test('send Note to non existent user', async () => {
		const db = await makeDB()

		const queue = {
			async send() {
				return
			},
			async sendBatch() {
				throw new Error('unimplemented')
			},
		}

		const activity: any = {}
		const res = await ap_inbox.handleRequest(domain, db, 'sven', activity, queue, userKEK, vapidKeys)
		await assertStatus(res, 404)
	})

	test('send activity sends message in queue', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		let msg: any = null

		const queue = {
			async send(v: any) {
				msg = v
			},
			async sendBatch() {
				throw new Error('unimplemented')
			},
		}

		const activity: any = {
			type: 'some activity',
		}
		const res = await ap_inbox.handleRequest(domain, db, 'sven', activity, queue, userKEK, vapidKeys)
		await assertStatus(res, 200)

		assert(msg)
		assert.equal(msg.type, MessageType.Inbox)
		assert.equal(msg.actorId, actor.id.toString())
		assert.equal(msg.activity.type, 'some activity')
	})
})
