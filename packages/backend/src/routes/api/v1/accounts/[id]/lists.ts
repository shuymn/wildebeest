// https://docs.joinmastodon.org/methods/accounts/#lists

import { Hono } from 'hono'

import { getActorByMastodonId } from '@wildebeest/backend/activitypub/actors'
import { getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, resourceNotFound } from '@wildebeest/backend/errors'
import { getListsContainingAccount } from '@wildebeest/backend/mastodon/list'
import type { HonoEnv } from '@wildebeest/backend/types'
import { cors, makeJsonResponse } from '@wildebeest/backend/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const app = new Hono<HonoEnv>()

app.get<'/:id/lists'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}

	const db = getDatabase(env)
	const target = await getActorByMastodonId(db, req.param('id'))
	if (!target) {
		return resourceNotFound('id', req.param('id'))
	}

	const lists = await getListsContainingAccount(
		db,
		env.data.connectedActor.id.toString(),
		target.id.toString()
	)
	return makeJsonResponse(lists, { headers })
})

export default app
