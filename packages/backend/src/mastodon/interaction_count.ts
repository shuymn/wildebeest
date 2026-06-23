import type { Database } from '@wildebeest/backend/database'

export async function refreshRemoteObjectInteractionCount(db: Database, objectId: string): Promise<void> {
	const { success, error } = await db
		.prepare(
			`
UPDATE objects
SET interaction_count = ${remoteInteractionCountSql()}
WHERE id = ?
  AND local = 0
`
		)
		.bind(objectId, objectId, objectId, objectId)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function refreshReblogAndRemoteInteractionCounts(db: Database, objectId: string): Promise<void> {
	const { success, error } = await db
		.prepare(
			`
UPDATE objects
SET reblogs_count = (SELECT COUNT(*) FROM actor_reblogs WHERE object_id = ?),
    interaction_count = CASE
      WHEN local = 0 THEN ${remoteInteractionCountSql()}
      ELSE interaction_count
    END
WHERE id = ?
`
		)
		.bind(objectId, objectId, objectId, objectId, objectId)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

function remoteInteractionCountSql(): string {
	return `
        (SELECT COUNT(*) FROM actor_reblogs INNER JOIN users ON users.actor_id = actor_reblogs.actor_id WHERE actor_reblogs.object_id = ?)
        + (SELECT COUNT(*) FROM actor_favourites INNER JOIN users ON users.actor_id = actor_favourites.actor_id WHERE actor_favourites.object_id = ?)
        + (SELECT COUNT(*) FROM bookmarks INNER JOIN users ON users.actor_id = bookmarks.account_id WHERE bookmarks.status_id = ?)
`
}
