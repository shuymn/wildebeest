import { strict as assert } from 'node:assert/strict'

import { getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import type { DeliverMessageBody, InboxMessageBody, MessageBody } from '@wildebeest/backend/types'
import { MessageType } from '@wildebeest/backend/types'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { createTestUser, makeDB, makeDOCache } from '@wildebeest/backend/test/utils'

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

	describe('queue', () => {
		const remoteActorId = 'https://example.com/users/receiver'
		const remoteInbox = 'https://example.com/inbox'

		function makeQueueMessage(body: MessageBody) {
			return { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() }
		}

		function makeBatch(messages: ReturnType<typeof makeQueueMessage>[]) {
			return { queue: 'test', messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<MessageBody>
		}

		function makeEnv(db: ReturnType<typeof makeDB>) {
			return {
				DATABASE: db,
				DOMAIN: domain,
				ADMIN_EMAIL: 'admin@cloudflare.com',
				DO_CACHE: makeDOCache(),
				SENTRY_DSN: '',
				SENTRY_ACCESS_CLIENT_ID: '',
				SENTRY_ACCESS_CLIENT_SECRET: '',
			} as unknown as Env
		}

		async function cacheRemoteActor(db: ReturnType<typeof makeDB>) {
			globalThis.fetch = async (input) => {
				if (input.toString() === remoteActorId) {
					return Response.json({
						id: remoteActorId,
						type: 'Person',
						preferredUsername: 'receiver',
						inbox: remoteInbox,
					})
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			const remote = await getAndCacheActor(new URL(remoteActorId), db)
			assert(remote)
			return remote
		}

		test('retries only the failing message and acks the others', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
			try {
				const db = makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				await cacheRemoteActor(db)

				const messages = ['first', 'failed', 'last'].map((suffix) =>
					makeQueueMessage({
						type: MessageType.Deliver,
						actorId: actor.id.toString(),
						toActorId: remoteActorId,
						userKEK,
						activity: {
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: `https://${domain}/ap/a/${suffix}`,
							type: 'Delete',
							actor: actor.id.toString(),
							object: `https://${domain}/ap/o/${suffix}`,
							to: [remoteActorId],
							cc: [],
						},
					} as DeliverMessageBody)
				)

				const attempted: string[] = []
				globalThis.fetch = async (input) => {
					const request = new Request(input)
					assert.equal(request.url, remoteInbox)
					const activity = (await request.json()) as { id: string }
					attempted.push(activity.id)
					return new Response('', { status: activity.id.endsWith('/failed') ? 503 : 202 })
				}

				await consumer.queue(makeBatch(messages), makeEnv(db), {} as ExecutionContext)

				assert.deepEqual(attempted, [
					`https://${domain}/ap/a/first`,
					`https://${domain}/ap/a/failed`,
					`https://${domain}/ap/a/last`,
				])
				assert.deepEqual(
					messages.map(({ ack }) => ack.mock.calls.length),
					[1, 0, 1]
				)
				assert.deepEqual(
					messages.map(({ retry }) => retry.mock.calls.length),
					[0, 1, 0]
				)
			} finally {
				consoleError.mockRestore()
			}
		})

		test('a missing local actor acks that message and does not drop the later ones', async () => {
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
			try {
				const db = makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				await cacheRemoteActor(db)

				const activity = {
					'@context': 'https://www.w3.org/ns/activitystreams',
					id: `https://${domain}/ap/a/after-missing`,
					type: 'Delete',
					actor: actor.id.toString(),
					object: `https://${domain}/ap/o/after-missing`,
					to: [remoteActorId],
					cc: [],
				}
				const missing = makeQueueMessage({
					type: MessageType.Deliver,
					actorId: 'https://cloudflare.com/ap/users/does-not-exist',
					toActorId: remoteActorId,
					userKEK,
					activity,
				} as DeliverMessageBody)
				const later = makeQueueMessage({
					type: MessageType.Deliver,
					actorId: actor.id.toString(),
					toActorId: remoteActorId,
					userKEK,
					activity,
				} as DeliverMessageBody)

				let delivered = 0
				globalThis.fetch = async (input) => {
					assert.equal(new Request(input).url, remoteInbox)
					delivered++
					return new Response('', { status: 202 })
				}

				await consumer.queue(makeBatch([missing, later]), makeEnv(db), {} as ExecutionContext)

				assert.equal(missing.ack.mock.calls.length, 1)
				assert.equal(missing.retry.mock.calls.length, 0)
				assert.equal(later.ack.mock.calls.length, 1)
				assert.equal(later.retry.mock.calls.length, 0)
				assert.equal(delivered, 1)
			} finally {
				consoleWarn.mockRestore()
			}
		})

		test('does not log inbound activity bodies', async () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
			try {
				const db = makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				await cacheRemoteActor(db)
				const secret = 'this-dm-must-not-be-logged'
				const message: InboxMessageBody = {
					type: MessageType.Inbox,
					actorId: actor.id.toString(),
					signerId: remoteActorId,
					userKEK,
					vapidKeys: {},
					activity: {
						'@context': 'https://www.w3.org/ns/activitystreams',
						id: 'https://example.com/activities/dm',
						type: 'Create',
						actor: remoteActorId,
						object: {
							id: 'https://example.com/objects/dm',
							type: 'Note',
							attributedTo: remoteActorId,
							content: secret,
							attachment: [],
							to: [actor.id.toString()],
							cc: [],
						},
						to: [actor.id.toString()],
						cc: [],
					},
				} as unknown as InboxMessageBody

				globalThis.fetch = async (input) => {
					throw new Error('unexpected request to ' + input.toString())
				}
				const queueMessage = makeQueueMessage(message)
				await consumer.queue(makeBatch([queueMessage]), makeEnv(db), {} as ExecutionContext)
				// The message must reach the handler rather than being dropped by the signer guard.
				assert.equal(queueMessage.ack.mock.calls.length, 1)
				const stored = await db
					.prepare('SELECT count(*) as count FROM objects WHERE original_object_id = ?')
					.bind('https://example.com/objects/dm')
					.first<{ count: number }>()
				assert.equal(stored?.count, 1)

				const logged = [...consoleLog.mock.calls, ...consoleWarn.mock.calls]
					.flat()
					.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
					.join(' ')
				assert.equal(logged.includes(secret), false)
				assert.equal(logged.includes('"type":"Create"'), false)
			} finally {
				consoleLog.mockRestore()
				consoleWarn.mockRestore()
			}
		})

		describe('Inbox signer guard', () => {
			function remoteCreate(recipient: string, id: string): InboxMessageBody['activity'] {
				return {
					type: 'Create',
					id: `https://example.com/activities/${id}`,
					actor: 'https://example.com/actor',
					to: [recipient],
					cc: [],
					object: {
						id: `https://example.com/objects/${id}`,
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

			let consoleWarn: ReturnType<typeof vi.spyOn>
			beforeEach(() => {
				consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
				globalThis.fetch = async (input: RequestInfo | URL) => {
					throw new Error('unexpected request to ' + (input instanceof Request ? input.url : input.toString()))
				}
			})
			afterEach(() => {
				consoleWarn.mockRestore()
			})

			test('drops a legacy message without the signer', async () => {
				const db = makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

				const message = makeQueueMessage({
					type: MessageType.Inbox,
					actorId: actor.id.toString(),
					activity: remoteCreate(actor.id.toString(), 'legacy'),
					userKEK,
					vapidKeys: {} as any,
				} as InboxMessageBody)
				await consumer.queue(makeBatch([message]), makeEnv(db), {} as ExecutionContext)

				assert.equal(await countObjects(db), 0)
				assert.equal(message.ack.mock.calls.length, 1)
				assert.equal(message.retry.mock.calls.length, 0)
			})

			test('drops a message whose activity actor is not the signer', async () => {
				const db = makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

				const message = makeQueueMessage({
					type: MessageType.Inbox,
					actorId: actor.id.toString(),
					signerId: 'https://evil.example/actor',
					activity: remoteCreate(actor.id.toString(), 'mismatch'),
					userKEK,
					vapidKeys: {} as any,
				} as InboxMessageBody)
				await consumer.queue(makeBatch([message]), makeEnv(db), {} as ExecutionContext)

				assert.equal(await countObjects(db), 0)
				assert.equal(message.ack.mock.calls.length, 1)
				assert.equal(message.retry.mock.calls.length, 0)
			})

			test('a dropped message does not stop the later messages in the batch', async () => {
				const db = makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				await cacheRemoteActor(db)

				const dropped = makeQueueMessage({
					type: MessageType.Inbox,
					actorId: actor.id.toString(),
					activity: remoteCreate(actor.id.toString(), 'legacy'),
					userKEK,
					vapidKeys: {} as any,
				} as InboxMessageBody)
				let delivered = 0
				const later = makeQueueMessage({
					type: MessageType.Deliver,
					actorId: actor.id.toString(),
					toActorId: remoteActorId,
					userKEK,
					activity: {
						'@context': 'https://www.w3.org/ns/activitystreams',
						id: `https://${domain}/ap/a/after-dropped`,
						type: 'Delete',
						actor: actor.id.toString(),
						object: `https://${domain}/ap/o/after-dropped`,
						to: [remoteActorId],
						cc: [],
					},
				} as DeliverMessageBody)
				globalThis.fetch = async (input) => {
					assert.equal(new Request(input).url, remoteInbox)
					delivered++
					return new Response('', { status: 202 })
				}

				await consumer.queue(makeBatch([dropped, later]), makeEnv(db), {} as ExecutionContext)

				assert.equal(dropped.ack.mock.calls.length, 1)
				assert.equal(dropped.retry.mock.calls.length, 0)
				assert.equal(later.ack.mock.calls.length, 1)
				assert.equal(later.retry.mock.calls.length, 0)
				assert.equal(delivered, 1)
				assert.equal(await countObjects(db), 0)
			})
		})
	})
})
