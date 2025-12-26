// https://docs.joinmastodon.org/methods/accounts/#lookup

import { Hono } from 'hono'

import { getAccount } from '@wildebeest/backend/accounts'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { resourceNotFound } from '@wildebeest/backend/errors'
import { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = { domain: string; db: Database }

const app = new Hono<HonoEnv>()

app.get(async ({ req, env }) => {
	const url = new URL(req.url)

	const acct = url.searchParams.get('acct')
	if (acct === null || acct === '') {
		return resourceNotFound('acct', '')
	}
	return handleRequest({ domain: url.hostname, db: getDatabase(env) }, acct)
})

async function handleRequest({ domain, db }: Dependencies, acct: string): Promise<Response> {
	const account = await getAccount(domain, db, acct)
	if (account === null) {
		return resourceNotFound('acct', acct)
	}
	return new Response(JSON.stringify(account), { headers })
}

export default app
