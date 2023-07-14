import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'

import { getResultsField } from './utils'

export async function insertLike(db: Database, actor: Actor, obj: ApObject) {
	const id = crypto.randomUUID()

	const query = `
		INSERT INTO actor_favourites (id, actor_id, object_id)
		VALUES (?, ?, ?)
	`

	const out = await db.prepare(query).bind(id, actor.id.toString(), obj.id.toString()).run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export function getLikes(db: Database, obj: ApObject): Promise<Array<string>> {
	const query = `
		SELECT actor_id FROM actor_favourites WHERE object_id=?
	`

	const statement = db.prepare(query).bind(obj.id.toString())

	return getResultsField(statement, 'actor_id')
}
