import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { getActorById } from 'wildebeest/backend/src/activitypub/actors'
import {
	type ApObject,
	ensureObjectMastodonId,
	getApUrl,
	getObjectById,
	getObjectByOriginalId,
	isLocalObject,
	mastodonIdSymbol,
	originalActorIdSymbol,
} from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import type { Cache } from 'wildebeest/backend/src/cache'
import { type Database } from 'wildebeest/backend/src/database'
import { loadMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { actorToMention, detectVisibility } from 'wildebeest/backend/src/mastodon/status'
import { getSubscriptionForAllClients } from 'wildebeest/backend/src/mastodon/subscription'
import { fromObject } from 'wildebeest/backend/src/media'
import type {
	Notification,
	NotificationsQueryResult,
	NotificationType,
} from 'wildebeest/backend/src/types/notification'
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
WHERE actor_id=?
ORDER BY actor_notifications.cdate DESC
LIMIT 20
  `

	const stmt = db.prepare(query).bind(actor.id.toString())
	const { results, success, error } = await stmt.all<NotificationsQueryResult>()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}

	const out: Array<Notification> = []
	if (!results || results.length === 0) {
		return []
	}

	for (const result of results) {
		const notifFromActorId = new URL(result.notif_from_actor_id)

		const notifFromActor = await getActorById(db, notifFromActorId)
		if (!notifFromActor) {
			console.warn('unknown actor')
			continue
		}

		const notifFromAccount = await loadMastodonAccount(db, domain, notifFromActor, actorToHandle(notifFromActor))

		const notif: Notification = {
			id: result.notif_id.toString(),
			type: result.notif_type,
			created_at: new Date(result.notif_cdate).toISOString(),
			account: notifFromAccount,
		}

		if (result.notif_type === 'mention' || result.notif_type === 'favourite') {
			if (result.id === null || result.type !== 'Note') {
				console.warn('notification object is null')
				continue
			}

			result.mastodon_id = await ensureObjectMastodonId(db, result.mastodon_id, result.cdate)

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
				const replied = isLocalObject(domain, properties.inReplyTo)
					? await getObjectById(db, properties.inReplyTo)
					: await getObjectByOriginalId(db, properties.inReplyTo)
				if (replied) {
					inReplyToId = replied[mastodonIdSymbol]
					try {
						const author = await actors.getAndCache(new URL(replied[originalActorIdSymbol]), db)
						inReplyToAccountId = author[mastodonIdSymbol]
					} catch (err) {
						console.warn('failed to get author of reply', err)
						inReplyToId = null
					}
				}
			}

			const actorId = new URL(result.original_actor_id)
			const actor = await actors.getAndCache(actorId, db)
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
				id: result.mastodon_id,
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
					? new URL(`/@${handleToAcct(handle, domain)}/${result.mastodon_id}`, 'https://' + domain)
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
