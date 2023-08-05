import { strict as assert } from 'node:assert/strict'

import { addAlias } from 'wildebeest/backend/src/accounts'
import { getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'

import { createTestUser, makeDB } from '../utils'

const domain = 'cloudflare.com'
const userKEK = 'test_kek22'

describe('Wildebeest', () => {
	describe('Settings', () => {
		test('add account alias', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			let receivedActivity: any = null

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/.well-known/webfinger?resource=acct%3Atest%40example.com') {
						return new Response(
							JSON.stringify({
								links: [
									{
										rel: 'self',
										type: 'application/activity+json',
										href: 'https://social.com/someone',
									},
								],
							})
						)
					}

					if (input.toString() === 'https://social.com/someone') {
						return new Response(
							JSON.stringify({
								id: 'https://social.com/someone',
								type: 'Person',
								inbox: 'https://social.com/someone/inbox',
								preferredUsername: 'someone',
							})
						)
					}
				}

				const request = new Request(input)
				if (request.url === 'https://social.com/someone/inbox') {
					assert.equal(request.method, 'POST')
					const data = await request.json()
					receivedActivity = data
					return new Response('')
				}

				if (input instanceof URL || typeof input === 'string') {
					throw new Error('unexpected request to ' + input.toString())
				} else {
					throw new Error('unexpected request to ' + input.url)
				}
			}

			await addAlias(db, 'test@example.com', actor, userKEK, domain)

			// Ensure the actor has the alias set
			const newActor = await getActorById(db, getApId(actor))
			assert(newActor)
			assert(newActor.alsoKnownAs)
			assert.equal(newActor.alsoKnownAs.length, 1)
			assert.equal(newActor.alsoKnownAs[0], 'https://social.com/someone')

			assert(receivedActivity)
			assert.equal(receivedActivity.type, 'Follow')
		})
	})
})
