import { isLocalAccount } from '@wildebeest/backend/accounts'
import { FollowActivity, insertActivity } from '@wildebeest/backend/activitypub/activities'
import { createAcceptActivity } from '@wildebeest/backend/activitypub/activities/accept'
import { type Actor, getActorById, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { type ApObject, getApId } from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { hasBlockBetween } from '@wildebeest/backend/mastodon/block'
import {
	ensureAcceptedFollowingIfNotBlocked,
	ensurePendingFollowingIfNotBlocked,
} from '@wildebeest/backend/mastodon/follow'
import {
	insertFollowNotification,
	insertFollowRequestNotification,
	sendFollowNotification,
	sendFollowRequestNotification,
} from '@wildebeest/backend/mastodon/notification'
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
	const activityId = getApId(activity)
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
	if (await hasBlockBetween(db, { id: followerId }, followee)) {
		return
	}

	const follower = await getAndCacheActor(followerId, db)
	if (follower === null) {
		console.warn(`actor ${followerId} not found`)
		return
	}

	if (followee.manuallyApprovesFollowers) {
		const result = await ensurePendingFollowingIfNotBlocked(domain, db, follower, followee, activityId.toString())
		if (result !== 'created') {
			return
		}
		const notifId = await insertFollowRequestNotification(db, followee, follower)
		await sendFollowRequestNotification(db, follower, followee, notifId, adminEmail, vapidKeys)
		return
	}

	if (!(await ensureAcceptedFollowingIfNotBlocked(domain, db, follower, followee))) {
		return
	}

	// Automatically send the Accept reply
	const reply = await createAcceptActivity(db, domain, followee, activity)
	const signingKey = await getSigningKey(userKEK, db, followee)
	await deliverToActor(signingKey, followee, follower, reply, domain)

	// Notify the user
	const notifId = await insertFollowNotification(db, followee, follower)
	await sendFollowNotification(db, follower, followee, notifId, adminEmail, vapidKeys)
}
