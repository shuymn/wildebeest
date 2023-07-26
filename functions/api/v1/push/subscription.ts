import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { getVAPIDKeys } from 'wildebeest/backend/src/config'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getClientById } from 'wildebeest/backend/src/mastodon/client'
import type { CreateRequest } from 'wildebeest/backend/src/mastodon/subscription'
import { createSubscription, getSubscription } from 'wildebeest/backend/src/mastodon/subscription'
import { VAPIDPublicKey } from 'wildebeest/backend/src/mastodon/subscription'
import { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'

export const onRequestGet: PagesFunction<Env, any, ContextData> = async ({ request, env, data }) => {
	return handleGetRequest(await getDatabase(env), request, data.connectedActor, data.clientId, getVAPIDKeys(env))
}

export const onRequestPost: PagesFunction<Env, any, ContextData> = async ({ request, env, data }) => {
	return handlePostRequest(await getDatabase(env), request, data.connectedActor, data.clientId, getVAPIDKeys(env))
}

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export async function handleGetRequest(
	db: Database,
	request: Request,
	connectedActor: Actor,
	clientId: string,
	vapidKeys: JWK
) {
	const client = await getClientById(db, clientId)
	if (client === null) {
		return errors.notAuthorized('the access token is invalid')
	}

	const subscription = await getSubscription(db, connectedActor, client)

	if (subscription === null) {
		return errors.resourceNotFound('subscription', clientId)
	}

	const vapidKey = VAPIDPublicKey(vapidKeys)

	const res = {
		id: subscription.id,
		endpoint: subscription.gateway.endpoint,
		alerts: subscription.alerts,
		policy: subscription.policy,
		server_key: vapidKey,
	}

	return new Response(JSON.stringify(res), { headers })
}

export async function handlePostRequest(
	db: Database,
	request: Request,
	connectedActor: Actor,
	clientId: string,
	vapidKeys: JWK
) {
	const client = await getClientById(db, clientId)
	if (client === null) {
		return errors.notAuthorized('the access token is invalid')
	}

	const data = await request.json<CreateRequest>()

	let subscription = await getSubscription(db, connectedActor, client)

	if (subscription === null) {
		subscription = await createSubscription(db, connectedActor, client, data)
	}

	const vapidKey = VAPIDPublicKey(vapidKeys)

	const res = {
		id: subscription.id,
		endpoint: subscription.gateway.endpoint,
		alerts: subscription.alerts,
		policy: subscription.policy,
		server_key: vapidKey,
	}

	return new Response(JSON.stringify(res), { headers })
}
