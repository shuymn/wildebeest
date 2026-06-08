// https://docs.joinmastodon.org/methods/lists/

import { Hono } from 'hono'
import { z } from 'zod'

import { getDatabase } from '@wildebeest/backend/database'
import { notAuthorized } from '@wildebeest/backend/errors'
import { createList, getListsForOwner } from '@wildebeest/backend/mastodon/list'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, makeJsonResponse, readBody } from '@wildebeest/backend/utils'
import myz from '@wildebeest/backend/utils/zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const createSchema = z.object({
	title: z.string().min(1),
	replies_policy: z.enum(['list', 'followed', 'none']).optional(),
	exclusive: myz.logical().optional(),
})

const app = new Hono<HonoEnv>()

app.get(async ({ env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const lists = await getListsForOwner(getDatabase(env), env.data.connectedActor.id.toString())
	return makeJsonResponse(lists, { headers })
})

app.post(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}

	const result = await readBody(req.raw, createSchema)
	if (!result.success) {
		return new Response('', { status: 400, headers })
	}

	const list = await createList(
		getDatabase(env),
		env.data.connectedActor.id.toString(),
		result.data.title,
		result.data.replies_policy,
		result.data.exclusive
	)
	return makeJsonResponse(list, { status: 200, headers })
})

export default app
