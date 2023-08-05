// https://docs.joinmastodon.org/methods/accounts/#lookup

import { getAccount } from 'wildebeest/backend/src/accounts'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = { domain: string; db: Database }

export const onRequestGet: PagesFunction<Env, '', ContextData> = async ({ request, env }) => {
	const url = new URL(request.url)

	const acct = url.searchParams.get('acct')
	if (acct === null || acct === '') {
		return resourceNotFound('acct', '')
	}
	return handleRequest({ domain: url.hostname, db: await getDatabase(env) }, acct)
}

export async function handleRequest({ domain, db }: Dependencies, acct: string): Promise<Response> {
	const account = await getAccount(domain, db, acct)
	if (account === null) {
		return resourceNotFound('acct', acct)
	}
	return new Response(JSON.stringify(account), { headers })
}
