// https://docs.joinmastodon.org/methods/apps/#verify_credentials

import { getVAPIDKeys } from 'wildebeest/backend/src/config'
import { type Database } from 'wildebeest/backend/src/database'
import { notAuthorized } from 'wildebeest/backend/src/errors'
import { Application } from 'wildebeest/backend/src/mastodon'
import { getClientByClientCredential, getClientById } from 'wildebeest/backend/src/mastodon/client'
import { VAPIDPublicKey } from 'wildebeest/backend/src/mastodon/subscription'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { makeJsonResponse, MastodonApiResponse } from 'wildebeest/backend/src/utils/http'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = {
	db: Database
	vapidKeys: JWK
}

export const onRequestGet: PagesFunction<Env, '', ContextData> = async ({ request, env }) => {
	const token = request.headers.get('Authorization')?.replace('Bearer ', '')
	if (token) {
		return handleRequest({ db: env.DATABASE, vapidKeys: getVAPIDKeys(env) }, token)
	}
	return notAuthorized('the access token is invalid')
}

export async function handleRequest(
	{ db, vapidKeys }: Dependencies,
	token: string
): Promise<MastodonApiResponse<Omit<Application, 'client_id' | 'client_secret'>>> {
	const client = (await getClientById(db, token.split('.')[0])) ?? (await getClientByClientCredential(db, token))
	if (client === null) {
		return notAuthorized('the access token is invalid')
	}
	return makeJsonResponse(
		{ name: client.name, website: client.website, vapid_key: VAPIDPublicKey(vapidKeys) },
		{ headers }
	)
}
