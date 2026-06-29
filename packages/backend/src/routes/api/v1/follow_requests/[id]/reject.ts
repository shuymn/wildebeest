// https://docs.joinmastodon.org/methods/follow_requests/#reject

import { Hono } from 'hono'

import { createRejectActivity } from '@wildebeest/backend/activitypub/activities/reject'
import { getActorByMastodonId, type Person } from '@wildebeest/backend/activitypub/actors'
import { deliverSafely, deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, recordNotFound, resourceNotFound } from '@wildebeest/backend/errors'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import {
	buildFollowApObject,
	getPendingInboundFollow,
	removePendingFollowing,
} from '@wildebeest/backend/mastodon/follow'
import { getRelationship } from '@wildebeest/backend/mastodon/relationship'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils'

const app = new Hono<HonoEnv>()

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

app.post<'/:id/reject'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	return handleRequest(
		{
			domain: new URL(req.url).hostname,
			db: getDatabase(env),
			connectedActor: env.data.connectedActor,
			userKEK: env.userKEK,
		},
		req.param('id')
	)
})

async function handleRequest(
	{ domain, db, connectedActor, userKEK }: { domain: string; db: Database; connectedActor: Person; userKEK: string },
	id: string
): Promise<Response> {
	const requester = await getActorByMastodonId(db, id)
	if (!requester) {
		return resourceNotFound('id', id)
	}

	const pending = await getPendingInboundFollow(db, requester, connectedActor)
	if (!pending) {
		return recordNotFound()
	}

	const followObject = buildFollowApObject(domain, requester, connectedActor, pending.uri)
	const removed = await removePendingFollowing(db, requester, connectedActor)
	if (!removed) {
		return recordNotFound()
	}

	const reply = await createRejectActivity(db, domain, connectedActor, followObject)
	const signingKey = await getSigningKey(userKEK, db, connectedActor)
	await deliverSafely(`Reject to ${requester.id.toString()}`, () =>
		deliverToActor(signingKey, connectedActor, requester, reply, domain)
	)

	const res = await getRelationship(db, connectedActor, id)
	return new Response(JSON.stringify(res), { headers })
}

export default app
