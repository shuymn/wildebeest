import { Hono } from 'hono'

import { getPeers } from '@wildebeest/backend/activitypub/peers'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'

const app = new Hono<HonoEnv>()

app.get(async ({ env }) => {
	return handleRequest(getDatabase(env))
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

async function handleRequest(db: Database): Promise<Response> {
	const peers = await getPeers(db)
	return new Response(JSON.stringify(peers), { headers })
}

export default app
