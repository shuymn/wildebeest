import { strict as assert } from 'node:assert/strict'

import { createPerson } from 'wildebeest/backend/src/activitypub/actors'
import { createPublicNote } from 'wildebeest/backend/src/activitypub/objects/note'
import type { DeliverMessageBody } from 'wildebeest/backend/src/types'
import { MessageType } from 'wildebeest/backend/src/types'
import { makeDB } from 'wildebeest/backend/test/utils'

import { Env } from '../src'
import { handleDeliverMessage } from '../src/deliver'

const domain = 'cloudflare.com'
const userKEK = 'test_kek25'

describe('Consumer', () => {
	describe('Deliver', () => {
		test('deliver to target Actor', async () => {
			const db = await makeDB()

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

			const actor = await createPerson(domain, db, userKEK, 'sven@cloudflare.com')
			const note = await createPublicNote(domain, db, 'my first status', actor, new Set(), [], {
				sensitive: false,
				source: { content: 'my first status', mediaType: 'text/plain' },
			})

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
})
