// Also known as boost.

import { AnnounceActivity, PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database } from 'wildebeest/backend/src/database'
import { MastodonId } from 'wildebeest/backend/src/types'
import { isUUID } from 'wildebeest/backend/src/utils'
import { generateMastodonId } from 'wildebeest/backend/src/utils/id'

import { addObjectInOutbox } from '../activitypub/actors/outbox'
import { getResultsField } from './utils'

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
) {
	const outboxObjectId = await addObjectInOutbox(
		db,
		actor,
		obj,
		activity.to ?? obj.to,
		activity.cc ?? obj.cc,
		published
	)
	await insertReblog(db, actor, obj, activity.id.toString(), outboxObjectId)
}

async function insertReblog(db: Database, actor: Actor, obj: Note, activityId: string, outboxObjectId: string) {
	const query = `
		INSERT INTO actor_reblogs (id, actor_id, object_id, outbox_object_id, mastodon_id)
		VALUES (?, ?, ?, ?, ?)
	`

	const out = await db
		.prepare(query)
		.bind(
			activityId,
			actor.id.toString(),
			obj.id.toString(),
			outboxObjectId,
			await generateMastodonId(db, 'actor_reblogs', new Date())
		)
		.run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}

export function getReblogs(db: Database, obj: Note): Promise<Array<string>> {
	const query = `
		SELECT actor_id FROM actor_reblogs WHERE object_id=?
	`

	const statement = db.prepare(query).bind(obj.id.toString())

	return getResultsField(statement, 'actor_id')
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

export function reblogNotAllowed(actor: Actor, note: Note, activity: AnnounceActivity): boolean {
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
