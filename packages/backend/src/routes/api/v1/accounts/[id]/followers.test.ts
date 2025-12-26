import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { acceptFollowing, addFollowing } from '@wildebeest/backend/mastodon/follow'
import { makeDB, createTestUser, assertStatus } from '@wildebeest/backend/test/utils'
import { queryAcct } from '@wildebeest/backend/webfinger'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/followers', () => {
	test('get remote actor followers', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')

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
							preferredUsername: 'sven',
							followers: 'https://example.com/users/sven/followers',
						})
					)
				}

				if (input.toString() === 'https://example.com/users/sven/followers') {
					return new Response(
						JSON.stringify({
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: 'https://example.com/users/sven/followers',
							type: 'OrderedCollection',
							totalItems: 3,
							first: 'https://example.com/users/sven/followers/1',
						})
					)
				}

				if (input.toString() === 'https://example.com/users/sven/followers/1') {
					return new Response(
						JSON.stringify({
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: 'https://example.com/users/sven/followers/1',
							type: 'OrderedCollectionPage',
							totalItems: 3,
							partOf: 'https://example.com/users/sven/followers',
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

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/followers`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)

		const data = await res.json<{ acct: unknown }[]>()
		assert.equal(data.length, 2)

		assert.equal(data[0].acct, 'a')
		assert.equal(data[1].acct, 'b@example.com')
	})

	test('get local actor followers', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://' + domain + '/ap/users/sven2') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/actor',
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
		await addFollowing(domain, db, actor2, actor)
		await acceptFollowing(db, actor2, actor)

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/followers`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)

		const data = await res.json<unknown[]>()
		assert.equal(data.length, 1)
	})
})
