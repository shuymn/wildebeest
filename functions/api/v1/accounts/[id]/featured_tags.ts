// https://docs.joinmastodon.org/methods/accounts/#featured_tags

import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { ContextData, Env } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils/cors'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

// TODO: implement
export const onRequestGet: PagesFunction<Env, 'id', ContextData> = async ({ params: { id } }) => {
	if (typeof id !== 'string') {
		return resourceNotFound('id', String(id))
	}
	return new Response(JSON.stringify([]), { headers })
}
