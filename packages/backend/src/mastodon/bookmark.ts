import type { Actor } from '@wildebeest/backend/activitypub/actors'
import type { ApObject } from '@wildebeest/backend/activitypub/objects'
import { type Database } from '@wildebeest/backend/database'

import { refreshRemoteObjectInteractionCount } from './interaction_count'
import { assertBatchSuccess, getResultsField } from './utils'

export async function insertBookmark(db: Database, actor: Pick<Actor, 'id'>, obj: Pick<ApObject, 'id'>) {
	const id = crypto.randomUUID()
	const actorId = actor.id.toString()
	const objectId = obj.id.toString()

	const results = await db.batch([
		db
			.prepare(
				db.qb.insertOrIgnore(`
INTO bookmarks (id, account_id, status_id)
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
  AND EXISTS (SELECT 1 FROM bookmarks WHERE id = ?)
`
			)
			.bind(objectId, actorId, id),
	])
	assertBatchSuccess(results)
	await refreshRemoteObjectInteractionCount(db, objectId)
}

export async function deleteBookmark(db: Database, actor: Pick<Actor, 'id'>, obj: Pick<ApObject, 'id'>) {
	const actorId = actor.id.toString()
	const objectId = obj.id.toString()

	const results = await db.batch([
		db
			.prepare(
				`
UPDATE objects
SET interaction_count = MAX(0, interaction_count - 1)
WHERE id = ?
  AND local = 0
  AND EXISTS (SELECT 1 FROM users WHERE users.actor_id = ?)
  AND EXISTS (SELECT 1 FROM bookmarks WHERE account_id = ? AND status_id = ?)
`
			)
			.bind(objectId, actorId, actorId, objectId),
		db.prepare(`DELETE FROM bookmarks WHERE account_id = ? AND status_id = ?`).bind(actorId, objectId),
	])
	assertBatchSuccess(results)
	await refreshRemoteObjectInteractionCount(db, objectId)
}

export function getBookmarkedObjectIds(
	db: Database,
	actor: Actor,
	{ limit, maxId }: { limit: number; maxId?: string }
): Promise<Array<string>> {
	const statement = db
		.prepare(
			`
SELECT status_id
FROM bookmarks
INNER JOIN objects ON objects.id = bookmarks.status_id
WHERE bookmarks.account_id = ?
  AND (? IS NULL OR objects.mastodon_id < ?)
ORDER BY objects.mastodon_id DESC
LIMIT ?
`
		)
		.bind(actor.id.toString(), maxId ?? null, maxId ?? null, limit)

	return getResultsField(statement, 'status_id')
}
