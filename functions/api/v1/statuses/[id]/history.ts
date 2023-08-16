// https://docs.joinmastodon.org/methods/statuses/#history

import { Actor, getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { getObjectByMastodonId, originalActorIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { isNote, Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Database, getDatabase } from 'wildebeest/backend/src/database'
import { recordNotFound, statusNotFound } from 'wildebeest/backend/src/errors'
import { getStatusRevisions, isVisible } from 'wildebeest/backend/src/mastodon/status'
import { ContextData, Env, MastodonId, MastodonStatusEdit } from 'wildebeest/backend/src/types'
import { cors, makeJsonResponse, MastodonApiResponse } from 'wildebeest/backend/src/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

type Dependencies = {
	domain: string
	db: Database
	connectedActor: Actor
}

export const onRequestGet: PagesFunction<Env, 'id', ContextData> = async ({
	request,
	env,
	params: { id },
	data: { connectedActor },
}) => {
	if (typeof id !== 'string') {
		return statusNotFound(String(id))
	}
	const url = new URL(request.url)
	return handleRequestGet(
		{
			domain: url.hostname,
			db: await getDatabase(env),
			connectedActor,
		},
		id
	)
}

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
	const visible = await isVisible(db, author, connectedActor, obj)
	if (!visible) {
		return statusNotFound(id)
	}
	return makeJsonResponse(await getStatusRevisions(domain, db, author, obj), { headers })
}
