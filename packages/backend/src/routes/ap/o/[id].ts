import { Hono } from 'hono'

import { getObjectById, getObjectUrl } from '@wildebeest/backend/activitypub/objects'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequest(domain, getDatabase(env), req.param('id'))
})

const headers = {
	...cors(),
	'content-type': 'application/activity+json; charset=utf-8',
}

async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const obj = await getObjectById(domain, db, getObjectUrl(domain, id))
	if (obj === null) {
		return new Response('', { status: 404 })
	}

	const res = {
		// TODO: should this be part of the object?
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

		...obj,
	}

	return new Response(JSON.stringify(res), { status: 200, headers })
}

export default app
