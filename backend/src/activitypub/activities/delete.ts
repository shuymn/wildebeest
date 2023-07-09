import { createActivityId, DeleteActivity } from 'wildebeest/backend/src/activitypub/activities'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import {
	APObject,
	deleteObject,
	getAPId,
	getObjectByOriginalId,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'

export function createDeleteActivity(domain: string, actor: Actor, object: APObject): DeleteActivity {
	return {
		'@context': ['https://www.w3.org/ns/activitystreams'],
		id: createActivityId(domain),
		type: 'Delete',
		actor: actor.id,
		object,
	}
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-delete
export async function handleDeleteActivity(activity: DeleteActivity, db: Database) {
	const objectId = getAPId(activity.object)
	const actorId = getAPId(activity.actor)

	const obj = await getObjectByOriginalId(db, objectId)
	if (obj === null || !obj[originalActorIdSymbol]) {
		console.warn('unknown object or missing originalActorId')
		return
	}

	if (actorId.toString() !== obj[originalActorIdSymbol]) {
		console.warn(`authorized Delete (${actorId} vs ${obj[originalActorIdSymbol]})`)
		return
	}

	if (!['Note'].includes(obj.type)) {
		console.warn('unsupported Update for Object type: ' + obj.type)
		return
	}

	await deleteObject(db, obj)
}
