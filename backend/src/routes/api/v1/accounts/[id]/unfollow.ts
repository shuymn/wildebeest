import { Hono } from 'hono'

import { UndoActivity } from 'wildebeest/backend/src/activitypub/activities'
import { createUnfollowActivity } from 'wildebeest/backend/src/activitypub/activities/undo'
import { getActorByMastodonId, type Person } from 'wildebeest/backend/src/activitypub/actors'
import { deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { notAuthorized, resourceNotFound } from 'wildebeest/backend/src/errors'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { isFollowingOrFollowingRequested, removeFollowing } from 'wildebeest/backend/src/mastodon/follow'
import type { HonoEnv, MastodonId } from 'wildebeest/backend/src/types'
import type { Relationship } from 'wildebeest/backend/src/types/account'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToHandle, isLocalHandle } from 'wildebeest/backend/src/utils/handle'

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
		{ domain: url.hostname, db: await getDatabase(env), connectedActor: env.data.connectedActor, userKEK: env.userKEK },
		req.param('id')
	)
})

export async function handleRequest(
	{ domain, db, connectedActor, userKEK }: Dependencies,
	id: MastodonId
): Promise<Response> {
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
