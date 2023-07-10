// https://docs.joinmastodon.org/methods/accounts/#followers

import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import { actorURL } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { getFollowers, loadActors } from 'wildebeest/backend/src/activitypub/actors/follow'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { loadExternalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import * as localFollow from 'wildebeest/backend/src/mastodon/follow'
import { MastodonAccount } from 'wildebeest/backend/src/types/account'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { LocalHandle, parseHandle, RemoteHandle } from 'wildebeest/backend/src/utils/handle'
import * as webfinger from 'wildebeest/backend/src/webfinger'

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ params, request, env }) => {
	const domain = new URL(request.url).hostname
	return handleRequest(domain, await getDatabase(env), params.id as string)
}

export async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const handle = parseHandle(id)

	if (isLocalAccount(domain, handle)) {
		// Retrieve the infos from a local user
		return getLocalFollowers(domain, handle, db)
	}
	// Retrieve the infos of a remote actor
	return getRemoteFollowers(handle, db)
}

async function getRemoteFollowers(handle: RemoteHandle, db: Database): Promise<Response> {
	const link = await webfinger.queryAcctLink(handle)
	if (link === null) {
		return new Response('', { status: 404 })
	}

	const actor = await actors.getAndCache(link, db)
	const followersIds = await getFollowers(actor)
	const followers = await loadActors(db, followersIds)

	const promises = followers.map((actor) => {
		return loadExternalMastodonAccount(actor)
	})

	const out = await Promise.all(promises)
	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(out), { headers })
}

async function getLocalFollowers(domain: string, handle: LocalHandle, db: Database): Promise<Response> {
	const actorId = actorURL(domain, handle)
	const actor = await actors.getAndCache(actorId, db)

	const followers = await localFollow.getFollowers(db, actor)
	const out: Array<MastodonAccount> = []

	for (let i = 0, len = followers.length; i < len; i++) {
		const id = new URL(followers[i])

		try {
			const actor = await actors.getAndCache(id, db)
			out.push(await loadExternalMastodonAccount(actor))
		} catch (err: any) {
			console.warn(`failed to retrieve follower (${id}): ${err.message}`)
		}
	}

	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(out), { headers })
}
