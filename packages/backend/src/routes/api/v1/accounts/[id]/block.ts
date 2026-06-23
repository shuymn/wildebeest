// https://docs.joinmastodon.org/methods/accounts/#block

import { Hono } from 'hono'

import { getActorByMastodonId, type Person } from '@wildebeest/backend/activitypub/actors'
import { cacheFromEnv, type Cache } from '@wildebeest/backend/cache'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound } from '@wildebeest/backend/errors'
import { insertBlock, isSelfBlock, removeBlockRelatedFollows } from '@wildebeest/backend/mastodon/block'
import { getRelationship } from '@wildebeest/backend/mastodon/relationship'
import * as timeline from '@wildebeest/backend/mastodon/timeline'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils'

const app = new Hono<HonoEnv>()

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

app.post<'/:id/block'>(async ({ req, env }) => {
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
	if (isSelfBlock(connectedActor, target)) {
		return new Response('', { status: 403 })
	}

	await insertBlock(db, connectedActor, target)
	await removeBlockRelatedFollows(db, connectedActor, target)
	await Promise.all([
		timeline.pregenerateTimelines(domain, db, cache, connectedActor),
		timeline.pregenerateTimelines(domain, db, cache, target),
	])

	const res = await getRelationship(db, connectedActor, id)
	return new Response(JSON.stringify(res), { headers })
}

export default app
