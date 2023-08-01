// https://docs.joinmastodon.org/methods/accounts/#statuses

import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorByMastodonId, Person } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { isFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { toMastodonStatusesFromRowsWithActor } from 'wildebeest/backend/src/mastodon/status'
import { getStatusRange } from 'wildebeest/backend/src/mastodon/timeline'
import type { ContextData, Env, MastodonId } from 'wildebeest/backend/src/types'
import { cors, myz, readParams } from 'wildebeest/backend/src/utils'
import { z } from 'zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const schema = z.object({
	// return results older than this ID
	max_id: z.string().optional(),
	// return results newer than this ID
	since_id: z.string().optional(),
	// return results immediately newer than this ID
	min_id: z.string().optional(),
	// maximum number of results to return
	// defaults to 20 statuses. max 40 statuses
	limit: myz
		.numeric()
		.refine((value) => value >= 1 && value <= 40 && (value | 0) === value)
		.catch(20),
	// filter out statuses without attachments
	only_media: myz.logical().default(false),
	// filter out statuses in reply to a different account
	exclude_replies: myz.logical().default(false),
	// filter out boosts from the response
	exclude_reblogs: myz.logical().default(false),
	// filter for pinned statuses only. defaults to false,
	// which includes all statuses. pinned statuses do not receive
	// special priority in the order of the returned results
	pinned: myz.logical().default(false),
	// filter for statuses using a specific hashtag
	tagged: z.string().optional(),
})

type Dependencies = {
	domain: string
	db: Database
	connectedActor: Person | undefined
}

type Parameters = z.infer<typeof schema>

export const onRequestGet: PagesFunction<Env, 'id', Partial<ContextData>> = async ({
	request,
	env,
	params: { id },
	data,
}) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	const result = await readParams(request, schema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}
	const url = new URL(request.url)
	return handleRequest(
		{ domain: url.hostname, db: await getDatabase(env), connectedActor: data?.connectedActor },
		id,
		result.data
	)
}

export async function handleRequest(deps: Dependencies, id: MastodonId, params: Parameters): Promise<Response> {
	const actor = await getActorByMastodonId(deps.db, id)
	if (actor) {
		return await getStatuses(deps, actor, params)
	}
	return resourceNotFound('id', id)
}

// TODO: support tagged parameter
async function getStatuses(
	{ domain, db, connectedActor }: Dependencies,
	actor: Actor,
	params: Parameters
): Promise<Response> {
	if (params.pinned) {
		// TODO: pinned statuses are not implemented yet. Stub the endpoint
		// to avoid returning statuses that aren't pinned.
		return new Response(JSON.stringify([]), { headers })
	}

	// Client asked to retrieve statuses using max_id or (max_id and since_id) or min_id
	// As opposed to Mastodon we don't use incremental ID but UUID, we need
	// to retrieve the cdate of the xxx_id row and only show the specific statuses.
	const [max, min] = await getStatusRange(db, params.max_id, params.since_id ?? params.min_id)
	if (params.max_id && max === null) {
		return resourceNotFound('max_id', params.max_id)
	}
	if (params.since_id && min === null) {
		return resourceNotFound('since_id', params.since_id)
	}
	if (params.min_id && min === null) {
		return resourceNotFound('min_id', params.min_id)
	}

	const targets = [PUBLIC_GROUP]
	if (connectedActor) {
		targets.push(connectedActor.id.toString())
		if (await isFollowing(db, connectedActor, actor)) {
			targets.push(actor.followers.toString())
		}
	}

	const { success, error, results } = await db
		.prepare(
			`
SELECT
  objects.id,
  objects.mastodon_id,
  objects.cdate,
  objects.properties,

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
  INNER JOIN objects ON objects.id = outbox_objects.object_id
  LEFT OUTER JOIN actor_reblogs ON actor_reblogs.outbox_object_id = outbox_objects.id
WHERE
  objects.type = 'Note'
  AND outbox_objects.actor_id = ?1
  ${params.exclude_replies ? `AND ${db.qb.jsonExtractIsNull('objects.properties', 'inReplyTo')}` : ''}
  AND (EXISTS(SELECT 1 FROM json_each(outbox_objects.'to') WHERE json_each.value IN ${db.qb.set('?2')})
        OR EXISTS(SELECT 1 FROM json_each(outbox_objects.cc) WHERE json_each.value IN ${db.qb.set('?2')}))
  AND ${db.qb.timeNormalize('outbox_objects.cdate')} ${max ? '<' : '>'} ?3
  ${max && min ? 'AND ' + db.qb.timeNormalize('outbox_objects.cdate') + ' > ?5' : ''}
  ${params.exclude_reblogs ? 'AND actor_reblogs.id IS NULL' : ''}
  ${params.only_media ? `AND ${db.qb.jsonArrayLength(db.qb.jsonExtract('objects.properties', 'attachment'))} != 0` : ''}
ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
LIMIT ?4
  `
		)
		.bind(
			...(max && min
				? [actor.id.toString(), JSON.stringify(targets), max, params.limit, min]
				: min
				? [actor.id.toString(), JSON.stringify(targets), max ?? db.qb.epoch(), params.limit, min]
				: [actor.id.toString(), JSON.stringify(targets), max ?? db.qb.epoch(), params.limit])
		)
		.all<{
			id: string
			mastodon_id: string
			cdate: string
			properties: string

			publisher_actor_id: string
			publisher_published: string
			publisher_to: string
			publisher_cc: string

			favourites_count: number
			reblogs_count: number
			replies_count: number

			reblog_id: string | null
			reblog_mastodon_id: string | null
		}>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	if (!results || results.length === 0) {
		return new Response(JSON.stringify([]), { headers })
	}
	const statuses = await toMastodonStatusesFromRowsWithActor(domain, db, actor, results)
	return new Response(JSON.stringify(statuses), { headers })
}
