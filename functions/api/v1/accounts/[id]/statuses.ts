import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import type { Activity } from 'wildebeest/backend/src/activitypub/activities'
import { isAnnounceActivity, isCreateActivity, PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { actorURL } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import * as outbox from 'wildebeest/backend/src/activitypub/actors/outbox'
import * as objects from 'wildebeest/backend/src/activitypub/objects'
import { isNote, type Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { toMastodonStatusFromObject } from 'wildebeest/backend/src/mastodon/status'
import { toMastodonStatusFromRow } from 'wildebeest/backend/src/mastodon/status'
import type { MastodonStatus } from 'wildebeest/backend/src/types'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import { adjustLocalHostDomain } from 'wildebeest/backend/src/utils/adjustLocalHostDomain'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { LocalHandle, parseHandle, RemoteHandle } from 'wildebeest/backend/src/utils/handle'
import * as webfinger from 'wildebeest/backend/src/webfinger'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ request, env, params }) => {
	return handleRequest(request, await getDatabase(env), params.id as string)
}

const DEFAULT_LIMIT = 20

export async function handleRequest(request: Request, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)
	const url = new URL(request.url)
	const domain = url.hostname
	let offset = Number.parseInt(url.searchParams.get('offset') ?? '0')
	if (offset < 0) {
		offset = 0
	}
	let limit = Number.parseInt(url.searchParams.get('limit') ?? '0')
	if (limit < 1 || limit > DEFAULT_LIMIT) {
		limit = DEFAULT_LIMIT
	}

	let withReplies: boolean | null = null
	if (url.searchParams.get('with-replies') !== null) {
		withReplies = url.searchParams.get('with-replies') === 'true'
	}
	let excludeReplies: boolean | null = null
	if (url.searchParams.get('exclude_replies') !== null) {
		excludeReplies = url.searchParams.get('exclude_replies') === 'true'
	}

	if (isLocalAccount(domain, handle)) {
		// Retrieve the statuses from a local user
		return getLocalStatuses(request, db, handle, offset, withReplies ?? excludeReplies ?? false, limit)
	}
	// Retrieve the statuses of a remote actor
	return getRemoteStatuses(request, handle, db, limit)
}

async function getRemoteStatuses(
	request: Request,
	handle: RemoteHandle,
	db: Database,
	limit: number
): Promise<Response> {
	const url = new URL(request.url)
	const domain = url.hostname
	const isPinned = url.searchParams.get('pinned') === 'true'
	if (isPinned) {
		// TODO: pinned statuses are not implemented yet. Stub the endpoint
		// to avoid returning statuses that aren't pinned.
		return new Response(JSON.stringify([]), { headers })
	}

	const link = await webfinger.queryAcctLink(handle)
	if (link === null) {
		console.warn('link is null')
		return new Response('', { status: 404 })
	}

	const actor = await actors.getAndCache(link, db)

	const activities = await outbox.get(actor, limit)

	// TODO: use account
	// eslint-disable-next-line unused-imports/no-unused-vars
	// const account = await loadExternalMastodonAccount(acct, actor)

	const promises = activities.items.map(async (activity: Activity) => {
		const actorId = objects.getApId(activity.actor)
		const objectId = objects.getApId(activity.object)

		if (isCreateActivity(activity)) {
			const res = await objects.cacheObject(domain, db, activity.object, actorId, objectId, false)
			return toMastodonStatusFromObject(db, res.object as Note, domain)
		}
		if (isAnnounceActivity(activity)) {
			let obj: objects.ApObject

			const localObject = await objects.getObjectById(db, objectId)
			if (localObject === null) {
				try {
					// Object doesn't exists locally, we'll need to download it.
					const remoteObject = await objects.get<Note>(objectId)

					const res = await objects.cacheObject(domain, db, remoteObject, actorId, objectId, false)
					if (res === null) {
						return null
					}
					obj = res.object
				} catch (err: any) {
					console.warn(`failed to retrieve object ${objectId}: ${err.message}`)
					return null
				}
			} else {
				// Object already exists locally, we can just use it.
				obj = localObject
			}
			if (!isNote(obj)) {
				console.warn('object type is not "Note"', obj.type)
				return null
			}

			return toMastodonStatusFromObject(db, obj, domain)
		}

		// FIXME: support other Activities, like Update.
		console.warn(`unsupported activity type: ${activity.type}`)
	})
	const statuses = (await Promise.all(promises)).filter(Boolean)

	return new Response(JSON.stringify(statuses), { headers })
}

export async function getLocalStatuses(
	request: Request,
	db: Database,
	handle: LocalHandle,
	offset: number,
	withReplies: boolean,
	limit = DEFAULT_LIMIT
): Promise<Response> {
	const domain = new URL(request.url).hostname
	const actorId = actorURL(adjustLocalHostDomain(domain), handle)

	const QUERY = `
SELECT objects.*,
       actors.id as actor_id,
       actors.type as actor_type,
       actors.pubkey as actor_pubkey,
       actors.cdate as actor_cdate,
       actors.properties as actor_properties,
       actors.is_admin as actor_is_admin,
       actors.mastodon_id as actor_mastodon_id,
       outbox_objects.actor_id as publisher_actor_id,
       (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
       (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
       (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count
FROM outbox_objects
INNER JOIN objects ON objects.id=outbox_objects.object_id
INNER JOIN actors ON actors.id=outbox_objects.actor_id
WHERE objects.type='Note'
      ${withReplies ? '' : 'AND ' + db.qb.jsonExtractIsNull('objects.properties', 'inReplyTo')}
      AND outbox_objects.target = '${PUBLIC_GROUP}'
      AND outbox_objects.actor_id = ?1
      AND outbox_objects.cdate > ?2${db.qb.psqlOnly('::timestamp')}
ORDER by strftime('%Y-%m-%d %H:%M:%f', outbox_objects.published_date) DESC
LIMIT ?3 OFFSET ?4
`

	const out: Array<MastodonStatus> = []

	const url = new URL(request.url)

	const isPinned = url.searchParams.get('pinned') === 'true'
	if (isPinned) {
		// TODO: pinned statuses are not implemented yet. Stub the endpoint
		// to avoid returning statuses that aren't pinned.
		return new Response(JSON.stringify(out), { headers })
	}

	let afterCdate = db.qb.epoch()
	const maxId = url.searchParams.get('max_id')
	if (maxId !== null) {
		// Client asked to retrieve statuses after the max_id
		// As opposed to Mastodon we don't use incremental ID but UUID, we need
		// to retrieve the cdate of the max_id row and only show the newer statuses.
		const row = await db
			.prepare('SELECT cdate FROM outbox_objects WHERE object_id=?')
			.bind(maxId)
			.first<{ cdate: string } | null>()
		if (!row) {
			return errors.statusNotFound(maxId)
		}
		afterCdate = row.cdate
	}

	const { success, error, results } = await db.prepare(QUERY).bind(actorId.toString(), afterCdate, limit, offset).all<{
		mastodon_id: string
		id: string
		cdate: string
		properties: string
		actor_id: string
		actor_type: actors.Actor['type']
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
		return new Response(JSON.stringify(out), { headers })
	}

	for (let i = 0, len = results.length; i < len; i++) {
		const status = await toMastodonStatusFromRow(domain, db, results[i])
		if (status !== null) {
			out.push(status)
		}
	}

	return new Response(JSON.stringify(out), { headers })
}
