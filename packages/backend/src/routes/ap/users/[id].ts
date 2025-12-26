import { Hono } from 'hono'

import { getUserId, isLocalAccount } from '@wildebeest/backend/accounts'
import * as actors from '@wildebeest/backend/activitypub/actors'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'
import { parseHandle } from '@wildebeest/backend/utils/handle'

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequest(domain, getDatabase(env), req.param('id'))
})

const headers = {
	...cors(),
	'content-type': 'application/activity+json; charset=utf-8',
	'Cache-Control': 'max-age=180, public',
}

async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)

	if (!isLocalAccount(domain, handle)) {
		return new Response('', { status: 403 })
	}

	const person = await actors.getActorById(db, getUserId(domain, handle))
	if (person === null) {
		return new Response('', { status: 404 })
	}

	const res = {
		// TODO: should this be part of the actor object?
		'@context': [
			'https://www.w3.org/ns/activitystreams',
			'https://w3id.org/security/v1',
			{
				toot: 'http://joinmastodon.org/ns#',
				discoverable: 'toot:discoverable',
				alsoKnownAs: {
					'@id': 'as:alsoKnownAs',
					'@type': '@id',
				},
			},
		],

		...person,
	}

	return new Response(JSON.stringify(res), { status: 200, headers })
}

export default app
