import { Hono } from 'hono'

import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { cacheFromEnv, type Cache } from '@wildebeest/backend/cache'
import { notAuthorized } from '@wildebeest/backend/errors'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const app = new Hono<HonoEnv>()

app.get(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleRequest(req.raw, cacheFromEnv(env), env.data.connectedActor)
})

async function handleRequest(request: Request, cache: Cache, actor: Actor): Promise<Response> {
	const url = new URL(request.url)
	if (url.searchParams.has('max_id')) {
		// We just return the pregenerated notifications, without any filter for
		// pagination. Return an empty array to avoid duplicating notifications
		// in the app.
		return new Response(JSON.stringify([]), { headers })
	}

	const timeline = await cache.get<any>(actor.id + '/timeline/home')
	if (timeline === null) {
		return new Response(JSON.stringify([]), { headers })
	}
	return new Response(JSON.stringify(timeline), { headers })
}

export default app
