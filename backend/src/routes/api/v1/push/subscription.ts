import { Hono } from 'hono'

import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { getVAPIDKeys } from '@wildebeest/backend/config'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import * as errors from '@wildebeest/backend/errors'
import { getClientById } from '@wildebeest/backend/mastodon/client'
import type { CreateRequest } from '@wildebeest/backend/mastodon/subscription'
import { createSubscription, getSubscription, VAPIDPublicKey } from '@wildebeest/backend/mastodon/subscription'
import { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const app = new Hono<HonoEnv>()

app.get(async ({ env }) => {
	if (!env.data.connectedActor || !env.data.clientId) {
		return errors.notAuthorized('not authorized')
	}
	return handleGetRequest(getDatabase(env), env.data.connectedActor, env.data.clientId, getVAPIDKeys(env))
})

app.post(async ({ req, env }) => {
	if (!env.data.connectedActor || !env.data.clientId) {
		return errors.notAuthorized('not authorized')
	}
	return handlePostRequest(getDatabase(env), req.raw, env.data.connectedActor, env.data.clientId, getVAPIDKeys(env))
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

async function handleGetRequest(db: Database, connectedActor: Actor, clientId: string, vapidKeys: JWK) {
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

async function handlePostRequest(
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

export default app
