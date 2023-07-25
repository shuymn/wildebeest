// https://docs.joinmastodon.org/methods/apps/#create

import { getVAPIDKeys } from 'wildebeest/backend/src/config'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { unprocessableEntity } from 'wildebeest/backend/src/errors'
import { createClient } from 'wildebeest/backend/src/mastodon/client'
import { VAPIDPublicKey } from 'wildebeest/backend/src/mastodon/subscription'
import type { Env } from 'wildebeest/backend/src/types'
import { readBody } from 'wildebeest/backend/src/utils'
import { cors } from 'wildebeest/backend/src/utils/cors'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import { z } from 'zod'

// Parameter validation according to https://github.com/mastodon/mastodon/blob/main/app/lib/application_extension.rb
const schema = z.object({
	client_name: z
		.string()
		.trim()
		.nonempty('client_name cannot be an empty string')
		.max(60, 'client_name cannot exceed 60 characters'),
	redirect_uris: z
		.string()
		.trim()
		.nonempty('redirect_uris cannot be an empty string')
		.max(2000, 'redirect_uris cannot exceed 2000 characters')
		.refine(
			(value) => {
				if (value === 'urn:ietf:wg:oauth:2.0:oob') {
					return true
				}
				try {
					new URL('', value)
				} catch {
					return false
				}
				return true
			},
			{ message: 'redirect_uris must be a valid URI' }
		),
	website: z
		.string()
		.max(2000, 'website cannot exceed 2000 characters')
		.refine(
			(value) => {
				try {
					new URL('', value)
				} catch {
					return false
				}
				return true
			},
			{ message: 'website is invalid URI' }
		)
		.optional(),
	scopes: z.string().default('read'),
})

type Parameters = z.infer<typeof schema>

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequestPost: PagesFunction<Env, ''> = async ({ request, env }) => {
	const result = await readBody(request, schema)
	if (result.success) {
		return handleRequest(await getDatabase(env), getVAPIDKeys(env), result.data)
	}
	return unprocessableEntity(result.error.issues[0]?.message)
}

export async function handleRequest(db: Database, vapidKeys: JWK, params: Parameters) {
	const client = await createClient(db, params.client_name, params.redirect_uris, params.scopes, params.website)

	return new Response(
		JSON.stringify({
			name: params.client_name,
			website: params.website,
			redirect_uri: params.redirect_uris,

			client_id: client.id,
			client_secret: client.secret,

			vapid_key: VAPIDPublicKey(vapidKeys),

			// FIXME: stub value
			id: '20',
		}),
		{ headers }
	)
}
