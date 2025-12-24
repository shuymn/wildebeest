import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { queryAcct } from 'wildebeest/backend/src/webfinger'
import { makeDB, createTestUser, assertStatus } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/following', () => {
	test('get local actor following', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://' + domain + '/ap/users/sven2') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/foo',
							type: 'Person',
						})
					)
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		await addFollowing(domain, db, actor, actor2)
		await acceptFollowing(db, actor, actor2)

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/following`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)

		const data = await res.json<unknown[]>()
		assert.equal(data.length, 1)
	})

	test('get remote actor following', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://example.com/.well-known/webfinger?resource=acct%3Asven%40example.com') {
					return new Response(
						JSON.stringify({
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'https://example.com/users/sven',
								},
							],
						})
					)
				}

				if (input.toString() === 'https://example.com/users/sven') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/users/sven',
							type: 'Person',
							following: 'https://example.com/users/sven/following',
							preferredUsername: 'sven',
						})
					)
				}

				if (input.toString() === 'https://example.com/users/sven/following') {
					return new Response(
						JSON.stringify({
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: 'https://example.com/users/sven/following',
							type: 'OrderedCollection',
							totalItems: 3,
							first: 'https://example.com/users/sven/following/1',
						})
					)
				}

				if (input.toString() === 'https://example.com/users/sven/following/1') {
					return new Response(
						JSON.stringify({
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: 'https://example.com/users/sven/following/1',
							type: 'OrderedCollectionPage',
							totalItems: 3,
							partOf: 'https://example.com/users/sven/following',
							orderedItems: [
								actorA.id.toString(), // local user
								'https://example.com/users/b', // remote user
							],
						})
					)
				}

				if (input.toString() === 'https://example.com/users/b') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/users/b',
							type: 'Person',
							preferredUsername: 'b',
						})
					)
				}

				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const actor = await queryAcct({ localPart: 'sven', domain: 'example.com' }, db)
		assert.ok(actor)

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/following`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)

		const data = await res.json<{ acct: unknown }[]>()
		assert.equal(data.length, 2)

		assert.equal(data[0].acct, 'a')
		assert.equal(data[1].acct, 'b@example.com')
	})
})
