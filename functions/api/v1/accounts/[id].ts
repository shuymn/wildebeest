// https://docs.joinmastodon.org/methods/accounts/#get

import { getAccountByMastodonId } from 'wildebeest/backend/src/accounts/getAccount'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import { cors } from 'wildebeest/backend/src/utils/cors'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ request, env, params: { id } }) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	return handleRequest(new URL(request.url).hostname, await getDatabase(env), id)
}

export async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const account = await getAccountByMastodonId(domain, db, id)

	if (account) {
		return new Response(JSON.stringify(account), { headers })
	} else {
		return new Response('', { status: 404 })
	}
}
