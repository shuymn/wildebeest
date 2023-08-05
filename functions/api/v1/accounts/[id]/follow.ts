import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import { createFollowActivity } from 'wildebeest/backend/src/activitypub/activities/follow'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound, unprocessableEntity } from 'wildebeest/backend/src/errors'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { addFollowing, isNotFollowing } from 'wildebeest/backend/src/mastodon/follow'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import type { Relationship } from 'wildebeest/backend/src/types/account'
import { myz, readBody } from 'wildebeest/backend/src/utils'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'
import { z } from 'zod'

type Dependencies = {
	domain: string
	db: Database
	connectedActor: Person
	userKEK: string
}

const schema = z.object({
	reblogs: z.optional(myz.logical()),
	notify: z.optional(myz.logical()),
	languages: z.optional(z.array(z.string())),
})

type Parameters = z.infer<typeof schema>

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

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

	const result = await readBody(request, schema)
	if (!result.success) {
		const [issue] = result.error.issues
		return unprocessableEntity(`${issue?.path.join('.')}: ${issue?.message}`)
	}

	return handleRequest(
		{
			domain: new URL(request.url).hostname,
			db: await getDatabase(env),
			connectedActor,
			userKEK: env.userKEK,
		},
		id,
		result.data
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
		const activity = await createFollowActivity(db, domain, connectedActor, followee)
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await deliverToActor(signingKey, connectedActor, followee, activity, domain)
		await addFollowing(domain, db, connectedActor, followee)
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
