import { isLocalAccount } from '@wildebeest/backend/accounts'
import { createFollowActivity } from '@wildebeest/backend/activitypub/activities/follow'
import { setActorAlias } from '@wildebeest/backend/activitypub/actors'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import { deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import { type Database } from '@wildebeest/backend/database'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { parseHandle } from '@wildebeest/backend/utils/handle'
import { queryAcct } from '@wildebeest/backend/webfinger'

export async function addAlias(db: Database, alias: string, connectedActor: Actor, userKEK: string, domain: string) {
	const handle = parseHandle(alias)
	if (isLocalAccount(domain, handle)) {
		throw new Error("account migration within an instance isn't supported")
	}

	const actor = await queryAcct(handle, db)
	if (actor === null) {
		throw new Error('actor not found: ' + alias)
	}

	await setActorAlias(db, getApId(connectedActor.id), getApId(actor.id))

	// For Mastodon to deliver the Move Activity we need to be following the
	// "moving from" actor.
	{
		const activity = await createFollowActivity(db, domain, connectedActor, actor)
		const signingKey = await getSigningKey(userKEK, db, connectedActor)
		await deliverToActor(signingKey, connectedActor, actor, activity, domain)
	}
}
