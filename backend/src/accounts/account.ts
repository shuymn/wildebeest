// https://docs.joinmastodon.org/methods/accounts/#get

import {
	ensureActorMastodonId,
	getActorByMastodonId,
	getActorByRemoteHandle,
} from 'wildebeest/backend/src/activitypub/actors'
import { type Database } from 'wildebeest/backend/src/database'
import {
	loadExternalMastodonAccount,
	loadLocalMastodonAccount,
	loadMastodonAccount,
} from 'wildebeest/backend/src/mastodon/account'
import { MastodonAccount, MastodonId } from 'wildebeest/backend/src/types'
import { adjustLocalHostDomain } from 'wildebeest/backend/src/utils/adjustLocalHostDomain'
import {
	actorToHandle,
	Handle,
	isLocalHandle,
	LocalHandle,
	parseHandle,
	RemoteHandle,
} from 'wildebeest/backend/src/utils/handle'

export function isLocalAccount(domain: string, handle: Handle): handle is LocalHandle {
	return isLocalHandle(handle) || handle.domain === domain
}

export async function getAccount(domain: string, db: Database, acct: string): Promise<MastodonAccount | null> {
	const handle = parseHandle(acct)
	if (isLocalAccount(domain, handle)) {
		const actor = await getActorByRemoteHandle(db, { ...handle, domain })
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
	return loadMastodonAccount(db, domain, actor, actorToHandle(actor), true)
}

export async function getMastodonIdByRemoteHandle(db: Database, handle: RemoteHandle): Promise<MastodonId | null> {
	const { results } = await db
		.prepare('SELECT mastodon_id, cdate FROM actors WHERE username=lower(?1) AND domain=?2')
		.bind(handle.localPart, adjustLocalHostDomain(handle.domain))
		.all<{ mastodon_id: string; cdate: string }>()
	if (!results || results.length === 0) {
		return null
	}
	return await ensureActorMastodonId(db, results[0].mastodon_id, results[0].cdate)
}
