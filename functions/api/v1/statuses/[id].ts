// https://docs.joinmastodon.org/methods/statuses/#get

import { createDeleteActivity } from 'wildebeest/backend/src/activitypub/activities/delete'
import { createUpdateActivity } from 'wildebeest/backend/src/activitypub/activities/update'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import { deliverFollowers } from 'wildebeest/backend/src/activitypub/deliver'
import {
	deleteObject,
	getApId,
	getObjectByMastodonId,
	originalActorIdSymbol,
	updateObject,
} from 'wildebeest/backend/src/activitypub/objects'
import { Image, isImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { newMention } from 'wildebeest/backend/src/activitypub/objects/mention'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Cache, cacheFromEnv } from 'wildebeest/backend/src/cache'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import { enrichStatus } from 'wildebeest/backend/src/mastodon/microformats'
import {
	getMastodonStatusById,
	getMentions,
	MAX_MEDIA_ATTACHMENTS,
	MAX_STATUS_LENGTH,
	toMastodonStatusFromObject,
} from 'wildebeest/backend/src/mastodon/status'
import * as timeline from 'wildebeest/backend/src/mastodon/timeline'
import type { ContextData, DeliverMessageBody, Env, MastodonId, Queue } from 'wildebeest/backend/src/types'
import { myz, readBody } from 'wildebeest/backend/src/utils'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { z } from 'zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequestGet: PagesFunction<Env, 'id', ContextData> = async ({ params: { id }, env, request, data }) => {
	if (typeof id !== 'string') {
		return errors.statusNotFound(String(id))
	}
	const domain = new URL(request.url).hostname
	return handleRequestGet(await getDatabase(env), id, domain, data.connectedActor)
}

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

export const onRequestPut: PagesFunction<Env, 'id', ContextData> = async ({
	params: { id },
	env,
	request,
	data: { connectedActor },
}) => {
	if (typeof id !== 'string') {
		return errors.statusNotFound(String(id))
	}
	const result = await readBody(request, schema)
	if (result.success) {
		const url = new URL(request.url)
		return handleRequestPut(
			{
				domain: url.hostname,
				db: await getDatabase(env),
				connectedActor,
				userKEK: env.userKEK,
				queue: env.QUEUE,
				cache: cacheFromEnv(env),
			},
			id,
			result.data
		)
	}
	const { issues } = result.error
	if (issues.length > 0) {
		const [issue] = issues
		return errors.validationError(`Validation failed: ${issue.path[0]} ${issue.code}`)
	}
	return new Response('', { status: 400 })
}

export const onRequestDelete: PagesFunction<Env, 'id', ContextData> = async ({
	params: { id },
	env,
	request,
	data,
}) => {
	if (typeof id !== 'string') {
		return errors.statusNotFound(String(id))
	}
	const domain = new URL(request.url).hostname
	return handleRequestDelete(
		await getDatabase(env),
		id,
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

	return new Response(JSON.stringify(status), { headers })
}

export async function handleRequestPut(
	{ domain, db, connectedActor, userKEK, queue, cache }: PutDependencies,
	id: MastodonId,
	params: PutParameters
): Promise<Response> {
	const obj = await getObjectByMastodonId<Note>(domain, db, id)
	if (obj === null) {
		return errors.statusNotFound(id)
	}

	if (obj[originalActorIdSymbol] !== connectedActor.id.toString()) {
		return errors.statusNotFound(id)
	}

	let updated = false
	const updatedObj = obj

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

		await updateObject(db, updatedObj, getApId(obj.id))

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

export async function handleRequestDelete(
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
