import { FollowActivity } from '@wildebeest/backend/activitypub/activities'
import { type Actor, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { type Database } from '@wildebeest/backend/database'
import { MastodonId } from '@wildebeest/backend/types'
import { HTTPS } from '@wildebeest/backend/utils'
import { actorToAcct } from '@wildebeest/backend/utils/handle'

import { noBlockBetweenSql } from './block_sql'
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

export type FollowOptions = {
	reblogs?: boolean
	notify?: boolean
	languages?: string[]
}

function serializeFollowOptions(options: FollowOptions): {
	showReblogs: number
	notify: number
	languages: string | null
} {
	return {
		showReblogs: (options.reblogs ?? true) ? 1 : 0,
		notify: (options.notify ?? false) ? 1 : 0,
		languages: options.languages ? JSON.stringify(options.languages) : null,
	}
}

// Add a pending following
export async function addFollowing(
	domain: string,
	db: Database,
	follower: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id' | 'preferredUsername'>,
	options: FollowOptions = {}
): Promise<string> {
	const id = crypto.randomUUID()

	const query = db.qb.insertOrIgnore(`
		INTO actor_following (id, actor_id, target_actor_id, state, target_actor_acct, show_reblogs, notify, languages)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`)

	const optionValues = serializeFollowOptions(options)
	const out = await db
		.prepare(query)
		.bind(
			id,
			follower.id.toString(),
			followee.id.toString(),
			STATE_PENDING,
			actorToAcct(followee, domain),
			optionValues.showReblogs,
			optionValues.notify,
			optionValues.languages
		)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	return id
}

export async function ensureAcceptedFollowingIfNotBlocked(
	domain: string,
	db: Database,
	follower: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id' | 'preferredUsername'>
): Promise<boolean> {
	const id = crypto.randomUUID()
	const followerId = follower.id.toString()
	const followeeId = followee.id.toString()

	const out = await db
		.prepare(
			`
	INSERT INTO actor_following (id, actor_id, target_actor_id, state, target_actor_acct)
	SELECT ?1, ?2, ?3, ?4, ?5
	WHERE ${noBlockBetweenSql('?2', '?3')}
	ON CONFLICT(actor_id, target_actor_id) DO UPDATE SET state = excluded.state
	WHERE actor_following.state = ?6
	`
		)
		.bind(id, followerId, followeeId, STATE_ACCEPTED, actorToAcct(followee, domain), STATE_PENDING)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	if (out.meta.changes === 1) {
		return true
	}

	const acceptedFollow = await db
		.prepare(
			`
		SELECT 1
		FROM actor_following
		WHERE actor_id = ?1
		  AND target_actor_id = ?2
		  AND state = ?3
		  AND ${noBlockBetweenSql('?1', '?2')}
		LIMIT 1
		`
		)
		.bind(followerId, followeeId, STATE_ACCEPTED)
		.first()
	return acceptedFollow !== null
}

export async function updateFollowingOptions(
	db: Database,
	follower: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id'>,
	options: FollowOptions
): Promise<void> {
	const updates: string[] = []
	const values: (number | string | null)[] = []
	const optionValues = serializeFollowOptions(options)
	if (options.reblogs !== undefined) {
		updates.push('show_reblogs = ?')
		values.push(optionValues.showReblogs)
	}
	if (options.notify !== undefined) {
		updates.push('notify = ?')
		values.push(optionValues.notify)
	}
	if (options.languages !== undefined) {
		updates.push('languages = ?')
		values.push(optionValues.languages)
	}
	if (updates.length === 0) {
		return
	}

	const out = await db
		.prepare(
			`
	UPDATE actor_following
	SET ${updates.join(', ')}
	WHERE actor_id = ? AND target_actor_id = ?
	`
		)
		.bind(...values, follower.id.toString(), followee.id.toString())
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

// Accept the pending following request
export async function acceptFollowing(
	db: Database,
	follower: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id'>
): Promise<boolean> {
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
    WHERE actor_id = ?2
      AND target_actor_id = ?1
      AND state = ?3
      AND ${noBlockBetweenSql('?2', '?1')}
  )
`
			)
			.bind(followeeId, followerId, STATE_PENDING),
		db
			.prepare(
				`
UPDATE actor_following
SET state=?1
WHERE actor_id=?2
  AND target_actor_id=?3
  AND state=?4
  AND ${noBlockBetweenSql('?2', '?3')}
`
			)
			.bind(STATE_ACCEPTED, followerId, followeeId, STATE_PENDING),
	])
	assertBatchSuccess(results)
	return results[1].meta.changes === 1
}

export async function removeFollowing(db: Database, follower: Pick<Actor, 'id'>, followee: Pick<Actor, 'id'>) {
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

export async function removePendingFollowing(
	db: Database,
	follower: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id'>
): Promise<boolean> {
	const out = await db
		.prepare(
			`
DELETE FROM actor_following
WHERE actor_id=?1 AND target_actor_id=?2 AND state=?3
`
		)
		.bind(follower.id.toString(), followee.id.toString(), STATE_PENDING)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	return out.meta.changes === 1
}

export type FollowingRelationship = {
	mastodon_id: MastodonId
	show_reblogs: number
	notify: number
	languages: string | null
}

export function getFollowingRequestedMastodonIdsForTargets(
	db: Database,
	actor: Actor,
	targetIds: MastodonId[]
): Promise<MastodonId[]> {
	return getFollowingMastodonIdsByStateForTargets(db, actor, STATE_PENDING, targetIds)
}

export async function getFollowingRelationshipsForTargets(
	db: Database,
	actor: Actor,
	targetIds: MastodonId[]
): Promise<FollowingRelationship[]> {
	if (targetIds.length === 0) {
		return []
	}

	const placeholders = targetIds.map(() => '?').join(', ')
	const { success, error, results } = await db
		.prepare(
			`
SELECT actors.mastodon_id, actor_following.show_reblogs, actor_following.notify, actor_following.languages
FROM actor_following
INNER JOIN actors ON actors.id = actor_following.target_actor_id
WHERE actor_following.actor_id = ?
  AND actor_following.state = ?
  AND actors.mastodon_id IN (${placeholders})
`
		)
		.bind(actor.id.toString(), STATE_ACCEPTED, ...targetIds)
		.all<FollowingRelationship>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return results ?? []
}

export function getFollowerMastodonIdsForTargets(
	db: Database,
	actor: Actor,
	targetIds: MastodonId[]
): Promise<MastodonId[]> {
	if (targetIds.length === 0) {
		return Promise.resolve([])
	}

	const placeholders = targetIds.map(() => '?').join(', ')
	const query = `
SELECT actors.mastodon_id
FROM actor_following
INNER JOIN actors ON actors.id = actor_following.actor_id
WHERE actor_following.target_actor_id = ?
  AND actor_following.state = ?
  AND actors.mastodon_id IN (${placeholders})
`
	return getResultsField(db.prepare(query).bind(actor.id.toString(), STATE_ACCEPTED, ...targetIds), 'mastodon_id')
}

function getFollowingMastodonIdsByStateForTargets(
	db: Database,
	actor: Actor,
	state: string,
	targetIds: MastodonId[]
): Promise<MastodonId[]> {
	if (targetIds.length === 0) {
		return Promise.resolve([])
	}

	const placeholders = targetIds.map(() => '?').join(', ')
	const query = `
SELECT actors.mastodon_id
FROM actor_following
INNER JOIN actors ON actors.id = actor_following.target_actor_id
WHERE actor_following.actor_id = ?
  AND actor_following.state = ?
  AND actors.mastodon_id IN (${placeholders})
`
	return getResultsField(db.prepare(query).bind(actor.id.toString(), state, ...targetIds), 'mastodon_id')
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

export type FollowRequestRow = {
	id: string
	mastodon_id: MastodonId
	cdate: string
}

type FollowRequestListOptions = {
	limit: number
	maxId?: string
	sinceId?: string
	minId?: string
}

type FollowRequestCursor = {
	id: string
	cdate: string
}

export type PendingInboundFollow = {
	uri: string | null
}

async function getFollowRequestCursor(
	db: Database,
	followee: Pick<Actor, 'id'>,
	id: string | undefined
): Promise<FollowRequestCursor | null> {
	if (!id) {
		return null
	}
	return db
		.prepare(
			`
SELECT actor_following.id, actor_following.cdate
FROM actor_following
WHERE actor_following.target_actor_id = ? AND actor_following.id = ? AND actor_following.state = ?
`
		)
		.bind(followee.id.toString(), id, STATE_PENDING)
		.first<FollowRequestCursor>()
}

export async function getFollowRequestedActors(
	db: Database,
	followee: Pick<Actor, 'id'>,
	{ limit, maxId, sinceId, minId }: FollowRequestListOptions
): Promise<FollowRequestRow[]> {
	const lowerBoundId = sinceId ?? minId
	const [max, min] = await Promise.all([
		getFollowRequestCursor(db, followee, maxId),
		getFollowRequestCursor(db, followee, lowerBoundId),
	])

	if ((maxId && max === null) || (lowerBoundId && min === null)) {
		return []
	}

	const filters: string[] = []
	const bindings: Array<string | number> = [followee.id.toString(), STATE_PENDING]
	if (max) {
		filters.push(`AND (actor_following.cdate < ? OR (actor_following.cdate = ? AND actor_following.id < ?))`)
		bindings.push(max.cdate, max.cdate, max.id)
	}
	if (min) {
		filters.push(`AND (actor_following.cdate > ? OR (actor_following.cdate = ? AND actor_following.id > ?))`)
		bindings.push(min.cdate, min.cdate, min.id)
	}
	bindings.push(limit)

	const { success, error, results } = await db
		.prepare(
			`
SELECT actor_following.id, actors.mastodon_id, actor_following.cdate
FROM actor_following
INNER JOIN actors ON actors.id = actor_following.actor_id
WHERE actor_following.target_actor_id = ?
  AND actor_following.state = ?
${filters.join('\n')}
ORDER BY actor_following.cdate DESC, actor_following.id DESC
LIMIT ?
`
		)
		.bind(...bindings)
		.all<FollowRequestRow>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return results ?? []
}

export async function getPendingInboundFollow(
	db: Database,
	requester: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id'>
): Promise<PendingInboundFollow | null> {
	return db
		.prepare(
			`
SELECT uri
FROM actor_following
WHERE actor_id = ? AND target_actor_id = ? AND state = ?
`
		)
		.bind(requester.id.toString(), followee.id.toString(), STATE_PENDING)
		.first<PendingInboundFollow>()
}

export function buildFollowApObject(
	domain: string,
	requester: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id'>,
	uri: string | null | undefined
): FollowActivity {
	let id: URL | undefined
	if (uri) {
		try {
			id = new URL(uri)
		} catch (err) {
			console.warn('invalid Follow activity URI: ' + uri, err)
		}
	}
	id ??= new URL('/ap/a/' + crypto.randomUUID(), HTTPS + domain)
	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Follow',
		actor: requester.id,
		object: followee.id,
		id,
	}
}

export type PendingFollowResult = 'created' | 'existing' | 'blocked'

type FollowingStateAndUri = {
	state: string
	uri: string | null
}

async function getFollowingStateAndUri(
	db: Database,
	followerId: string,
	followeeId: string
): Promise<FollowingStateAndUri | null> {
	return db
		.prepare(
			`
SELECT state, uri
FROM actor_following
WHERE actor_id = ? AND target_actor_id = ?
`
		)
		.bind(followerId, followeeId)
		.first<FollowingStateAndUri>()
}

async function backfillPendingFollowUri(
	db: Database,
	followerId: string,
	followeeId: string,
	followUri: string | undefined,
	current: FollowingStateAndUri
) {
	if (!followUri || current.uri || current.state !== STATE_PENDING) {
		return
	}
	await db
		.prepare(`UPDATE actor_following SET uri = ? WHERE actor_id = ? AND target_actor_id = ? AND state = ?`)
		.bind(followUri, followerId, followeeId, STATE_PENDING)
		.run()
}

export async function ensurePendingFollowingIfNotBlocked(
	domain: string,
	db: Database,
	follower: Pick<Actor, 'id'>,
	followee: Pick<Actor, 'id' | 'preferredUsername'>,
	followUri?: string
): Promise<PendingFollowResult> {
	const followerId = follower.id.toString()
	const followeeId = followee.id.toString()

	const id = crypto.randomUUID()
	const out = await db
		.prepare(
			`
INSERT INTO actor_following (id, actor_id, target_actor_id, state, target_actor_acct, uri)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
WHERE ${noBlockBetweenSql('?2', '?3')}
ON CONFLICT(actor_id, target_actor_id) DO NOTHING
`
		)
		.bind(id, followerId, followeeId, STATE_PENDING, actorToAcct(followee, domain), followUri ?? null)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	if (out.meta.changes === 1) {
		return 'created'
	}

	const current = await getFollowingStateAndUri(db, followerId, followeeId)
	if (!current) {
		return 'blocked'
	}
	await backfillPendingFollowUri(db, followerId, followeeId, followUri, current)
	return 'existing'
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
