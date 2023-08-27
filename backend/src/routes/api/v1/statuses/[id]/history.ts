// https://docs.joinmastodon.org/methods/statuses/#history

import { Hono } from 'hono'

import { Actor, getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { getObjectByMastodonId, originalActorIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { isNote, Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database, getDatabase } from 'wildebeest/backend/src/database'
import { notAuthorized, recordNotFound, statusNotFound } from 'wildebeest/backend/src/errors'
import { getStatusRevisions, isVisible } from 'wildebeest/backend/src/mastodon/status'
import { HonoEnv, MastodonId, MastodonStatusEdit } from 'wildebeest/backend/src/types'
import { cors, makeJsonResponse, MastodonApiResponse } from 'wildebeest/backend/src/utils'

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
			db: await getDatabase(env),
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
