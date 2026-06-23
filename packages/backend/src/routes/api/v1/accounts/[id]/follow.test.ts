import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { insertBlock } from '@wildebeest/backend/mastodon/block'
import { makeDB, createTestUser, assertStatus, assertCORS, assertJSON } from '@wildebeest/backend/test/utils'
import { queryAcct } from '@wildebeest/backend/webfinger'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/follow', () => {
	test('follow local account', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const targetActor = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/accounts/${targetActor[mastodonIdSymbol]}/follow`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor } })
		await assertStatus(res, 403)
	})

	test('follow blocked account is forbidden', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'block-follow@cloudflare.com')
		const followee = {
			id: new URL('https://example.com/ap/users/blocked'),
			type: 'Person',
			inbox: new URL('https://example.com/ap/users/blocked/inbox'),
			preferredUsername: 'blocked',
			mastodonId: 'blocked-remote',
		}

		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id) VALUES (?, 'Person', 'blocked', 'example.com', ?, ?)`
			)
			.bind(
				followee.id.toString(),
				JSON.stringify({
					id: followee.id.toString(),
					type: 'Person',
					inbox: followee.inbox.toString(),
					preferredUsername: followee.preferredUsername,
				}),
				followee.mastodonId
			)
			.run()
		await insertBlock(db, connectedActor, followee as unknown as Parameters<typeof insertBlock>[2])

		const req = new Request(`https://${domain}/api/v1/accounts/${followee.mastodonId}/follow`, { method: 'POST' })
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor } })
		await assertStatus(res, 403)
	})

	test('follow account', async () => {
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

		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor

		const followee = await queryAcct({ localPart: 'actor', domain: 'example.com' }, db)
		assert.ok(followee)

		const req = new Request(`https://${domain}/api/v1/accounts/${followee[mastodonIdSymbol]}/follow`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)
		const data = await res.json<{ following: boolean; requested: boolean }>()
		assert.equal(data.following, true)
		assert.equal(data.requested, false)

		assert(receivedActivity)
		assert.equal(receivedActivity.type, 'Follow')

		const row = await db
			.prepare(`SELECT target_actor_acct, target_actor_id, state FROM actor_following WHERE actor_id=?`)
			.bind(actor.id.toString())
			.first<{ target_actor_acct: string; target_actor_id: string; state: string }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(row.target_actor_acct, 'actor@example.com')
		assert.equal(row.target_actor_id, `https://example.com/ap/users/actor`)
		assert.equal(row.state, 'pending')
	})
})
