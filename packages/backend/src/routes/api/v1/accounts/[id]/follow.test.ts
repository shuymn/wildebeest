import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { insertBlock } from '@wildebeest/backend/mastodon/block'
import { acceptFollowing, addFollowing } from '@wildebeest/backend/mastodon/follow'
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

	test('follow keeps local state when remote delivery fails', async () => {
		let inboxRequests = 0

		globalThis.fetch = async (input: RequestInfo) => {
			const request = new Request(input)
			if (request.url === 'https://example.com/.well-known/webfinger?resource=acct%3Afailing%40example.com') {
				return new Response(
					JSON.stringify({
						links: [
							{
								rel: 'self',
								type: 'application/activity+json',
								href: `https://example.com/ap/users/failing`,
							},
						],
					})
				)
			}

			if (request.url === `https://example.com/ap/users/failing`) {
				return new Response(
					JSON.stringify({
						id: `https://example.com/ap/users/failing`,
						type: 'Person',
						inbox: `https://example.com/ap/users/failing/inbox`,
						preferredUsername: 'failing',
					})
				)
			}

			if (request.url === `https://example.com/ap/users/failing/inbox`) {
				inboxRequests += 1
				return new Response('temporary failure', { status: 503 })
			}

			throw new Error('unexpected request to ' + request.url)
		}

		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'delivery-failure@cloudflare.com')
		const followee = await queryAcct({ localPart: 'failing', domain: 'example.com' }, db)
		assert.ok(followee)

		const req = new Request(`https://${domain}/api/v1/accounts/${followee[mastodonIdSymbol]}/follow`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor } })
		await assertStatus(res, 200)
		assert.equal(inboxRequests, 1)

		const row = await db
			.prepare(`SELECT target_actor_id, state FROM actor_following WHERE actor_id=?`)
			.bind(connectedActor.id.toString())
			.first<{ target_actor_id: string; state: string }>()
		assert.equal(row?.target_actor_id, `https://example.com/ap/users/failing`)
		assert.equal(row?.state, 'pending')
	})

	test('follow updates settings for an existing relationship', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			const request = new Request(input)
			throw new Error('unexpected request to ' + request.url)
		}

		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'follow-settings@cloudflare.com')
		const followee = {
			id: new URL('https://example.com/ap/users/settings'),
			type: 'Person',
			inbox: new URL('https://example.com/ap/users/settings/inbox'),
			preferredUsername: 'settings',
			mastodonId: 'settings-remote',
		}
		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id) VALUES (?, 'Person', 'settings', 'example.com', ?, ?)`
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
		await addFollowing(domain, db, connectedActor, followee, { reblogs: false, notify: false, languages: ['en'] })
		await acceptFollowing(db, connectedActor, followee)

		const req = new Request(`https://${domain}/api/v1/accounts/${followee.mastodonId}/follow`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ reblogs: true, notify: true, languages: ['ja'] }),
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor } })
		await assertStatus(res, 200)
		const data = await res.json<{ showing_reblogs: boolean; notifying: boolean; languages?: string[] }>()
		assert.equal(data.showing_reblogs, true)
		assert.equal(data.notifying, true)
		assert.deepEqual(data.languages, ['ja'])

		const row = await db
			.prepare(`SELECT show_reblogs, notify, languages FROM actor_following WHERE actor_id=? AND target_actor_id=?`)
			.bind(connectedActor.id.toString(), followee.id.toString())
			.first<{ show_reblogs: number; notify: number; languages: string | null }>()
		assert.equal(row?.show_reblogs, 1)
		assert.equal(row?.notify, 1)
		assert.equal(row?.languages, '["ja"]')
	})
})
