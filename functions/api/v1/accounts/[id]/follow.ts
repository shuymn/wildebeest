import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import { createFollowActivity } from 'wildebeest/backend/src/activitypub/activities/follow'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { addFollowing, isNotFollowing } from 'wildebeest/backend/src/mastodon/follow'
import type { Relationship } from 'wildebeest/backend/src/types/account'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import { makeReadBody } from 'wildebeest/backend/src/utils/body'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'

type Dependencies = {
	domain: string
	db: Database
	connectedActor: Person
	userKEK: string
}

type Parameters = {
	reblogs?: boolean
	notify?: boolean
	languages?: string[]
}

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const readBody = makeReadBody<Parameters>({ reblogs: 'boolean', notify: 'boolean', languages: 'string[]' })

// TODO: support request form parameters
export const onRequestPost: PagesFunction<Env, 'id', ContextData> = async ({
	request,
	env,
	params: { id },
	data: { connectedActor },
}) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	return handleRequest(
		{ domain: new URL(request.url).hostname, db: await getDatabase(env), connectedActor, userKEK: env.userKEK },
		id,
		await readBody(request)
	)
}

export async function handleRequest(
	{ domain, db, connectedActor, userKEK }: Dependencies,
	id: string,
	params: Parameters
): Promise<Response> {
	const followee = await actors.getActorByMastodonId(db, id)
	if (!followee) {
		return resourceNotFound('id', id)
	}

	// Only allow to follow remote users
	// TODO: implement following local users
	if (isLocalAccount(domain, actorToHandle(followee))) {
		return new Response('', { status: 403 })
	}

	if (await isNotFollowing(db, connectedActor, followee)) {
		const activity = createFollowActivity(domain, connectedActor, followee)
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await deliverToActor(signingKey, connectedActor, followee, activity, domain)
		await addFollowing(db, connectedActor, followee)
	}

	const res: Relationship = {
		id,
		following: true,
		// FIXME: stub
		showing_reblogs: params.reblogs ?? true,
		notifying: params.notify ?? false,
		followed_by: false,
		blocking: false,
		blocked_by: false,
		muting: false,
		muting_notifications: false,
		requested: false,
		domain_blocking: false,
		endorsed: false,
		note: '',
		languages: params.languages ?? undefined,
	}
	return new Response(JSON.stringify(res), { headers })
}
