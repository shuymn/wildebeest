import { createActivityId, UndoActivity } from 'wildebeest/backend/src/activitypub/activities'
import { createFollowActivity } from 'wildebeest/backend/src/activitypub/activities/follow'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { ApObject } from 'wildebeest/backend/src/activitypub/objects'

export function createUnfollowActivity(domain: string, actor: Actor, object: ApObject): UndoActivity {
	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: createActivityId(domain),
		type: 'Undo',
		actor: actor.id,
		object: createFollowActivity(domain, actor, object),
	}
}
