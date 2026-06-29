import { RejectActivity, insertActivity } from '@wildebeest/backend/activitypub/activities'
import { Actor } from '@wildebeest/backend/activitypub/actors'
import { ApObject } from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'

export async function createRejectActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject
): Promise<RejectActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Reject',
		actor: actor.id,
		object,
	})
}
