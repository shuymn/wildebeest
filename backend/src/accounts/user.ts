import {
	Actor,
	actorFromRow,
	ensureActorMastodonId,
	isActorRowLike,
	PERSON,
	Person,
} from 'wildebeest/backend/src/activitypub/actors'
import { Remote } from 'wildebeest/backend/src/activitypub/objects'
import { Image } from 'wildebeest/backend/src/activitypub/objects/image'
import { type Database } from 'wildebeest/backend/src/database'
import * as query from 'wildebeest/backend/src/database/d1/querier'
import { HTTPS } from 'wildebeest/backend/src/utils'
import { Handle, LocalHandle } from 'wildebeest/backend/src/utils/handle'
import { generateMastodonId } from 'wildebeest/backend/src/utils/id'
import { generateUserKey } from 'wildebeest/backend/src/utils/key-ops'

export function getUserId(domain: string, obj: { preferredUsername: string } | Pick<Handle, 'localPart'>): URL {
	if ('preferredUsername' in obj) {
		return new URL(`/ap/users/${obj.preferredUsername}`, 'https://' + domain)
	}
	return new URL(`/ap/users/${obj.localPart}`, 'https://' + domain)
}

export function getUserUrl(domain: string, obj: { preferredUsername: string } | Pick<LocalHandle, 'localPart'>): URL {
	if ('preferredUsername' in obj) {
		return new URL(`/@${obj.preferredUsername}`, HTTPS + domain)
	}
	return new URL(`/@${obj.localPart}`, HTTPS + domain)
}

type CreateUserParams = {
	domain: string
	db: Database
	userKEK: string
	email: string
	preferredUsername: string
	name: string
	admin?: boolean
	icon?: Image
}

type UserProperties = Required<
	Pick<
		Remote<Actor>,
		| 'id'
		| 'type'
		| 'name'
		| 'preferredUsername'
		| 'url'
		| 'inbox'
		| 'outbox'
		| 'following'
		| 'followers'
		| 'featured'
		| 'discoverable'
		| 'manuallyApprovesFollowers'
		| 'publicKey'
	>
> &
	Pick<Remote<Actor>, 'icon'>

export const isAdminSymbol = Symbol()
export type User = Person & { [isAdminSymbol]: boolean }

// Create a local user
export async function createUser({
	domain,
	db,
	userKEK,
	email,
	preferredUsername,
	name,
	admin = false,
	icon,
}: CreateUserParams): Promise<User> {
	const userKeyPair = await generateUserKey(userKEK)

	const privkey = userKeyPair.wrappedPrivKey
	const salt = userKeyPair.salt.buffer

	const id = getUserId(domain, { preferredUsername }).toString()

	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'actors', now)

	const properties: UserProperties = {
		id,
		type: PERSON,
		name,
		preferredUsername,
		url: getUserUrl(domain, { preferredUsername }).toString(),
		inbox: new URL(id + '/inbox'),
		outbox: new URL(id + '/outbox'),
		following: new URL(id + '/following'),
		followers: new URL(id + '/followers'),
		featured: new URL(id + '/featured'),
		discoverable: false,
		manuallyApprovesFollowers: false,
		publicKey: {
			id: id + '#main-key',
			owner: id,
			publicKeyPem: userKeyPair.pubKey,
		},
		icon,
	}

	await query.insertActor(db, {
		id,
		mastodonId,
		domain,
		properties: JSON.stringify(properties),
		cdate: now.toISOString(),
		type: properties.type,
		username: properties.preferredUsername.toLowerCase(),
	})

	const queries = [
		query.insertActorPreferences(db, { id }),
		query.insertUser(db, {
			id: crypto.randomUUID(),
			actorId: id,
			email,
			privkey,
			privkeySalt: salt,
			pubkey: userKeyPair.pubKey,
			isAdmin: admin ? 1 : 0,
			cdate: now.toISOString(),
		}),
	]
	for (const q of queries) {
		try {
			await q
		} catch (err) {
			await query.deleteActor(db, { id }).catch((delErr) => {
				console.error(`failed to delete actor ${id} after failed creation: ${delErr}`)
			})
			throw err
		}
	}

	const person = actorFromRow<Person>({
		id,
		type: PERSON,
		cdate: now.toISOString(),
		properties: properties,
		mastodonId: mastodonId,
	})

	return {
		...person,
		[isAdminSymbol]: admin,
	}
}

export async function getUserByEmail(db: Database, email: string): Promise<User | null> {
	const row = await query.selectUserByEmail(db, { email })
	if (!row || !isActorRowLike(row)) {
		return null
	}
	const actor = actorFromRow<Person>({
		...row,
		mastodonId: await ensureActorMastodonId(db, row.mastodonId, row.cdate),
		type: 'Person',
	})
	return {
		...actor,
		[isAdminSymbol]: row.isAdmin === 1,
	}
}

export async function getAdminByEmail(db: Database, email: string): Promise<User | null> {
	const row = await query.selectUserByEmail(db, { email })
	if (!row || !isActorRowLike(row)) {
		return null
	}
	const actor = actorFromRow<Person>({
		...row,
		mastodonId: await ensureActorMastodonId(db, row.mastodonId, row.cdate),
		type: 'Person',
	})
	return { ...actor, [isAdminSymbol]: true }
}
