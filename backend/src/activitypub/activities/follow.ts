import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import { FollowActivity, insertActivity } from 'wildebeest/backend/src/activitypub/activities'
import { createAcceptActivity } from 'wildebeest/backend/src/activitypub/activities/accept'
import { type Actor, getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { type ApObject, getApId } from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { insertFollowNotification, sendFollowNotification } from 'wildebeest/backend/src/mastodon/notification'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

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
		console.warn(`actor ${followee} not found`)
		return
	}
	// activity.object must be a local user
	if (!isLocalAccount(domain, actorToHandle(followee))) {
		return
	}

	const followerId = getApId(activity.actor)
	const follower = await getAndCache(followerId, db)

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
