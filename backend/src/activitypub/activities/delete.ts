import { DeleteActivity, insertActivity } from 'wildebeest/backend/src/activitypub/activities'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import {
	ApObject,
	deleteObject,
	getApId,
	getObjectByOriginalId,
	isLocalObject,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { Database } from 'wildebeest/backend/src/database'

export async function createDeleteActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject
): Promise<DeleteActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': 'https://www.w3.org/ns/activitystreams',
		type: 'Delete',
		actor: actor.id,
		object,
	})
}

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-delete
export async function handleDeleteActivity(domain: string, activity: DeleteActivity, db: Database) {
	const objectId = getApId(activity.object)
	const actorId = getApId(activity.actor)

	// ignore if object is local
	if (isLocalObject(domain, objectId)) {
		return
	}

	const obj = await getObjectByOriginalId(domain, db, objectId)
	if (obj === null || !obj[originalActorIdSymbol]) {
		console.warn('unknown object or missing originalActorId')
		return
	}

	if (actorId.toString() !== obj[originalActorIdSymbol]) {
		console.warn(`authorized Delete (${actorId} vs ${obj[originalActorIdSymbol]})`)
		return
	}

	if (obj.type !== 'Note') {
		console.warn('unsupported Update for Object type: ' + obj.type)
		return
	}

	await deleteObject(db, obj)
}
