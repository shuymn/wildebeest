// https://docs.joinmastodon.org/methods/follow_requests/#reject

import { Hono } from 'hono'

import { createRejectActivity } from '@wildebeest/backend/activitypub/activities/reject'
import { getActorByMastodonId, type Person } from '@wildebeest/backend/activitypub/actors'
import { enqueueDelivery } from '@wildebeest/backend/activitypub/deliver'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, recordNotFound, resourceNotFound } from '@wildebeest/backend/errors'
import {
	buildFollowApObject,
	getPendingInboundFollow,
	removePendingFollowing,
} from '@wildebeest/backend/mastodon/follow'
import { getRelationship } from '@wildebeest/backend/mastodon/relationship'
import type { DeliverMessageBody, HonoEnv, Queue } from '@wildebeest/backend/types'
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
			queue: env.QUEUE,
		},
		req.param('id')
	)
})

async function handleRequest(
	{
		domain,
		db,
		connectedActor,
		userKEK,
		queue,
	}: { domain: string; db: Database; connectedActor: Person; userKEK: string; queue: Queue<DeliverMessageBody> },
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
	const reply = await createRejectActivity(db, domain, connectedActor, followObject)
	const removed = await removePendingFollowing(db, requester, connectedActor)
	if (!removed) {
		return recordNotFound()
	}
	await enqueueDelivery(queue, userKEK, connectedActor, requester, reply)

	const res = await getRelationship(db, connectedActor, id)
	return new Response(JSON.stringify(res), { headers })
}

export default app
