import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { queryAcct } from 'wildebeest/backend/src/webfinger'
import { makeDB, createTestUser, assertStatus, assertCORS, assertJSON } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/unfollow', () => {
	test('unfollow account', async () => {
		let receivedActivity: any = null

		globalThis.fetch = async (input: RequestInfo) => {
			const request = new Request(input)
			if (request.url === 'https://example.com/.well-known/webfinger?resource=acct%3Aactor%40example.com') {
				return new Response(
					JSON.stringify({
						links: [
							{
								rel: 'self',
								type: 'application/activity+json',
								href: `https://example.com/ap/users/actor`,
							},
						],
					})
				)
			}

			if (request.url === `https://example.com/ap/users/actor`) {
				return new Response(
					JSON.stringify({
						id: `https://example.com/ap/users/actor`,
						type: 'Person',
						inbox: `https://example.com/ap/users/actor/inbox`,
						preferredUsername: 'actor',
					})
				)
			}

			if (request.url === `https://example.com/ap/users/actor/inbox`) {
				assert.equal(request.method, 'POST')
				receivedActivity = await request.json()
				return new Response('')
			}

			throw new Error('unexpected request to ' + request.url)
		}

		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const followee = await queryAcct({ localPart: 'actor', domain: 'example.com' }, db)
		assert.ok(followee)
		await addFollowing(domain, db, actor, followee)

		const connectedActor = actor

		const req = new Request(`https://${domain}/api/v1/accounts/${followee[mastodonIdSymbol]}/unfollow`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		assert(receivedActivity)
		assert.equal(receivedActivity.type, 'Undo')
		assert.equal(receivedActivity.object.type, 'Follow')

		const row = await db
			.prepare(`SELECT count(*) as count FROM actor_following WHERE actor_id=?`)
			.bind(actor.id.toString())
			.first<{ count: number }>()
		assert(row)
		assert.equal(row.count, 0)
	})
})
