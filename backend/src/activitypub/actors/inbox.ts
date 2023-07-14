import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'

export async function addObjectInInbox(db: Database, actor: Actor, obj: ApObject) {
	const id = crypto.randomUUID()
	const out = await db
		.prepare('INSERT INTO inbox_objects(id, actor_id, object_id) VALUES(?, ?, ?)')
		.bind(id, actor.id.toString(), obj.id.toString())
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}
