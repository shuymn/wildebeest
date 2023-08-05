import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { type ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'
import { toMastodonStatusFromRow } from 'wildebeest/backend/src/mastodon/status'
import type { MastodonStatus } from 'wildebeest/backend/src/types/status'

export async function insertReply(db: Database, actor: Actor, obj: ApObject, inReplyToObj: ApObject) {
	const id = crypto.randomUUID()
	const query = `
        INSERT INTO actor_replies (id, actor_id, object_id, in_reply_to_object_id)
        VALUES (?, ?, ?, ?)
    `
	const { success, error } = await db
		.prepare(query)
		.bind(id, actor.id.toString(), obj.id.toString(), inReplyToObj.id.toString())
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
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
  (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
  (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count
FROM outbox_objects
  INNER JOIN actor_replies ON actor_replies.object_id = outbox_objects.object_id
  INNER JOIN objects ON objects.id = actor_replies.object_id
  INNER JOIN actors ON actors.id = actor_replies.actor_id
WHERE
  objects.type = 'Note'
  AND actor_replies.in_reply_to_object_id = ?1
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
