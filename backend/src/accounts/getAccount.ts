// https://docs.joinmastodon.org/methods/accounts/#get

import {
	actorURL,
	getActorById,
	getActorByMastodonId,
	getActorByRemoteHandle,
} from 'wildebeest/backend/src/activitypub/actors'
import { type Database } from 'wildebeest/backend/src/database'
import { loadExternalMastodonAccount, loadLocalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import { MastodonAccount, MastodonId } from 'wildebeest/backend/src/types'
import { adjustLocalHostDomain } from 'wildebeest/backend/src/utils/adjustLocalHostDomain'
import { actorToHandle, Handle, isLocalHandle, LocalHandle, parseHandle } from 'wildebeest/backend/src/utils/handle'

export function isLocalAccount(domain: string, handle: Handle): handle is LocalHandle {
	return isLocalHandle(handle) || handle.domain === domain
}

export async function getAccount(domain: string, db: Database, acct: string): Promise<MastodonAccount | null> {
	const handle = parseHandle(acct)

	if (isLocalAccount(domain, handle)) {
		const actorId = actorURL(adjustLocalHostDomain(domain), handle)
		const actor = await getActorById(db, actorId)
		if (actor === null) {
			return null
		}
		return await loadLocalMastodonAccount(db, actor, handle)
	}
	const actor = await getActorByRemoteHandle(db, handle)
	if (actor === null) {
		return null
	}
	return await loadExternalMastodonAccount(db, actor, handle, true)
}

export async function getAccountByMastodonId(
	domain: string,
	db: Database,
	id: MastodonId
): Promise<MastodonAccount | null> {
	const actor = await getActorByMastodonId(db, id)
	if (actor === null) {
		return null
	}
	const handle = actorToHandle(actor)
	if (isLocalAccount(domain, handle)) {
		return await loadLocalMastodonAccount(db, actor)
	}
	return await loadExternalMastodonAccount(db, actor, handle, true)
}
