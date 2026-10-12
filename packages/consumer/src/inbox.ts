import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import { cacheFromEnv } from '@wildebeest/backend/cache'
import { getDatabase } from '@wildebeest/backend/database'
import * as notification from '@wildebeest/backend/mastodon/notification'
import * as timeline from '@wildebeest/backend/mastodon/timeline'
import type { InboxMessageBody } from '@wildebeest/backend/types'

import type { Env } from './'

// Inbox messages enqueued before the inbox route started recording the
// signature key owner cannot be authorized any more, and a message whose
// activity no longer matches its signer must never be processed.
export function isSignedInboxMessage(message: InboxMessageBody): boolean {
	if (!message.signerId) {
		return false
	}
	try {
		return getApId(message.activity.actor).toString() === message.signerId
	} catch {
		return false
	}
}

export async function handleInboxMessage(env: Env, actor: Actor, message: InboxMessageBody) {
	const domain = env.DOMAIN
	const db = getDatabase(env)
	const adminEmail = env.ADMIN_EMAIL
	const cache = cacheFromEnv(env)
	const activity = message.activity

	await activityHandler.handle(domain, activity, db, message.userKEK, adminEmail, message.vapidKeys)

	// Assuming we received new posts or a like, pregenerate the user's timelines
	// and notifications.
	await Promise.all([
		timeline.pregenerateTimelines(domain, db, cache, actor),
		notification.pregenerateNotifications(db, cache, actor, domain),
	])
}
