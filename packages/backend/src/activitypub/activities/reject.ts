import { isLocalAccount } from '@wildebeest/backend/accounts'
import {
	getActivityObject,
	insertActivity,
	isFollowActivity,
	RejectActivity,
} from '@wildebeest/backend/activitypub/activities'
import { Actor, getActorById, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { ApObject, getApId, getApType } from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'
import { removeFollowing } from '@wildebeest/backend/mastodon/follow'
import { actorToHandle } from '@wildebeest/backend/utils/handle'

export async function createRejectActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject
): Promise<RejectActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Reject',
		actor: actor.id,
		object,
	})
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-reject
export async function handleRejectActivity(domain: string, activity: RejectActivity, db: Database) {
	const obj = getActivityObject(activity)

	if (!isFollowActivity(obj)) {
		console.warn('unsupported Reject type: ' + getApType(obj))
		return
	}

	// only the followee can reject the Follow it received
	const followeeId = getApId(activity.actor)
	if (getApId(obj.object).toString() !== followeeId.toString()) {
		console.warn('Reject Follow actor mismatch')
		return
	}

	const followerId = getApId(obj.actor)
	const follower = await getActorById(db, followerId)
	if (follower === null) {
		console.warn(`actor ${followerId} not found`)
		return
	}

	// obj.actor must be a local user
	if (!isLocalAccount(domain, actorToHandle(follower))) {
		return
	}

	const followee = await getAndCacheActor(followeeId, db)
	if (followee === null) {
		console.warn(`actor ${followeeId} not found`)
		return
	}
	await removeFollowing(db, follower, followee)
}
