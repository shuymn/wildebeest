// https://docs.joinmastodon.org/methods/statuses/#context

import { Hono } from 'hono'

import { getObjectByMastodonId } from 'wildebeest/backend/src/activitypub/objects'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { getReplies } from 'wildebeest/backend/src/mastodon/reply'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import type { Context } from 'wildebeest/backend/src/types/status'
import { cors } from 'wildebeest/backend/src/utils/cors'

const app = new Hono<HonoEnv>()

app.get<'/:id/context'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequest(domain, getDatabase(env), req.param('id'))
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const obj = await getObjectByMastodonId(domain, db, id)
	if (obj === null) {
		return new Response('', { status: 404 })
	}

	const descendants = await getReplies(domain, db, obj)
	const out: Context = {
		ancestors: [],
		descendants,
	}

	return new Response(JSON.stringify(out), { headers })
}

export default app
