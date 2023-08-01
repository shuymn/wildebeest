// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-announce

import { AnnounceActivity, cacheActivityObject, insertActivity } from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { get, getApId, getObjectById, originalActorIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { isNote, Note } from 'wildebeest/backend/src/activitypub/objects/note'
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

	// Object already exists locally, we can just use it.
	let obj = await getObjectById(db, objectId)
	if (obj === null) {
		try {
			// Object doesn't exists locally, we'll need to download it.
			const remoteObject = await get<Note>(objectId)

			const res = await cacheActivityObject(domain, remoteObject, db, actorId, objectId)
			if (res === null) {
				return
			}
			obj = res.object
		} catch (err: any) {
			console.warn(`failed to retrieve object ${objectId}: ${err.message}`)
			return
		}
	}

	if (!isNote(obj)) {
		console.warn(`object ${objectId} is not a note`)
		return
	}

	const rebloggingActor = await getAndCache(actorId, db)
	if (reblogNotAllowed(rebloggingActor, obj, activity)) {
		console.warn(`reblog not allowed for object ${objectId}`)
		return
	}

	if (await hasReblog(db, rebloggingActor, obj)) {
		// A reblog already exists. To avoid duplicated reblog we ignore.
		console.warn('probably duplicated Announce message')
		return
	}

	// notify the user
	const rebloggedActor = await getActorById(db, new URL(obj[originalActorIdSymbol]))
	if (rebloggedActor === null) {
		console.warn('object actor not found')
		return
	}

	const notifId = await createNotification(db, 'reblog', rebloggedActor, rebloggingActor, obj)

	await Promise.all([
		createReblog(db, rebloggingActor, obj, activity, activity.published),
		sendReblogNotification(db, rebloggingActor, rebloggedActor, notifId, adminEmail, vapidKeys),
	])
}
