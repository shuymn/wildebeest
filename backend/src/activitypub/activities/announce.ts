// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-announce

import { AnnounceActivity, insertActivity } from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorById, getAndCacheActor } from 'wildebeest/backend/src/activitypub/actors'
import { getAndCacheObject, getApId, originalActorIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { isNote } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database } from 'wildebeest/backend/src/database'
import { createNotification, sendReblogNotification } from 'wildebeest/backend/src/mastodon/notification'
import { createReblog, hasReblog, reblogNotAllowed } from 'wildebeest/backend/src/mastodon/reblog'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

export async function createAnnounceActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: URL,
	to: Set<string>,
	cc: Set<string>
): Promise<AnnounceActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Announce',
		actor: actor.id,
		object,
		to: Array.from(to),
		cc: Array.from(cc),
	})
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-announce
export async function handleAnnounceActivity(
	domain: string,
	activity: AnnounceActivity,
	db: Database,
	adminEmail: string,
	vapidKeys: JWK
) {
	const objectId = getApId(activity.object)
	const actorId = getApId(activity.actor)

	const actor = await getAndCacheActor(actorId, db)
	if (!actor) {
		console.warn(`failed to retrieve actor ${actorId}`)
		return
	}

	const res = await getAndCacheObject(domain, db, objectId, actor).catch((err) => {
		console.warn(`failed to retrieve object ${objectId}: ${err.message}`)
		return null
	})
	if (!res?.object) {
		return
	}

	const obj = res.object
	if (!isNote(obj)) {
		console.warn(`object ${objectId} is not a note`)
		return
	}

	if (reblogNotAllowed(actor, obj, activity)) {
		console.warn(`reblog not allowed for object ${objectId}`)
		return
	}

	if (await hasReblog(db, actor, obj)) {
		// A reblog already exists. To avoid duplicated reblog we ignore.
		console.warn('probably duplicated Announce message')
		return
	}

	// notify the user
	const rebloggedActorId = new URL(obj[originalActorIdSymbol])
	const rebloggedActor = await getActorById(db, rebloggedActorId)
	if (rebloggedActor === null) {
		console.warn('object actor not found: ' + rebloggedActorId.toString())
		return
	}

	const notifId = await createNotification(db, 'reblog', rebloggedActor, actor, obj)

	await Promise.all([
		createReblog(db, actor, obj, activity, activity.published),
		sendReblogNotification(db, actor, rebloggedActor, notifId, adminEmail, vapidKeys),
	])
}
