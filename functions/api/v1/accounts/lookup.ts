// https://docs.joinmastodon.org/methods/accounts/#lookup

import { getAccount } from 'wildebeest/backend/src/accounts/getAccount'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { ContextData } from 'wildebeest/backend/src/types/context'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { Env } from 'wildebeest/consumer/src'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, '', ContextData> = async ({ request, env }) => {
	return handleRequest(request, await getDatabase(env))
}

export async function handleRequest(req: Request, db: Database): Promise<Response> {
	const url = new URL(req.url)

	const acct = url.searchParams.get('acct')
	if (acct === null || acct === '') {
		return resourceNotFound('acct', '')
	}

	const account = await getAccount(url.hostname, db, acct)

	if (account === null) {
		return resourceNotFound('acct', acct)
	}
	return new Response(JSON.stringify(account), { headers })
}
