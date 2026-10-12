import { type Activity, PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import { getAndCacheActor, type Person } from '@wildebeest/backend/activitypub/actors'
import { deliverFollowers, deliverSafely, deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { type ApObject, getApId } from '@wildebeest/backend/activitypub/objects'
import type { Database } from '@wildebeest/backend/database'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import type { DeliverMessageBody, Queue } from '@wildebeest/backend/types'
import { toArray, unique } from '@wildebeest/backend/utils'

/**
 * Delivers an activity about an existing object (Update, Delete) to the audience the object was
 * originally addressed to: the followers collection only when it is addressed, and every other
 * addressed actor individually. Prevents leaking followers-only and direct statuses to actors that
 * were never recipients.
 */
export async function deliverToStatusAudience(
	db: Database,
	userKEK: string,
	actor: Person,
	activity: Activity,
	queue: Queue<DeliverMessageBody>,
	domain: string,
	audience: Pick<ApObject, 'to' | 'cc'>
): Promise<void> {
	const recipients = unique(
		[...toArray(audience.to ?? []), ...toArray(audience.cc ?? [])].map((target) => getApId(target).toString())
	)

	const followersUrl = actor.followers.toString()
	const actorId = actor.id.toString()
	const targetActorIds = recipients.filter((id) => id !== PUBLIC_GROUP && id !== followersUrl && id !== actorId)

	const deliveries: Promise<void>[] = []

	if (recipients.includes(followersUrl)) {
		deliveries.push(
			deliverSafely(`${activity.type} to followers`, () =>
				deliverFollowers(db, userKEK, actor, activity, queue, new Set(targetActorIds))
			)
		)
	}

	for (const targetActorId of targetActorIds) {
		deliveries.push(
			deliverSafely(`${activity.type} to ${targetActorId}`, async () => {
				const targetActor = await getAndCacheActor(new URL(targetActorId), db)
				if (targetActor === null) {
					throw new Error(`actor ${targetActorId} not found`)
				}
				const signingKey = await getSigningKey(userKEK, db, actor)
				await deliverToActor(signingKey, actor, targetActor, activity, domain)
			})
		)
	}

	await Promise.all(deliveries)
}
