import { getActivityObject, insertActivity, UpdateActivity } from 'wildebeest/backend/src/activitypub/activities'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import {
	ApObject,
	getApId,
	getObjectByOriginalId,
	originalActorIdSymbol,
	updateObject,
} from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'

export async function createUpdateActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject
): Promise<UpdateActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Update',
		actor: actor.id,
		object,
	})
}

export async function handleUpdateActivity(domain: string, activity: UpdateActivity, db: Database) {
	activity.object = getActivityObject(activity)

	const actorId = getApId(activity.actor)
	const objectId = getApId(activity.object)

	if (!['Note', 'Person', 'Service'].includes(activity.object.type)) {
		console.warn('unsupported Update for Object type: ' + JSON.stringify(activity.object.type))
		return
	}

	// check current object
	const obj = await getObjectByOriginalId(domain, db, objectId)
	if (obj === null) {
		throw new Error(`object ${objectId} does not exist`)
	}

	if (actorId.toString() !== obj[originalActorIdSymbol]) {
		throw new Error('actor.id mismatch when updating object')
	}

	await updateObject(db, activity.object, getApId(obj))
}
