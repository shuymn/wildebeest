import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { type ApObject } from '@wildebeest/backend/activitypub/objects'
import { type Database } from '@wildebeest/backend/database'
import { toMastodonStatusFromRow } from '@wildebeest/backend/mastodon/status'
import type { MastodonStatus } from '@wildebeest/backend/types/status'

import { assertBatchSuccess } from './utils'

export async function insertReply(
	db: Database,
	actor: Pick<Actor, 'id'>,
	obj: Pick<ApObject, 'id'>,
	inReplyToObj: Pick<ApObject, 'id'>
): Promise<void> {
	const id = crypto.randomUUID()
	const objectId = obj.id.toString()
	const inReplyToObjectId = inReplyToObj.id.toString()
	const oldReply = await db
		.prepare(`SELECT in_reply_to_id FROM objects WHERE id = ? AND in_reply_to_id IS NOT NULL`)
		.bind(objectId)
		.first<{ in_reply_to_id: string }>()

	const results = await db.batch([
		db
			.prepare(
				`
UPDATE actor_replies
SET actor_id = ?, in_reply_to_object_id = ?
WHERE object_id = ?
`
			)
			.bind(actor.id.toString(), inReplyToObjectId, objectId),
		db
			.prepare(
				`
INSERT INTO actor_replies (id, actor_id, object_id, in_reply_to_object_id)
SELECT ?, ?, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM actor_replies WHERE object_id = ?)
`
			)
			.bind(id.toString(), actor.id.toString(), objectId, inReplyToObjectId, objectId),
		db
			.prepare(
				`UPDATE objects
SET in_reply_to_id = ?,
    in_reply_to_account_id = (SELECT original_actor_id FROM objects AS parent WHERE parent.id = ?)
WHERE id = ?`
			)
			.bind(inReplyToObjectId, inReplyToObjectId, objectId),
		db
			.prepare(
				`
UPDATE objects
SET replies_count = (
  SELECT COUNT(*) FROM objects AS reply WHERE reply.in_reply_to_id = ?
)
WHERE id = ?
`
			)
			.bind(inReplyToObjectId, inReplyToObjectId),
		...(oldReply && oldReply.in_reply_to_id !== inReplyToObjectId
			? [
					db
						.prepare(
							`
UPDATE objects
SET replies_count = (
  SELECT COUNT(*) FROM objects AS reply WHERE reply.in_reply_to_id = ?
)
WHERE id = ?
`
						)
						.bind(oldReply.in_reply_to_id, oldReply.in_reply_to_id),
				]
			: []),
	])
	assertBatchSuccess(results)
}

export async function getReplies(domain: string, db: Database, obj: ApObject): Promise<Array<MastodonStatus>> {
	const QUERY = `
SELECT
  objects.id,
  objects.mastodon_id,
  objects.cdate,
  objects.properties,

  actors.id as actor_id,
  actors.mastodon_id as actor_mastodon_id,
  actors.type as actor_type,
  actors.properties as actor_properties,
  actors.cdate as actor_cdate,

  outbox_objects.actor_id as publisher_actor_id,
  outbox_objects.published_date as publisher_published,
  outbox_objects.'to' as publisher_to,
  outbox_objects.cc as publisher_cc,

  (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
  COALESCE(objects.reblogs_count, 0) as reblogs_count,
  COALESCE(objects.replies_count, 0) as replies_count
FROM outbox_objects
  INNER JOIN objects ON objects.id = outbox_objects.object_id
  INNER JOIN actors ON actors.id = objects.original_actor_id
WHERE
  objects.type = 'Note'
  AND objects.in_reply_to_id = ?1
  AND outbox_objects.actor_id = objects.original_actor_id
  AND (EXISTS(SELECT 1 FROM json_each(outbox_objects.'to') WHERE json_each.value IN ${db.qb.set('?3')})
        OR EXISTS(SELECT 1 FROM json_each(outbox_objects.cc) WHERE json_each.value IN ${db.qb.set('?3')}))
ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
LIMIT ?2
`
	const DEFAULT_LIMIT = 20

	// TODO: use connectedActor for ?3
	const { success, error, results } = await db
		.prepare(QUERY)
		.bind(obj.id.toString(), DEFAULT_LIMIT, JSON.stringify([PUBLIC_GROUP]))
		.all<{
			id: string
			mastodon_id: string
			cdate: string
			properties: string

			actor_id: string
			actor_mastodon_id: string
			actor_type: Actor['type']
			actor_properties: string
			actor_cdate: string

			publisher_actor_id: string
			publisher_published: string
			publisher_to: string
			publisher_cc: string

			favourites_count: number
			reblogs_count: number
			replies_count: number
		}>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	if (!results) {
		return []
	}

	const out: Array<MastodonStatus> = []

	for (const result of results) {
		const status = await toMastodonStatusFromRow(domain, db, { ...result, reblog_id: null })
		if (status !== null) {
			out.push(status)
		}
	}

	return out
}
