import { Hono } from 'hono'

import { type Database, getDatabase } from '@wildebeest/backend/database'
import type { HonoEnv } from '@wildebeest/backend/types'

const app = new Hono<HonoEnv>()

app.get(async ({ env }) => {
	return handleRequestGet(getDatabase(env))
})

async function handleRequestGet(db: Database) {
	const query = `SELECT * from server_rules;`
	const result = await db.prepare(query).all<{ id: string; text: string }>()

	if (!result.success) {
		return new Response('SQL error: ' + result.error, { status: 500 })
	}

	return new Response(JSON.stringify(result.results ?? []), { status: 200 })
}

export default app
