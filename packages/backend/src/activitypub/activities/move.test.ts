import { strict as assert } from 'node:assert/strict'

import type { MoveActivity } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { type Actor, getAndCacheActor, setActorAlias } from '@wildebeest/backend/activitypub/actors'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import type { Database } from '@wildebeest/backend/database'
import { acceptFollowing, addFollowing } from '@wildebeest/backend/mastodon/follow'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek_move'
const vapidKeys = {} as JWK

const movingId = 'https://example.com/users/old'
const remoteFollowerId = 'https://example.com/users/fan'
const remoteFolloweeId = 'https://example.com/users/idol'

function person(id: string) {
	return {
		id,
		type: 'Person',
		preferredUsername: id.split('/').pop(),
		followers: `${id}/followers`,
		following: `${id}/following`,
	}
}

// The moving actor publishes the given collections.
function serveMovingActor({ followers, following }: { followers: string[]; following: string[] }) {
	const documents: Record<string, unknown> = {
		[movingId]: person(movingId),
		[remoteFollowerId]: person(remoteFollowerId),
		[remoteFolloweeId]: person(remoteFolloweeId),
		[`${movingId}/followers`]: { totalItems: followers.length, first: `${movingId}/followers/1` },
		[`${movingId}/followers/1`]: { orderedItems: followers },
		[`${movingId}/following`]: { totalItems: following.length, first: `${movingId}/following/1` },
		[`${movingId}/following/1`]: { orderedItems: following },
	}
	globalThis.fetch = (input) => {
		const url = input instanceof URL || typeof input === 'string' ? input.toString() : input.url
		const document = documents[url]
		if (document === undefined) {
			return Promise.resolve(new Response('', { status: 404 }))
		}
		return Promise.resolve(new Response(JSON.stringify(document)))
	}
}

async function move(db: Database, target: Actor) {
	const activity: MoveActivity = {
		type: 'Move',
		id: getApId(`${movingId}#move`),
		actor: getApId(movingId),
		object: getApId(movingId),
		target: target.id,
	}
	await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)
}

async function relationships(db: Database): Promise<string[]> {
	const { results } = await db
		.prepare('SELECT actor_id, target_actor_id, state FROM actor_following ORDER BY actor_id, target_actor_id')
		.all<{ actor_id: string; target_actor_id: string; state: string }>()
	return (results ?? []).map((r) => `${r.actor_id} -> ${r.target_actor_id} (${r.state})`)
}

describe('Move', () => {
	test('a Move to a local actor that does not list the mover as an alias is ignored', async () => {
		const db = makeDB()
		const target = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		serveMovingActor({ followers: [remoteFollowerId], following: [remoteFolloweeId] })

		await move(db, target)

		assert.deepEqual(await relationships(db), [])
	})

	test('a Move to a local actor listing the mover as an alias copies its relationships', async () => {
		const db = makeDB()
		const target = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		await setActorAlias(db, getApId(target.id), getApId(movingId))
		serveMovingActor({ followers: [remoteFollowerId], following: [remoteFolloweeId] })

		await move(db, target)

		assert.deepEqual(await relationships(db), [
			`${target.id.toString()} -> ${remoteFolloweeId} (accepted)`,
			`${remoteFollowerId} -> ${target.id.toString()} (accepted)`,
		])
	})

	test('a local follower of the mover follows the target', async () => {
		const db = makeDB()
		const target = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const follower = await createTestUser(domain, db, userKEK, 'alice@cloudflare.com', { preferredUsername: 'alice' })
		await setActorAlias(db, getApId(target.id), getApId(movingId))
		serveMovingActor({ followers: [follower.id.toString()], following: [] })
		const mover = await getAndCacheActor(getApId(movingId), db)
		assert.ok(mover)
		await addFollowing(domain, db, follower, mover)
		await acceptFollowing(db, follower, mover)

		await move(db, target)

		assert.deepEqual(await relationships(db), [
			`${follower.id.toString()} -> ${target.id.toString()} (accepted)`,
			`${follower.id.toString()} -> ${movingId} (accepted)`,
		])
	})

	test('a Move cannot make other local actors follow or be followed by the target', async () => {
		const db = makeDB()
		const target = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const bystander = await createTestUser(domain, db, userKEK, 'alice@cloudflare.com', {
			preferredUsername: 'alice',
		})
		await setActorAlias(db, getApId(target.id), getApId(movingId))
		// The mover claims relationships with a local actor that are not recorded here.
		serveMovingActor({ followers: [bystander.id.toString()], following: [bystander.id.toString()] })

		await move(db, target)

		assert.deepEqual(await relationships(db), [])
	})
})
