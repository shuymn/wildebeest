import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as timelines from 'wildebeest/backend/src/mastodon/timeline'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { getDomain } from 'wildebeest/backend/src/utils/getDomain'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, any, ContextData> = async ({ request, env, params }) => {
	const url = new URL(request.url)
	return handleRequest(await getDatabase(env), request, getDomain(url), params.tag as string)
}

export async function handleRequest(db: Database, request: Request, domain: string, tag: string): Promise<Response> {
	// FIXME: handle query params
	const url = new URL(request.url)
	if (url.searchParams.has('max_id')) {
		return new Response(JSON.stringify([]), { headers })
	}

	const timeline = await timelines.getPublicTimeline(
		domain,
		db,
		timelines.LocalPreference.NotSet,
		false,
		20,
		undefined,
		undefined,
		tag
	)
	return new Response(JSON.stringify(timeline), { headers })
}
