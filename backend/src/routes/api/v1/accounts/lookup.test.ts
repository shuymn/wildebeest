import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { queryAcct } from 'wildebeest/backend/src/webfinger'
import { createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { makeDB, assertStatus, isUrlValid, createTestUser } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/lookup', () => {
	test('lookup unknown remote actor', async () => {
		const db = await makeDB()
		const req = new Request(`https://${domain}/api/v1/accounts/lookup?acct=sven@social.com`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 404)
	})

	test('lookup unknown local actor', async () => {
		const db = await makeDB()
		const req = new Request(`https://${domain}/api/v1/accounts/lookup?acct=sven`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 404)
	})

	test('lookup remote actor', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://social.com/.well-known/webfinger?resource=acct%3Asomeone%40social.com') {
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
							preferredUsername: '<script>some</script>one',
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

		const db = await makeDB()
		await queryAcct({ localPart: 'someone', domain: 'social.com' }, db)

		const req = new Request(`https://${domain}/api/v1/accounts/lookup?acct=someone@social.com`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.username, 'someone')
		assert.equal(data.display_name, 'Sven Cool')
		assert.equal(data.acct, 'someone@social.com')

		assert(isUrlValid(data.url))
		assert(data.url, 'https://social.com/@someone')

		assert.equal(data.followers_count, 321)
		assert.equal(data.following_count, 123)
		assert.equal(data.statuses_count, 890)
	})

	test('lookup local actor', async () => {
		const db = await makeDB()
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

		const req = new Request(`https://${domain}/api/v1/accounts/lookup?acct=sven`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.username, 'sven')
		assert.equal(data.acct, 'sven')
		assert.equal(data.followers_count, 1)
		assert.equal(data.following_count, 2)
		assert.equal(data.statuses_count, 1)
		assert(isUrlValid(data.url))
		assert((data.url as string).includes(domain))
	})
})
