// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-like

import { insertActivity, LikeActivity } from '@wildebeest/backend/activitypub/activities'
import { Actor, getActorById, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { getApId, getObjectById, originalActorIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'
import { insertLike } from '@wildebeest/backend/mastodon/like'
import { createNotification, sendLikeNotification } from '@wildebeest/backend/mastodon/notification'
import { JWK } from '@wildebeest/backend/webpush/jwk'

export async function createLikeActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: URL
): Promise<LikeActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Like',
		actor: actor.id,
		object,
	})
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-like
export async function handleLikeActivity(
	domain: string,
	activity: LikeActivity,
	db: Database,
	adminEmail: string,
	vapidKeys: JWK
) {
	const objectId = getApId(activity.object)
	const actorId = getApId(activity.actor)

	const obj = await getObjectById(domain, db, objectId)
	if (obj === null || !obj[originalActorIdSymbol]) {
		console.warn('unknown object')
		return
	}

	const fromActor = await getAndCacheActor(actorId, db)
	if (fromActor === null) {
		console.warn('actor not found: ', actorId.toString())
		return
	}
	const targetActor = await getActorById(db, new URL(obj[originalActorIdSymbol]))
	if (targetActor === null) {
		console.warn('object actor not found')
		return
	}

	const [notifId] = await Promise.all([
		// Notify the user
		createNotification(db, 'favourite', targetActor, fromActor, obj),
		// Store the like for counting
		insertLike(db, fromActor, obj),
	])

	await sendLikeNotification(db, fromActor, targetActor, notifId, adminEmail, vapidKeys)
}
