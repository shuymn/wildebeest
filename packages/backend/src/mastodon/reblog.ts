// Also known as boost.

import { AnnounceActivity, PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { addObjectInOutbox } from '@wildebeest/backend/activitypub/actors/outbox'
import { getApId, originalObjectIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { Note } from '@wildebeest/backend/activitypub/objects/note'
import { type Database } from '@wildebeest/backend/database'
import { MastodonId } from '@wildebeest/backend/types'
import { isUUID } from '@wildebeest/backend/utils'
import { generateMastodonId } from '@wildebeest/backend/utils/id'

import { refreshReblogAndRemoteInteractionCounts } from './interaction_count'
import { assertBatchSuccess, getResultsField } from './utils'

/**
 * Creates a reblog and inserts it in the reblog author's outbox
 *
 * @param db Database
 * @param actor Reblogger
 * @param obj ActivityPub object to reblog
 */
export async function createReblog(
	db: Database,
	actor: Actor,
	obj: Note,
	activity: Pick<AnnounceActivity, 'id' | 'to' | 'cc'>,
	published?: string
): Promise<boolean> {
	const [outboxObjectId, mastodonId] = await Promise.all([
		addObjectInOutbox(db, actor, obj, activity.to ?? obj.to, activity.cc ?? obj.cc, published),
		generateMastodonId(db, 'actor_reblogs', new Date()),
	])
	const inserted = await insertReblog(db, actor, obj, activity.id.toString(), outboxObjectId, mastodonId)
	if (!inserted) {
		const results = await db.batch([
			db.prepare(`DELETE FROM outbox_objects WHERE id = ?`).bind(outboxObjectId),
			db.prepare(`DELETE FROM actor_activities WHERE json_extract(activity, '$.id') = ?`).bind(activity.id.toString()),
		])
		assertBatchSuccess(results)
	}
	return inserted
}

async function insertReblog(
	db: Database,
	actor: Pick<Actor, 'id'>,
	obj: Pick<Note, 'id'>,
	activityId: string,
	outboxObjectId: string,
	mastodonId: MastodonId
): Promise<boolean> {
	const actorId = actor.id.toString()
	const objectId = obj.id.toString()
	const insert = await db
		.prepare(
			db.qb.insertOrIgnore(`
INTO actor_reblogs (id, actor_id, object_id, outbox_object_id, mastodon_id)
VALUES (?, ?, ?, ?, ?)
`)
		)
		.bind(activityId, actorId, objectId, outboxObjectId, mastodonId)
		.run()
	if (!insert.success) {
		throw new Error('SQL error: ' + insert.error)
	}
	await refreshReblogAndRemoteInteractionCounts(db, objectId)
	return insert.meta.changes === 1
}

export function getReblogs(db: Database, obj: Note): Promise<Array<string>> {
	const query = `
		SELECT actor_id FROM actor_reblogs WHERE object_id=?
	`

	const statement = db.prepare(query).bind(obj.id.toString())

	return getResultsField(statement, 'actor_id')
}

export async function getReblogActivity(
	db: Database,
	actor: Pick<Actor, 'id'>,
	obj: Note
): Promise<AnnounceActivity | null> {
	const row = await db
		.prepare(
			`
SELECT actor_reblogs.id, outbox_objects.published_date, outbox_objects.'to', outbox_objects.cc
FROM actor_reblogs
LEFT JOIN outbox_objects ON outbox_objects.id = actor_reblogs.outbox_object_id
WHERE actor_reblogs.actor_id = ? AND actor_reblogs.object_id = ?
`
		)
		.bind(actor.id.toString(), obj.id.toString())
		.first<{ id: string; published_date: string | null; to: string | null; cc: string | null }>()

	if (!row) {
		return null
	}

	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: row.id,
		type: 'Announce',
		actor: actor.id,
		object: new URL(obj[originalObjectIdSymbol] ?? obj.id.toString()),
		to: JSON.parse(row.to ?? '[]'),
		cc: JSON.parse(row.cc ?? '[]'),
		...(row.published_date ? { published: row.published_date } : {}),
	}
}

export async function deleteReblog(db: Database, actor: Pick<Actor, 'id'>, obj: Pick<Note, 'id'>): Promise<boolean> {
	return deleteReblogWhere(db, actor.id.toString(), 'object_id = ?', obj.id.toString())
}

export async function deleteReblogByActivityId(
	db: Database,
	actor: Pick<Actor, 'id'>,
	activityId: URL
): Promise<boolean> {
	return deleteReblogWhere(db, actor.id.toString(), 'id = ?', activityId.toString())
}

async function deleteReblogWhere(db: Database, actorId: string, condition: string, value: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT object_id FROM actor_reblogs WHERE actor_id = ? AND ${condition}`)
		.bind(actorId, value)
		.first<{ object_id: string }>()
	if (!row) {
		return false
	}

	const objectId = row.object_id
	const results = await db.batch([
		db
			.prepare(
				`DELETE FROM outbox_objects
WHERE id = (SELECT outbox_object_id FROM actor_reblogs WHERE actor_id = ? AND ${condition})`
			)
			.bind(actorId, value),
		db.prepare(`DELETE FROM actor_reblogs WHERE actor_id = ? AND ${condition}`).bind(actorId, value),
	])
	assertBatchSuccess(results)
	await refreshReblogAndRemoteInteractionCounts(db, objectId)
	return true
}

export async function hasReblog(db: Database, actor: Actor, obj: Note): Promise<boolean> {
	const query = `
		SELECT count(*) as count FROM actor_reblogs WHERE object_id=?1 AND actor_id=?2
	`

	const { count } = await db
		.prepare(query)
		.bind(obj.id.toString(), actor.id.toString())
		.first<{ count: number }>()
		.then((row) => {
			if (!row) {
				throw new Error('row is undefined')
			}
			return row
		})
	return count > 0
}

export function reblogNotAllowed(
	actor: Pick<Actor, 'id' | 'followers'>,
	note: Pick<Note, 'to' | 'cc' | 'attributedTo'>,
	activity: AnnounceActivity
): boolean {
	const noteTo = (Array.isArray(note.to) ? note.to : [note.to]).map((to) => getApId(to).toString())
	const noteCc = (Array.isArray(note.cc) ? note.cc : [note.cc]).map((cc) => getApId(cc).toString())

	if (actor.id.toString() !== note.attributedTo.toString()) {
		// reblogging others' posts is limited only to public or unlisted ones
		return !(noteTo.includes(PUBLIC_GROUP) || noteCc.includes(PUBLIC_GROUP))
	}

	// self reblog

	// public or unlisted status -> allowed all visibility
	if (noteTo.includes(PUBLIC_GROUP) || noteCc.includes(PUBLIC_GROUP)) {
		return false
	}

	const activityTo =
		activity.to === undefined
			? []
			: (Array.isArray(activity.to) ? activity.to : [activity.to]).map((to) => getApId(to).toString())
	const activityCc =
		activity.cc === undefined
			? []
			: (Array.isArray(activity.cc) ? activity.cc : [activity.cc]).map((cc) => getApId(cc).toString())

	// private status -> allowed only private or direct visibility
	if (noteTo.includes(actor.followers.toString())) {
		return activityTo.includes(PUBLIC_GROUP) || activityCc.includes(PUBLIC_GROUP)
	}
	// direct status -> allowed only direct visibility (exact match)
	return !(activityTo.every((to) => noteTo.includes(to)) && activityCc.every((cc) => noteCc.includes(cc)))
}

export async function ensureReblogMastodonId(db: Database, mastodonId: MastodonId, cdate: string): Promise<MastodonId> {
	if (!isUUID(mastodonId)) {
		return mastodonId
	}
	const newMastodonId = await generateMastodonId(db, 'actor_reblogs', new Date(cdate))
	const { success, error } = await db
		.prepare(`UPDATE actor_reblogs SET mastodon_id=?1 WHERE mastodon_id=?2`)
		.bind(newMastodonId, mastodonId)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return newMastodonId
}
