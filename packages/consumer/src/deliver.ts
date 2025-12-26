import { type Actor, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { getDatabase } from '@wildebeest/backend/database'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import type { DeliverMessageBody } from '@wildebeest/backend/types'

import type { Env } from './'

export async function handleDeliverMessage(env: Env, actor: Actor, message: DeliverMessageBody) {
	const toActorId = new URL(message.toActorId)
	const targetActor = await getAndCacheActor(toActorId, getDatabase(env))
	if (targetActor === null) {
		console.warn(`actor ${toActorId} not found`)
		return
	}

	const signingKey = await getSigningKey(message.userKEK, getDatabase(env), actor)
	await deliverToActor(signingKey, actor, targetActor, message.activity, env.DOMAIN)
}
