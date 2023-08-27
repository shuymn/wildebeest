// https://docs.joinmastodon.org/methods/tags/#get

import { Hono } from 'hono'

import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getTag } from 'wildebeest/backend/src/mastodon/hashtag'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

const headers = {
	...cors(),
	'content-type': 'application/json',
}

const app = new Hono<HonoEnv>()

app.get<'/:tag'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequestGet(await getDatabase(env), domain, req.param('tag'))
})

async function handleRequestGet(db: Database, domain: string, value: string): Promise<Response> {
	const tag = await getTag(db, domain, value)
	if (tag === null) {
		return errors.tagNotFound(value)
	}
	return new Response(JSON.stringify(tag), { headers })
}

export default app
