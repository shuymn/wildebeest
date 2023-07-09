// https://docs.joinmastodon.org/methods/accounts/#get

import { actorURL, getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { type Database } from 'wildebeest/backend/src/database'
import { loadExternalMastodonAccount, loadLocalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { MastodonAccount } from 'wildebeest/backend/src/types'
import { adjustLocalHostDomain } from 'wildebeest/backend/src/utils/adjustLocalHostDomain'
import { Handle, isLocalHandle, LocalHandle, parseHandle, RemoteHandle } from 'wildebeest/backend/src/utils/handle'
import { queryAcct } from 'wildebeest/backend/src/webfinger/index'

export function isLocalAccount(domain: string, handle: Handle): handle is LocalHandle {
	return isLocalHandle(handle) || handle.domain === domain
}

export async function getAccount(domain: string, accountId: string, db: Database): Promise<MastodonAccount | null> {
	const handle = parseHandle(accountId)

	if (isLocalAccount(domain, handle)) {
		// Retrieve the statuses from a local user
		return getLocalAccount(domain, db, handle)
	}
	// Retrieve the statuses of a remote actor
	return getRemoteAccount(handle, db)
}

async function getRemoteAccount(handle: RemoteHandle, db: Database): Promise<MastodonAccount | null> {
	// TODO: using webfinger isn't the optimal implementation. We could cache
	// the object in D1 and directly query the remote API, indicated by the actor's
	// url field. For now, let's keep it simple.
	const actor = await queryAcct(handle, db)
	if (actor === null) {
		return null
	}

	return await loadExternalMastodonAccount(actor, true, handle)
}

async function getLocalAccount(domain: string, db: Database, handle: LocalHandle): Promise<MastodonAccount | null> {
	const actorId = actorURL(adjustLocalHostDomain(domain), handle)

	const actor = await getActorById(db, actorId)
	if (actor === null) {
		return null
	}

	return await loadLocalMastodonAccount(db, actor)
}
