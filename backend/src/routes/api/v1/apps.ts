// https://docs.joinmastodon.org/methods/apps/#create

import { Hono } from 'hono'
import { z } from 'zod'

import { getVAPIDKeys } from '@wildebeest/backend/config'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { unprocessableEntity } from '@wildebeest/backend/errors'
import { Application } from '@wildebeest/backend/mastodon'
import { createClient } from '@wildebeest/backend/mastodon/client'
import { VAPIDPublicKey } from '@wildebeest/backend/mastodon/subscription'
import type { HonoEnv } from '@wildebeest/backend/types'
import { makeJsonResponse, MastodonApiResponse, readBody } from '@wildebeest/backend/utils'
import { cors } from '@wildebeest/backend/utils/cors'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

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

const app = new Hono<HonoEnv>()

app.post(async ({ req, env }) => {
	const result = await readBody(req.raw, schema)
	if (result.success) {
		return handleRequest(getDatabase(env), getVAPIDKeys(env), result.data)
	}
	return unprocessableEntity(result.error.issues[0]?.message)
})

async function handleRequest(
	db: Database,
	vapidKeys: JWK,
	params: Parameters
): Promise<MastodonApiResponse<Application>> {
	const client = await createClient(db, params.client_name, params.redirect_uris, params.scopes, params.website)
	return makeJsonResponse(
		{
			name: params.client_name,
			website: params.website,
			vapid_key: VAPIDPublicKey(vapidKeys),
			client_id: client.id,
			client_secret: client.secret,

			// These fields do not exist in the Application type,
			// but it appears in the Mastodon API documentation.
			// So, it was followed as it is.
			// FIXME: stub value
			id: '20',
			redirect_uri: params.redirect_uris,
		},
		{ headers }
	)
}

export default app
