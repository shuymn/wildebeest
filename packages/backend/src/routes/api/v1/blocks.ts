import { Hono } from 'hono'
import { z } from 'zod'

import { getAccountByMastodonId } from '@wildebeest/backend/accounts'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized } from '@wildebeest/backend/errors'
import { getBlockedMastodonIds } from '@wildebeest/backend/mastodon/block'
import { HonoEnv } from '@wildebeest/backend/types'
import type { MastodonAccount } from '@wildebeest/backend/types/account'
import { cors, readParams } from '@wildebeest/backend/utils'

const app = new Hono<HonoEnv>()

const schema = z.object({
	limit: z.coerce.number().int().positive().max(80).default(40),
	max_id: z.string().optional(),
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

app.get(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const params = await readParams(req.raw, schema)
	if (!params.success) {
		return new Response('', { status: 400 })
	}
	const domain = new URL(req.url).hostname
	return handleRequest(getDatabase(env), env.data.connectedActor, domain, params.data)
})

async function handleRequest(
	db: Database,
	connectedActor: NonNullable<HonoEnv['Bindings']['data']['connectedActor']>,
	domain: string,
	params: z.infer<typeof schema>
): Promise<Response> {
	const ids = await getBlockedMastodonIds(db, connectedActor, { limit: params.limit, maxId: params.max_id })
	const accounts = (await Promise.all(ids.map((id) => getAccountByMastodonId(domain, db, id)))).filter(
		(account): account is MastodonAccount => account !== null
	)
	return new Response(JSON.stringify(accounts), { headers })
}

export default app
