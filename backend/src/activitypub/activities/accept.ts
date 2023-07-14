import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import {
	AcceptActivity,
	createActivityId,
	getActivityObject,
	isFollowActivity,
} from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { ApObject, getApId, getApType } from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'
import { acceptFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'

export function createAcceptActivity(domain: string, actor: Actor, object: ApObject): AcceptActivity {
	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Accept',
		id: createActivityId(domain),
		actor: actor.id,
		object,
	}
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
	const followee = await getAndCache(getApId(activity.actor), db)
	await acceptFollowing(db, follower, followee)
}
