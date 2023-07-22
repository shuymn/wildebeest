// https://docs.joinmastodon.org/methods/statuses/#get

import { createDeleteActivity } from 'wildebeest/backend/src/activitypub/activities/delete'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import { deliverFollowers } from 'wildebeest/backend/src/activitypub/deliver'
import { deleteObject, getObjectByMastodonId } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Cache, cacheFromEnv } from 'wildebeest/backend/src/cache'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { getMastodonStatusById, toMastodonStatusFromObject } from 'wildebeest/backend/src/mastodon/status'
import * as timeline from 'wildebeest/backend/src/mastodon/timeline'
import type { MastodonId } from 'wildebeest/backend/src/types'
import type { ContextData } from 'wildebeest/backend/src/types/context'
import type { Env } from 'wildebeest/backend/src/types/env'
import type { DeliverMessageBody, Queue } from 'wildebeest/backend/src/types/queue'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToAcct } from 'wildebeest/backend/src/utils/handle'

export const onRequestGet: PagesFunction<Env, any, ContextData> = async ({ params, env, request, data }) => {
	const domain = new URL(request.url).hostname
	return handleRequestGet(await getDatabase(env), params.id as MastodonId, domain, data.connectedActor)
}

export const onRequestDelete: PagesFunction<Env, any, ContextData> = async ({ params, env, request, data }) => {
	const domain = new URL(request.url).hostname
	return handleRequestDelete(
		await getDatabase(env),
		params.id as MastodonId,
		data.connectedActor,
		domain,
		env.userKEK,
		env.QUEUE,
		cacheFromEnv(env)
	)
}

export async function handleRequestGet(
	db: Database,
	id: MastodonId,
	domain: string,
	// To be used when we implement private statuses
	// eslint-disable-next-line unused-imports/no-unused-vars
	connectedActor: Person
): Promise<Response> {
	const status = await getMastodonStatusById(db, id, domain)
	if (status === null) {
		return new Response('', { status: 404 })
	}

	// future validation for private statuses
	/*
	if (status.private && status.account.id !== actorToHandle(connectedActor)) {
		return errors.notAuthorized('status is private')
	}
	*/

	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(status), { headers })
}

export async function handleRequestDelete(
	db: Database,
	id: MastodonId,
	connectedActor: Person,
	domain: string,
	userKEK: string,
	queue: Queue<DeliverMessageBody>,
	cache: Cache
): Promise<Response> {
	const obj = (await getObjectByMastodonId(db, id)) as Note
	if (obj === null) {
		return errors.statusNotFound(id)
	}

	const status = await toMastodonStatusFromObject(db, obj, domain)
	if (status === null) {
		return errors.statusNotFound(id)
	}
	if (status.account.acct !== actorToAcct(connectedActor)) {
		return errors.statusNotFound(id)
	}

	await deleteObject(db, obj)

	// FIXME: deliver a Delete message to our peers
	const activity = createDeleteActivity(domain, connectedActor, obj)
	await deliverFollowers(db, userKEK, connectedActor, activity, queue)

	await timeline.pregenerateTimelines(domain, db, cache, connectedActor)

	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}
	return new Response(JSON.stringify(status), { headers })
}
