import { isLocalAccount } from '@wildebeest/backend/accounts'
import {
	AnnounceActivity,
	FollowActivity,
	getActivityObject,
	insertActivity,
	isAnnounceActivity,
	isFollowActivity,
	isLikeActivity,
	LikeActivity,
	UndoActivity,
} from '@wildebeest/backend/activitypub/activities'
import { createFollowActivity } from '@wildebeest/backend/activitypub/activities/follow'
import { Actor, getActorById, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { ApObject, getApId, getObjectById } from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'
import { removeFollowing } from '@wildebeest/backend/mastodon/follow'
import { deleteLike } from '@wildebeest/backend/mastodon/like'
import { deleteFavouriteNotification } from '@wildebeest/backend/mastodon/notification'
import { deleteReblogByActivityId } from '@wildebeest/backend/mastodon/reblog'
import { actorToHandle } from '@wildebeest/backend/utils/handle'

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

export async function handleUndoActivity(domain: string, activity: UndoActivity, db: Database) {
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
	if (isFollowActivity(object)) {
		await handleUndoFollowActivity(domain, object, actor, db)
		return
	}
	if (isLikeActivity(object)) {
		await handleUndoLikeActivity(domain, object, actor, db)
		return
	}
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

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-undo
async function handleUndoFollowActivity(domain: string, follow: FollowActivity, actor: Actor, db: Database) {
	if (getApId(follow.actor).toString() !== actor.id.toString()) {
		console.warn('Undo Follow actor mismatch')
		return
	}

	const followeeId = getApId(follow.object)
	const followee = await getActorById(db, followeeId)
	if (followee === null) {
		console.warn(`actor ${followeeId} not found`)
		return
	}

	// the followee must be a local user
	if (!isLocalAccount(domain, actorToHandle(followee))) {
		return
	}

	await removeFollowing(db, actor, followee)
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-undo
async function handleUndoLikeActivity(domain: string, like: LikeActivity, actor: Actor, db: Database) {
	if (getApId(like.actor).toString() !== actor.id.toString()) {
		console.warn('Undo Like actor mismatch')
		return
	}

	const objectId = getApId(like.object)
	const obj = await getObjectById(domain, db, objectId)
	if (obj === null) {
		console.warn('unknown object')
		return
	}

	await deleteLike(db, actor, obj)
	await deleteFavouriteNotification(db, actor, obj)
}
