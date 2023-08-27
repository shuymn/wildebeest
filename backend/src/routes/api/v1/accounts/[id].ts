// https://docs.joinmastodon.org/methods/accounts/#get

import { Hono } from 'hono'

import { getAccountByMastodonId } from 'wildebeest/backend/src/accounts'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import type { ContextData, Env, HonoEnv } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = {
	domain: string
	db: Database
}

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	return handleRequest({ domain: new URL(req.url).hostname, db: await getDatabase(env) }, req.param('id'))
})

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ request, env, params: { id } }) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	return handleRequest({ domain: new URL(request.url).hostname, db: await getDatabase(env) }, id)
}

async function handleRequest({ domain, db }: Dependencies, id: string): Promise<Response> {
	const account = await getAccountByMastodonId(domain, db, id)

	if (account) {
		return new Response(JSON.stringify(account), { headers })
	} else {
		return resourceNotFound('id', id)
	}
}

export default app
