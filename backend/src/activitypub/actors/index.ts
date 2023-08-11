import {
	type ApObject,
	ApObjectId,
	getApId,
	getTextContent,
	mastodonIdSymbol,
	Remote,
	sanitizeContent,
} from 'wildebeest/backend/src/activitypub/objects'
import { addPeer } from 'wildebeest/backend/src/activitypub/peers'
import { type Database } from 'wildebeest/backend/src/database'
import { MastodonId } from 'wildebeest/backend/src/types'
import { isUUID } from 'wildebeest/backend/src/utils'
import { adjustLocalHostDomain } from 'wildebeest/backend/src/utils/adjustLocalHostDomain'
import { RemoteHandle } from 'wildebeest/backend/src/utils/handle'
import { generateMastodonId } from 'wildebeest/backend/src/utils/id'
import { defaultImages } from 'wildebeest/config/accounts'
import { UA } from 'wildebeest/config/ua'

export const isAdminSymbol = Symbol()

// https://www.w3.org/TR/activitystreams-vocabulary/#actor-types
export interface Actor extends ApObject {
	type: 'Person' | 'Service' | 'Organization' | 'Group' | 'Application'
	inbox: URL
	outbox: URL
	following: URL
	followers: URL
	featured?: URL
	discoverable: boolean
	manuallyApprovesFollowers?: boolean
	alsoKnownAs?: string[]
	publicKey?: {
		id: string
		owner?: string
		publicKeyPem: string
	}

	// Internal
	[mastodonIdSymbol]: string
}

export const PERSON = 'Person'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-person
export interface Person extends Actor {
	type: typeof PERSON
}

export async function fetchActor(url: string | URL): Promise<Remote<Actor>> {
	const headers = {
		accept: 'application/activity+json',
		'User-Agent': UA,
	}
	const res = await fetch(url, { headers })
	if (!res.ok) {
		throw new Error(`${url.toString()} returned: ${res.status}`)
	}

	const actor = await res.json<Remote<Actor>>()
	actor.id = new URL(actor.id)

	if (actor.summary) {
		actor.summary = await sanitizeContent(actor.summary)
		if (actor.summary.length > 500) {
			actor.summary = actor.summary.substring(0, 500)
		}
	}
	if (actor.name) {
		actor.name = await getTextContent(actor.name)
		if (actor.name.length > 30) {
			actor.name = actor.name.substring(0, 30)
		}
	}
	if (actor.preferredUsername) {
		actor.preferredUsername = await getTextContent(actor.preferredUsername)
		if (actor.preferredUsername.length > 30) {
			actor.preferredUsername = actor.preferredUsername.substring(0, 30)
		}
	}

	// This is mostly for testing where for convenience not all values
	// are provided.
	// TODO: eventually clean that to better match production.
	if (actor.inbox !== undefined) {
		actor.inbox = new URL(actor.inbox)
	}
	if (actor.outbox !== undefined) {
		actor.outbox = new URL(actor.outbox)
	}
	if (actor.following !== undefined) {
		actor.following = new URL(actor.following)
	}
	if (actor.followers !== undefined) {
		actor.followers = new URL(actor.followers)
	}
	if (actor.featured !== undefined) {
		actor.featured = new URL(actor.featured)
	}

	return actor
}

// Get and cache the Actor locally
export async function getAndCache(url: URL, db: Database): Promise<Actor> {
	{
		const actor = await getActorById(db, url)
		if (actor !== null) {
			return actor
		}
	}

	const actor = await fetchActor(url)
	if (!actor.type || !actor.id) {
		throw new Error('missing fields on Actor')
	}

	const properties = actor

	const now = new Date()
	const mastodonId = await generateMastodonId(db, 'actors', now)
	const actorId = getApId(actor.id)

	const row = await db
		.prepare(
			`
INSERT INTO actors (id, mastodon_id, domain, properties, cdate, type, username)
VALUES (?, ?, ?, ?, ?, ?, lower(?))
RETURNING type
    `
		)
		.bind(
			actorId.toString(),
			mastodonId,
			actorId.hostname,
			JSON.stringify(properties),
			now.toISOString(),
			properties.type,
			properties.preferredUsername ?? null
		)
		.first<{ type: Actor['type'] }>()
	if (!row) {
		throw new Error('failed to insert actor')
	}

	// Add peer
	await addPeer(db, getApId(actor.id).host)

	return actorFromRow({
		id: actorId.toString(),
		mastodon_id: mastodonId,
		type: row.type,
		properties: actor,
		cdate: now.toISOString(),
	})
}

export type ActorProperties = Pick<
	Remote<Actor>,
	| 'url'
	| 'name'
	| 'summary'
	| 'icon'
	| 'image'
	| 'preferredUsername'
	| 'inbox'
	| 'outbox'
	| 'following'
	| 'followers'
	| 'featured'
	| 'alsoKnownAs'
	| 'discoverable'
	| 'publicKey'
	| 'manuallyApprovesFollowers'
	| 'sensitive'
>

export async function updateActorProperty(db: Database, actorId: URL, key: string, value: string) {
	const { success, error } = await db
		.prepare(`UPDATE actors SET properties=${db.qb.jsonSet('properties', key, '?1')} WHERE id=?2`)
		.bind(value, actorId.toString())
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function setActorAlias(db: Database, actorId: URL, alias: URL) {
	const { success, error } = await db
		.prepare(`UPDATE actors SET properties=${db.qb.jsonSet('properties', 'alsoKnownAs', 'json_array(?1)')} WHERE id=?2`)
		.bind(alias.toString(), actorId.toString())
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
}

export async function ensureActorMastodonId(db: Database, mastodonId: string, cdate: string): Promise<MastodonId> {
	if (!isUUID(mastodonId)) {
		return mastodonId
	}
	const newMastodonId = await generateMastodonId(db, 'actors', new Date(cdate))
	const { success, error } = await db
		.prepare(`UPDATE actors SET mastodon_id=?1 WHERE mastodon_id=?2`)
		.bind(newMastodonId, mastodonId)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	return newMastodonId
}

type ActorRowLike = {
	id: string
	mastodon_id: string
	type: Actor['type']
	properties: string
	cdate: string
}

export async function getActorByMastodonId(db: Database, id: MastodonId): Promise<Actor | null> {
	const { results } = await db
		.prepare(
			`
SELECT
  id,
  mastodon_id,
  type,
  properties,
  cdate
FROM actors
WHERE mastodon_id=?1
`
		)
		.bind(id)
		.all<ActorRowLike>()
	if (!results || results.length === 0) {
		return null
	}
	return actorFromRow(results[0])
}

export async function getActorById(db: Database, id: Actor['id']): Promise<Actor | null> {
	const stmt = db
		.prepare(
			`
SELECT
  id,
  mastodon_id,
  type,
  properties,
  cdate
FROM actors
WHERE id=?1
  `
		)
		.bind(id.toString())
	const { results } = await stmt.all<ActorRowLike>()
	if (!results || results.length === 0) {
		return null
	}
	return actorFromRow({
		...results[0],
		mastodon_id: await ensureActorMastodonId(db, results[0].mastodon_id, results[0].cdate),
	})
}

export async function getActorByRemoteHandle(db: Database, handle: RemoteHandle): Promise<Actor | null> {
	const { results } = await db
		.prepare(
			`
SELECT
  id,
  mastodon_id,
  type,
  properties,
  cdate
FROM actors
WHERE username=lower(?1) AND domain=?2
`
		)
		.bind(handle.localPart, adjustLocalHostDomain(handle.domain))
		.all<ActorRowLike>()
	if (!results || results.length === 0) {
		return null
	}
	return actorFromRow({
		...results[0],
		mastodon_id: await ensureActorMastodonId(db, results[0].mastodon_id, results[0].cdate),
	})
}

export type ActorRow<T extends Actor> = {
	id: string
	mastodon_id: string
	type: T['type']
	properties: ActorProperties | string
	cdate: string
	original_actor_id?: ApObjectId
}

export function actorFromRow<T extends Actor>(row: ActorRow<T>) {
	let properties
	if (typeof row.properties === 'object') {
		// neon uses JSONB for properties which is returned as a deserialized
		// object.
		properties = row.properties
	} else {
		// D1 uses a string for JSON properties
		properties = JSON.parse(row.properties) as ActorProperties
	}

	const { preferredUsername } = properties
	const name = properties.name ?? preferredUsername

	let publicKey
	if (properties.publicKey !== undefined && properties.publicKey.publicKeyPem !== undefined) {
		publicKey = {
			id: properties.publicKey.id ?? new URL(row.id + '#main-key'),
			publicKeyPem: properties.publicKey.publicKeyPem,
		}
	}

	const id = new URL(row.id)
	// Old local actors weren't created with inbox/outbox/etc properties, so add
	// them if missing.
	if (properties.inbox === undefined) {
		properties.inbox = new URL(id + '/inbox')
	}
	if (properties.outbox === undefined) {
		properties.outbox = new URL(id + '/outbox')
	}
	if (properties.following === undefined) {
		properties.following = new URL(id + '/following')
	}
	if (properties.followers === undefined) {
		properties.followers = new URL(id + '/followers')
	}

	return {
		type: row.type,
		id,
		url: properties.url,
		published: new Date(row.cdate).toISOString(),
		icon: properties.icon ?? {
			type: 'Image',
			// TODO: stub values
			mediaType: 'image/jpeg',
			url: new URL(defaultImages.avatar),
			id: new URL(row.id + '#icon'),
		},
		image: properties.image ?? {
			type: 'Image',
			mediaType: 'image/jpeg',
			url: new URL(defaultImages.header),
			id: new URL(row.id + '#image'),
		},
		summary: properties.summary ?? undefined,
		name,
		preferredUsername,

		// Actor specific
		inbox: properties.inbox,
		outbox: properties.outbox,
		following: properties.following,
		followers: properties.followers,
		featured: properties.featured ?? undefined,
		discoverable: properties.discoverable ?? false,
		manuallyApprovesFollowers: properties.manuallyApprovesFollowers ?? false,
		publicKey: publicKey ?? undefined,
		alsoKnownAs: properties.alsoKnownAs ?? undefined,
		sensitive: properties.sensitive ?? undefined,

		// Hidden values
		[mastodonIdSymbol]: row.mastodon_id,
	}
}
