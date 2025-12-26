// https://docs.joinmastodon.org/methods/accounts/#following

import { Hono } from 'hono'
import { z } from 'zod'

import { isLocalAccount } from '@wildebeest/backend/accounts'
import { Actor, getActorByMastodonId, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { getFollowing, loadActors } from '@wildebeest/backend/activitypub/actors/follow'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { resourceNotFound } from '@wildebeest/backend/errors'
import { loadMastodonAccount } from '@wildebeest/backend/mastodon/account'
import { getFollowingId } from '@wildebeest/backend/mastodon/follow'
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
app.get<'/:id/following'>(async ({ req, env }) => {
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
		const followingIds = await getFollowingId(db, actor, params.limit)
		const promises: Promise<MastodonAccount>[] = []
		for (const id of followingIds) {
			const followee = await getAndCacheActor(new URL(id), db)
			if (followee === null) {
				console.warn(`failed to retrieve following (${id}): not found`)
				continue
			}
			promises.push(loadMastodonAccount(db, domain, followee, actorToHandle(followee)))
		}

		return makeJsonResponse(await Promise.all(promises), { headers })
	}

	const following = await loadActors(db, await getFollowing(actor, params.limit))
	const promises = following.map((followee) => {
		return loadMastodonAccount(db, domain, followee, actorToHandle(followee))
	})

	return makeJsonResponse(await Promise.all(promises), { headers })
}

export default app
