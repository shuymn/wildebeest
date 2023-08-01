import type { Activity } from 'wildebeest/backend/src/activitypub/activities'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { type ApObject, ApObjectOrId } from 'wildebeest/backend/src/activitypub/objects'
import type { OrderedCollection } from 'wildebeest/backend/src/activitypub/objects/collection'
import { getMetadata, loadItems } from 'wildebeest/backend/src/activitypub/objects/collection'
import { type Database } from 'wildebeest/backend/src/database'
import { unique } from 'wildebeest/backend/src/utils'

export async function addObjectInOutbox<T extends ApObject>(
	db: Database,
	actor: Actor,
	obj: T,
	objTo: T['to'] = obj.to ?? [],
	objCc: T['cc'] = obj.cc ?? [],
	published_date?: string
): Promise<string> {
	const id = crypto.randomUUID()

	const to: ApObjectOrId[] = Array.isArray(objTo) ? objTo : [objTo]
	const cc: ApObjectOrId[] = Array.isArray(objCc) ? objCc : [objCc]

	let out
	if (published_date !== undefined) {
		out = await db
			.prepare('INSERT INTO outbox_objects(id, actor_id, object_id, published_date, `to`, cc) VALUES(?, ?, ?, ?, ?, ?)')
			.bind(
				id,
				actor.id.toString(),
				obj.id.toString(),
				published_date,
				JSON.stringify(unique(to)),
				JSON.stringify(unique(cc))
			)
			.run()
	} else {
		out = await db
			.prepare('INSERT INTO outbox_objects(id, actor_id, object_id, `to`, cc) VALUES(?, ?, ?, ?, ?)')
			.bind(id, actor.id.toString(), obj.id.toString(), JSON.stringify(unique(to)), JSON.stringify(unique(cc)))
			.run()
	}
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
	return id
}

export async function get<T extends Activity>(actor: Actor, limit?: number): Promise<OrderedCollection<T>> {
	const collection = await getMetadata<T>(actor.outbox)
	collection.items = await loadItems(collection, limit ?? 20)

	return collection
}

export async function countStatuses(actor: Actor): Promise<number> {
	const metadata = await getMetadata(actor.outbox)
	return metadata.totalItems
}
