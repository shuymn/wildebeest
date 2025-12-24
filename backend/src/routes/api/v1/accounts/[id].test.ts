import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { queryAcct } from 'wildebeest/backend/src/webfinger'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, assertStatus, isUrlValid, createTestUser } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]', () => {
	test('get remote actor by id', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://social.com/.well-known/webfinger?resource=acct%3Asven%40social.com') {
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
							url: 'https://social.com/@someone',
							type: 'Person',
							preferredUsername: '<script>bad</script>sven',
							name: 'Sven <i>Cool<i>',
							outbox: 'https://social.com/someone/outbox',
							following: 'https://social.com/someone/following',
							followers: 'https://social.com/someone/followers',
						})
					)
				}

				if (input.toString() === 'https://social.com/someone/following') {
					return new Response(
						JSON.stringify({
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: 'https://social.com/someone/following',
							type: 'OrderedCollection',
							totalItems: 123,
							first: 'https://social.com/someone/following/page',
						})
					)
				}

				if (input.toString() === 'https://social.com/someone/followers') {
					return new Response(
						JSON.stringify({
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: 'https://social.com/someone/followers',
							type: 'OrderedCollection',
							totalItems: 321,
							first: 'https://social.com/someone/followers/page',
						})
					)
				}

				if (input.toString() === 'https://social.com/someone/outbox') {
					return new Response(
						JSON.stringify({
							'@context': 'https://www.w3.org/ns/activitystreams',
							id: 'https://social.com/someone/outbox',
							type: 'OrderedCollection',
							totalItems: 890,
							first: 'https://social.com/someone/outbox/page',
						})
					)
				}

				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')
		const actor = await queryAcct({ localPart: 'sven', domain: 'social.com' }, db)
		assert.ok(actor)

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		// Note the sanitization
		assert.equal(data.username, 'badsven')
		assert.equal(data.display_name, 'Sven Cool')
		assert.equal(data.acct, 'badsven@social.com')

		assert.ok(isUrlValid(data.url))
		assert.equal(data.url, 'https://social.com/@someone')

		assert.equal(data.followers_count, 321)
		assert.equal(data.following_count, 123)
		assert.equal(data.statuses_count, 890)
	})

	test('get unknown actor by id', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')
		const req = new Request(`https://${domain}/api/v1/accounts/123456789`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 404)
	})

	test('get local actor by id', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
		await addFollowing(domain, db, actor, actor2)
		await acceptFollowing(db, actor, actor2)
		await addFollowing(domain, db, actor, actor3)
		await acceptFollowing(db, actor, actor3)
		await addFollowing(domain, db, actor3, actor)
		await acceptFollowing(db, actor3, actor)

		await createPublicStatus(domain, db, actor, 'my first status')

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: actor } })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.username, 'sven')
		assert.equal(data.acct, 'sven')
		assert.equal(data.followers_count, 1)
		assert.equal(data.following_count, 2)
		assert.equal(data.statuses_count, 1)
		assert.ok(isUrlValid(data.url))
		assert.ok((data.url as string).includes(domain))
	})
})
