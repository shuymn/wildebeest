// https://docs.joinmastodon.org/methods/accounts/#relationships

import { Hono } from 'hono'
import { z } from 'zod'

import type { Person } from '@wildebeest/backend/activitypub/actors'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized } from '@wildebeest/backend/errors'
import { getRelationships } from '@wildebeest/backend/mastodon/relationship'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, readParams } from '@wildebeest/backend/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const schema = z.object({
	id: z.union([z.string().nonempty(), z.array(z.string().nonempty()).nonempty()]),
})

type Parameters = z.infer<typeof schema>

type Dependencies = {
	db: Database
	connectedActor: Person
}

const app = new Hono<HonoEnv>()

app.get(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}

	const result = await readParams(req.raw, schema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}
	return handleRequest({ db: getDatabase(env), connectedActor: env.data.connectedActor }, result.data)
})

async function handleRequest({ db, connectedActor }: Dependencies, params: Parameters): Promise<Response> {
	const ids = Array.isArray(params.id) ? params.id : [params.id]
	return new Response(JSON.stringify(await getRelationships(db, connectedActor, ids)), { headers })
}

export default app
