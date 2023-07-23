// https://docs.joinmastodon.org/methods/accounts/#following

import { isLocalAccount } from 'wildebeest/backend/src/accounts/getAccount'
import { actorURL } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { getFollowing, loadActors } from 'wildebeest/backend/src/activitypub/actors/follow'
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
		return getLocalFollowing(domain, handle, db)
	}
	// Retrieve the infos of a remote actor
	return getRemoteFollowing(handle, db)
}

async function getRemoteFollowing(handle: RemoteHandle, db: Database): Promise<Response> {
	const link = await webfinger.queryAcctLink(handle)
	if (link === null) {
		return new Response('', { status: 404 })
	}

	const actor = await actors.getAndCache(link, db)
	const followingIds = await getFollowing(actor)
	const following = await loadActors(db, followingIds)

	const promises = following.map((actor) => {
		return loadExternalMastodonAccount(db, actor)
	})

	const out = await Promise.all(promises)
	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(out), { headers })
}

async function getLocalFollowing(domain: string, handle: LocalHandle, db: Database): Promise<Response> {
	const actorId = actorURL(domain, handle)
	const actor = await actors.getAndCache(actorId, db)

	const following = await localFollow.getFollowingId(db, actor)
	const out: Array<MastodonAccount> = []

	for (let i = 0, len = following.length; i < len; i++) {
		const id = new URL(following[i])

		try {
			const actor = await actors.getAndCache(id, db)
			out.push(await loadExternalMastodonAccount(db, actor))
		} catch (err: any) {
			console.warn(`failed to retrieve following (${id}): ${err.message}`)
		}
	}

	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(out), { headers })
}
