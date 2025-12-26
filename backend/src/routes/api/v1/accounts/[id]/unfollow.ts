import { Hono } from 'hono'

import { UndoActivity } from '@wildebeest/backend/activitypub/activities'
import { createUnfollowActivity } from '@wildebeest/backend/activitypub/activities/undo'
import { getActorByMastodonId, type Person } from '@wildebeest/backend/activitypub/actors'
import { deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound } from '@wildebeest/backend/errors'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { isFollowingOrFollowingRequested, removeFollowing } from '@wildebeest/backend/mastodon/follow'
import type { HonoEnv, MastodonId } from '@wildebeest/backend/types'
import type { Relationship } from '@wildebeest/backend/types/account'
import { cors } from '@wildebeest/backend/utils/cors'
import { actorToHandle, isLocalHandle } from '@wildebeest/backend/utils/handle'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = {
	domain: string
	db: Database
	connectedActor: Person
	userKEK: string
}

const app = new Hono<HonoEnv>()

app.post<'/:id/unfollow'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const url = new URL(req.url)
	return handleRequest(
		{ domain: url.hostname, db: getDatabase(env), connectedActor: env.data.connectedActor, userKEK: env.userKEK },
		req.param('id')
	)
})

async function handleRequest({ domain, db, connectedActor, userKEK }: Dependencies, id: MastodonId): Promise<Response> {
	const targetActor = await getActorByMastodonId(db, id)
	if (!targetActor) {
		return resourceNotFound('id', id)
	}

	const handle = actorToHandle(targetActor)

	// Only allow to unfollow remote users
	// TODO: implement unfollowing local users
	if (isLocalHandle(handle)) {
		return new Response('', { status: 403 })
	}

	if (await isFollowingOrFollowingRequested(db, connectedActor, targetActor)) {
		const activity = await createUnfollowActivity(db, domain, connectedActor, targetActor)
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await deliverToActor<UndoActivity>(signingKey, connectedActor, targetActor, activity, domain)
		await removeFollowing(db, connectedActor, targetActor)
	}

	const res: Relationship = {
		id,
		following: false,
		// FIXME: stub
		showing_reblogs: true,
		notifying: false,
		followed_by: false,
		blocking: false,
		blocked_by: false,
		muting: false,
		muting_notifications: false,
		requested: false,
		domain_blocking: false,
		endorsed: false,
		note: '',
	}
	return new Response(JSON.stringify(res), { headers })
}

export default app
