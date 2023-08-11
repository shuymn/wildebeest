import { Buffer } from 'buffer'
import {
	Actor,
	actorFromRow,
	ActorRow,
	ensureActorMastodonId,
	PERSON,
	Person,
} from 'wildebeest/backend/src/activitypub/actors'
import { Remote } from 'wildebeest/backend/src/activitypub/objects'
import { Image } from 'wildebeest/backend/src/activitypub/objects/image'
import { type Database } from 'wildebeest/backend/src/database'
import { HTTPS } from 'wildebeest/backend/src/utils'
import { Handle, LocalHandle } from 'wildebeest/backend/src/utils/handle'
import { generateMastodonId } from 'wildebeest/backend/src/utils/id'
import { generateUserKey } from 'wildebeest/backend/src/utils/key-ops'

const isTesting = typeof jest !== 'undefined'

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

	let privkey, salt
	// Since D1 and better-sqlite3 behaviors don't exactly match, presumable
	// because Buffer support is different in Node/Worker. We have to transform
	// the values depending on the platform.
	if (isTesting) {
		privkey = Buffer.from(userKeyPair.wrappedPrivKey)
		salt = Buffer.from(userKeyPair.salt)
	} else {
		privkey = userKeyPair.wrappedPrivKey
		salt = userKeyPair.salt.buffer
	}

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

	{
		const result = await db
			.prepare(
				'INSERT INTO actors (id, mastodon_id, domain, properties, cdate, type, username) VALUES(?, ?, ?, ?, ?, ?, lower(?))'
			)
			.bind(
				id,
				mastodonId,
				domain,
				JSON.stringify(properties),
				now.toISOString(),
				properties.type,
				properties.preferredUsername
			)
			.run()
		if (!result.success) {
			console.error('SQL error: ', result.error)
			throw new Error(`Failed to insert actor ${id} into database`)
		}
	}

	{
		const results = await db.batch([
			db.prepare('INSERT INTO actor_preferences(id) VALUES(?)').bind(id),
			db
				.prepare(
					'INSERT INTO users(id, actor_id, email, privkey, privkey_salt, pubkey, is_admin, cdate) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(crypto.randomUUID(), id, email, privkey, salt, userKeyPair.pubKey, admin ? 1 : 0, now.toISOString()),
		])
		for (const result of results) {
			if (result.success) {
				continue
			}
			console.error('SQL error: ', result.error)
			const recovery = await db.prepare('DELETE FROM actors WHERE id=?').bind(id).run()
			if (!recovery.success) {
				console.error(`faield to delete actor ${id} from database`)
				console.error('SQL error: ', recovery.error)
			}
			throw new Error(`Failed to insert user ${id} into database`)
		}
	}

	const person = actorFromRow<Person>({
		id,
		type: PERSON,
		cdate: now.toISOString(),
		properties: properties,
		mastodon_id: mastodonId,
	})

	return {
		...person,
		[isAdminSymbol]: admin,
	}
}

export async function getUserByEmail(db: Database, email: string): Promise<User | null> {
	const stmt = db
		.prepare(
			`
SELECT
	actors.id,
	actors.mastodon_id,
	actors.type,
	users.pubkey,
	actors.cdate,
	actors.properties,
	users.is_admin
FROM actors
INNER JOIN users ON users.actor_id = actors.id
WHERE email = ?1;
`
		)
		.bind(email)

	const { results } = await stmt.all<{
		id: string
		type: typeof PERSON
		pubkey: string
		cdate: string
		properties: string
		is_admin: 1 | 0
		mastodon_id: string
	}>()
	if (!results || results.length === 0) {
		return null
	}
	const row: ActorRow<Person> = {
		...results[0],
		mastodon_id: await ensureActorMastodonId(db, results[0].mastodon_id, results[0].cdate),
	}
	const actor = actorFromRow(row)
	if (actor === null) {
		return null
	}
	return {
		...actor,
		[isAdminSymbol]: results[0].is_admin === 1,
	}
}

export async function getAdminByEmail(db: Database, email: string): Promise<User | null> {
	const stmt = db
		.prepare(
			`
SELECT
  actors.id,
  actors.mastodon_id,
  actors.type,
  users.pubkey,
  actors.cdate,
  actors.properties
FROM actors
INNER JOIN users ON users.actor_id = actors.id
WHERE
  users.is_admin=1
  AND users.email=?1
`
		)
		.bind(email)
	const { results } = await stmt.all<{
		id: string
		type: typeof PERSON
		pubkey: string
		cdate: string
		properties: string
		mastodon_id: string
	}>()
	if (!results || results.length === 0) {
		return null
	}
	const row: ActorRow<Person> = results[0]
	return { ...actorFromRow(row), [isAdminSymbol]: true }
}
