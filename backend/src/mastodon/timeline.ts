import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors/'
import type { Cache } from 'wildebeest/backend/src/cache'
import { type Database } from 'wildebeest/backend/src/database'
import { toMastodonStatusFromRow } from 'wildebeest/backend/src/mastodon/status'
import { MastodonId } from 'wildebeest/backend/src/types'
import type { MastodonStatus } from 'wildebeest/backend/src/types/status'

export async function pregenerateTimelines(domain: string, db: Database, cache: Cache, actor: Actor) {
	const timeline = await getHomeTimeline(domain, db, actor)
	await cache.put(actor.id + '/timeline/home', timeline)
}

export async function getHomeTimeline(domain: string, db: Database, actor: Actor): Promise<Array<MastodonStatus>> {
	const { results: q1Results } = await db
		.prepare(
			`
SELECT
	actor_following.target_actor_id AS following_id,
  json_extract(actors.properties, '$.followers') AS actor_followers_url
FROM
	actor_following
	INNER JOIN actors ON actors.id = actor_following.target_actor_id
WHERE
	actor_following.actor_id = ?1
	AND actor_following.state = 'accepted'
        `
		)
		.bind(actor.id.toString())
		.all<{ following_id: string; actor_followers_url: string | null }>()

	// follow ourself to see our statuses in the our home timeline
	const followingIds = new Set<string>([actor.id.toString()])
	// show direct messages in the home timeline
	const followingFollowersURLs = new Set<string>([PUBLIC_GROUP, actor.followers.toString(), actor.id.toString()])

	if (q1Results) {
		for (const result of q1Results) {
			followingIds.add(result.following_id)
			if (result.actor_followers_url) {
				followingFollowersURLs.add(result.actor_followers_url)
			} else {
				// We don't have the Actor's followers URL stored, we'll guess
				// one.
				followingFollowersURLs.add(actor.id + '/followers')
			}
		}
	}

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
  (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count,

  (SELECT count(*) > 0 FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id AND actor_reblogs.actor_id=?1) as reblogged,
  (SELECT count(*) > 0 FROM actor_favourites WHERE actor_favourites.object_id=objects.id AND actor_favourites.actor_id=?1) as favourited,

  actor_reblogs.id as reblog_id,
  actor_reblogs.mastodon_id as reblog_mastodon_id
FROM outbox_objects
  INNER JOIN objects ON objects.id = outbox_objects.object_id
  INNER JOIN actors ON actors.id = outbox_objects.actor_id
  LEFT OUTER JOIN actor_reblogs ON actor_reblogs.outbox_object_id = outbox_objects.id
WHERE
  objects.type = 'Note'
  AND outbox_objects.actor_id IN ${db.qb.set('?2')}
  AND (${db.qb.jsonExtractIsNull('objects.properties', 'inReplyTo')}
        OR ${db.qb.jsonExtract('objects.properties', 'inReplyTo')}
          IN (SELECT ifnull(objects.original_object_id, objects.id)
            FROM objects WHERE objects.original_actor_id IN ${db.qb.set('?2')}))
  AND (EXISTS(SELECT 1 FROM json_each(outbox_objects.'to') WHERE json_each.value IN ${db.qb.set('?3')})
        OR EXISTS(SELECT 1 FROM json_each(outbox_objects.cc) WHERE json_each.value IN ${db.qb.set('?3')}))
ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
LIMIT ?4
`
	const DEFAULT_LIMIT = 20

	const {
		success,
		error,
		results: q2Results,
	} = await db
		.prepare(QUERY)
		.bind(
			actor.id.toString(),
			JSON.stringify([...followingIds]),
			JSON.stringify([...followingFollowersURLs]),
			DEFAULT_LIMIT
		)
		.all<
			{
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

				reblogged: 1 | 0
				favourited: 1 | 0
			} & ({ reblog_id: string; reblog_mastodon_id: string } | { reblog_id: null; reblog_mastodon_id: null })
		>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	if (!q2Results) {
		return []
	}

	const out: Array<MastodonStatus> = []

	for (const result of q2Results) {
		const status = await toMastodonStatusFromRow(domain, db, result)
		if (status !== null) {
			out.push(status)
		}
	}

	return out
}

export enum LocalPreference {
	NotSet,
	OnlyLocal,
	OnlyRemote,
}

function localPreferenceQuery(preference: LocalPreference): string {
	switch (preference) {
		case LocalPreference.NotSet:
			return 'true'
		case LocalPreference.OnlyLocal:
			return 'objects.local = 1'
		case LocalPreference.OnlyRemote:
			return 'objects.local = 0'
	}
}

export async function getPublicTimeline(
	domain: string,
	db: Database,
	localPreference: LocalPreference,
	onlyMedia: boolean,
	limit: number,
	maxId?: string,
	minId?: string,
	hashtag?: string
): Promise<Array<MastodonStatus>> {
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
  (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count,

  actor_reblogs.id as reblog_id,
  actor_reblogs.mastodon_id as reblog_mastodon_id
FROM outbox_objects
  INNER JOIN objects ON objects.id=outbox_objects.object_id
  INNER JOIN actors ON actors.id=outbox_objects.actor_id
  LEFT JOIN note_hashtags ON objects.id=note_hashtags.object_id
  LEFT OUTER JOIN actor_reblogs ON actor_reblogs.outbox_object_id = outbox_objects.id
WHERE
  objects.type='Note'
  AND ${localPreferenceQuery(localPreference)}
  AND ${db.qb.jsonExtractIsNull('objects.properties', 'inReplyTo')}
  AND EXISTS(SELECT 1 FROM json_each(outbox_objects.'to') WHERE json_each.value = '${PUBLIC_GROUP}')
  AND ${db.qb.timeNormalize('outbox_objects.cdate')} ${maxId ? '<' : '>'} ?2
  ${maxId && minId ? 'AND ' + db.qb.timeNormalize('outbox_objects.cdate') + ' > ?3' : ''}
  ${hashtag ? 'AND note_hashtags.value = ' + (maxId && minId ? '?4' : '?3') : ''}
  ${onlyMedia ? `AND ${db.qb.jsonArrayLength(db.qb.jsonExtract('objects.properties', 'attachment'))} != 0` : ''}
GROUP BY outbox_objects.id
ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
LIMIT ?1
`
	const bindings: [number, ...string[]] = [limit]
	if (maxId) {
		bindings.push(maxId)
		if (minId) {
			bindings.push(minId)
		}
		if (hashtag) {
			bindings.push(hashtag)
		}
	} else if (minId) {
		bindings.push(minId)
		if (hashtag) {
			bindings.push(hashtag)
		}
	} else {
		bindings.push(db.qb.epoch())
		if (hashtag) {
			bindings.push(hashtag)
		}
	}

	const { success, error, results } = await db
		.prepare(QUERY)
		.bind(...bindings)
		.all<
			{
				mastodon_id: string
				id: string
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
			} & ({ reblog_id: string; reblog_mastodon_id: string } | { reblog_id: null })
		>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	if (!results) {
		return []
	}

	const out: Array<MastodonStatus> = []

	for (const result of results) {
		const status = await toMastodonStatusFromRow(domain, db, result)
		if (status !== null) {
			out.push(status)
		}
	}

	return out
}

export async function getStatusRange(
	db: Database,
	maxId?: MastodonId,
	minId?: MastodonId
): Promise<[max: string | null, min: string | null]> {
	const QUERY = `
SELECT outbox_objects.cdate
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
WHERE objects.mastodon_id = ?1
  `
	if (maxId) {
		const { results } = await db.prepare(QUERY).bind(maxId).all<{ cdate: string }>()
		if (results === undefined || results.length === 0) {
			return [null, null]
		}
		const [{ cdate: max }] = results

		if (minId) {
			const { results } = await db.prepare(QUERY).bind(minId).all<{ cdate: string }>()
			if (results === undefined || results.length === 0) {
				return [null, null]
			}
			const [{ cdate: min }] = results
			return [max, min]
		}
		return [max, null]
	}
	if (minId) {
		const { results } = await db.prepare(QUERY).bind(minId).all<{ cdate: string }>()
		if (results === undefined || results.length === 0) {
			return [null, null]
		}
		const [{ cdate: min }] = results
		return [null, min]
	}
	return [null, null]
}
