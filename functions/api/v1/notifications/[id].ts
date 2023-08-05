// https://docs.joinmastodon.org/methods/notifications/#get-one

import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import { getActorById, getAndCache } from 'wildebeest/backend/src/activitypub/actors'
import {
	ensureObjectMastodonId,
	getObjectById,
	getObjectByOriginalId,
	isLocalObject,
	mastodonIdSymbol,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { statusNotFound } from 'wildebeest/backend/src/errors'
import { loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { actorToMention, detectVisibility } from 'wildebeest/backend/src/mastodon/status'
import { fromObject } from 'wildebeest/backend/src/media'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import type { Notification, NotificationsQueryResult } from 'wildebeest/backend/src/types/notification'
import { actorToHandle, handleToAcct } from 'wildebeest/backend/src/utils/handle'

const headers = {
	'content-type': 'application/json; charset=utf-8',
}

export const onRequest: PagesFunction<Env, 'id', ContextData> = async ({ data, request, env, params: { id } }) => {
	if (typeof id !== 'string') {
		return statusNotFound('id')
	}
	const domain = new URL(request.url).hostname
	return handleRequest(domain, id, await getDatabase(env), data.connectedActor)
}

export async function handleRequest(
	domain: string,
	id: string,
	db: Database,
	connectedActor: Person
): Promise<Response> {
	const query = `
SELECT
  objects.*,
  actor_notifications.type as notif_type,
  actor_notifications.actor_id as notif_actor_id,
  actor_notifications.from_actor_id as notif_from_actor_id,
  actor_notifications.cdate as notif_cdate,
  actor_notifications.id as notif_id
FROM actor_notifications
LEFT JOIN objects ON objects.id=actor_notifications.object_id
WHERE actor_notifications.id=? AND actor_notifications.actor_id=?
    `

	const row = await db.prepare(query).bind(id, connectedActor.id.toString()).first<NotificationsQueryResult>()
	if (!row) {
		return statusNotFound('notification')
	}

	const from_actor_id = new URL(row.notif_from_actor_id)
	const fromActor = await getActorById(db, from_actor_id)
	if (!fromActor) {
		throw new Error('unknown from actor')
	}

	const fromHandle = actorToHandle(fromActor)
	const fromAccount = await loadMastodonAccount(db, domain, fromActor, fromHandle)

	const out: Notification = {
		id: row.notif_id.toString(),
		type: row.notif_type,
		created_at: new Date(row.notif_cdate).toISOString(),
		account: fromAccount,
	}

	if (row.notif_type === 'mention' || row.notif_type === 'favourite') {
		if (row.id === null || row.type !== 'Note') {
			throw new Error('notification object is null')
		}

		row.mastodon_id = await ensureObjectMastodonId(db, row.mastodon_id, row.cdate)

		let properties
		if (typeof row.properties === 'object') {
			// neon uses JSONB for properties which is returned as a deserialized
			// object.
			properties = row.properties as Note
		} else {
			// D1 uses a string for JSON properties
			properties = JSON.parse(row.properties) as Note
		}

		const mediaAttachments = Array.isArray(properties.attachment)
			? properties.attachment.map((doc) => fromObject(doc))
			: []

		const mentions = []
		for (const link of properties.tag ?? []) {
			if (link.type === 'Mention') {
				const target = fromActor.id.toString() === link.href.toString() ? fromActor : await getActorById(db, link.href)
				if (target) {
					mentions.push(actorToMention(domain, target))
				}
			}
		}

		let inReplyToId: string | null = null
		let inReplyToAccountId: string | null = null
		if (properties.inReplyTo) {
			const replied = isLocalObject(domain, properties.inReplyTo)
				? await getObjectById(db, properties.inReplyTo)
				: await getObjectByOriginalId(db, properties.inReplyTo)
			if (replied) {
				inReplyToId = replied[mastodonIdSymbol]
				try {
					const author = await getAndCache(new URL(replied[originalActorIdSymbol]), db)
					inReplyToAccountId = author[mastodonIdSymbol]
				} catch (err) {
					console.warn('failed to get author of reply', err)
					inReplyToId = null
				}
			}
		}

		out.status = {
			id: row.mastodon_id,
			uri: new URL(row.id),
			created_at: new Date(properties.published ?? row.cdate).toISOString(),
			// TODO: a shortcut has been taken. We assume that the actor
			// generating the notification also created the object. In practice
			// likely true but not guarantee.
			account: fromAccount,
			content: properties.content,
			visibility: detectVisibility({ to: properties.to, cc: properties.cc, followers: fromActor.followers }),
			sensitive: properties.sensitive,
			spoiler_text: properties.spoiler_text ?? '',
			media_attachments: mediaAttachments,
			mentions,
			url: properties.url
				? new URL(properties.url)
				: isLocalAccount(domain, fromHandle)
				? new URL(`/@${handleToAcct(fromHandle, domain)}/${row.mastodon_id}`, 'https://' + domain)
				: new URL(row.id),
			reblog: null,
			edited_at: properties.updated ? new Date(properties.updated).toISOString() : null,
			in_reply_to_id: inReplyToId,
			in_reply_to_account_id: inReplyToAccountId,

			// TODO: stub values
			reblogs_count: 0,
			favourites_count: 0,
			replies_count: 0,
			tags: [],
			emojis: [],
			favourited: false,
			reblogged: false,
			poll: null,
			card: null,
			language: null,
			text: null,
			muted: false,
			bookmarked: false,
			pinned: false,
			// filtered
		}
	}

	return new Response(JSON.stringify(out), { headers })
}
