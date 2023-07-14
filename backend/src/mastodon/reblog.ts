// Also known as boost.

import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'

import { addObjectInOutbox } from '../activitypub/actors/outbox'
import { getResultsField } from './utils'

/**
 * Creates a reblog and inserts it in the reblog author's outbox
 *
 * @param db Database
 * @param actor Reblogger
 * @param obj ActivityPub object to reblog
 */
export async function createReblog(db: Database, actor: Actor, obj: ApObject) {
	await Promise.all([addObjectInOutbox(db, actor, obj), insertReblog(db, actor, obj)])
}

export async function insertReblog(db: Database, actor: Actor, obj: ApObject) {
	const id = crypto.randomUUID()

	const query = `
		INSERT INTO actor_reblogs (id, actor_id, object_id)
		VALUES (?, ?, ?)
	`

	const out = await db.prepare(query).bind(id, actor.id.toString(), obj.id.toString()).run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export function getReblogs(db: Database, obj: ApObject): Promise<Array<string>> {
	const query = `
		SELECT actor_id FROM actor_reblogs WHERE object_id=?
	`

	const statement = db.prepare(query).bind(obj.id.toString())

	return getResultsField(statement, 'actor_id')
}

export async function hasReblog(db: Database, actor: Actor, obj: ApObject): Promise<boolean> {
	const query = `
		SELECT count(*) as count FROM actor_reblogs WHERE object_id=?1 AND actor_id=?2
	`

	const { count } = await db.prepare(query).bind(obj.id.toString(), actor.id.toString()).first<{ count: number }>()
	return count > 0
}
