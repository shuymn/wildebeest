import type { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import {
	ensureObjectMastodonId,
	mastodonIdSymbol,
	originalActorIdSymbol,
	originalObjectIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'

export async function insertKey(db: Database, key: string, obj: ApObject): Promise<void> {
	const query = `
        INSERT INTO idempotency_keys (key, object_id, expires_at)
        VALUES (?1, ?2, datetime('now', '+1 hour'))
    `

	const { success, error } = await db.prepare(query).bind(key, obj.id.toString()).run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function hasKey<T extends ApObject>(db: Database, key: string) {
	const query = `
        SELECT objects.*
        FROM idempotency_keys
        INNER JOIN objects ON objects.id = idempotency_keys.object_id
        WHERE idempotency_keys.key = ?1 AND expires_at >= datetime() 
    `

	const { results, success, error } = await db.prepare(query).bind(key).all<{
		properties: string | object
		cdate: string
		type: ApObject['type']
		id: string
		mastodon_id: string
		original_actor_id: string | null
		original_object_id: string | null
	}>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}

	if (!results || results.length === 0) {
		return null
	}

	const [result] = results
	let properties
	if (typeof result.properties === 'object') {
		// neon uses JSONB for properties which is returned as a deserialized
		// object.
		properties = result.properties as T
	} else {
		// D1 uses a string for JSON properties
		properties = JSON.parse(result.properties) as T
	}

	return {
		published: new Date(result.cdate).toISOString(),
		...properties,

		type: result.type,
		id: new URL(result.id),

		[mastodonIdSymbol]: await ensureObjectMastodonId(db, result.mastodon_id, result.cdate),
		[originalActorIdSymbol]: result.original_actor_id,
		[originalObjectIdSymbol]: result.original_object_id,
	}
}
