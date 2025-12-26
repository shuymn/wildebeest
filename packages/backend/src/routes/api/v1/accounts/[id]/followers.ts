// https://docs.joinmastodon.org/methods/accounts/#followers

import { Hono } from 'hono'
import { z } from 'zod'

import { isLocalAccount } from '@wildebeest/backend/accounts'
import { Actor, getActorByMastodonId, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { getFollowers, loadActors } from '@wildebeest/backend/activitypub/actors/follow'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { resourceNotFound } from '@wildebeest/backend/errors'
import { loadMastodonAccount } from '@wildebeest/backend/mastodon/account'
import { getFollowerIds } from '@wildebeest/backend/mastodon/follow'
import type { HonoEnv } from '@wildebeest/backend/types'
import { MastodonAccount } from '@wildebeest/backend/types/account'
import { cors, makeJsonResponse, MastodonApiResponse, readParams } from '@wildebeest/backend/utils'
import { actorToHandle } from '@wildebeest/backend/utils/handle'

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

const app = new Hono<HonoEnv>()

// TODO: support pagination
app.get<'/:id/followers'>(async ({ req, env }) => {
	const result = await readParams(req.raw, schema)
	if (!result.success) {
		throw new Error('failed to read params')
	}
	const url = new URL(req.url)
	return handleRequest({ domain: url.hostname, db: getDatabase(env) }, req.param('id'), result.data)
})

async function handleRequest(
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

export default app
