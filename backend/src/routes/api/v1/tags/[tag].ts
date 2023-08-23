// https://docs.joinmastodon.org/methods/tags/#get

import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getTag } from 'wildebeest/backend/src/mastodon/hashtag'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

const headers = {
	...cors(),
	'content-type': 'application/json',
} as const

export const onRequestGet: PagesFunction<Env, any, ContextData> = async ({ params, env, request }) => {
	const domain = new URL(request.url).hostname
	return handleRequestGet(await getDatabase(env), domain, params.tag as string)
}

export async function handleRequestGet(db: Database, domain: string, value: string): Promise<Response> {
	const tag = await getTag(db, domain, value)
	if (tag === null) {
		return errors.tagNotFound(value)
	}
	return new Response(JSON.stringify(tag), { headers })
}
