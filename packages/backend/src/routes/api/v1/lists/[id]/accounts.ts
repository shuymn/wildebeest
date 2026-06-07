// https://docs.joinmastodon.org/methods/lists/

import { Hono } from 'hono'
import { z } from 'zod'

import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound } from '@wildebeest/backend/errors'
import {
	addAccountsToList,
	getListMemberAccounts,
	removeAccountsFromList,
} from '@wildebeest/backend/mastodon/list'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, makeJsonResponse, readBody } from '@wildebeest/backend/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const modifySchema = z.object({
	account_ids: z.array(z.string()).min(1),
})

type Dependencies = {
	domain: string
	db: Database
	connectedActorId: string
}

const app = new Hono<HonoEnv>()

app.get<'/accounts'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleGet(
		{
			domain: new URL(req.url).hostname,
			db: getDatabase(env),
			connectedActorId: env.data.connectedActor.id.toString(),
		},
		req.param('id')
	)
})

app.post<'/accounts'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleAdd(
		{
			domain: new URL(req.url).hostname,
			db: getDatabase(env),
			connectedActorId: env.data.connectedActor.id.toString(),
		},
		req.param('id'),
		req.raw
	)
})

app.delete<'/accounts'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleRemove(
		{
			domain: new URL(req.url).hostname,
			db: getDatabase(env),
			connectedActorId: env.data.connectedActor.id.toString(),
		},
		req.param('id'),
		req.raw
	)
})

async function handleGet({ domain, db, connectedActorId }: Dependencies, listId: string): Promise<Response> {
	const accounts = await getListMemberAccounts(domain, db, listId, connectedActorId)
	if (accounts === null) {
		return resourceNotFound('id', listId)
	}
	return makeJsonResponse(accounts, { headers })
}

async function handleAdd(
	{ domain, db, connectedActorId }: Dependencies,
	listId: string,
	request: Request
): Promise<Response> {
	const result = await readBody(request, modifySchema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}

	const list = await addAccountsToList(db, listId, connectedActorId, result.data.account_ids)
	if (!list) {
		return resourceNotFound('id', listId)
	}
	const accounts = await getListMemberAccounts(domain, db, listId, connectedActorId)
	return makeJsonResponse(accounts, { headers })
}

async function handleRemove(
	{ domain, db, connectedActorId }: Dependencies,
	listId: string,
	request: Request
): Promise<Response> {
	const result = await readBody(request, modifySchema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}

	const list = await removeAccountsFromList(db, listId, connectedActorId, result.data.account_ids)
	if (!list) {
		return resourceNotFound('id', listId)
	}
	const accounts = await getListMemberAccounts(domain, db, listId, connectedActorId)
	return makeJsonResponse(accounts, { headers })
}

export default app
