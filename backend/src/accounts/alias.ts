import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import { createFollowActivity } from 'wildebeest/backend/src/activitypub/activities/follow'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { setActorAlias } from 'wildebeest/backend/src/activitypub/actors'
import { deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import { parseHandle } from 'wildebeest/backend/src/utils/handle'
import { queryAcct } from 'wildebeest/backend/src/webfinger'

export async function addAlias(db: Database, alias: string, connectedActor: Actor, userKEK: string, domain: string) {
	const handle = parseHandle(alias)
	if (isLocalAccount(domain, handle)) {
		throw new Error("account migration within an instance isn't supported")
	}

	const actor = await queryAcct(handle, db)
	if (actor === null) {
		throw new Error('actor not found')
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
