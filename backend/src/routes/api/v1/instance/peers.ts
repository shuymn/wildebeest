import { Hono } from 'hono'

import { getPeers } from 'wildebeest/backend/src/activitypub/peers'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

const app = new Hono<HonoEnv>()

app.get(async ({ env }) => {
	return handleRequest(await getDatabase(env))
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export async function handleRequest(db: Database): Promise<Response> {
	const peers = await getPeers(db)
	return new Response(JSON.stringify(peers), { headers })
}

export default app
