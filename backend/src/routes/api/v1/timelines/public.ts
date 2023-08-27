import { Hono } from 'hono'
import { z } from 'zod'

import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { getPublicTimeline, getStatusRange, LocalPreference } from 'wildebeest/backend/src/mastodon/timeline'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import { cors, readParams } from 'wildebeest/backend/src/utils'
import myz from 'wildebeest/backend/src/utils/zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const schema = z.object({
	local: myz.logical().catch(false),
	remote: myz.logical().catch(false),
	only_media: myz.logical().catch(false),
	max_id: z.string().optional(),
	since_id: z.string().optional(),
	min_id: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(40).catch(20),
})

type Parameters = z.infer<typeof schema>

type Dependencies = {
	domain: string
	db: Database
}

const app = new Hono<HonoEnv>()

app.get(async ({ req, env }) => {
	const result = await readParams(req.raw, schema)
	if (result.success) {
		return handleRequest({ domain: new URL(req.url).hostname, db: await getDatabase(env) }, result.data)
	}
	return new Response('', { status: 400 })
})

async function handleRequest({ domain, db }: Dependencies, params: Parameters): Promise<Response> {
	const localPreference = params.local
		? LocalPreference.OnlyLocal
		: params.remote
		? LocalPreference.OnlyRemote
		: LocalPreference.NotSet

	const [max, min] = await getStatusRange(db, params.max_id, params.since_id ?? params.min_id)
	if (params.max_id && max === null) {
		return resourceNotFound('max_id', params.max_id)
	}
	if (params.since_id && min === null) {
		return resourceNotFound('since_id', params.since_id)
	}
	if (params.min_id && min === null) {
		return resourceNotFound('min_id', params.min_id)
	}

	const statuses = await getPublicTimeline(
		domain,
		db,
		localPreference,
		false,
		params.limit,
		max ?? undefined,
		min ?? undefined
	)
	return new Response(JSON.stringify(statuses), { headers })
}

export default app
