import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { cacheFromEnv } from '@wildebeest/backend/cache'
import { getDatabase } from '@wildebeest/backend/database'
import * as notification from '@wildebeest/backend/mastodon/notification'
import * as timeline from '@wildebeest/backend/mastodon/timeline'
import type { InboxMessageBody } from '@wildebeest/backend/types'

import type { Env } from './'

export async function handleInboxMessage(env: Env, actor: Actor, message: InboxMessageBody) {
	const domain = env.DOMAIN
	const db = getDatabase(env)
	const adminEmail = env.ADMIN_EMAIL
	const cache = cacheFromEnv(env)
	const activity = message.activity
	console.log(JSON.stringify(activity))

	await activityHandler.handle(domain, activity, db, message.userKEK, adminEmail, message.vapidKeys)

	// Assuming we received new posts or a like, pregenerate the user's timelines
	// and notifications.
	await Promise.all([
		timeline.pregenerateTimelines(domain, db, cache, actor),
		notification.pregenerateNotifications(db, cache, actor, domain),
	])
}
