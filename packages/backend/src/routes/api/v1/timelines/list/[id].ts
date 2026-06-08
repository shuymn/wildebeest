// https://docs.joinmastodon.org/methods/timelines/#list

import { Hono } from 'hono'
import { z } from 'zod'

import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound } from '@wildebeest/backend/errors'
import { getListById, getListMemberActorIds } from '@wildebeest/backend/mastodon/list'
import { getListTimeline } from '@wildebeest/backend/mastodon/timeline'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, makeJsonResponse, readParams } from '@wildebeest/backend/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const schema = z.object({
	limit: z.coerce.number().int().min(1).max(40).catch(20),
})

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}

	const params = await readParams(req.raw, schema)
	if (!params.success) {
		return new Response('', { status: 400 })
	}

	return handleRequest(
		{
			domain: new URL(req.url).hostname,
			db: getDatabase(env),
			connectedActor: env.data.connectedActor,
		},
		req.param('id'),
		params.data.limit
	)
})

async function handleRequest(
	{ domain, db, connectedActor }: { domain: string; db: Database; connectedActor: Actor },
	listId: string,
	limit: number
): Promise<Response> {
	const list = await getListById(db, listId, connectedActor.id.toString())
	if (!list) {
		return resourceNotFound('id', listId)
	}

	const memberIds = await getListMemberActorIds(db, listId)
	const statuses = await getListTimeline(domain, db, connectedActor, memberIds, limit)
	return makeJsonResponse(statuses, { headers })
}

export default app
