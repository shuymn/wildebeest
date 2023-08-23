import { Hono } from 'hono'

import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as timelines from 'wildebeest/backend/src/mastodon/timeline'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { getDomain } from 'wildebeest/backend/src/utils/getDomain'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const app = new Hono<HonoEnv>()

app.get<'/:tag'>(async ({ req, env }) => {
	const url = new URL(req.url)
	return handleRequest(await getDatabase(env), req.raw, getDomain(url), req.param('tag'))
})

export async function handleRequest(db: Database, request: Request, domain: string, tag: string): Promise<Response> {
	// FIXME: handle query params
	const url = new URL(request.url)
	if (url.searchParams.has('max_id')) {
		return new Response(JSON.stringify([]), { headers })
	}

	const timeline = await timelines.getPublicTimeline(
		domain,
		db,
		timelines.LocalPreference.NotSet,
		false,
		20,
		undefined,
		undefined,
		tag
	)
	return new Response(JSON.stringify(timeline), { headers })
}

export default app
