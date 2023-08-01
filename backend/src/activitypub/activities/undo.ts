import { insertActivity, UndoActivity } from 'wildebeest/backend/src/activitypub/activities'
import { createFollowActivity } from 'wildebeest/backend/src/activitypub/activities/follow'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'

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
