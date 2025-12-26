import { getActivityObject, insertActivity, UpdateActivity } from '@wildebeest/backend/activitypub/activities'
import {
	Actor,
	getActorById,
	isActorType,
	sanitizeActor,
	updateActorProperties,
} from '@wildebeest/backend/activitypub/actors'
import {
	ApObject,
	getApId,
	getObjectByOriginalId,
	originalActorIdSymbol,
} from '@wildebeest/backend/activitypub/objects'
import { isNoteType, updateNote } from '@wildebeest/backend/activitypub/objects/note'
import { Database } from '@wildebeest/backend/database'

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

	if (isActorType(activity.object.type)) {
		const actor = await getActorById(db, objectId)
		if (actor === null) {
			throw new Error(`actor ${objectId} does not exist`)
		}

		if (actorId.toString() !== getApId(actor.id).toString()) {
			throw new Error('actor.id mismatch when updating actor')
		}

		const sanitized = await sanitizeActor(activity.object)
		await updateActorProperties(db, actorId, sanitized)
	} else if (isNoteType(activity.object.type)) {
		// check current object
		const obj = await getObjectByOriginalId(domain, db, objectId)
		if (obj === null) {
			throw new Error(`object ${objectId} does not exist`)
		}

		if (actorId.toString() !== obj[originalActorIdSymbol]) {
			throw new Error('actor.id mismatch when updating object')
		}

		await updateNote(db, activity.object, obj)
	} else {
		console.warn('unsupported Update for Object type: ' + JSON.stringify(activity.object.type))
		return
	}
}
