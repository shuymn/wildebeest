import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { getActorById, getAndCacheActor } from 'wildebeest/backend/src/activitypub/actors'
import {
	type ApObject,
	ensureObjectMastodonId,
	getApUrl,
	getObjectByOriginalId,
	mastodonIdSymbol,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import type { Cache } from 'wildebeest/backend/src/cache'
import { type Database } from 'wildebeest/backend/src/database'
import * as query from 'wildebeest/backend/src/database/d1/querier'
import { loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { actorToMention, detectVisibility } from 'wildebeest/backend/src/mastodon/status'
import { getSubscriptionForAllClients } from 'wildebeest/backend/src/mastodon/subscription'
import { fromObject } from 'wildebeest/backend/src/media'
import { isNotificationType, type Notification, type NotificationType } from 'wildebeest/backend/src/types/notification'
import { actorToHandle, handleToAcct } from 'wildebeest/backend/src/utils/handle'
import { generateWebPushMessage } from 'wildebeest/backend/src/webpush'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import type { WebPushInfos, WebPushMessage } from 'wildebeest/backend/src/webpush/webpushinfos'
import { WebPushResult } from 'wildebeest/backend/src/webpush/webpushinfos'
import { defaultImages } from 'wildebeest/config/accounts'

export async function createNotification(
	db: Database,
	type: NotificationType,
	actor: Actor,
	fromActor: Actor,
	obj: ApObject
): Promise<string> {
	const query = `
          INSERT INTO actor_notifications (type, actor_id, from_actor_id, object_id)
          VALUES (?, ?, ?, ?)
          RETURNING id
`
	const row = await db
		.prepare(query)
		.bind(type, actor.id.toString(), fromActor.id.toString(), obj.id.toString())
		.first<{ id: string }>()
	if (!row) {
		throw new Error('returned row is null')
	}
	return row.id
}

export async function insertFollowNotification(db: Database, actor: Actor, fromActor: Actor): Promise<string> {
	const type: NotificationType = 'follow'

	const query = `
          INSERT INTO actor_notifications (type, actor_id, from_actor_id)
          VALUES (?, ?, ?)
          RETURNING id
`
	const row = await db.prepare(query).bind(type, actor.id.toString(), fromActor.id.toString()).first<{ id: string }>()
	if (!row) {
		throw new Error('returned row is null')
	}
	return row.id
}

export async function sendFollowNotification(
	db: Database,
	follower: Actor,
	actor: Actor,
	notificationId: string,
	adminEmail: string,
	vapidKeys: JWK
) {
	let icon = new URL(defaultImages.avatar)
	if (follower.icon && follower.icon.url) {
		icon = getApUrl(follower.icon.url)
	}

	const data = {
		preferred_locale: 'en',
		notification_type: 'follow',
		notification_id: notificationId,
		icon,
		title: 'New follower',
		body: `${follower.name} is now following you`,
	}

	const message: WebPushMessage = {
		data: JSON.stringify(data),
		urgency: 'normal',
		sub: adminEmail,
		ttl: 60 * 24 * 7,
	}

	return sendNotification(db, actor, message, vapidKeys)
}

export async function sendLikeNotification(
	db: Database,
	fromActor: Actor,
	actor: Actor,
	notificationId: string,
	adminEmail: string,
	vapidKeys: JWK
) {
	let icon = new URL(defaultImages.avatar)
	if (fromActor.icon && fromActor.icon.url) {
		icon = getApUrl(fromActor.icon.url)
	}

	const data = {
		preferred_locale: 'en',
		notification_type: 'favourite',
		notification_id: notificationId,
		icon,
		title: 'New favourite',
		body: `${fromActor.name} favourited your status`,
	}

	const message: WebPushMessage = {
		data: JSON.stringify(data),
		urgency: 'normal',
		sub: adminEmail,
		ttl: 60 * 24 * 7,
	}

	return sendNotification(db, actor, message, vapidKeys)
}

export async function sendMentionNotification(
	db: Database,
	fromActor: Actor,
	actor: Actor,
	notificationId: string,
	adminEmail: string,
	vapidKeys: JWK
) {
	let icon = new URL(defaultImages.avatar)
	if (fromActor.icon && fromActor.icon.url) {
		icon = getApUrl(fromActor.icon.url)
	}

	const data = {
		preferred_locale: 'en',
		notification_type: 'mention',
		notification_id: notificationId,
		icon,
		title: 'New mention',
		body: `You were mentioned by ${fromActor.name}`,
	}

	const message: WebPushMessage = {
		data: JSON.stringify(data),
		urgency: 'normal',
		sub: adminEmail,
		ttl: 60 * 24 * 7,
	}

	return sendNotification(db, actor, message, vapidKeys)
}

export async function sendReblogNotification(
	db: Database,
	fromActor: Actor,
	actor: Actor,
	notificationId: string,
	adminEmail: string,
	vapidKeys: JWK
) {
	let icon = new URL(defaultImages.avatar)
	if (fromActor.icon && fromActor.icon.url) {
		icon = getApUrl(fromActor.icon.url)
	}

	const data = {
		preferred_locale: 'en',
		notification_type: 'reblog',
		notification_id: notificationId,
		icon,
		title: 'New boost',
		body: `${fromActor.name} boosted your status`,
	}

	const message: WebPushMessage = {
		data: JSON.stringify(data),
		urgency: 'normal',
		sub: adminEmail,
		ttl: 60 * 24 * 7,
	}

	return sendNotification(db, actor, message, vapidKeys)
}

async function sendNotification(db: Database, actor: Actor, message: WebPushMessage, vapidKeys: JWK) {
	const subscriptions = await getSubscriptionForAllClients(db, actor)

	const promises = subscriptions.map(async (subscription) => {
		const device: WebPushInfos = {
			endpoint: subscription.gateway.endpoint,
			key: subscription.gateway.keys.p256dh,
			auth: subscription.gateway.keys.auth,
		}

		const result = await generateWebPushMessage(message, device, vapidKeys)
		if (result !== WebPushResult.Success) {
			throw new Error('failed to send push notification')
		}
	})

	await Promise.allSettled(promises)
}

export async function getNotifications(db: Database, actor: Actor, domain: string): Promise<Array<Notification>> {
	const { results } = await query.selectNotificationsByActorId(db, { actorId: actor.id.toString(), limit: 20 })

	const out: Notification[] = []
	if (!results || results.length === 0) {
		return []
	}

	for (const result of results) {
		const notifFromActorId = new URL(result.notificationFromActorId)

		const notifFromActor = await getActorById(db, notifFromActorId)
		if (!notifFromActor) {
			console.warn('unknown actor: ', notifFromActorId)
			continue
		}

		const notifFromAccount = await loadMastodonAccount(db, domain, notifFromActor, actorToHandle(notifFromActor))

		const { notificationType, originalActorId } = result
		if (!isNotificationType(notificationType)) {
			console.warn('unknown notification type: ', notificationType)
			continue
		}

		const notif: Notification = {
			id: result.notificationId.toString(),
			type: notificationType,
			created_at: new Date(result.notificationCdate).toISOString(),
			account: notifFromAccount,
		}

		if (notificationType === 'mention' || notificationType === 'favourite') {
			if (!originalActorId) {
				console.warn('unknown original_actor_id', JSON.stringify(result))
				continue
			}
			if (result.id === null || result.type !== 'Note') {
				console.warn('notification object is null')
				continue
			}

			result.mastodonId = await ensureObjectMastodonId(db, result.mastodonId, result.cdate)

			let properties
			if (typeof result.properties === 'object') {
				// neon uses JSONB for properties which is returned as a deserialized
				// object.
				properties = result.properties as Note
			} else {
				// D1 uses a string for JSON properties
				properties = JSON.parse(result.properties) as Note
			}

			const mediaAttachments = Array.isArray(properties.attachment)
				? properties.attachment.map((doc) => fromObject(doc))
				: []

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
					if (!author) {
						inReplyToId = null
					} else {
						inReplyToAccountId = author[mastodonIdSymbol]
					}
				}
			}

			const actorId = new URL(originalActorId)
			const actor = await getAndCacheActor(actorId, db)
			if (!actor) {
				console.warn('unknown actor: ', actorId)
				continue
			}
			const handle = actorToHandle(actor)

			const mentions = []
			for (const link of properties.tag ?? []) {
				if (link.type === 'Mention') {
					const target = actor.id.toString() === link.href.toString() ? actor : await getActorById(db, link.href)
					if (target) {
						mentions.push(actorToMention(domain, target))
					}
				}
			}

			notif.status = {
				id: result.mastodonId,
				uri: new URL(result.id),
				created_at: new Date(properties.published ?? result.cdate).toISOString(),
				account: await loadMastodonAccount(db, domain, actor, handle),
				content: properties.content,
				visibility: detectVisibility({ to: properties.to, cc: properties.cc, followers: actor.followers }),
				sensitive: properties.sensitive,
				spoiler_text: properties.spoiler_text ?? '',
				media_attachments: mediaAttachments,
				mentions,
				url: properties.url
					? new URL(properties.url)
					: isLocalAccount(domain, handle)
						? new URL(`/@${handleToAcct(handle, domain)}/${result.mastodonId}`, 'https://' + domain)
						: new URL(result.id),
				reblog: null,
				edited_at: properties.updated ? new Date(properties.updated).toISOString() : null,

				// TODO: stub values
				reblogs_count: 0,
				favourites_count: 0,
				replies_count: 0,
				tags: [],
				emojis: [],
				favourited: false,
				reblogged: false,
				in_reply_to_id: inReplyToId,
				in_reply_to_account_id: inReplyToAccountId,
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

		out.push(notif)
	}

	return out
}

export async function pregenerateNotifications(db: Database, cache: Cache, actor: Actor, domain: string) {
	const notifications = await getNotifications(db, actor, domain)
	await cache.put(actor.id + '/notifications', notifications)
}
