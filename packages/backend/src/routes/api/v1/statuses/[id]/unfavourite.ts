// https://docs.joinmastodon.org/methods/statuses/#unfavourite

import { Hono } from 'hono'

import type { Person } from '@wildebeest/backend/activitypub/actors'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, recordNotFound } from '@wildebeest/backend/errors'
import { deleteLike } from '@wildebeest/backend/mastodon/like'
import { loadVisibleStatusObject, toViewerStatusResponse } from '@wildebeest/backend/mastodon/status_response'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'

const app = new Hono<HonoEnv>()

app.post<'/:id/unfavourite'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const domain = new URL(req.url).hostname
	return handleRequest(getDatabase(env), req.param('id'), env.data.connectedActor, domain)
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

async function handleRequest(db: Database, id: string, connectedActor: Person, domain: string): Promise<Response> {
	const obj = await loadVisibleStatusObject(db, domain, id, connectedActor)
	if (obj === null) {
		return recordNotFound(`object ${id} not found`)
	}

	await deleteLike(db, connectedActor, obj)

	const status = await toViewerStatusResponse(db, domain, obj, connectedActor)
	if (status === null) {
		return recordNotFound(`object ${id} not found`)
	}

	return new Response(JSON.stringify(status), { headers })
}

export default app
