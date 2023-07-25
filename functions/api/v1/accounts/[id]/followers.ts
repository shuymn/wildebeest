// https://docs.joinmastodon.org/methods/accounts/#followers

import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import { Actor, getActorByMastodonId, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import { getFollowers, loadActors } from 'wildebeest/backend/src/activitypub/actors/follow'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { loadExternalMastodonAccount, loadLocalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { getFollowerIds } from 'wildebeest/backend/src/mastodon/follow'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { MastodonAccount } from 'wildebeest/backend/src/types/account'
import { numberParam } from 'wildebeest/backend/src/utils'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'
import { Override } from 'wildebeest/backend/src/utils/type'

type Dependencies = {
	domain: string
	db: Database
}

type Parameters = {
	limit: number
}

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 80

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

// TODO: support pagination
export const onRequestGet: PagesFunction<Env, 'id', ContextData> = async ({ params: { id }, request, env }) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	const url = new URL(request.url)
	return handleRequest({ domain: url.hostname, db: await getDatabase(env) }, id, {
		limit: url.searchParams.get('limit'),
	})
}

export async function handleRequest(
	{ domain, db }: Dependencies,
	id: string,
	params: Override<Required<Parameters>, string | null>
): Promise<Response> {
	const actor = await getActorByMastodonId(db, id)
	if (!actor) {
		return resourceNotFound('id', id)
	}
	return await get(domain, db, actor, {
		limit: numberParam(params.limit, DEFAULT_LIMIT, { maxValue: MAX_LIMIT }),
	})
}

async function get(domain: string, db: Database, actor: Actor, params: Parameters): Promise<Response> {
	if (isLocalAccount(domain, actorToHandle(actor))) {
		const followerIds = await getFollowerIds(db, actor, params.limit)
		const promises: Promise<MastodonAccount>[] = []
		for (const id of followerIds) {
			try {
				const follower = await getAndCache(new URL(id), db)
				const handle = actorToHandle(follower)
				if (isLocalAccount(domain, handle)) {
					promises.push(loadLocalMastodonAccount(db, follower))
				} else {
					promises.push(loadExternalMastodonAccount(db, follower, handle))
				}
			} catch (err: any) {
				console.warn(`failed to retrieve follower (${id}): ${err.message}`)
			}
		}

		const accounts = await Promise.all(promises)
		return new Response(JSON.stringify(accounts), { headers })
	}

	const followers = await loadActors(db, await getFollowers(actor, params.limit))
	const promises = followers.map((follower) => {
		const handle = actorToHandle(follower)
		if (isLocalAccount(domain, handle)) {
			return loadLocalMastodonAccount(db, follower)
		}
		return loadExternalMastodonAccount(db, actor, handle)
	})

	const accounts = await Promise.all(promises)
	return new Response(JSON.stringify(accounts), { headers })
}
