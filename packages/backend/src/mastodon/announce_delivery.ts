import type { AnnounceActivity, UndoActivity } from '@wildebeest/backend/activitypub/activities'
import { getAndCacheActor, type Actor, type Person } from '@wildebeest/backend/activitypub/actors'
import { deliverFollowers, deliverSafely, deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import {
	getApId,
	isLocalObject,
	originalActorIdSymbol,
	originalObjectIdSymbol,
} from '@wildebeest/backend/activitypub/objects'
import type { Note } from '@wildebeest/backend/activitypub/objects/note'
import type { Database } from '@wildebeest/backend/database'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import type { DeliverMessageBody, Queue } from '@wildebeest/backend/types'
import { toArray } from '@wildebeest/backend/utils'

export function addressesActor(activity: Pick<AnnounceActivity, 'to' | 'cc'>, actorId: string): boolean {
	return [...toArray(activity.to ?? []), ...toArray(activity.cc ?? [])].some(
		(target) => getApId(target).toString() === actorId
	)
}

export function addressesFollowers(
	activity: Pick<AnnounceActivity, 'to' | 'cc'>,
	actor: Pick<Person, 'followers'>
): boolean {
	return addressesActor(activity, actor.followers.toString())
}

export async function getRemoteAnnounceTargetActor(
	db: Database,
	domain: string,
	actor: Pick<Actor, 'id'>,
	obj: Pick<Note, 'id'> & Pick<Note, typeof originalActorIdSymbol | typeof originalObjectIdSymbol>,
	{ skipSelf }: { skipSelf: boolean }
): Promise<Actor | null | undefined> {
	const originalObjectId = new URL(obj[originalObjectIdSymbol] ?? obj.id.toString())
	if (isLocalObject(domain, originalObjectId)) {
		return undefined
	}
	const originalActorId = obj[originalActorIdSymbol]
	if (!originalActorId) {
		return null
	}
	if (skipSelf && originalActorId === actor.id.toString()) {
		return undefined
	}
	return getAndCacheActor(new URL(originalActorId), db)
}

export async function deliverCreatedAnnounce(
	db: Database,
	userKEK: string,
	actor: Person,
	activity: AnnounceActivity,
	queue: Queue<DeliverMessageBody>,
	domain: string,
	targetActor: Actor | undefined
): Promise<void> {
	if (!targetActor) {
		if (addressesFollowers(activity, actor)) {
			await deliverSafely('Announce to followers', () => deliverFollowers(db, userKEK, actor, activity, queue))
		}
		return
	}

	const deliveries: Promise<void>[] = []
	const targetActorId = targetActor.id.toString()
	if (addressesActor(activity, targetActorId)) {
		const signingKey = await getSigningKey(userKEK, db, actor)
		deliveries.push(
			deliverSafely(`Announce to ${targetActorId}`, () =>
				deliverToActor(signingKey, actor, targetActor, activity, domain)
			)
		)
	}
	if (addressesFollowers(activity, actor)) {
		deliveries.push(
			deliverSafely('Announce to followers', () =>
				deliverFollowers(db, userKEK, actor, activity, queue, new Set([targetActorId]))
			)
		)
	}
	await Promise.all(deliveries)
}

export async function deliverUndoAnnounce(
	db: Database,
	userKEK: string,
	actor: Person,
	reblogActivity: AnnounceActivity,
	undoActivity: UndoActivity,
	queue: Queue<DeliverMessageBody>,
	domain: string,
	targetActor: Actor | undefined
): Promise<void> {
	const deliveries: Promise<void>[] = []
	const excludeActorIds = new Set<string>()

	if (targetActor) {
		const targetActorId = targetActor.id.toString()
		excludeActorIds.add(targetActorId)
		if (addressesActor(reblogActivity, targetActorId)) {
			const signingKey = await getSigningKey(userKEK, db, actor)
			deliveries.push(
				deliverSafely(`Undo Announce to ${targetActorId}`, () =>
					deliverToActor<UndoActivity>(signingKey, actor, targetActor, undoActivity, domain)
				)
			)
		}
	}
	if (addressesFollowers(reblogActivity, actor)) {
		deliveries.push(
			deliverSafely('Undo Announce to followers', () =>
				deliverFollowers(db, userKEK, actor, undoActivity, queue, excludeActorIds)
			)
		)
	}

	await Promise.all(deliveries)
}
