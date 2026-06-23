// https://docs.joinmastodon.org/methods/accounts/#mute

import { Hono } from 'hono'
import { z } from 'zod'

import { getActorByMastodonId, type Person } from '@wildebeest/backend/activitypub/actors'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { cacheFromEnv, type Cache } from '@wildebeest/backend/cache'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound, unprocessableEntity } from '@wildebeest/backend/errors'
import { insertMute } from '@wildebeest/backend/mastodon/mute'
import { getRelationship } from '@wildebeest/backend/mastodon/relationship'
import * as timeline from '@wildebeest/backend/mastodon/timeline'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, readBody } from '@wildebeest/backend/utils'
import myz from '@wildebeest/backend/utils/zod'

const app = new Hono<HonoEnv>()

const schema = z.object({
	notifications: z.optional(myz.logical()),
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

app.post<'/:id/mute'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const result = await readBody(req.raw, schema)
	if (!result.success) {
		const [issue] = result.error.issues
		return unprocessableEntity(`${issue?.path.join('.')}: ${issue?.message}`)
	}
	return handleRequest(
		getDatabase(env),
		env.data.connectedActor,
		req.param('id'),
		result.data,
		new URL(req.url).hostname,
		cacheFromEnv(env)
	)
})

async function handleRequest(
	db: Database,
	connectedActor: Person,
	id: string,
	params: z.infer<typeof schema>,
	domain: string,
	cache: Cache
): Promise<Response> {
	const target = await getActorByMastodonId(db, id)
	if (!target) {
		return resourceNotFound('id', id)
	}
	if (connectedActor[mastodonIdSymbol] === target[mastodonIdSymbol]) {
		return new Response('', { status: 403 })
	}

	await insertMute(db, connectedActor, target, params.notifications ?? true)
	await timeline.pregenerateTimelines(domain, db, cache, connectedActor)

	const res = await getRelationship(db, connectedActor, id)
	return new Response(JSON.stringify(res), { headers })
}

export default app
