// https://docs.joinmastodon.org/methods/notifications/#get

import { Hono } from 'hono'

import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import type { Cache } from 'wildebeest/backend/src/cache'
import { cacheFromEnv } from 'wildebeest/backend/src/cache'
import { notAuthorized } from 'wildebeest/backend/src/errors'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

const app = new Hono<HonoEnv>()

app.get(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleRequest(req.raw, cacheFromEnv(env), env.data.connectedActor)
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export async function handleRequest(request: Request, cache: Cache, connectedActor: Person): Promise<Response> {
	const url = new URL(request.url)
	if (url.searchParams.has('max_id')) {
		// We just return the pregenerated notifications, without any filter for
		// pagination. Return an empty array to avoid duplicating notifications
		// in the app.
		return new Response(JSON.stringify([]), { headers })
	}

	const notifications = await cache.get<any>(connectedActor.id + '/notifications')
	if (notifications === null) {
		return new Response(JSON.stringify([]), { headers })
	}
	return new Response(JSON.stringify(notifications), { headers })
}

export default app
