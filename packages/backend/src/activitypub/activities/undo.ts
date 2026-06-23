import {
	AnnounceActivity,
	getActivityObject,
	insertActivity,
	isAnnounceActivity,
	UndoActivity,
} from '@wildebeest/backend/activitypub/activities'
import { createFollowActivity } from '@wildebeest/backend/activitypub/activities/follow'
import { Actor, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { ApObject, getApId } from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'
import { deleteReblogByActivityId } from '@wildebeest/backend/mastodon/reblog'

export async function createUnfollowActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject
): Promise<UndoActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Undo',
		actor: actor.id,
		object: await createFollowActivity(db, domain, actor, object),
	})
}

export async function createUndoAnnounceActivity(
	db: Database,
	domain: string,
	actor: Actor,
	announce: AnnounceActivity
): Promise<UndoActivity<AnnounceActivity>> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Undo',
		actor: actor.id,
		object: announce,
		to: announce.to,
		cc: announce.cc,
	})
}

export async function handleUndoActivity(_domain: string, activity: UndoActivity, db: Database) {
	const actorId = getApId(activity.actor)
	const actor = await getAndCacheActor(actorId, db)
	if (!actor) {
		console.warn(`failed to retrieve actor ${actorId}`)
		return
	}

	if (typeof activity.object === 'string' || activity.object instanceof URL) {
		await deleteReblogByActivityId(db, actor, getApId(activity.object))
		return
	}

	const object = getActivityObject(activity)
	if (!isAnnounceActivity(object)) {
		console.warn(`Unsupported Undo object: ${object.type}`)
		return
	}
	if (getApId(object.actor).toString() !== actor.id.toString()) {
		console.warn('Undo Announce actor mismatch')
		return
	}

	await deleteReblogByActivityId(db, actor, getApId(object.id))
}
