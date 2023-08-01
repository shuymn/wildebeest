// https://docs.joinmastodon.org/methods/statuses/#boost
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { createAnnounceActivity } from 'wildebeest/backend/src/activitypub/activities/announce'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { deliverFollowers, deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { getApId, getObjectByMastodonId } from 'wildebeest/backend/src/activitypub/objects'
import { originalActorIdSymbol, originalObjectIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import type { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { recordNotFound } from 'wildebeest/backend/src/errors'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { createReblog } from 'wildebeest/backend/src/mastodon/reblog'
import { toMastodonStatusFromObject } from 'wildebeest/backend/src/mastodon/status'
import type { ContextData, DeliverMessageBody, Env, Queue, Visibility } from 'wildebeest/backend/src/types'
import { readBody } from 'wildebeest/backend/src/utils'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { z } from 'zod'

const schema = z.object({
	visibility: z
		.union([z.literal('public'), z.literal('unlisted'), z.literal('private'), z.literal('direct')])
		.default('public'),
})

type Parameters = z.infer<typeof schema>

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ env, data, params: { id }, request }) => {
	if (typeof id !== 'string') {
		return new Response('', { status: 400 })
	}

	const result = await readBody(request, schema)
	if (!result.success) {
		return new Response('', { status: 400 })
	}

	const url = new URL(request.url)
	return handleRequest(
		await getDatabase(env),
		id,
		data.connectedActor,
		env.userKEK,
		env.QUEUE,
		url.hostname,
		result.data
	)
}

export async function handleRequest(
	db: Database,
	id: string,
	connectedActor: Person,
	userKEK: string,
	queue: Queue<DeliverMessageBody>,
	domain: string,
	{ visibility }: Parameters
): Promise<Response> {
	const obj = await getObjectByMastodonId<Note>(db, id)
	if (obj === null || reblogNotAllowed(connectedActor, obj, visibility)) {
		return recordNotFound(`object ${id} not found`)
	}

	const status = await toMastodonStatusFromObject(db, obj, domain)
	if (status === null) {
		return recordNotFound(`object ${id} not found`)
	}

	const to = new Set<string>()
	const cc = new Set<string>()
	if (visibility === 'public') {
		to.add(PUBLIC_GROUP)
		cc.add(connectedActor.followers.toString())
		if (obj.attributedTo) {
			cc.add(getApId(obj.attributedTo).toString())
		}
	} else if (visibility === 'unlisted') {
		to.add(connectedActor.followers.toString())
		cc.add(PUBLIC_GROUP)
		if (obj.attributedTo) {
			cc.add(getApId(obj.attributedTo).toString())
		}
	} else if (visibility === 'private') {
		to.add(connectedActor.followers.toString())
		if (obj.attributedTo) {
			cc.add(getApId(obj.attributedTo).toString())
		}
	}

	let activity
	if (obj[originalObjectIdSymbol]) {
		// Reblogging an external object delivers the announce activity to the post author.
		const targetActor = await actors.getAndCache(new URL(obj[originalActorIdSymbol]), db)
		if (targetActor === null) {
			return recordNotFound(`target Actor ${obj[originalActorIdSymbol]} not found`)
		}

		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		activity = await createAnnounceActivity(db, domain, connectedActor, new URL(obj[originalObjectIdSymbol]), to, cc)

		await Promise.all([
			// Delivers the announce activity to the post author.
			deliverToActor(signingKey, connectedActor, targetActor, activity, domain),
			// Share reblogged by delivering the announce activity to followers
			deliverFollowers(db, userKEK, connectedActor, activity, queue),
		])
	} else {
		activity = await createAnnounceActivity(db, domain, connectedActor, new URL(obj.id), to, cc)
	}

	await createReblog(db, connectedActor, obj, activity, activity.published ?? new Date().toISOString())
	status.reblogged = true

	return new Response(JSON.stringify(status), { headers })
}

function reblogNotAllowed(actor: Person, obj: Note, visibility: Visibility): boolean {
	const to = (Array.isArray(obj.to) ? obj.to : [obj.to]).map((target) => getApId(target).toString())
	const cc = (Array.isArray(obj.cc) ? obj.cc : [obj.cc]).map((target) => getApId(target).toString())

	if (actor.id.toString() !== getApId(obj.attributedTo).toString()) {
		return !(to.includes(PUBLIC_GROUP) || cc.includes(PUBLIC_GROUP))
	}

	// self reblog

	// public or unlisted status -> allowed all visibility
	if (to.includes(PUBLIC_GROUP) || cc.includes(PUBLIC_GROUP)) {
		return false
	}

	// private status -> allowed only to followers
	if (to.includes(actor.followers.toString())) {
		return visibility === 'public' || visibility === 'unlisted'
	}

	return visibility === 'direct'
}
