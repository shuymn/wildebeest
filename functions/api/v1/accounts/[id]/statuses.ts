// https://docs.joinmastodon.org/methods/accounts/#statuses

import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorByMastodonId } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { toMastodonStatusesFromRowsWithActor } from 'wildebeest/backend/src/mastodon/status'
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
}

type Parameters = z.infer<typeof schema>

export const onRequestGet: PagesFunction<Env, 'id', ContextData> = async ({ request, env, params: { id } }) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	const result = await readParams(request, schema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}
	const url = new URL(request.url)
	return handleRequest({ domain: url.hostname, db: await getDatabase(env) }, id, result.data)
}

export async function handleRequest(
	{ domain, db }: Dependencies,
	id: MastodonId,
	params: Parameters
): Promise<Response> {
	const actor = await getActorByMastodonId(db, id)
	if (actor) {
		return await getStatuses(domain, db, actor, params)
	}
	return resourceNotFound('id', id)
}

// TODO: support onlyMedia,excludeReblogs,tagged parameter
async function getStatuses(domain: string, db: Database, actor: Actor, params: Parameters): Promise<Response> {
	if (params.pinned) {
		// TODO: pinned statuses are not implemented yet. Stub the endpoint
		// to avoid returning statuses that aren't pinned.
		return new Response(JSON.stringify([]), { headers })
	}

	// Client asked to retrieve statuses using max_id or (max_id and since_id) or min_id
	// As opposed to Mastodon we don't use incremental ID but UUID, we need
	// to retrieve the cdate of the xxx_id row and only show the specific statuses.
	const CDATE_QUERY = `
SELECT outbox_objects.cdate
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
WHERE objects.mastodon_id = ?1
`
	let cdate: string = db.qb.epoch()
	let since: string | null = null
	if (params.max_id) {
		const { results } = await db.prepare(CDATE_QUERY).bind(params.max_id).all<{ cdate: string }>()
		if (results === undefined || results.length === 0) {
			return resourceNotFound('max_id', params.max_id)
		}
		cdate = results[0].cdate

		const sinceId = params.since_id || params.min_id
		if (sinceId) {
			const { results } = await db.prepare(CDATE_QUERY).bind(sinceId).all<{ cdate: string }>()
			if (results === undefined || results.length === 0) {
				return resourceNotFound(params.since_id ? 'since_id' : 'min_id', sinceId)
			}
			since = results[0].cdate
		}
	} else {
		const minId = params.min_id || params.since_id
		if (minId) {
			const { results } = await db.prepare(CDATE_QUERY).bind(minId).all<{ cdate: string }>()
			if (results === undefined || results.length === 0) {
				return resourceNotFound('min_id', minId)
			}
			cdate = results[0].cdate
		}
	}

	const { success, error, results } = await db
		.prepare(
			`
SELECT
  objects.*,
  outbox_objects.actor_id as publisher_actor_id,
  (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
  (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
  (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
WHERE
  objects.type = 'Note'
  ${params.exclude_replies ? 'AND ' + db.qb.jsonExtractIsNull('objects.properties', 'inReplyTo') : ''}
  AND outbox_objects.target = '${PUBLIC_GROUP}'
  AND outbox_objects.actor_id = ?1
  AND ${db.qb.timeNormalize('outbox_objects.cdate')} ${params.max_id ? '<' : '>'} ?2
  ${params.max_id && since ? 'AND ' + db.qb.timeNormalize('outbox_objects.cdate') + ' > ?4' : ''}
ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
LIMIT ?3
  `
		)
		.bind(
			...(params.max_id && since
				? [actor.id.toString(), cdate, params.limit, since]
				: [actor.id.toString(), cdate, params.limit])
		)
		.all<{
			mastodon_id: string
			id: string
			cdate: string
			properties: string
			publisher_actor_id: string
			favourites_count: number
			reblogs_count: number
			replies_count: number
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
