// https://docs.joinmastodon.org/methods/accounts/#lists

import { resourceNotFound } from 'wildebeest/backend/src/errors'
import { ContextData } from 'wildebeest/backend/src/types/context'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { Env } from 'wildebeest/consumer/src'

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
