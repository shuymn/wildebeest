import { strict as assert } from 'node:assert/strict'

import type { DeliverMessageBody, InboxMessageBody } from '@wildebeest/backend/types'
import { MessageType } from '@wildebeest/backend/types'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'

import consumer, { Env } from '../src'
import { handleDeliverMessage } from '../src/deliver'

const domain = 'cloudflare.com'
const userKEK = 'test_kek25'

describe('Consumer', () => {
	describe('Deliver', () => {
		test('deliver to target Actor', async () => {
			const db = makeDB()

			let receivedActivity: any = null

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/users/a') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/users/a',
								type: 'Person',
								preferredUsername: 'someone',
								inbox: 'https://example.com/inbox',
							})
						)
					}
					throw new Error('unexpected request to ' + input.toString())
				} else {
					if (input.url.toString() === 'https://example.com/inbox') {
						assert(input.headers.get('accept')!.includes('json'))
						assert(input.headers.get('user-agent')!.includes('Wildebeest'))
						assert(input.headers.get('user-agent')!.includes(domain))
						assert.equal(input.method, 'POST')
						receivedActivity = await input.json()
						return new Response('')
					}
					throw new Error('unexpected request to ' + input.url)
				}
			}

			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const note = await createPublicStatus(domain, db, actor, 'my first status')

			const activity: any = {
				type: 'Create',
				actor: actor.id.toString(),
				to: ['https://example.com/users/a'],
				cc: [],
				object: note.id,
			}

			const message: DeliverMessageBody = {
				activity,
				type: MessageType.Deliver,
				actorId: actor.id.toString(),
				toActorId: 'https://example.com/users/a',
				userKEK: userKEK,
			}

			const env = {
				DATABASE: db,
				DOMAIN: domain,
			} as Env
			await handleDeliverMessage(env, actor, message)

			assert(receivedActivity)
			assert.equal(receivedActivity.type, activity.type)
		})
	})

	describe('Inbox', () => {
		async function processInbox(db: ReturnType<typeof makeDB>, body: InboxMessageBody) {
			const env = { DATABASE: db, DOMAIN: domain, SENTRY_DSN: '' } as Env
			const batch = { messages: [{ body }] } as unknown as MessageBatch<InboxMessageBody>
			await consumer.queue(batch, env, {} as ExecutionContext)
		}

		function remoteCreate(recipient: string): InboxMessageBody['activity'] {
			return {
				type: 'Create',
				id: 'https://example.com/activities/1',
				actor: 'https://example.com/actor',
				to: [recipient],
				cc: [],
				object: {
					id: 'https://example.com/note1',
					type: 'Note',
					content: 'hello',
					attributedTo: 'https://example.com/actor',
					to: [recipient],
					cc: [],
				},
			} as any
		}

		async function countObjects(db: ReturnType<typeof makeDB>): Promise<number> {
			const row = await db.prepare('SELECT count(*) as count FROM objects').first<{ count: number }>()
			return row?.count ?? -1
		}

		beforeEach(() => {
			globalThis.fetch = async (input: RequestInfo) => {
				throw new Error('unexpected request to ' + (input instanceof Request ? input.url : input.toString()))
			}
		})

		test('drops a legacy message without the signer', async () => {
			const db = makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			await processInbox(db, {
				type: MessageType.Inbox,
				actorId: actor.id.toString(),
				activity: remoteCreate(actor.id.toString()),
				userKEK,
				vapidKeys: {} as any,
			})

			assert.equal(await countObjects(db), 0)
		})

		test('drops a message whose activity actor is not the signer', async () => {
			const db = makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			await processInbox(db, {
				type: MessageType.Inbox,
				actorId: actor.id.toString(),
				signerId: 'https://evil.example/actor',
				activity: remoteCreate(actor.id.toString()),
				userKEK,
				vapidKeys: {} as any,
			})

			assert.equal(await countObjects(db), 0)
		})
	})
})
