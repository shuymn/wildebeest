import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { type Database } from 'wildebeest/backend/src/database'
import { MastodonId } from 'wildebeest/backend/src/types'
import { actorToAcct } from 'wildebeest/backend/src/utils/handle'

import { getResultsField } from './utils'

const STATE_PENDING = 'pending'
const STATE_ACCEPTED = 'accepted'

// During a migration we move the followers from the old Actor to the new
export async function moveFollowers(
	domain: string,
	db: Database,
	actor: Actor,
	followers: Array<string>
): Promise<void> {
	const batch = []
	const stmt = db.prepare(
		db.qb.insertOrIgnore(`
        INTO actor_following (id, actor_id, target_actor_id, target_actor_acct, state)
		VALUES (?1, ?2, ?3, ?4, 'accepted')
    `)
	)

	const actorId = actor.id.toString()
	const actorAcct = actorToAcct(actor, domain)

	for (let i = 0; i < followers.length; i++) {
		const follower = new URL(followers[i])
		const followActor = await actors.getAndCache(follower, db)

		const id = crypto.randomUUID()
		batch.push(stmt.bind(id, followActor.id.toString(), actorId, actorAcct))
	}

	await db.batch(batch)
}

export async function moveFollowing(
	domain: string,
	db: Database,
	actor: Actor,
	followingActors: Array<string>
): Promise<void> {
	const batch = []
	const stmt = db.prepare(
		db.qb.insertOrIgnore(`
        INTO actor_following (id, actor_id, target_actor_id, target_actor_acct, state)
		VALUES (?1, ?2, ?3, ?4, 'accepted')
    `)
	)

	const actorId = actor.id.toString()

	for (let i = 0; i < followingActors.length; i++) {
		const following = new URL(followingActors[i])
		const followingActor = await actors.getAndCache(following, db)
		const actorAcc = actorToAcct(followingActor, domain)

		const id = crypto.randomUUID()
		batch.push(stmt.bind(id, actorId, followingActor.id.toString(), actorAcc))
	}

	await db.batch(batch)
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
export async function acceptFollowing(db: Database, actor: Actor, target: Actor) {
	const query = `
		UPDATE actor_following SET state=? WHERE actor_id=? AND target_actor_id=? AND state=?
	`

	const out = await db
		.prepare(query)
		.bind(STATE_ACCEPTED, actor.id.toString(), target.id.toString(), STATE_PENDING)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export async function removeFollowing(db: Database, actor: Actor, target: Actor) {
	const query = `
		DELETE FROM actor_following WHERE actor_id=? AND target_actor_id=?
	`

	const out = await db.prepare(query).bind(actor.id.toString(), target.id.toString()).run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export function getFollowingMastodonIds(db: Database, actor: Actor): Promise<MastodonId[]> {
	const query = `
SELECT actors.mastodon_id
FROM actor_following
INNER JOIN actors ON actors.id = actor_following.target_actor_id
WHERE actor_following.actor_id=?1 AND actor_following.state=?2
`
	const statement = db.prepare(query).bind(actor.id.toString(), STATE_ACCEPTED)

	return getResultsField(statement, 'mastodon_id')
}

export function getFollowingRequestedMastodonIds(db: Database, actor: Actor): Promise<MastodonId[]> {
	const query = `
SELECT actors.mastodon_id
FROM actor_following
INNER JOIN actors ON actors.id = actor_following.target_actor_id
WHERE actor_following.actor_id=?1 AND actor_following.state=?2
	`

	const statement = db.prepare(query).bind(actor.id.toString(), STATE_PENDING)

	return getResultsField(statement, 'mastodon_id')
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

	return following === 0
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
