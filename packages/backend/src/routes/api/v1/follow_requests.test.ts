import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { getApId, mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { insertBlock } from '@wildebeest/backend/mastodon/block'
import {
	acceptFollowing,
	addFollowing,
	buildFollowApObject,
	getFollowRequestedActors,
	removePendingFollowing,
} from '@wildebeest/backend/mastodon/follow'
import { assertCORS, assertJSON, assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_follow_requests'
const domain = 'cloudflare.com'

async function insertRemoteRequester(
	db: ReturnType<typeof makeDB>,
	{
		id,
		preferredUsername,
		mastodonId,
	}: {
		id: URL
		preferredUsername: string
		mastodonId: string
	}
) {
	await db
		.prepare(
			`INSERT INTO actors (id, type, username, domain, properties, mastodon_id) VALUES (?, 'Person', ?, 'example.com', ?, ?)`
		)
		.bind(
			id.toString(),
			preferredUsername,
			JSON.stringify({
				id: id.toString(),
				type: 'Person',
				inbox: `${id.toString()}/inbox`,
				preferredUsername,
			}),
			mastodonId
		)
		.run()
	return {
		id,
		preferredUsername,
		mastodonId,
		inbox: new URL(`${id.toString()}/inbox`),
	}
}

describe('buildFollowApObject', () => {
	test('falls back to a generated id when stored follow uri is invalid', () => {
		const requester = { id: new URL('https://example.com/ap/users/requester') }
		const followee = { id: new URL(`https://${domain}/ap/users/followee`) }

		const object = buildFollowApObject(domain, requester, followee, 'not-a-url')

		assert.equal(object.type, 'Follow')
		assert.equal(getApId(object.actor).toString(), requester.id.toString())
		assert.equal(getApId(object.object).toString(), followee.id.toString())
		assert.equal(getApId(object).hostname, domain)
	})
})

describe('removePendingFollowing', () => {
	test('leaves an accepted follow intact', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'remove-pending-followee@cloudflare.com')
		const requester = await createTestUser(domain, db, userKEK, 'remove-pending-requester@cloudflare.com')
		await addFollowing(domain, db, requester, followee)
		await acceptFollowing(db, requester, followee)

		const removed = await removePendingFollowing(db, requester, followee)
		assert.equal(removed, false)

		const row = await db
			.prepare(`SELECT state FROM actor_following WHERE actor_id = ? AND target_actor_id = ?`)
			.bind(requester.id.toString(), followee.id.toString())
			.first<{ state: string }>()
		assert.equal(row?.state, 'accepted')
	})
})

describe('getFollowRequestedActors', () => {
	test('returns inbound pending requesters ordered newest first', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'follow-requestee@cloudflare.com')
		const requester1 = await createTestUser(domain, db, userKEK, 'follow-requester1@cloudflare.com')
		const requester2 = await createTestUser(domain, db, userKEK, 'follow-requester2@cloudflare.com')

		await addFollowing(domain, db, requester1, followee)
		await addFollowing(domain, db, requester2, followee)

		const rows = await getFollowRequestedActors(db, followee, { limit: 40 })
		assert.equal(rows.length, 2)
		assert.deepEqual(
			new Set(rows.map((row) => row.mastodon_id)),
			new Set([requester1[mastodonIdSymbol], requester2[mastodonIdSymbol]])
		)
	})
})

describe('/api/v1/follow_requests', () => {
	test('lists pending follow requests', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'list-followee@cloudflare.com')
		const requester = await createTestUser(domain, db, userKEK, 'list-requester@cloudflare.com')
		await addFollowing(domain, db, requester, followee)

		const req = new Request(`https://${domain}/api/v1/follow_requests`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: followee } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		const data = await res.json<Array<{ id: string }>>()
		assert.equal(data.length, 1)
		assert.equal(data[0]?.id, requester[mastodonIdSymbol])
	})

	test('requires authentication', async () => {
		const db = makeDB()
		const req = new Request(`https://${domain}/api/v1/follow_requests`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 401)
	})
})

describe('/api/v1/follow_requests/:id/authorize', () => {
	test('accepts a pending request and delivers Accept', async () => {
		let receivedActivity: unknown = null

		globalThis.fetch = async (input) => {
			const request = new Request(input)
			if (request.url === 'https://example.com/ap/users/requester/inbox') {
				assert.equal(request.method, 'POST')
				receivedActivity = await request.json()
				return new Response('')
			}
			throw new Error('unexpected request to ' + request.url)
		}

		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'authorize-followee@cloudflare.com')
		const requester = await insertRemoteRequester(db, {
			id: new URL('https://example.com/ap/users/requester'),
			preferredUsername: 'requester',
			mastodonId: 'remote-requester',
		})
		await addFollowing(domain, db, requester, followee)

		const req = new Request(`https://${domain}/api/v1/follow_requests/${requester.mastodonId}/authorize`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor: followee } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		const relationship = await res.json<{ followed_by: boolean }>()
		assert.equal(relationship.followed_by, true)

		const row = await db
			.prepare(`SELECT state FROM actor_following WHERE actor_id = ? AND target_actor_id = ?`)
			.bind(requester.id.toString(), followee.id.toString())
			.first<{ state: string }>()
		assert.equal(row?.state, 'accepted')

		assert(receivedActivity)
		assert.equal((receivedActivity as { type: string }).type, 'Accept')
		assert.equal((receivedActivity as { object: { type: string } }).object.type, 'Follow')
	})

	test('returns 404 for unknown requester', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'authorize-missing@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/follow_requests/missing-id/authorize`, { method: 'POST' })
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor: followee } })
		await assertStatus(res, 404)
	})

	test('returns 404 when no pending request exists', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'authorize-not-pending@cloudflare.com')
		const requester = await createTestUser(domain, db, userKEK, 'authorize-not-pending-requester@cloudflare.com')
		await addFollowing(domain, db, requester, followee)
		await acceptFollowing(db, requester, followee)

		const req = new Request(`https://${domain}/api/v1/follow_requests/${requester[mastodonIdSymbol]}/authorize`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor: followee } })
		await assertStatus(res, 404)
	})

	test('does not accept a request after either side is blocked', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'authorize-blocked@cloudflare.com')
		const requester = await createTestUser(domain, db, userKEK, 'authorize-blocked-requester@cloudflare.com')
		await addFollowing(domain, db, requester, followee)
		await insertBlock(db, followee, requester)

		const req = new Request(`https://${domain}/api/v1/follow_requests/${requester[mastodonIdSymbol]}/authorize`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor: followee } })
		await assertStatus(res, 404)

		const row = await db
			.prepare(`SELECT state FROM actor_following WHERE actor_id = ? AND target_actor_id = ?`)
			.bind(requester.id.toString(), followee.id.toString())
			.first<{ state: string }>()
		assert.equal(row?.state, 'pending')
	})
})

describe('/api/v1/follow_requests/:id/reject', () => {
	test('rejects a pending request and delivers Reject', async () => {
		let receivedActivity: unknown = null

		globalThis.fetch = async (input) => {
			const request = new Request(input)
			if (request.url === 'https://example.com/ap/users/rejecter/inbox') {
				assert.equal(request.method, 'POST')
				receivedActivity = await request.json()
				return new Response('')
			}
			throw new Error('unexpected request to ' + request.url)
		}

		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'reject-followee@cloudflare.com')
		const requester = await insertRemoteRequester(db, {
			id: new URL('https://example.com/ap/users/rejecter'),
			preferredUsername: 'rejecter',
			mastodonId: 'remote-rejecter',
		})
		await addFollowing(domain, db, requester, followee)

		const req = new Request(`https://${domain}/api/v1/follow_requests/${requester.mastodonId}/reject`, {
			method: 'POST',
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, data: { connectedActor: followee } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		const relationship = await res.json<{ followed_by: boolean }>()
		assert.equal(relationship.followed_by, false)

		const row = await db
			.prepare(`SELECT 1 as yes FROM actor_following WHERE actor_id = ? AND target_actor_id = ?`)
			.bind(requester.id.toString(), followee.id.toString())
			.first()
		assert.equal(row, null)

		assert(receivedActivity)
		assert.equal((receivedActivity as { type: string }).type, 'Reject')
		assert.equal((receivedActivity as { object: { type: string } }).object.type, 'Follow')
		assert.equal(
			getApId((receivedActivity as { object: { actor: URL } }).object.actor).toString(),
			requester.id.toString()
		)
	})
})
