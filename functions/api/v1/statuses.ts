// https://docs.joinmastodon.org/methods/statuses/#create

import { createCreateActivity } from 'wildebeest/backend/src/activitypub/activities/create'
import { Person } from 'wildebeest/backend/src/activitypub/actors'
import { addObjectInOutbox } from 'wildebeest/backend/src/activitypub/actors/outbox'
import { deliverFollowers, deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import {
	Document,
	getObjectByMastodonId,
	isDocument,
	originalObjectIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { newMention } from 'wildebeest/backend/src/activitypub/objects/mention'
import { createDirectNote, createPublicNote, Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { Cache, cacheFromEnv } from 'wildebeest/backend/src/cache'
import { Database, getDatabase } from 'wildebeest/backend/src/database'
import { exceededLimit, statusNotFound, validationError } from 'wildebeest/backend/src/errors'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { getHashtags, insertHashtags } from 'wildebeest/backend/src/mastodon/hashtag'
import * as idempotency from 'wildebeest/backend/src/mastodon/idempotency'
import { enrichStatus } from 'wildebeest/backend/src/mastodon/microformats'
import { insertReply } from 'wildebeest/backend/src/mastodon/reply'
import { getMentions, toMastodonStatusFromObject } from 'wildebeest/backend/src/mastodon/status'
import * as timeline from 'wildebeest/backend/src/mastodon/timeline'
import { ContextData, DeliverMessageBody, Env, Queue, Visibility } from 'wildebeest/backend/src/types'
import { cors, myz, readBody } from 'wildebeest/backend/src/utils'
import { z } from 'zod'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

const MAX_STATUS_LENGTH = 500
const MAX_MEDIA_ATTACHMENTS = 4

const schema = z.object({
	// TODO: check server settings for max length
	status: z.string().max(MAX_STATUS_LENGTH),
	visibility: z.union([
		z.literal('public'),
		z.literal('unlisted'),
		z.literal('private'),
		z.literal('direct'),
	]) satisfies z.ZodType<Visibility>,
	sensitive: myz.logical().default(false),
	// TODO: check server settings for max length
	media_ids: z.optional(z.array(z.string()).max(MAX_MEDIA_ATTACHMENTS)),
	in_reply_to_id: z.string().optional(),
})

type Parameters = z.infer<typeof schema>

type Dependencies = {
	domain: string
	db: Database
	connectedActor: Person
	userKEK: string
	queue: Queue<DeliverMessageBody>
	cache: Cache
}

export const onRequestPost: PagesFunction<Env, '', ContextData> = async ({
	request,
	env,
	data: { connectedActor },
}) => {
	const result = await readBody(request, schema)
	if (result.success) {
		const url = new URL(request.url)
		return handleRequest(
			{
				domain: url.hostname,
				db: await getDatabase(env),
				connectedActor,
				userKEK: env.userKEK,
				queue: env.QUEUE,
				cache: cacheFromEnv(env),
			},
			result.data,
			request.headers.get('Idempotency-Key')
		)
	}
	const { issues } = result.error
	// status
	{
		const errors = issues.filter(({ path: [key] }) => key === 'status')
		if (errors.some(({ code }) => code === 'too_big')) {
			return validationError('text character limit of 500 exceeded')
		}
	}
	// media_ids
	{
		const errors = issues.filter(({ path: [key] }) => key === 'media_ids')
		if (errors.some(({ code }) => code === 'too_big')) {
			return exceededLimit('up to 4 images are allowed')
		}
	}
	return new Response('', { status: 400 })
}

// FIXME: add tests for delivery to followers and mentions to a specific Actor.
export async function handleRequest(
	{ domain, db, connectedActor, userKEK, queue, cache }: Dependencies,
	params: Parameters,
	idempotencyKey: string | null
): Promise<Response> {
	if (idempotencyKey !== null) {
		const maybeObject = await idempotency.hasKey<Note>(db, idempotencyKey)
		if (maybeObject !== null) {
			const res = await toMastodonStatusFromObject(db, maybeObject, domain)
			return new Response(JSON.stringify(res), { headers })
		}
	}

	const mediaAttachments: Document[] = []
	if (params.media_ids && params.media_ids.length > 0) {
		for (const id of [...params.media_ids]) {
			const document = await getObjectByMastodonId(db, id)
			if (document === null) {
				console.warn('object attachement not found: ' + id)
				continue
			}
			if (!isDocument(document)) {
				console.warn('object is not a document: ' + id)
				continue
			}
			mediaAttachments.push(document)
		}
	}

	let inReplyToObject
	if (params.in_reply_to_id) {
		inReplyToObject = await getObjectByMastodonId<Note>(db, params.in_reply_to_id)
		if (inReplyToObject === null) {
			return statusNotFound(params.in_reply_to_id)
		}
	}

	const extraProperties: PartialProps<Pick<Note, 'source' | 'sensitive' | 'inReplyTo' | 'tag'>, 'inReplyTo' | 'tag'> = {
		source: {
			content: params.status,
			mediaType: 'text/plain',
		},
		sensitive: params.sensitive,
	}
	if (inReplyToObject) {
		extraProperties.inReplyTo = inReplyToObject[originalObjectIdSymbol] || inReplyToObject.id.toString()
	}

	const mentions = await getMentions(params.status, domain, db)
	if (mentions.length > 0) {
		extraProperties.tag = mentions.map((actor) => newMention(actor, domain))
	}

	const content = enrichStatus(params.status, mentions)

	let note
	if (params.visibility === 'public') {
		note = await createPublicNote(domain, db, content, connectedActor, mediaAttachments, extraProperties)
	} else if (params.visibility === 'direct') {
		note = await createDirectNote(domain, db, content, connectedActor, mentions, mediaAttachments, extraProperties)
	} else {
		return validationError(`status with visibility: ${params.visibility}`)
	}

	const hashtags = getHashtags(params.status)
	if (hashtags.length > 0) {
		await insertHashtags(db, note, hashtags)
	}

	if (inReplyToObject) {
		// after the status has been created, record the reply.
		await insertReply(db, connectedActor, note, inReplyToObject)
	}

	const activity = createCreateActivity(domain, connectedActor, note)
	await deliverFollowers(db, userKEK, connectedActor, activity, queue)

	if (params.visibility === 'public') {
		await addObjectInOutbox(db, connectedActor, note)

		// A public note is sent to the public group URL and cc'ed any mentioned
		// actors.
		for (const targetActor of mentions) {
			if (Array.isArray(note.cc)) {
				note.cc.push(targetActor.id)
			} else {
				note.cc = [note.cc, targetActor.id]
			}
		}
	} else if (params.visibility === 'direct') {
		//  A direct note is sent to mentioned people only
		for (const targetActor of mentions) {
			await addObjectInOutbox(db, connectedActor, note, undefined, targetActor.id.toString())
		}
	}

	// If the status is mentioning other persons, we need to delivery it to them.
	for (const targetActor of mentions) {
		const activity = createCreateActivity(domain, connectedActor, note)
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await deliverToActor(signingKey, connectedActor, targetActor, activity, domain)
	}

	if (idempotencyKey !== null) {
		await idempotency.insertKey(db, idempotencyKey, note)
	}

	await timeline.pregenerateTimelines(domain, db, cache, connectedActor)

	const res = await toMastodonStatusFromObject(db, note, domain)
	return new Response(JSON.stringify(res), { headers })
}
