// https://docs.joinmastodon.org/methods/notifications/#get-one

import { Hono } from 'hono'

import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import type { Person } from 'wildebeest/backend/src/activitypub/actors'
import { getActorById, getAndCacheActor } from 'wildebeest/backend/src/activitypub/actors'
import {
	ensureObjectMastodonId,
	getObjectByOriginalId,
	mastodonIdSymbol,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as query from 'wildebeest/backend/src/database/d1/querier'
import { statusNotFound } from 'wildebeest/backend/src/errors'
import { loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { actorToMention, detectVisibility } from 'wildebeest/backend/src/mastodon/status'
import { fromObject } from 'wildebeest/backend/src/media'
import type { HonoEnv } from 'wildebeest/backend/src/types'
import { isNotificationType, type Notification } from 'wildebeest/backend/src/types/notification'
import { HTTPS } from 'wildebeest/backend/src/utils'
import { actorToHandle, handleToAcct } from 'wildebeest/backend/src/utils/handle'

const headers = {
	'content-type': 'application/json; charset=utf-8',
}

const app = new Hono<HonoEnv>()

app.get<'/:id'>(async ({ req, env }) => {
	if (!env.data.connectedActor) {
		return statusNotFound('not authorized')
	}
	const domain = new URL(req.url).hostname
	return handleRequest(domain, req.param('id'), await getDatabase(env), env.data.connectedActor)
})

export async function handleRequest(
	domain: string,
	id: string,
	db: Database,
	connectedActor: Person
): Promise<Response> {
	const row = await query.selectNotificationsByIdAndActorId(db, {
		id: parseInt(id, 10),
		actorId: connectedActor.id.toString(),
	})
	if (!row) {
		return statusNotFound('notification')
	}

	const fromActorId = new URL(row.notificationFromActorId)
	const fromActor = await getActorById(db, fromActorId)
	if (!fromActor) {
		throw new Error('unknown from actor')
	}

	const fromHandle = actorToHandle(fromActor)
	const fromAccount = await loadMastodonAccount(db, domain, fromActor, fromHandle)

	const { notificationType } = row
	if (!isNotificationType(notificationType)) {
		throw new Error(`unknown notification type ${notificationType}`)
	}
	const out: Notification = {
		id: row.notificationId.toString(),
		type: notificationType,
		created_at: new Date(row.notificationCdate).toISOString(),
		account: fromAccount,
	}

	if (notificationType === 'mention' || notificationType === 'favourite') {
		if (row.id === null || row.type !== 'Note') {
			throw new Error('notification object is null')
		}

		row.mastodonId = await ensureObjectMastodonId(db, row.mastodonId, row.cdate)

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
			const replied = await getObjectByOriginalId(domain, db, properties.inReplyTo)
			if (replied) {
				inReplyToId = replied[mastodonIdSymbol]
				const author = await getAndCacheActor(new URL(replied[originalActorIdSymbol]), db).catch((err) => {
					console.warn('failed to get author of reply', err)
					return null
				})
				if (author) {
					inReplyToAccountId = author[mastodonIdSymbol]
				} else {
					inReplyToId = null
				}
			}
		}

		out.status = {
			id: row.mastodonId,
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
				? new URL(`/@${handleToAcct(fromHandle, domain)}/${row.mastodonId}`, HTTPS + domain)
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

export default app
