import { createFollowActivity } from 'wildebeest/backend/src/activitypub/activities/follow'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import type { Relationship } from 'wildebeest/backend/src/types/account'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { isLocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'
import * as webfinger from 'wildebeest/backend/src/webfinger'

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ request, env, params, data }) => {
	return handleRequest(request, await getDatabase(env), params.id as string, data.connectedActor, env.userKEK)
}

export async function handleRequest(
	request: Request,
	db: Database,
	id: string,
	follower: Person,
	userKEK: string
): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('', { status: 400 })
	}
	const domain = new URL(request.url).hostname
	const followeeHandle = parseHandle(id)

	// Only allow to follow remote users
	// TODO: implement following local users
	if (isLocalHandle(followeeHandle)) {
		return new Response('', { status: 403 })
	}

	const link = await webfinger.queryAcctLink(followeeHandle)
	if (link === null) {
		return new Response('', { status: 404 })
	}

	const followee = await actors.getAndCache(link, db)

	const activity = createFollowActivity(domain, follower, followee)
	const signingKey = await getSigningKey(userKEK, db, follower)
	await deliverToActor(signingKey, follower, followee, activity, domain)

	const res: Relationship = {
		id: await addFollowing(db, follower, followee),
	}
	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(res), { headers })
}
