import { Hono } from 'hono'

import { getUserId } from '@wildebeest/backend/accounts'
import * as actors from '@wildebeest/backend/activitypub/actors'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { getFollowerIds } from '@wildebeest/backend/mastodon/follow'
import type { HonoEnv } from '@wildebeest/backend/types'
import { isLocalHandle, parseHandle } from '@wildebeest/backend/utils/handle'

const app = new Hono<HonoEnv>()

app.get<'/:id/followers'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequest(domain, getDatabase(env), req.param('id'))
})

const headers = {
	'content-type': 'application/json; charset=utf-8',
}

async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)

	if (!isLocalHandle(handle)) {
		return new Response('', { status: 403 })
	}

	const actorId = getUserId(domain, handle)
	const actor = await actors.getActorById(db, actorId)
	if (actor === null) {
		return new Response('', { status: 404 })
	}

	const followers = await getFollowerIds(db, actor)

	const out = {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: actor.followers,
		type: 'OrderedCollection',
		totalItems: followers.length,
		first: new URL(actor.followers.toString() + '/page'),
		last: new URL(actor.followers.toString() + '/page?min_id=0'),
	}
	return new Response(JSON.stringify(out), { headers })
}

export default app
