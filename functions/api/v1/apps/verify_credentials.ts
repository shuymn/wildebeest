// https://docs.joinmastodon.org/methods/apps/#verify_credentials

import { getVAPIDKeys } from 'wildebeest/backend/src/config'
import { type Database } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getClientById } from 'wildebeest/backend/src/mastodon/client'
import { VAPIDPublicKey } from 'wildebeest/backend/src/mastodon/subscription'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'

export type CredentialApp = {
	name: string
	website: string
	vapid_key: string
}

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ request, env }) => {
	return handleRequest(env.DATABASE, request, getVAPIDKeys(env))
}

export async function handleRequest(db: Database, request: Request, vapidKeys: JWK) {
	if (request.method !== 'GET') {
		return new Response('', { status: 400 })
	}

	const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '')
	const parts = authHeader?.split('.') ?? ''
	const clientId = parts[0]

	const client = await getClientById(db, clientId)
	if (client === null) {
		return errors.clientUnknown()
	}
	const vapidKey = VAPIDPublicKey(vapidKeys)

	const res = {
		name: client.name,
		website: client.website,
		vapid_key: vapidKey,
	}

	return new Response(JSON.stringify(res), { headers })
}
