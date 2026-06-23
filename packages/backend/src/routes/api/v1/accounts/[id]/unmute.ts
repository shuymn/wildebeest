// https://docs.joinmastodon.org/methods/accounts/#unmute

import { Hono } from 'hono'

import { getActorByMastodonId, type Person } from '@wildebeest/backend/activitypub/actors'
import { cacheFromEnv, type Cache } from '@wildebeest/backend/cache'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound } from '@wildebeest/backend/errors'
import { deleteMute } from '@wildebeest/backend/mastodon/mute'
import { getRelationship } from '@wildebeest/backend/mastodon/relationship'
import * as timeline from '@wildebeest/backend/mastodon/timeline'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils'

const app = new Hono<HonoEnv>()

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

app.post<'/:id/unmute'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleRequest(
		getDatabase(env),
		env.data.connectedActor,
		req.param('id'),
		new URL(req.url).hostname,
		cacheFromEnv(env)
	)
})

async function handleRequest(
	db: Database,
	connectedActor: Person,
	id: string,
	domain: string,
	cache: Cache
): Promise<Response> {
	const target = await getActorByMastodonId(db, id)
	if (!target) {
		return resourceNotFound('id', id)
	}

	await deleteMute(db, connectedActor, target)
	await timeline.pregenerateTimelines(domain, db, cache, connectedActor)

	const res = await getRelationship(db, connectedActor, id)
	return new Response(JSON.stringify(res), { headers })
}

export default app
