import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { ApObject } from 'wildebeest/backend/src/activitypub/objects'
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
SELECT objects.*,
       actors.id as actor_id,
       actors.type as actor_type,
       actors.pubkey as actor_pubkey,
       actors.cdate as actor_cdate,
       actors.properties as actor_properties,
       actors.is_admin as actor_is_admin,
       actors.mastodon_id as actor_mastodon_id,
       actor_replies.actor_id as publisher_actor_id,
       (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
       (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
       (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count
FROM actor_replies
INNER JOIN objects ON objects.id=actor_replies.object_id
INNER JOIN actors ON actors.id=actor_replies.actor_id
WHERE actor_replies.in_reply_to_object_id=?
ORDER by actor_replies.cdate DESC
LIMIT ?
`
	const DEFAULT_LIMIT = 20

	const { success, error, results } = await db.prepare(QUERY).bind(obj.id.toString(), DEFAULT_LIMIT).all<{
		mastodon_id: string
		id: string
		cdate: string
		properties: string
		actor_id: string
		actor_type: Actor['type']
		actor_pubkey: string | null
		actor_cdate: string
		actor_properties: string
		actor_is_admin: 1 | null
		actor_mastodon_id: string
		publisher_actor_id: string
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

	for (let i = 0, len = results.length; i < len; i++) {
		const status = await toMastodonStatusFromRow(domain, db, results[i])
		if (status !== null) {
			out.push(status)
		}
	}

	return out
}
