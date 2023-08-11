// https://docs.joinmastodon.org/methods/statuses/#create

import { createCreateActivity } from 'wildebeest/backend/src/activitypub/activities/create'
import { Person } from 'wildebeest/backend/src/activitypub/actors'
import { addObjectInOutbox } from 'wildebeest/backend/src/activitypub/actors/outbox'
import { deliverFollowers, deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { getObjectByMastodonId, originalObjectIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { Image, isImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { newMention } from 'wildebeest/backend/src/activitypub/objects/mention'
import {
	createDirectNote,
	createPrivateNote,
	createPublicNote,
	createUnlistedNote,
	Note,
} from 'wildebeest/backend/src/activitypub/objects/note'
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
import { PartialProps } from 'wildebeest/backend/src/utils/type'
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

	const mediaAttachments: Image[] = []
	if (params.media_ids && params.media_ids.length > 0) {
		for (const id of [...params.media_ids]) {
			const document = await getObjectByMastodonId(db, id)
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
			// TODO: selectable mediaType
			mediaType: 'text/markdown',
		},
		sensitive: params.sensitive,
	}
	if (inReplyToObject) {
		extraProperties.inReplyTo = inReplyToObject[originalObjectIdSymbol] || inReplyToObject.id.toString()
	}

	const mentions = await getMentions(params.status, domain, db)
	if (mentions.size > 0) {
		extraProperties.tag = [...mentions].map((actor) => newMention(actor, domain))
	}

	const content = enrichStatus(params.status, mentions)

	let createFn
	if (params.visibility === 'public') {
		createFn = createPublicNote
	} else if (params.visibility === 'unlisted') {
		createFn = createUnlistedNote
	} else if (params.visibility === 'private') {
		createFn = createPrivateNote
	} else if (params.visibility === 'direct') {
		if (mentions.size === 0) {
			return validationError('direct messages must have at least one mention')
		}
		createFn = createDirectNote
	} else {
		return validationError(`status with visibility: ${params.visibility}`)
	}

	const note = await createFn(domain, db, content, connectedActor, mentions, mediaAttachments, extraProperties)

	const hashtags = getHashtags(params.status)
	if (hashtags.length > 0) {
		await insertHashtags(db, note, hashtags)
	}

	if (inReplyToObject) {
		// after the status has been created, record the reply.
		await insertReply(db, connectedActor, note, inReplyToObject)
	}

	const activity = await createCreateActivity(db, domain, connectedActor, note)

	const to = Array.isArray(activity.to) ? activity.to : [activity.to]
	const cc = Array.isArray(activity.cc) ? activity.cc : [activity.cc]
	await addObjectInOutbox(db, connectedActor, note, activity.to, activity.cc, note.published)

	const followersUrl = connectedActor.followers.toString()
	if (cc.includes(followersUrl) || to.includes(followersUrl)) {
		await deliverFollowers(db, userKEK, connectedActor, activity, queue)
	}

	// If the status is mentioning other persons, we need to delivery it to them.
	for (const targetActor of mentions) {
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await deliverToActor(signingKey, connectedActor, targetActor, activity, domain)
	}

	if (idempotencyKey !== null) {
		await idempotency.insertKey(db, idempotencyKey, note)
	}

	await timeline.pregenerateTimelines(domain, db, cache, connectedActor)

	const res = await toMastodonStatusFromObject(db, note, domain, mentions)
	return new Response(JSON.stringify(res), { headers })
}
