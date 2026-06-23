// https://docs.joinmastodon.org/methods/favourites/

import { Hono } from 'hono'
import { z } from 'zod'

import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized } from '@wildebeest/backend/errors'
import { getFavouritedObjectIds } from '@wildebeest/backend/mastodon/like'
import { loadViewerStatusesByObjectIds } from '@wildebeest/backend/mastodon/status_response'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, readParams } from '@wildebeest/backend/utils'

const app = new Hono<HonoEnv>()

const schema = z.object({
	limit: z.coerce.number().int().positive().max(40).default(20),
	max_id: z.string().optional(),
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

app.get(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const params = await readParams(req.raw, schema)
	if (!params.success) {
		return new Response('', { status: 400 })
	}
	const domain = new URL(req.url).hostname
	return handleRequest(getDatabase(env), env.data.connectedActor, domain, params.data)
})

async function handleRequest(
	db: Database,
	connectedActor: NonNullable<HonoEnv['Bindings']['data']['connectedActor']>,
	domain: string,
	params: z.infer<typeof schema>
): Promise<Response> {
	const objectIds = await getFavouritedObjectIds(db, connectedActor, { limit: params.limit, maxId: params.max_id })
	const statuses = await loadViewerStatusesByObjectIds(db, domain, objectIds, connectedActor)
	return new Response(JSON.stringify(statuses), { headers })
}

export default app
