import { DeleteActivity, insertActivity } from '@wildebeest/backend/activitypub/activities'
import { Actor } from '@wildebeest/backend/activitypub/actors'
import {
	ApObject,
	deleteObject,
	getApId,
	getObjectByOriginalId,
	isLocalObject,
	originalActorIdSymbol,
} from '@wildebeest/backend/activitypub/objects'
import { Database } from '@wildebeest/backend/database'

export type Tombstone = ApObject & {
	type: 'Tombstone'
	atomUri: string
}

/**
 * Builds the Tombstone sent in a Delete activity. Only the object id is disclosed, never its
 * content, as a Delete reaches actors that may no longer be able to see the object.
 */
export function newTombstone(objectId: string | URL): Tombstone {
	const id = objectId.toString()
	return { id, type: 'Tombstone', atomUri: id }
}

export async function createDeleteActivity(
	db: Database,
	domain: string,
	actor: Actor,
	object: ApObject,
	audience?: Pick<ApObject, 'to' | 'cc'>
): Promise<DeleteActivity> {
	return await insertActivity(db, domain, actor, {
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			{ ostatus: 'http://ostatus.org#', atomUri: 'ostatus:atomUri' },
		],
		type: 'Delete',
		actor: actor.id,
		object,
		...(audience ? { to: audience.to, cc: audience.cc } : {}),
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
