// https://docs.joinmastodon.org/methods/statuses/#context

import { getObjectByMastodonId } from 'wildebeest/backend/src/activitypub/objects'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { getReplies } from 'wildebeest/backend/src/mastodon/reply'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import type { Context } from 'wildebeest/backend/src/types/status'
import { cors } from 'wildebeest/backend/src/utils/cors'

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ request, env, params }) => {
	const domain = new URL(request.url).hostname
	return handleRequest(domain, await getDatabase(env), params.id as string)
}

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export async function handleRequest(domain: string, db: Database, id: string): Promise<Response> {
	const obj = await getObjectByMastodonId(domain, db, id)
	if (obj === null) {
		return new Response('', { status: 404 })
	}

	const descendants = await getReplies(domain, db, obj)
	const out: Context = {
		ancestors: [],
		descendants,
	}

	return new Response(JSON.stringify(out), { headers })
}
