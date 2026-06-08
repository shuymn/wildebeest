import type { Actor } from '@wildebeest/backend/activitypub/actors'
import type { ApObject } from '@wildebeest/backend/activitypub/objects'
import { type Database } from '@wildebeest/backend/database'

import { assertBatchSuccess, getResultsField } from './utils'

export async function insertLike(db: Database, actor: Actor, obj: ApObject) {
	const id = crypto.randomUUID()
	const actorId = actor.id.toString()
	const objectId = obj.id.toString()

	const results = await db.batch([
		db
			.prepare(
				db.qb.insertOrIgnore(`
INTO actor_favourites (id, actor_id, object_id)
VALUES (?, ?, ?)
`)
			)
			.bind(id, actorId, objectId),
		db
			.prepare(
				`
UPDATE objects
SET interaction_count = interaction_count + 1
WHERE id = ?
  AND local = 0
  AND EXISTS (SELECT 1 FROM users WHERE users.actor_id = ?)
  AND EXISTS (SELECT 1 FROM actor_favourites WHERE id = ?)
`
			)
			.bind(objectId, actorId, id),
	])
	assertBatchSuccess(results)
}

export function getLikes(db: Database, obj: ApObject): Promise<Array<string>> {
	const query = `
		SELECT actor_id FROM actor_favourites WHERE object_id=?
	`

	const statement = db.prepare(query).bind(obj.id.toString())

	return getResultsField(statement, 'actor_id')
}
