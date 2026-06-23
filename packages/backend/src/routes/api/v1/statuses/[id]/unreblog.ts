// https://docs.joinmastodon.org/methods/statuses/#unreblog

import { Hono } from 'hono'

import { createUndoAnnounceActivity } from '@wildebeest/backend/activitypub/activities/undo'
import { type Person } from '@wildebeest/backend/activitypub/actors'
import { getObjectByMastodonId } from '@wildebeest/backend/activitypub/objects'
import { isNote, type Note } from '@wildebeest/backend/activitypub/objects/note'
import { cacheFromEnv, type Cache } from '@wildebeest/backend/cache'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import { notAuthorized, recordNotFound } from '@wildebeest/backend/errors'
import { deliverUndoAnnounce, getRemoteAnnounceTargetActor } from '@wildebeest/backend/mastodon/announce_delivery'
import { deleteReblog, getReblogActivity } from '@wildebeest/backend/mastodon/reblog'
import {
	canViewStatus,
	setMastodonStatusViewerState,
	toMastodonStatusFromObject,
} from '@wildebeest/backend/mastodon/status'
import * as timeline from '@wildebeest/backend/mastodon/timeline'
import type { DeliverMessageBody, HonoEnv, Queue } from '@wildebeest/backend/types'
import { cors } from '@wildebeest/backend/utils/cors'

const app = new Hono<HonoEnv>()

app.post<'/:id/unreblog'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return notAuthorized('not authorized')
	}
	const domain = new URL(req.url).hostname
	return handleRequest(
		getDatabase(env),
		req.param('id'),
		env.data.connectedActor,
		domain,
		cacheFromEnv(env),
		env.userKEK,
		env.QUEUE
	)
})

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

async function handleRequest(
	db: Database,
	id: string,
	connectedActor: Person,
	domain: string,
	cache: Cache,
	userKEK: string,
	queue: Queue<DeliverMessageBody>
): Promise<Response> {
	const obj = await getObjectByMastodonId<Note>(domain, db, id)
	if (obj === null || !isNote(obj)) {
		return recordNotFound(`object ${id} not found`)
	}

	if (!(await canViewStatus(db, obj, connectedActor))) {
		return recordNotFound(`object ${id} not found`)
	}

	const reblogActivity = await getReblogActivity(db, connectedActor, obj)
	const deleted = await deleteReblog(db, connectedActor, obj)
	if (deleted && reblogActivity !== null) {
		const undoActivity = await createUndoAnnounceActivity(db, domain, connectedActor, reblogActivity)
		const targetActor = await getRemoteAnnounceTargetActor(db, domain, connectedActor, obj, { skipSelf: true })
		if (targetActor !== null) {
			await deliverUndoAnnounce(db, userKEK, connectedActor, reblogActivity, undoActivity, queue, domain, targetActor)
		}
	}
	await timeline.pregenerateTimelines(domain, db, cache, connectedActor)

	const status = await toMastodonStatusFromObject(db, obj, domain)
	if (status === null) {
		return recordNotFound(`object ${id} not found`)
	}
	await setMastodonStatusViewerState(db, status, obj, connectedActor)

	return new Response(JSON.stringify(status), { headers })
}

export default app
