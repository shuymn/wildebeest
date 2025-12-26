// https://docs.joinmastodon.org/methods/statuses/#get

import { Hono } from 'hono'
import { z } from 'zod'

import { createDeleteActivity } from '@wildebeest/backend/activitypub/activities/delete'
import { createUpdateActivity } from '@wildebeest/backend/activitypub/activities/update'
import type { Person } from '@wildebeest/backend/activitypub/actors'
import { deliverFollowers } from '@wildebeest/backend/activitypub/deliver'
import { deleteObject, getObjectByMastodonId, originalActorIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { Image, isImage } from '@wildebeest/backend/activitypub/objects/image'
import { newMention } from '@wildebeest/backend/activitypub/objects/mention'
import { Note, updateNote } from '@wildebeest/backend/activitypub/objects/note'
import { Cache, cacheFromEnv } from '@wildebeest/backend/cache'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import * as errors from '@wildebeest/backend/errors'
import { enrichStatus } from '@wildebeest/backend/mastodon/microformats'
import {
	getMastodonStatusById,
	getMentions,
	MAX_MEDIA_ATTACHMENTS,
	MAX_STATUS_LENGTH,
	toMastodonStatusFromObject,
} from '@wildebeest/backend/mastodon/status'
import * as timeline from '@wildebeest/backend/mastodon/timeline'
import type { DeliverMessageBody, HonoEnv, MastodonId, Queue } from '@wildebeest/backend/types'
import { cors, readBody } from '@wildebeest/backend/utils'
import { actorToAcct } from '@wildebeest/backend/utils/handle'
import myz from '@wildebeest/backend/utils/zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	const domain = new URL(req.url).hostname
	return handleRequestGet(getDatabase(env), req.param('id'), domain, env.data.connectedActor)
})

const schema = z.object({
	status: z.string().max(MAX_STATUS_LENGTH).optional(),
	spoiler_text: z.string().optional(),
	sensitive: myz.logical().optional(),
	media_ids: z.array(z.string()).max(MAX_MEDIA_ATTACHMENTS).optional(),
	// TODO: support polls, language
})

type PutParameters = z.infer<typeof schema>

type PutDependencies = {
	domain: string
	db: Database
	connectedActor: Person
	userKEK: string
	queue: Queue<DeliverMessageBody>
	cache: Cache
}

app.put<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return errors.notAuthorized('not authorized')
	}

	const result = await readBody(req.raw, schema)
	if (result.success) {
		const url = new URL(req.url)
		return handleRequestPut(
			{
				domain: url.hostname,
				db: getDatabase(env),
				connectedActor: env.data.connectedActor,
				userKEK: env.userKEK,
				queue: env.QUEUE,
				cache: cacheFromEnv(env),
			},
			req.param('id'),
			result.data
		)
	}
	const { issues } = result.error
	if (issues.length > 0) {
		const [issue] = issues
		return errors.validationError(`Validation failed: ${issue.path[0]} ${issue.code}`)
	}
	return new Response('', { status: 400 })
})

app.delete<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return errors.notAuthorized('not authorized')
	}

	const domain = new URL(req.url).hostname
	return handleRequestDelete(
		getDatabase(env),
		req.param('id'),
		env.data.connectedActor,
		domain,
		env.userKEK,
		env.QUEUE,
		cacheFromEnv(env)
	)
})

async function handleRequestGet(
	db: Database,
	id: MastodonId,
	domain: string,
	connectedActor: Person | null
): Promise<Response> {
	const status = await getMastodonStatusById(db, id, domain)
	if (status === null) {
		return new Response('', { status: 404 })
	}

	if (status.visibility === 'public' || status.visibility === 'unlisted') {
		return new Response(JSON.stringify(status), { headers })
	}

	if (!connectedActor || status.account.acct !== actorToAcct(connectedActor, domain)) {
		return errors.notAuthorized('status is private')
	}
	return new Response(JSON.stringify(status), { headers })
}

async function handleRequestPut(
	{ domain, db, connectedActor, userKEK, queue, cache }: PutDependencies,
	id: MastodonId,
	params: PutParameters
): Promise<Response> {
	const currentObj = await getObjectByMastodonId<Note>(domain, db, id)
	if (currentObj === null) {
		return errors.statusNotFound(id)
	}

	if (currentObj[originalActorIdSymbol] !== connectedActor.id.toString()) {
		return errors.statusNotFound(id)
	}

	let updated = false
	const updatedObj = { ...currentObj }

	if (params.media_ids && params.media_ids.length > 0) {
		const mediaAttachments: Image[] = []

		for (const id of [...params.media_ids]) {
			const document = await getObjectByMastodonId(domain, db, id)
			if (document === null) {
				console.warn('object attachment not found: ' + id)
				continue
			}
			if (!isImage(document)) {
				console.warn('object is not a image: ' + id)
				continue
			}
			mediaAttachments.push(document)
		}

		updated = true
		updatedObj.attachment = mediaAttachments
	}

	if (params.status) {
		updated = true
		updatedObj.source = { content: params.status, mediaType: 'text/markdown' }

		const mentions = await getMentions(params.status, domain, db)
		updatedObj.tag = mentions.size > 0 ? [...mentions].map((actor) => newMention(actor, domain)) : undefined

		updatedObj.content = enrichStatus(params.status, mentions)
	}

	if (params.spoiler_text) {
		updated = true
		updatedObj.spoiler_text = params.spoiler_text
	}

	if (params.sensitive !== undefined) {
		updated = true
		updatedObj.sensitive = params.sensitive
	}

	if (updated) {
		updatedObj.updated = new Date().toISOString()

		await updateNote(db, updatedObj, currentObj)

		const activity = await createUpdateActivity(db, domain, connectedActor, updatedObj)
		await deliverFollowers(db, userKEK, connectedActor, activity, queue)

		await timeline.pregenerateTimelines(domain, db, cache, connectedActor)
	}

	const status = await toMastodonStatusFromObject(db, updatedObj, domain)
	if (status === null) {
		return errors.statusNotFound(id)
	}

	return new Response(JSON.stringify(status), { headers })
}

async function handleRequestDelete(
	db: Database,
	id: MastodonId,
	connectedActor: Person,
	domain: string,
	userKEK: string,
	queue: Queue<DeliverMessageBody>,
	cache: Cache
): Promise<Response> {
	const obj = await getObjectByMastodonId<Note>(domain, db, id)
	if (obj === null) {
		return errors.statusNotFound(id)
	}

	if (obj[originalActorIdSymbol] !== connectedActor.id.toString()) {
		return errors.statusNotFound(id)
	}

	await deleteObject(db, obj)

	// FIXME: deliver a Delete message to our peers
	const activity = await createDeleteActivity(db, domain, connectedActor, obj)
	await deliverFollowers(db, userKEK, connectedActor, activity, queue)

	await timeline.pregenerateTimelines(domain, db, cache, connectedActor)

	const status = await toMastodonStatusFromObject(db, obj, domain)
	if (status === null) {
		return errors.statusNotFound(id)
	}

	return new Response(JSON.stringify(status), { headers })
}

export default app
