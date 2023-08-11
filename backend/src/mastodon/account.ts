import { isLocalAccount } from 'wildebeest/backend/src/accounts'
import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import { countFollowers, countFollowing } from 'wildebeest/backend/src/activitypub/actors/follow'
import { countStatuses } from 'wildebeest/backend/src/activitypub/actors/outbox'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'
import type { MastodonAccount, Preference } from 'wildebeest/backend/src/types/account'
import { Handle, handleToAcct, isLocalHandle, LocalHandle, RemoteHandle } from 'wildebeest/backend/src/utils/handle'
import { unwrapPrivateKey } from 'wildebeest/backend/src/utils/key-ops'
import { PartialProps } from 'wildebeest/backend/src/utils/type'
import { defaultImages } from 'wildebeest/config/accounts'

function toMastodonAccount(
	handle: Handle,
	actor: Actor
): PartialProps<MastodonAccount, 'last_status_at' | 'followers_count' | 'following_count' | 'statuses_count'> {
	const avatar = actor.icon?.url?.toString() ?? defaultImages.avatar
	const header = actor.image?.url?.toString() ?? defaultImages.header

	let acct: string
	if (isLocalHandle(handle)) {
		acct = handle.localPart
	} else {
		acct = handleToAcct(handle)
	}

	return {
		id: actor[mastodonIdSymbol],
		username: actor.preferredUsername ?? actor.name ?? 'unnamed',
		acct,
		url: actor.url ? actor.url.toString() : '',
		display_name: actor.name ?? actor.preferredUsername ?? '',
		note: actor.summary ?? '',
		avatar,
		avatar_static: avatar,
		header,
		header_static: header,
		locked: actor.manuallyApprovesFollowers ?? false,
		// TODO: replace stubs with actual values
		fields: [],
		emojis: [],
		bot: actor.type === 'Service',
		group: actor.type === 'Group',
		discoverable: actor.discoverable,
		created_at: actor.published ?? new Date().toISOString(),
	}
}

export async function loadMastodonAccount(
	db: Database,
	domain: string,
	actor: Actor,
	handle: Handle,
	loadStat = false
): Promise<MastodonAccount> {
	if (isLocalAccount(domain, handle)) {
		return await loadLocalMastodonAccount(db, actor, handle)
	}
	return await loadExternalMastodonAccount(db, actor, handle, loadStat)
}

// Load an external user, using ActivityPub queries, and return it as a MastodonAccount
export async function loadExternalMastodonAccount(
	db: Database,
	actor: Actor,
	handle: RemoteHandle,
	loadStat = false
): Promise<MastodonAccount> {
	const { results } = await db
		.prepare(
			`
SELECT outbox_objects.published_date as last_status_at
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
WHERE outbox_objects.actor_id=?1
  AND objects.type = 'Note'
ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
LIMIT 1
  `
		)
		.bind(actor.id.toString())
		.all<{ last_status_at: string }>()

	const lastStatusAt =
		results !== undefined && results.length === 1 ? new Date(results[0].last_status_at).toISOString() : null

	const account = toMastodonAccount(handle, actor)
	if (loadStat) {
		return {
			...account,
			// TODO: cache this
			statuses_count: await countStatuses(actor),
			followers_count: await countFollowers(actor),
			following_count: await countFollowing(actor),
			last_status_at: lastStatusAt,
		}
	}
	return {
		...account,
		statuses_count: 0,
		followers_count: 0,
		following_count: 0,
		last_status_at: lastStatusAt,
	}
}

// Load a local user and return it as a MastodonAccount
export async function loadLocalMastodonAccount(
	db: Database,
	actor: Actor,
	handle: LocalHandle
): Promise<MastodonAccount> {
	const account = toMastodonAccount({ ...handle, domain: null }, actor)

	const query = `
SELECT
  (SELECT count(*)
   FROM outbox_objects
   INNER JOIN objects ON objects.id = outbox_objects.object_id
   WHERE outbox_objects.actor_id=?1
     AND objects.type = 'Note') AS statuses_count,

  (SELECT count(*)
   FROM actor_following
   WHERE actor_following.actor_id=?1) AS following_count,

  (SELECT count(*)
   FROM actor_following
   WHERE actor_following.target_actor_id=?1) AS followers_count,

  (SELECT outbox_objects.published_date
   FROM outbox_objects
   INNER JOIN objects ON objects.id = outbox_objects.object_id
   WHERE outbox_objects.actor_id=?1
     AND objects.type = 'Note'
   ORDER BY ${db.qb.timeNormalize('outbox_objects.published_date')} DESC
   LIMIT 1) as last_status_at
  `

	const row = await db.prepare(query).bind(actor.id.toString()).first<{
		statuses_count: number
		followers_count: number
		following_count: number
		last_status_at: string | null
	}>()
	if (!row) {
		throw new Error('row is undefined')
	}

	return {
		...account,
		statuses_count: row.statuses_count,
		followers_count: row.followers_count,
		following_count: row.following_count,
		last_status_at: row.last_status_at === null ? null : new Date(row.last_status_at).toISOString(),
	}
}

export async function getSigningKey(instanceKey: string, db: Database, actor: Actor): Promise<CryptoKey> {
	const stmt = db.prepare('SELECT privkey, privkey_salt FROM users WHERE actor_id=?').bind(actor.id.toString())
	const { privkey, privkey_salt } = await stmt.first<{ privkey: any; privkey_salt: any }>().then((row) => {
		if (!row) {
			throw new Error('res is undefined')
		}
		return row
	})

	if (privkey.buffer && privkey_salt.buffer) {
		// neon.tech
		return unwrapPrivateKey(instanceKey, new Uint8Array(privkey.buffer), new Uint8Array(privkey_salt.buffer))
	} else {
		// D1
		return unwrapPrivateKey(instanceKey, new Uint8Array(privkey), new Uint8Array(privkey_salt))
	}
}

export async function getPreference(db: Database, actor: Actor): Promise<Preference> {
	const query = `
SELECT
	posting_default_visibility,
	posting_default_sensitive,
	posting_default_language,
	reading_expand_spoilers
FROM actor_preferences WHERE id=?
`
	const row: any = await db.prepare(query).bind(actor.id.toString()).first()
	return {
		posting_default_visibility: row.posting_default_visibility,
		posting_default_sensitive: row.posting_default_sensitive === 1,
		posting_default_language: row.posting_default_language,
		reading_expand_media: 'default',
		reading_expand_spoilers: row.reading_expand_spoilers === 1,
	}
}
