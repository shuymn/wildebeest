import { Actor } from 'wildebeest/backend/src/activitypub/actors'
import * as apFollow from 'wildebeest/backend/src/activitypub/actors/follow'
import * as apOutbox from 'wildebeest/backend/src/activitypub/actors/outbox'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { type Database } from 'wildebeest/backend/src/database'
import type { MastodonAccount, Preference } from 'wildebeest/backend/src/types/account'
import {
	actorToHandle,
	Handle,
	handleToAcct,
	isLocalHandle,
	LocalHandle,
	RemoteHandle,
} from 'wildebeest/backend/src/utils/handle'
import { unwrapPrivateKey } from 'wildebeest/backend/src/utils/key-ops'
import { defaultImages } from 'wildebeest/config/accounts'

function toMastodonAccount(handle: Handle, res: Actor): MastodonAccount {
	const avatar = res.icon?.url?.toString() ?? defaultImages.avatar
	const header = res.image?.url?.toString() ?? defaultImages.header

	let acct: string
	if (isLocalHandle(handle)) {
		acct = handle.localPart
	} else {
		acct = handleToAcct(handle)
	}

	// TODO: replace stubs with actual values
	return {
		acct,
		id: res[mastodonIdSymbol],
		username: res.preferredUsername || res.name || 'unnamed',
		url: res.url ? res.url.toString() : '',
		display_name: res.name || res.preferredUsername || '',
		note: res.summary || '',
		created_at: res.published || new Date().toISOString(),

		avatar,
		avatar_static: avatar,

		header,
		header_static: header,

		locked: false,
		bot: false,
		discoverable: true,
		group: false,

		emojis: [],
		fields: [],

		followers_count: 0,
		following_count: 0,
		statuses_count: 0,
	}
}

// Load an external user, using ActivityPub queries, and return it as a MastodonAccount
export async function loadExternalMastodonAccount(
	actor: Actor,
	loadStats = false,
	handle?: RemoteHandle
): Promise<MastodonAccount> {
	if (handle === undefined) {
		handle = actorToHandle(actor)
	}
	const account = toMastodonAccount(handle, actor)
	if (loadStats === true) {
		account.statuses_count = await apOutbox.countStatuses(actor)
		account.followers_count = await apFollow.countFollowers(actor)
		account.following_count = await apFollow.countFollowing(actor)
	}
	return account
}

// Load a local user and return it as a MastodonAccount
export async function loadLocalMastodonAccount(
	db: Database,
	res: Actor,
	handle?: LocalHandle
): Promise<MastodonAccount> {
	if (handle === undefined) {
		handle = {
			localPart: actorToHandle(res).localPart,
			domain: null,
		}
	}
	const account = toMastodonAccount(handle, res)

	const query = `
SELECT
  (SELECT count(*)
   FROM outbox_objects
   INNER JOIN objects ON objects.id = outbox_objects.object_id
   WHERE outbox_objects.actor_id=?
     AND objects.type = 'Note') AS statuses_count,

  (SELECT count(*)
   FROM actor_following
   WHERE actor_following.actor_id=?) AS following_count,

  (SELECT count(*)
   FROM actor_following
   WHERE actor_following.target_actor_id=?) AS followers_count
  `

	const row = await db
		.prepare(query)
		.bind(res.id.toString(), res.id.toString(), res.id.toString())
		.first<{ statuses_count: number; followers_count: number; following_count: number }>()

	account.statuses_count = row.statuses_count
	account.followers_count = row.followers_count
	account.following_count = row.following_count

	return account
}

export async function getSigningKey(instanceKey: string, db: Database, actor: Actor): Promise<CryptoKey> {
	const stmt = db.prepare('SELECT privkey, privkey_salt FROM actors WHERE id=?').bind(actor.id.toString())
	const { privkey, privkey_salt } = (await stmt.first()) as any

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
