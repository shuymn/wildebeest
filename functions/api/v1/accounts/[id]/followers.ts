// https://docs.joinmastodon.org/methods/accounts/#followers

import { z } from 'zod'

import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import { Actor, getActorByMastodonId, getAndCacheActor } from 'wildebeest/backend/src/activitypub/actors'
import { getFollowers, loadActors } from 'wildebeest/backend/src/activitypub/actors/follow'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { getFollowerIds } from 'wildebeest/backend/src/mastodon/follow'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { MastodonAccount } from 'wildebeest/backend/src/types/account'
import { cors, makeJsonResponse, MastodonApiResponse, readParams } from 'wildebeest/backend/src/utils'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'

const schema = z.object({
	limit: z.coerce.number().int().min(1).max(80).catch(40),
})

type Dependencies = {
	domain: string
	db: Database
}

type Parameters = z.infer<typeof schema>

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

// TODO: support pagination
export const onRequestGet: PagesFunction<Env, 'id', ContextData> = async ({ params: { id }, request, env }) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	const result = await readParams(request, schema)
	if (!result.success) {
		throw new Error('failed to read params')
	}
	const url = new URL(request.url)
	return handleRequest({ domain: url.hostname, db: await getDatabase(env) }, id, result.data)
}

export async function handleRequest(
	{ domain, db }: Dependencies,
	id: string,
	params: Parameters
): Promise<MastodonApiResponse<MastodonAccount[]>> {
	const actor = await getActorByMastodonId(db, id)
	if (!actor) {
		return resourceNotFound('id', id)
	}
	return await get(domain, db, actor, params)
}

async function get(
	domain: string,
	db: Database,
	actor: Actor,
	params: Parameters
): Promise<MastodonApiResponse<MastodonAccount[]>> {
	if (isLocalAccount(domain, actorToHandle(actor))) {
		const followerIds = await getFollowerIds(db, actor, params.limit)
		const promises: Promise<MastodonAccount>[] = []
		for (const id of followerIds) {
			const follower = await getAndCacheActor(new URL(id), db)
			if (!follower) {
				console.warn(`failed to load follower ${id}`)
				continue
			}
			promises.push(loadMastodonAccount(db, domain, follower, actorToHandle(follower)))
		}

		return makeJsonResponse(await Promise.all(promises), { headers })
	}

	const followers = await loadActors(db, await getFollowers(actor, params.limit))
	const promises = followers.map((follower) => {
		return loadMastodonAccount(db, domain, follower, actorToHandle(follower))
	})
	return makeJsonResponse(await Promise.all(promises), { headers })
}
