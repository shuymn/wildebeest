import { isLocalAccount } from '@wildebeest/backend/accounts'
import { FollowActivity, insertActivity } from '@wildebeest/backend/activitypub/activities'
import { createAcceptActivity } from '@wildebeest/backend/activitypub/activities/accept'
import { type Actor, getActorById, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { type ApObject, getApId } from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { acceptFollowing, addFollowing } from '@wildebeest/backend/mastodon/follow'
import { insertFollowNotification, sendFollowNotification } from '@wildebeest/backend/mastodon/notification'
import { actorToHandle } from '@wildebeest/backend/utils/handle'
import { JWK } from '@wildebeest/backend/webpush/jwk'

export async function createFollowActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject
): Promise<FollowActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Follow',
		actor: actor.id,
		object: object.id,
	})
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-follow
export async function handleFollowActivity(
	domain: string,
	activity: FollowActivity,
	db: Database,
	userKEK: string,
	adminEmail: string,
	vapidKeys: JWK
) {
	const followeeId = getApId(activity.object)
	const followee = await getActorById(db, followeeId)
	if (followee === null) {
		console.warn(`actor ${followeeId} not found`)
		return
	}
	// activity.object must be a local user
	if (!isLocalAccount(domain, actorToHandle(followee))) {
		return
	}

	const followerId = getApId(activity.actor)
	const follower = await getAndCacheActor(followerId, db)
	if (follower === null) {
		console.warn(`actor ${followerId} not found`)
		return
	}

	await addFollowing(domain, db, follower, followee)

	// Automatically send the Accept reply
	await acceptFollowing(db, follower, followee)
	const reply = await createAcceptActivity(db, domain, followee, activity)
	const signingKey = await getSigningKey(userKEK, db, followee)
	await deliverToActor(signingKey, followee, follower, reply, domain)

	// Notify the user
	const notifId = await insertFollowNotification(db, followee, follower)
	await sendFollowNotification(db, follower, followee, notifId, adminEmail, vapidKeys)
}
