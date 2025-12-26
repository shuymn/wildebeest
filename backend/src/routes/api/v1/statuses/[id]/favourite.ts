// https://docs.joinmastodon.org/methods/statuses/#favourite

import { Hono } from 'hono'

import { createLikeActivity } from '@wildebeest/backend/activitypub/activities/like'
import { getAndCacheActor, type Person } from '@wildebeest/backend/activitypub/actors'
import { deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import {
	getApId,
	getObjectByMastodonId,
	isLocalObject,
	originalActorIdSymbol,
	originalObjectIdSymbol,
} from '@wildebeest/backend/activitypub/objects'
import type { Note } from '@wildebeest/backend/activitypub/objects/note'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized } from '@wildebeest/backend/errors'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { insertLike } from '@wildebeest/backend/mastodon/like'
import { toMastodonStatusFromObject } from '@wildebeest/backend/mastodon/status'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'

const app = new Hono<HonoEnv>()

app.get<'/:id/favourite'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const domain = new URL(req.url).hostname
	return handleRequest(getDatabase(env), req.param('id'), env.data.connectedActor, env.userKEK, domain)
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

async function handleRequest(
	db: Database,
	id: string,
	connectedActor: Person,
	userKEK: string,
	domain: string
): Promise<Response> {
	const obj = await getObjectByMastodonId<Note>(domain, db, id)
	if (obj === null) {
		return new Response('', { status: 404 })
	}

	const status = await toMastodonStatusFromObject(db, obj, domain)
	if (status === null) {
		return new Response('', { status: 404 })
	}

	if (!isLocalObject(domain, getApId(obj.id))) {
		// Liking an external object delivers the like activity
		const targetActor = await getAndCacheActor(new URL(obj[originalActorIdSymbol]), db)
		if (!targetActor) {
			return new Response(`target Actor ${obj[originalActorIdSymbol]} not found`, { status: 404 })
		}

		const activity = await createLikeActivity(db, domain, connectedActor, new URL(obj[originalObjectIdSymbol]))
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await deliverToActor(signingKey, connectedActor, targetActor, activity, domain)
	}

	await insertLike(db, connectedActor, obj)
	status.favourited = true

	return new Response(JSON.stringify(status), { headers })
}

export default app
