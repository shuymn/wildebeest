// https://docs.joinmastodon.org/methods/accounts/#statuses

import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { Actor, getActorByMastodonId } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { toMastodonStatusesFromRowsWithActor } from 'wildebeest/backend/src/mastodon/status'
import type { MastodonId } from 'wildebeest/backend/src/types'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import { boolParam, numberParam } from 'wildebeest/backend/src/utils'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { Override } from 'wildebeest/backend/src/utils/type'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = {
	domain: string
	db: Database
}

type Parameters = {
	// return results older than this ID
	maxId?: string
	// return results newer than this ID
	sinceId?: string
	// return results immediately newer than this ID
	minId?: string
	// maximim number of results to return
	// defaults to 20 statuses. max 40 statuses
	limit: number
	// filter out statuses without attachments
	onlyMedia?: boolean
	// filter out statuses in reply to a different account
	excludeReplies: boolean
	// filter out boosts from the response
	excludeReblogs?: boolean
	// filter for pinned statuses only. defaults to false,
	// which includes all statuses. pinned statuses do not receive
	// special priority in the order of the returned results
	pinned?: boolean
	// filter for statuses using a specific hashtag
	tagged?: string
}

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ request, env, params: { id } }) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	const url = new URL(request.url)
	return handleRequest({ domain: url.hostname, db: await getDatabase(env) }, id, {
		maxId: url.searchParams.get('max_id'),
		sinceId: url.searchParams.get('since_id'),
		minId: url.searchParams.get('min_id'),
		limit: url.searchParams.get('limit'),
		onlyMedia: url.searchParams.get('only_media'),
		excludeReplies: url.searchParams.get('exclude_replies'),
		excludeReblogs: url.searchParams.get('exclude_reblogs'),
		pinned: url.searchParams.get('pinned'),
		tagged: url.searchParams.get('tagged'),
	})
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 40

export async function handleRequest(
	{ domain, db }: Dependencies,
	id: MastodonId,
	params: Override<Required<Parameters>, string | null>
): Promise<Response> {
	const actor = await getActorByMastodonId(db, id)
	if (actor) {
		return await getStatuses(domain, db, actor, {
			maxId: params.maxId ?? undefined,
			sinceId: params.sinceId ?? undefined,
			minId: params.minId ?? undefined,
			limit: numberParam(params.limit, DEFAULT_LIMIT, { maxValue: MAX_LIMIT }),
			onlyMedia: boolParam(params.onlyMedia, false),
			excludeReplies: boolParam(params.excludeReplies, false),
			excludeReblogs: boolParam(params.excludeReblogs, false),
			pinned: boolParam(params.pinned, false),
			tagged: params.tagged ?? undefined,
		})
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
	const CDATE_QUERY = 'SELECT cdate FROM outbox_objects WHERE object_id=?'
	let cdate: string = db.qb.epoch()
	let since: string | null = null
	if (params.maxId) {
		const { results } = await db.prepare(CDATE_QUERY).bind(params.maxId).all<{ cdate: string }>()
		if (results === undefined || results.length === 0) {
			return resourceNotFound('max_id', params.maxId)
		}
		cdate = results[0].cdate
		if (params.sinceId) {
			const { results } = await db.prepare(CDATE_QUERY).bind(params.sinceId).all<{ cdate: string }>()
			if (results === undefined || results.length === 0) {
				return resourceNotFound('since_id', params.sinceId)
			}
			since = results[0].cdate
		}
	} else if (params.minId) {
		const { results } = await db.prepare(CDATE_QUERY).bind(params.minId).all<{ cdate: string }>()
		if (results === undefined || results.length === 0) {
			return resourceNotFound('min_id', params.minId)
		}
		cdate = results[0].cdate
	}

	const { success, error, results } = await db
		.prepare(
			`
SELECt
  objects.*,
  outbox_objects.actor_id as publisher_actor_id,
  (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
  (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
  (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
WHERE
  objects.type = 'Note'
  ${params.excludeReplies ? 'AND ' + db.qb.jsonExtractIsNull('objects.properties', 'inReplyTo') : ''}
  AND outbox_objects.target = '${PUBLIC_GROUP}'
  AND outbox_objects.actor_id = ?1
  AND ${db.qb.timeNormalize('outbox_objects.cdate')} ${params.maxId ? '<' : '>'} ?2
  ${params.maxId && since ? 'AND ' + db.qb.timeNormalize('outbox_objects.cdate') + ' > ?4' : ''}
ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
LIMIT ?3
  `
		)
		.bind(
			...(params.maxId && since
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
