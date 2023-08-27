import { Hono } from 'hono'

import { getUserId } from 'wildebeest/backend/src/accounts'
import { getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { getFollowingId } from 'wildebeest/backend/src/mastodon/follow'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import { isLocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'

const app = new Hono<HonoEnv>()

app.get<'/:id/following/page'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequest(domain, await getDatabase(env), req.param('id'))
})

const headers = {
	'content-type': 'application/json; charset=utf-8',
}

export async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)

	if (!isLocalHandle(handle)) {
		return new Response('', { status: 403 })
	}

	const actorId = getUserId(domain, handle)
	const actor = await getActorById(db, actorId)
	if (actor === null) {
		return new Response('', { status: 404 })
	}

	const following = await getFollowingId(db, actor)

	const out = {
		'@context': ['https://www.w3.org/ns/activitystreams'],
		id: new URL(actor.following.toString() + '/page'),
		type: 'OrderedCollectionPage',
		partOf: actor.following,
		orderedItems: following,

		// FIXME: stub values
		prev: 'https://example.com/todo',
	}
	return new Response(JSON.stringify(out), { headers })
}

export default app
