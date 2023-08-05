// https://docs.joinmastodon.org/methods/accounts/#get

import {
	actorURL,
	getActorById,
	getActorByMastodonId,
	getActorByRemoteHandle,
	setActorMastodonId,
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
	handleToMastodonUrl,
	handleToPleromaUrl,
	isLocalHandle,
	LocalHandle,
	parseHandle,
} from 'wildebeest/backend/src/utils/handle'

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
	return loadMastodonAccount(db, domain, actor, actorToHandle(actor), true)
}

export async function getMastodonIdByHandle(domain: string, db: Database, handle: Handle): Promise<MastodonId | null> {
	if (isLocalAccount(domain, handle)) {
		const id = actorURL(adjustLocalHostDomain(domain), handle).toString()
		const { results } = await db
			.prepare('SELECT mastodon_id FROM actors WHERE id = ?1')
			.bind(id)
			.all<{ mastodon_id: string | null }>()
		if (!results || results.length === 0) {
			return null
		}
		const { mastodon_id: mastodonId } = results[0]
		if (mastodonId) {
			return mastodonId
		}
		const { cdate } = await db.prepare('SELECT cdate FROM actors WHERE id = ?1').bind(id).first<{ cdate: string }>()
		return await setActorMastodonId(db, id, cdate)
	}

	const { results } = await db
		.prepare(`SELECT id, mastodon_id FROM actors WHERE ${db.qb.jsonExtract('properties', 'url')} IN (?1, ?2)`)
		.bind(handleToMastodonUrl(handle).toString(), handleToPleromaUrl(handle).toString())
		.all<{ id: string; mastodon_id: string | null }>()
	if (!results || results.length === 0) {
		return null
	}
	const { id, mastodon_id: mastodonId } = results[0]
	if (mastodonId) {
		return mastodonId
	}
	const { cdate } = await db.prepare('SELECT cdate FROM actors WHERE id = ?1').bind(id).first<{ cdate: string }>()
	return await setActorMastodonId(db, id, cdate)
}
