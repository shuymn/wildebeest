import type { Activity } from 'wildebeest/backend/src/activitypub/activities'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { createCreateActivity } from 'wildebeest/backend/src/activitypub/activities/create'
import { getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { actorURL } from 'wildebeest/backend/src/activitypub/actors'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import type { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { isLocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ request, env, params }) => {
	const domain = new URL(request.url).hostname
	return handleRequest(domain, await getDatabase(env), params.id as string)
}

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const DEFAULT_LIMIT = 20

export async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)

	if (!isLocalHandle(handle)) {
		return new Response('', { status: 403 })
	}

	const actorId = actorURL(domain, handle)
	const actor = await getActorById(db, actorId)
	if (actor === null) {
		return new Response('', { status: 404 })
	}

	const items: Array<Activity> = []

	// TODO: eventually move to a shared file
	const QUERY = `
SELECT objects.*
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
WHERE outbox_objects.actor_id = ?1
      AND objects.type = 'Note'
      AND outbox_objects.target = '${PUBLIC_GROUP}'
ORDER by outbox_objects.cdate DESC
LIMIT ?2
`

	const { success, error, results } = await db.prepare(QUERY).bind(actorId.toString(), DEFAULT_LIMIT).all()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}

	if (results && results.length > 0) {
		for (let i = 0, len = results.length; i < len; i++) {
			const result: any = results[i]
			const properties = JSON.parse(result.properties)

			const note: Note = {
				id: new URL(result.id),
				atomUri: new URL(result.id),
				type: 'Note',
				published: new Date(result.cdate).toISOString(),

				// FIXME: stub
				sensitive: false,
				attachment: [],
				tag: [],
				replies: {
					first: {
						items: [],

						// FIXME: stub values
						next: 'https://example.com/users/a/statuses/109372762645660352/replies?only_other_accounts=true&page=true',
						partOf: 'https://example.com/users/a/statuses/109372762645660352/replies',
						type: 'CollectionPage',
					},
					id: 'https://example.com/users/a/statuses/109372762645660352/replies',
					type: 'Collection',
				},

				...properties,
			}
			const activity = createCreateActivity(domain, actor, note)
			delete activity['@context']

			const activityId = getApId(note.id)
			// check if the URL pathname ends with '/', if not add one.
			activityId.pathname = activityId.pathname.endsWith('/') ? activityId.pathname : activityId.pathname + '/'
			// append the additional path
			activityId.pathname += 'activity'

			activity.id = activityId
			activity.published = new Date(result.cdate).toISOString()
			activity.to = [getApId('https://www.w3.org/ns/activitystreams#Public')]
			activity.cc = [actor.followers]
			items.push(activity)
		}
	}

	const out = {
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			{
				ostatus: 'http://ostatus.org#',
				atomUri: 'ostatus:atomUri',
				inReplyToAtomUri: 'ostatus:inReplyToAtomUri',
				conversation: 'ostatus:conversation',
				sensitive: 'as:sensitive',
				toot: 'http://joinmastodon.org/ns#',
				votersCount: 'toot:votersCount',
			},
		],
		id: new URL(actor.outbox + '/page'),
		type: 'OrderedCollectionPage',
		partOf: actor.outbox,
		orderedItems: items,

		// FIXME: stub values
		prev: 'https://example.com/todo',
	}
	return new Response(JSON.stringify(out), { headers })
}
