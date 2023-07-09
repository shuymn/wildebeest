import { createActivityId, getActivityObject, UpdateActivity } from 'wildebeest/backend/src/activitypub/activities'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import {
	APObject,
	getAPId,
	getObjectBy,
	ObjectByKey,
	originalActorIdSymbol,
	updateObject,
} from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'

export function createUpdateActivity(domain: string, actor: Actor, object: APObject): UpdateActivity {
	return {
		'@context': ['https://www.w3.org/ns/activitystreams'],
		id: createActivityId(domain),
		type: 'Update',
		actor: actor.id,
		object,
	}
}

export async function handleUpdateActivity(activity: UpdateActivity, db: Database) {
	activity.object = getActivityObject(activity)

	const actorId = getAPId(activity.actor)
	const objectId = getAPId(activity.object)

	if (!['Note', 'Person', 'Service'].includes(activity.object.type)) {
		console.warn('unsupported Update for Object type: ' + JSON.stringify(activity.object.type))
		return
	}

	// check current object
	const obj = await getObjectBy(db, ObjectByKey.originalObjectId, objectId.toString())
	if (obj === null) {
		throw new Error(`object ${objectId} does not exist`)
	}

	if (actorId.toString() !== obj[originalActorIdSymbol]) {
		throw new Error('actor.id mismatch when updating object')
	}

	const updated = await updateObject(db, activity.object, getAPId(obj))
	if (!updated) {
		throw new Error('could not update object in database')
	}
}
