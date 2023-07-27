// https://docs.joinmastodon.org/methods/accounts/#relationships

import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { getFollowingMastodonIds, getFollowingRequestedMastodonIds } from 'wildebeest/backend/src/mastodon/follow'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors, readParams } from 'wildebeest/backend/src/utils'
import { z } from 'zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const schema = z.object({
	id: z.union([z.string().nonempty(), z.array(z.string().nonempty()).nonempty()]),
})

type Parameters = z.infer<typeof schema>

type Dependencies = {
	db: Database
	connectedActor: Person
}

export const onRequestGet: PagesFunction<Env, '', ContextData> = async ({ request, env, data: { connectedActor } }) => {
	const result = await readParams(request, schema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}
	return handleRequest({ db: await getDatabase(env), connectedActor }, result.data)
}

export async function handleRequest({ db, connectedActor }: Dependencies, params: Parameters): Promise<Response> {
	const ids = Array.isArray(params.id) ? params.id : [params.id]
	const following = await getFollowingMastodonIds(db, connectedActor)
	const followingRequested = await getFollowingRequestedMastodonIds(db, connectedActor)

	return new Response(
		JSON.stringify(
			ids.map((id) => ({
				id,
				following: following.includes(id),
				requested: followingRequested.includes(id),

				// FIXME: stub values
				showing_reblogs: false,
				notifying: false,
				followed_by: false,
				blocking: false,
				blocked_by: false,
				muting: false,
				muting_notifications: false,
				domain_blocking: false,
				endorsed: false,
			}))
		),
		{ headers }
	)
}
