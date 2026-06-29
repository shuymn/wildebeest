import { env } from 'cloudflare:test'
import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { getApId, mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { insertBlock } from '@wildebeest/backend/mastodon/block'
import {
	acceptFollowing,
	addFollowing,
	buildFollowApObject,
	getFollowRequestedActors,
	makeFollowRequestCursor,
	removePendingFollowing,
} from '@wildebeest/backend/mastodon/follow'
import { assertCORS, assertJSON, assertStatus, createTestUser, makeDB, makeQueue } from '@wildebeest/backend/test/utils'
import { MessageType } from '@wildebeest/backend/types'

const userKEK = env.userKEK
const domain = env.DOMAIN

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

async function setFollowRequestCdate(db: ReturnType<typeof makeDB>, id: string, cdate: string) {
	const out = await db.prepare(`UPDATE actor_following SET cdate = ? WHERE id = ?`).bind(cdate, id).run()
	assert.equal(out.success, true)
}

function getLinkUrl(response: Response, rel: 'next' | 'prev'): URL {
	const link = response.headers.get('link') ?? ''
	const match = link.match(new RegExp(`<([^>]+)>; rel="${rel}"`))
	assert(match)
	return new URL(match[1])
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

		const id1 = await addFollowing(domain, db, requester1, followee)
		const id2 = await addFollowing(domain, db, requester2, followee)
		await setFollowRequestCdate(db, id1, '2026-06-29 11:00:00.000')
		await setFollowRequestCdate(db, id2, '2026-06-29 11:01:00.000')

		const rows = await getFollowRequestedActors(db, followee, { limit: 40 })
		assert.equal(rows.length, 2)
		assert.deepEqual(
			rows.map((row) => row.mastodon_id),
			[requester2[mastodonIdSymbol], requester1[mastodonIdSymbol]]
		)
	})

	test('continues paging when the cursor request was removed', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'follow-request-pagee@cloudflare.com')
		const requester1 = await createTestUser(domain, db, userKEK, 'follow-request-page-1@cloudflare.com')
		const requester2 = await createTestUser(domain, db, userKEK, 'follow-request-page-2@cloudflare.com')
		const requester3 = await createTestUser(domain, db, userKEK, 'follow-request-page-3@cloudflare.com')

		const id1 = await addFollowing(domain, db, requester1, followee)
		const id2 = await addFollowing(domain, db, requester2, followee)
		const id3 = await addFollowing(domain, db, requester3, followee)
		await setFollowRequestCdate(db, id1, '2026-06-29 11:00:00.000')
		await setFollowRequestCdate(db, id2, '2026-06-29 11:01:00.000')
		await setFollowRequestCdate(db, id3, '2026-06-29 11:02:00.000')

		const firstPage = await getFollowRequestedActors(db, followee, { limit: 1 })
		assert.equal(firstPage[0]?.mastodon_id, requester3[mastodonIdSymbol])
		const cursor = makeFollowRequestCursor(firstPage[0])

		assert.equal(await removePendingFollowing(db, requester3, followee), true)

		const nextPage = await getFollowRequestedActors(db, followee, { limit: 1, maxId: cursor })
		assert.equal(nextPage[0]?.mastodon_id, requester2[mastodonIdSymbol])
	})
})

describe('/api/v1/follow_requests', () => {
	test('lists pending follow requests', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'list-followee@cloudflare.com')
		const requester1 = await createTestUser(domain, db, userKEK, 'list-requester1@cloudflare.com')
		const requester2 = await createTestUser(domain, db, userKEK, 'list-requester2@cloudflare.com')
		const id1 = await addFollowing(domain, db, requester1, followee)
		const id2 = await addFollowing(domain, db, requester2, followee)
		const cdate1 = '2026-06-29 11:00:00.000'
		const cdate2 = '2026-06-29 11:01:00.000'
		await setFollowRequestCdate(db, id1, cdate1)
		await setFollowRequestCdate(db, id2, cdate2)

		const req = new Request(`https://${domain}/api/v1/follow_requests?limit=1`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: followee } })
		await assertStatus(res, 200)
		assertCORS(res, req)
		assertJSON(res)

		const data = await res.json<Array<{ id: string }>>()
		assert.equal(data.length, 1)
		assert.equal(data[0]?.id, requester2[mastodonIdSymbol])
		assert.equal(
			getLinkUrl(res, 'next').searchParams.get('max_id'),
			makeFollowRequestCursor({ id: id2, cdate: cdate2 })
		)
		assert.equal(
			getLinkUrl(res, 'prev').searchParams.get('min_id'),
			makeFollowRequestCursor({ id: id2, cdate: cdate2 })
		)
	})

	test('requires authentication', async () => {
		const db = makeDB()
		const req = new Request(`https://${domain}/api/v1/follow_requests`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 401)
	})

	test('adds CORS headers to invalid parameter responses', async () => {
		const db = makeDB()
		const followee = await createTestUser(domain, db, userKEK, 'list-invalid-followee@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/follow_requests?limit=0`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor: followee } })
		await assertStatus(res, 400)
		assertCORS(res, req)
	})
})

describe('/api/v1/follow_requests/:id/authorize', () => {
	test('accepts a pending request and queues Accept delivery', async () => {
		const db = makeDB()
		const queue = makeQueue()
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
		const res = await app.fetch(req, { DATABASE: db, QUEUE: queue, userKEK, data: { connectedActor: followee } })
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

		assert.equal(queue.messages.length, 1)
		assert.equal(queue.messages[0].type, MessageType.Deliver)
		assert.equal(queue.messages[0].actorId, followee.id.toString())
		assert.equal(queue.messages[0].toActorId, requester.id.toString())
		assert.equal(queue.messages[0].activity.type, 'Accept')
		assert.equal(queue.messages[0].activity.object.type, 'Follow')
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

	test.each(['followee', 'requester'] as const)(
		'does not accept a request after the %s blocks the other side',
		async (blocker) => {
			const db = makeDB()
			const followee = await createTestUser(domain, db, userKEK, `authorize-blocked-${blocker}@cloudflare.com`)
			const requester = await createTestUser(
				domain,
				db,
				userKEK,
				`authorize-blocked-${blocker}-requester@cloudflare.com`
			)
			await addFollowing(domain, db, requester, followee)
			if (blocker === 'followee') {
				await insertBlock(db, followee, requester)
			} else {
				await insertBlock(db, requester, followee)
			}

			const req = new Request(`https://${domain}/api/v1/follow_requests/${requester[mastodonIdSymbol]}/authorize`, {
				method: 'POST',
			})
			const res = await app.fetch(req, {
				DATABASE: db,
				QUEUE: makeQueue(),
				userKEK,
				data: { connectedActor: followee },
			})
			await assertStatus(res, 404)

			const row = await db
				.prepare(`SELECT state FROM actor_following WHERE actor_id = ? AND target_actor_id = ?`)
				.bind(requester.id.toString(), followee.id.toString())
				.first<{ state: string }>()
			assert.equal(row?.state, 'pending')
		}
	)
})

describe('/api/v1/follow_requests/:id/reject', () => {
	test('rejects a pending request and queues Reject delivery', async () => {
		const db = makeDB()
		const queue = makeQueue()
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
		const res = await app.fetch(req, { DATABASE: db, QUEUE: queue, userKEK, data: { connectedActor: followee } })
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

		assert.equal(queue.messages.length, 1)
		assert.equal(queue.messages[0].type, MessageType.Deliver)
		assert.equal(queue.messages[0].actorId, followee.id.toString())
		assert.equal(queue.messages[0].toActorId, requester.id.toString())
		assert.equal(queue.messages[0].activity.type, 'Reject')
		assert.equal(queue.messages[0].activity.object.type, 'Follow')
		assert.equal(getApId(queue.messages[0].activity.object.actor).toString(), requester.id.toString())
	})
})
