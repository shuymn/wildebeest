import { MoveActivity } from 'wildebeest/backend/src/activitypub/activities'
import { getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import { getMetadata, loadItems } from 'wildebeest/backend/src/activitypub/objects/collection'
import { Database } from 'wildebeest/backend/src/database'
import { moveFollowers, moveFollowing } from 'wildebeest/backend/src/mastodon/follow'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-move
export async function handleMoveActivity(domain: string, activity: MoveActivity, db: Database) {
	const fromActorId = getApId(activity.actor)
	const targetId = getApId(activity.target)

	if (targetId.hostname !== domain) {
		console.warn("Moving actor isn't local")
		return
	}

	const fromActor = await getAndCache(fromActorId, db)

	const localActor = await getActorById(db, targetId)
	if (localActor === null) {
		console.warn(`actor ${targetId} not found`)
		return
	}

	// FIXME: Requires alsoKnownAs to be set in both directions

	// move followers
	{
		const collection = await getMetadata(fromActor.followers)
		collection.items = await loadItems<string>(collection)

		// TODO: eventually move to queue and move workers
		while (collection.items.length > 0) {
			const batch = collection.items.splice(0, 20)
			await moveFollowers(db, localActor, batch)
			console.log(`moved ${batch.length} followers`)
		}
	}

	// move following
	{
		const collection = await getMetadata(fromActor.following)
		collection.items = await loadItems<string>(collection)

		// TODO: eventually move to queue and move workers
		while (collection.items.length > 0) {
			const batch = collection.items.splice(0, 20)
			await moveFollowing(db, localActor, batch)
			console.log(`moved ${batch.length} following`)
		}
	}
}
