import { MoveActivity } from '@wildebeest/backend/activitypub/activities'
import { type Actor, getActorById, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { getApId, isLocalObject } from '@wildebeest/backend/activitypub/objects'
import { getMetadata, loadItems, OrderedCollection } from '@wildebeest/backend/activitypub/objects/collection'
import { Database } from '@wildebeest/backend/database'
import { moveFollowers, moveFollowing } from '@wildebeest/backend/mastodon/follow'

// Whether `follower` has an accepted follow of `followee` recorded here.
async function hasAcceptedFollow(db: Database, follower: string, followee: string): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT 1 FROM actor_following WHERE actor_id = ?1 AND target_actor_id = ?2 AND state = 'accepted' LIMIT 1"
		)
		.bind(follower, followee)
		.first()
	return row !== null
}

// The moving actor's collections are its own claims. They are trusted for
// remote actors, but a relationship involving a local actor is only carried
// over when it is recorded here: a remote actor can never make a local actor
// follow, or be followed by, the target on its word alone.
async function keepRecordedLocalRelationships(
	domain: string,
	db: Database,
	ids: string[],
	isRecorded: (localId: string) => Promise<boolean>
): Promise<string[]> {
	const kept = []
	for (const id of ids) {
		let url: URL
		try {
			url = new URL(id)
		} catch {
			continue
		}
		if (isLocalObject(domain, url) && !(await isRecorded(id))) {
			console.warn(`ignoring unrecorded relationship of local actor ${id} in Move`)
			continue
		}
		kept.push(id)
	}
	return kept
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-move
//
// As in Mastodon, a Move is only honored when the actor moves itself (checked
// by `authorizeInboundActivity`) and the target lists the moving actor in its
// `alsoKnownAs`.
//
// Only a Move to a local actor is implemented: that actor's owner declared the
// alias in the aliases settings, and the moving actor's followers and following
// are copied to it. A Move to a remote actor is ignored, so local followers of
// the moving actor keep following it rather than re-following the target.
export async function handleMoveActivity(domain: string, activity: MoveActivity, db: Database) {
	const fromActorId = getApId(activity.actor)
	const targetId = getApId(activity.target)

	if (!isLocalObject(domain, targetId)) {
		console.warn(`Move to remote actor ${targetId.toString()} is not supported`)
		return
	}

	const localActor = await getActorById(db, targetId)
	if (localActor === null) {
		console.warn(`actor ${targetId} not found`)
		return
	}

	// The local aliases are the only `alsoKnownAs` of a local actor.
	if (!(localActor.alsoKnownAs ?? []).includes(fromActorId.toString())) {
		console.warn(`${targetId.toString()} does not list ${fromActorId.toString()} as an alias`)
		return
	}

	const fromActor = await getAndCacheActor(fromActorId, db)
	if (fromActor === null) {
		console.warn(`actor ${fromActorId} not found`)
		return
	}

	// FIXME: Depending on the number of followings/followers the account has,
	// it may be caught by the Cloudflare Workers limit.
	// ref: https://developers.cloudflare.com/workers/platform/limits/

	await moveCollection(fromActor.followers, async (batch) => {
		const followers = await keepRecordedLocalRelationships(domain, db, batch, (id) =>
			hasAcceptedFollow(db, id, fromActorId.toString())
		)
		await moveFollowers(domain, db, localActor, followers)
		console.log(`moved ${followers.length} followers`)
	})

	await moveCollection(fromActor.following, async (batch) => {
		const following = await keepRecordedLocalRelationships(domain, db, batch, (id) =>
			hasAcceptedFollow(db, fromActorId.toString(), id)
		)
		await moveFollowing(domain, db, localActor, following)
		console.log(`moved ${following.length} following`)
	})
}

async function moveCollection(url: Actor['followers'], move: (batch: string[]) => Promise<void>) {
	const collection: OrderedCollection<string> = await getMetadata(url)
	// FIXME: stub
	collection.items = await loadItems(collection, 500)

	// TODO: eventually move to queue and move workers
	while (collection.items.length > 0) {
		await move(collection.items.splice(0, 20))
	}
}
