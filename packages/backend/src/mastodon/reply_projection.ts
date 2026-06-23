import type { Database } from '@wildebeest/backend/database'
import { insertReply } from '@wildebeest/backend/mastodon/reply'

export async function repairReplyProjection(
	db: Database,
	actorId: string | URL,
	objectId: string | URL,
	inReplyToObjectId: string | URL
): Promise<void> {
	await insertReply(db, { id: new URL(actorId) }, { id: new URL(objectId) }, { id: new URL(inReplyToObjectId) }).catch(
		(err) => {
			console.warn('failed to repair reply: ' + err)
		}
	)
}

export async function getReplyParentId(db: Database, objectId: string): Promise<string | null> {
	const reply = await db
		.prepare(`SELECT in_reply_to_id FROM objects WHERE id = ? AND in_reply_to_id IS NOT NULL`)
		.bind(objectId)
		.first<{ in_reply_to_id: string }>()
	return reply?.in_reply_to_id ?? null
}

export function deleteObjectProjectionStatements(db: Database, objectId: string): D1PreparedStatement[] {
	return [
		db.prepare('DELETE FROM outbox_objects WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM inbox_objects WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM actor_notifications WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM actor_favourites WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM actor_reblogs WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM bookmarks WHERE status_id=?').bind(objectId),
		db
			.prepare(`UPDATE objects SET in_reply_to_id = NULL, in_reply_to_account_id = NULL WHERE in_reply_to_id = ?`)
			.bind(objectId),
		db.prepare('DELETE FROM actor_replies WHERE object_id=?1 OR in_reply_to_object_id=?1').bind(objectId),
		db.prepare('DELETE FROM idempotency_keys WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM note_hashtags WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM object_revisions WHERE object_id=?').bind(objectId),
		db.prepare('DELETE FROM objects WHERE id=?').bind(objectId),
	]
}

export async function refreshRepliesCount(db: Database, objectId: string): Promise<void> {
	const { success, error } = await db
		.prepare(
			`UPDATE objects
SET replies_count = (SELECT COUNT(*) FROM objects AS replies WHERE replies.in_reply_to_id = ?)
WHERE id = ?`
		)
		.bind(objectId, objectId)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}
