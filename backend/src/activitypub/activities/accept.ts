import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import {
	AcceptActivity,
	getActivityObject,
	insertActivity,
	isFollowActivity,
} from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorById, getAndCacheActor } from 'wildebeest/backend/src/activitypub/actors'
import { ApObject, getApId, getApType } from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'
import { acceptFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'

export async function createAcceptActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject
): Promise<AcceptActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Accept',
		actor: actor.id,
		object,
	})
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-accept
export async function handleAcceptActivity(domain: string, activity: AcceptActivity, db: Database) {
	const obj = getActivityObject(activity)

	if (!isFollowActivity(obj)) {
		console.warn('unsupported Accept type: ' + getApType(obj))
		return
	}

	const followerId = getApId(obj.actor)
	const follower = await getActorById(db, followerId)
	if (follower === null) {
		console.warn(`actor ${followerId} not found`)
		return
	}

	// activity.actor must be a local user
	if (!isLocalAccount(domain, actorToHandle(follower))) {
		return
	}

	const followeeId = getApId(activity.actor)
	const followee = await getAndCacheActor(followeeId, db)
	if (followee === null) {
		console.warn(`actor ${followeeId} not found`)
		return
	}
	await acceptFollowing(db, follower, followee)
}
