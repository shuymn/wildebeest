import { type Actor, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { type Database } from '@wildebeest/backend/database'
import { MastodonId } from '@wildebeest/backend/types'
import { actorToAcct } from '@wildebeest/backend/utils/handle'

import { assertBatchSuccess, getResultsField } from './utils'

const STATE_PENDING = 'pending'
const STATE_ACCEPTED = 'accepted'

// During a migration we move the followers from the old Actor to the new
export async function moveFollowers(domain: string, db: Database, actor: Actor, followers: string[]): Promise<void> {
	const batch = []
	const stmt = db.prepare(
		db.qb.insertOrIgnore(`
        INTO actor_following (id, actor_id, target_actor_id, target_actor_acct, state)
		VALUES (?1, ?2, ?3, ?4, 'accepted')
    `)
	)

	const actorId = actor.id.toString()
	const actorAcct = actorToAcct(actor, domain)

	for (const follower of followers) {
		const followerId = new URL(follower)
		const followActor = await getAndCacheActor(followerId, db)
		if (followActor === null) {
			console.warn(`actor ${follower} not found`)
			continue
		}

		const id = crypto.randomUUID()
		batch.push(stmt.bind(id, followActor.id.toString(), actorId, actorAcct))
	}

	if (batch.length > 0) {
		assertBatchSuccess(await db.batch(batch))
	}
}

export async function moveFollowing(
	domain: string,
	db: Database,
	actor: Actor,
	followingActors: string[]
): Promise<void> {
	const batch = []
	const stmt = db.prepare(
		db.qb.insertOrIgnore(`
        INTO actor_following (id, actor_id, target_actor_id, target_actor_acct, state)
		VALUES (?1, ?2, ?3, ?4, 'accepted')
    `)
	)

	const actorId = actor.id.toString()

	for (const following of followingActors) {
		const followingId = new URL(following)
		const followingActor = await getAndCacheActor(followingId, db)
		if (followingActor === null) {
			console.warn(`actor ${following} not found`)
			continue
		}
		const actorAcc = actorToAcct(followingActor, domain)

		const id = crypto.randomUUID()
		batch.push(stmt.bind(id, actorId, followingActor.id.toString(), actorAcc))
	}

	if (batch.length > 0) {
		assertBatchSuccess(await db.batch(batch))
	}
}

// Add a pending following
export async function addFollowing(domain: string, db: Database, follower: Actor, followee: Actor): Promise<string> {
	const id = crypto.randomUUID()

	const query = db.qb.insertOrIgnore(`
		INTO actor_following (id, actor_id, target_actor_id, state, target_actor_acct)
		VALUES (?, ?, ?, ?, ?)
	`)

	const out = await db
		.prepare(query)
		.bind(id, follower.id.toString(), followee.id.toString(), STATE_PENDING, actorToAcct(followee, domain))
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	return id
}

// Accept the pending following request
export async function acceptFollowing(db: Database, follower: Actor, followee: Actor) {
	const followerId = follower.id.toString()
	const followeeId = followee.id.toString()

	const results = await db.batch([
		db
			.prepare(
				`
UPDATE actors
SET interaction_count = interaction_count + 1
WHERE id = ?1
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.actor_id = actors.id)
  AND EXISTS (
    SELECT 1 FROM actor_following
    WHERE actor_id = ?2 AND target_actor_id = ?1 AND state = ?3
  )
`
			)
			.bind(followeeId, followerId, STATE_PENDING),
		db
			.prepare(
				`
UPDATE actor_following SET state=?1 WHERE actor_id=?2 AND target_actor_id=?3 AND state=?4
`
			)
			.bind(STATE_ACCEPTED, followerId, followeeId, STATE_PENDING),
	])
	assertBatchSuccess(results)
}

export async function removeFollowing(db: Database, follower: Actor, followee: Actor) {
	const followerId = follower.id.toString()
	const followeeId = followee.id.toString()

	const results = await db.batch([
		db
			.prepare(
				`
UPDATE actors
SET interaction_count = MAX(0, interaction_count - 1)
WHERE id = ?2
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.actor_id = actors.id)
  AND EXISTS (
    SELECT 1 FROM actor_following
    WHERE actor_id = ?1 AND target_actor_id = ?2 AND state = ?3
  )
`
			)
			.bind(followerId, followeeId, STATE_ACCEPTED),
		db
			.prepare(
				`
DELETE FROM actor_following WHERE actor_id=?1 AND target_actor_id=?2
`
			)
			.bind(followerId, followeeId),
	])
	assertBatchSuccess(results)
}

export function getFollowingMastodonIds(db: Database, actor: Actor): Promise<MastodonId[]> {
	return getFollowingMastodonIdsByState(db, actor, STATE_ACCEPTED)
}

export function getFollowingRequestedMastodonIds(db: Database, actor: Actor): Promise<MastodonId[]> {
	return getFollowingMastodonIdsByState(db, actor, STATE_PENDING)
}

function getFollowingMastodonIdsByState(db: Database, actor: Actor, state: string): Promise<MastodonId[]> {
	const query = `
SELECT actors.mastodon_id
FROM actor_following
INNER JOIN actors ON actors.id = actor_following.target_actor_id
WHERE actor_following.actor_id=?1 AND actor_following.state=?2
`
	return getResultsField(db.prepare(query).bind(actor.id.toString(), state), 'mastodon_id')
}

export function getFollowingId(db: Database, actor: Actor, limit?: number): Promise<Array<string>> {
	const query = `
		SELECT target_actor_id FROM actor_following WHERE actor_id=?1 AND state=?2 ${limit ? 'LIMIT ?3' : ''}
	`

	const statement = db
		.prepare(query)
		.bind(...(limit ? [actor.id.toString(), STATE_ACCEPTED, limit] : [actor.id.toString(), STATE_ACCEPTED]))

	return getResultsField(statement, 'target_actor_id')
}

export function getFollowerIds(db: Database, actor: Actor, limit?: number): Promise<Array<string>> {
	const query = `
		SELECT actor_id FROM actor_following WHERE target_actor_id=?1 AND state=?2 ${limit ? 'LIMIT ?3' : ''}
	`

	const statement = db
		.prepare(query)
		.bind(...(limit ? [actor.id.toString(), STATE_ACCEPTED, limit] : [actor.id.toString(), STATE_ACCEPTED]))

	return getResultsField(statement, 'actor_id')
}

export async function isFollowingOrFollowingRequested(db: Database, actor: Actor, target: Actor): Promise<boolean> {
	const { yes } = await db
		.prepare(
			'SELECT COUNT(*) > 0 as yes FROM actor_following WHERE actor_id = ?1 AND target_actor_id = ?2 AND state IN (?3, ?4)'
		)
		.bind(actor.id.toString(), target.id.toString(), STATE_ACCEPTED, STATE_PENDING)
		.first<{ yes: 1 | 0 }>()
		.then((row) => {
			if (!row) {
				throw new Error('row is undefined')
			}
			return row
		})

	return yes === 1
}

export async function isNotFollowing(db: Database, actor: Actor, target: Actor): Promise<boolean> {
	return !(await isFollowing(db, actor, target))
}

export async function isFollowing(db: Database, actor: Actor, target: Actor): Promise<boolean> {
	const { following } = await db
		.prepare(
			'SELECT COUNT(*) > 0 as following FROM actor_following WHERE actor_id = ?1 AND target_actor_id = ?2 AND state = ?3'
		)
		.bind(actor.id.toString(), target.id.toString(), STATE_ACCEPTED)
		.first<{ following: 1 | 0 }>()
		.then((row) => {
			if (!row) {
				throw new Error('row is undefined')
			}
			return row
		})

	return following === 1
}
