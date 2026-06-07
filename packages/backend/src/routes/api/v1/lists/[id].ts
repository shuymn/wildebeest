// https://docs.joinmastodon.org/methods/lists/

import { Hono } from 'hono'
import { z } from 'zod'

import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound } from '@wildebeest/backend/errors'
import { deleteList, getListById, updateList } from '@wildebeest/backend/mastodon/list'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, makeJsonResponse, readBody } from '@wildebeest/backend/utils'
import myz from '@wildebeest/backend/utils/zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const updateSchema = z.object({
	title: z.string().min(1).optional(),
	replies_policy: z.enum(['list', 'followed', 'none']).optional(),
	exclusive: myz.logical().optional(),
})

type Dependencies = {
	db: Database
	connectedActorId: string
}

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleGet(
		{ db: getDatabase(env), connectedActorId: env.data.connectedActor.id.toString() },
		req.param('id')
	)
})

app.put<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleUpdate(
		{ db: getDatabase(env), connectedActorId: env.data.connectedActor.id.toString() },
		req.param('id'),
		req.raw
	)
})

app.patch<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleUpdate(
		{ db: getDatabase(env), connectedActorId: env.data.connectedActor.id.toString() },
		req.param('id'),
		req.raw
	)
})

app.delete<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleDelete(
		{ db: getDatabase(env), connectedActorId: env.data.connectedActor.id.toString() },
		req.param('id')
	)
})

async function handleGet({ db, connectedActorId }: Dependencies, listId: string): Promise<Response> {
	const list = await getListById(db, listId, connectedActorId)
	if (!list) {
		return resourceNotFound('id', listId)
	}
	return makeJsonResponse(list, { headers })
}

async function handleUpdate(
	{ db, connectedActorId }: Dependencies,
	listId: string,
	request: Request
): Promise<Response> {
	const result = await readBody(request, updateSchema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}

	const list = await updateList(db, listId, connectedActorId, result.data)
	if (!list) {
		return resourceNotFound('id', listId)
	}
	return makeJsonResponse(list, { headers })
}

async function handleDelete({ db, connectedActorId }: Dependencies, listId: string): Promise<Response> {
	const deleted = await deleteList(db, listId, connectedActorId)
	if (!deleted) {
		return resourceNotFound('id', listId)
	}
	return new Response('', { status: 200, headers })
}

export default app
