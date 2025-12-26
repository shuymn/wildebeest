// https://docs.joinmastodon.org/methods/statuses/#history

import { Hono } from 'hono'

import { Actor, getActorById } from '@wildebeest/backend/activitypub/actors'
import { getObjectByMastodonId, originalActorIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { isNote, Note } from '@wildebeest/backend/activitypub/objects/note'
import { Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, recordNotFound, statusNotFound } from '@wildebeest/backend/errors'
import { getStatusRevisions, isVisible } from '@wildebeest/backend/mastodon/status'
import { HonoEnv, MastodonId, MastodonStatusEdit } from '@wildebeest/backend/types'
import { cors, makeJsonResponse, MastodonApiResponse } from '@wildebeest/backend/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = {
	domain: string
	db: Database
	connectedActor?: Actor
}

const app = new Hono<HonoEnv>()

app.get<'/:id/history'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}

	const url = new URL(req.url)
	return handleRequestGet(
		{
			domain: url.hostname,
			db: getDatabase(env),
			connectedActor: env.data.connectedActor,
		},
		req.param('id')
	)
})

async function handleRequestGet(
	{ domain, db, connectedActor }: Dependencies,
	id: MastodonId
): Promise<MastodonApiResponse<MastodonStatusEdit[]>> {
	const obj = await getObjectByMastodonId<Note>(domain, db, id)
	if (obj === null) {
		return recordNotFound(id)
	}
	if (!isNote(obj)) {
		return statusNotFound(id)
	}
	const author = await getActorById(db, obj[originalActorIdSymbol])
	if (author === null) {
		return recordNotFound(id)
	}
	try {
		const visible = await isVisible(db, author, connectedActor, obj)
		if (!visible) {
			return statusNotFound(id)
		}
	} catch (err) {
		if (err instanceof Error) {
			if (err.message === 'viewer is required') {
				return notAuthorized('missing authorization')
			}
		}
		throw err
	}
	return makeJsonResponse(await getStatusRevisions(domain, db, author, obj), { headers })
}

export default app
