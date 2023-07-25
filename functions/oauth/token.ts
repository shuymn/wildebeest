// https://docs.joinmastodon.org/methods/oauth/#token

import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { clientUnknown, notAuthorized } from 'wildebeest/backend/src/errors'
import { getClientById } from 'wildebeest/backend/src/mastodon/client'
import type { Env } from 'wildebeest/backend/src/types'
import { cors, readBody } from 'wildebeest/backend/src/utils'
import { z } from 'zod'

const schema = z.object({
	code: z.string().nonempty(),
})

type Parameters = z.infer<typeof schema>

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequestOptions: PagesFunction<Env, ''> = async () => {
	return new Response('', { headers })
}

export const onRequestPost: PagesFunction<Env, ''> = async ({ request, env }) => {
	const result = await readBody(request, schema)
	if (result.success) {
		return handleRequest(await getDatabase(env), result.data)
	}

	// fallback to url params if body is empty (invalid json)
	if (request.headers.get('content-type')?.startsWith('application/json')) {
		const url = new URL(request.url)
		const code = url.searchParams.get('code')
		if (code) {
			return handleRequest(await getDatabase(env), { code })
		}
	}

	return notAuthorized('missing authorization')
}

export async function handleRequest(db: Database, params: Parameters): Promise<Response> {
	const parts = params.code.split('.')
	const clientId = parts[0]

	const client = await getClientById(db, clientId)
	if (client === null) {
		return clientUnknown()
	}

	const res = {
		access_token: params.code,
		token_type: 'Bearer',
		scope: client.scopes,
		created_at: (Date.now() / 1000) | 0,
	}
	return new Response(JSON.stringify(res), { headers })
}
