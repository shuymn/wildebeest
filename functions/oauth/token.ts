// https://docs.joinmastodon.org/methods/oauth/#token

import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { clientUnknown, notAuthorized } from 'wildebeest/backend/src/errors'
import { Token } from 'wildebeest/backend/src/mastodon'
import { createClientCredential, getClientById } from 'wildebeest/backend/src/mastodon/client'
import type { Env } from 'wildebeest/backend/src/types'
import { cors, makeJsonResponse, MastodonApiResponse, readBody } from 'wildebeest/backend/src/utils'
import { z } from 'zod'

const schema = z
	.object({
		grant_type: z.union([z.literal('authorization_code'), z.literal('client_credentials')]),
		code: z.string().nonempty().optional(),
		client_id: z.string().nonempty(),
		client_secret: z.string().nonempty(),
		redirect_uri: z.string().trim().nonempty(),
		scope: z.string().nonempty().default('read'),
	})
	.refine(({ code, grant_type }) => {
		if (code) {
			return grant_type === 'authorization_code'
		}
		return grant_type === 'client_credentials'
	})

type Parameters = z.infer<typeof schema>

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequestOptions: PagesFunction<Env, ''> = () => {
	return new Response('', { headers })
}

export const onRequestPost: PagesFunction<Env, ''> = async ({ request, env }) => {
	const result = await readBody(request, schema)
	if (result.success) {
		return handleRequest(await getDatabase(env), result.data)
	}
	return notAuthorized('missing authorization')
}

export async function handleRequest(db: Database, params: Parameters): Promise<MastodonApiResponse<Token>> {
	const clientId = params.code?.split('.')[0] ?? params.client_id
	const client = await getClientById(db, clientId)
	if (
		client === null ||
		client.id !== params.client_id ||
		client.secret !== params.client_secret ||
		client.redirect_uris !== params.redirect_uri
	) {
		return notAuthorized(
			'invalid_client',
			'Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.'
		)
	}
	const want = client.scopes.split(' ')
	const got = params.scope.split(' ')
	if (!got.every((scope) => want.includes(scope))) {
		return clientUnknown('invalid_scope', 'The requested scope is invalid, unknown, or malformed.')
	}

	const [secret, created] = params.code
		? [params.code, Date.now()]
		: await createClientCredential(db, clientId, params.scope)

	return makeJsonResponse(
		{
			access_token: secret,
			token_type: 'Bearer',
			scope: params.scope,
			created_at: (created / 1000) | 0,
		} satisfies Token,
		{ headers }
	)
}
