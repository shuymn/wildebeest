// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-announce

import { AnnounceActivity, cacheActivityObject, createActivityId } from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { get, getApId, getObjectById, originalActorIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database } from 'wildebeest/backend/src/database'
import { createNotification, sendReblogNotification } from 'wildebeest/backend/src/mastodon/notification'
import { createReblog, hasReblog } from 'wildebeest/backend/src/mastodon/reblog'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'

export function createAnnounceActivity(domain: string, actor: Actor, object: URL): AnnounceActivity {
	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: createActivityId(domain),
		type: 'Announce',
		actor: actor.id,
		object,
	}
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

	let obj: any = null

	const localObject = await getObjectById(db, objectId)
	if (localObject === null) {
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
	} else {
		// Object already exists locally, we can just use it.
		obj = localObject
	}

	const fromActor = await getAndCache(actorId, db)

	if (await hasReblog(db, fromActor, obj)) {
		// A reblog already exists. To avoid dulicated reblog we ignore.
		console.warn('probably duplicated Announce message')
		return
	}

	// notify the user
	const targetActor = await getActorById(db, new URL(obj[originalActorIdSymbol]))
	if (targetActor === null) {
		console.warn('object actor not found')
		return
	}

	const notifId = await createNotification(db, 'reblog', targetActor, fromActor, obj)

	await Promise.all([
		createReblog(db, fromActor, obj),
		sendReblogNotification(db, fromActor, targetActor, notifId, adminEmail, vapidKeys),
	])
}
