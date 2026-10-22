import { type FieldSource, fieldSources } from './accounts'
import { accessAdminRefusal } from './admin-authority'
import { availableLocalSql, availableSql, followListsShownSql } from './audience'
import { type EmojiTag, localEmojiTags } from './custom-emojis'
import { taggedUrl } from './featured-tags'
import { readOperation, writeOperation } from './operation'
import { listedTagName, listedTagNameSql } from './tag-bounds'
import type { Db } from '../db/sql'
import type { ImportAuthority } from '../platform/store-admin'
import { ACCOUNT_EMOJIS_BYTES } from '../platform/stored-bounds'
import { base64ToBytes, bytesToBase64 } from '../security/key-wrap'

// What the federation layer needs from the Store to publish local actors: profiles, wrapped keys, collections, and
// usage counts. Ids are derived by the caller from the domain fixed at /setup.

export type LocalActor = {
	username: string
	actorType: string
	displayName: string
	note: string
	avatarUrl: string | null
	headerUrl: string | null
	locked: boolean
	discoverable: boolean | null
	indexable: boolean
	alsoKnownAs: string[]
	// Profile fields as the owner wrote them; the actor document publishes them as PropertyValue attachments.
	fields: FieldSource[]
	// Mastodon's attribution domains, published as `attributionDomains` when there is one (federation.ts).
	attributionDomains: string[]
	// A suspended actor is published redacted (federation.ts).
	suspended: boolean
	// The Emoji tags of the profile's local emoji snapshot (custom-emojis.ts localEmojiTags); none while suspended.
	emojis: EmojiTag[]
	pubkey: string
	createdAt: string
}

export type StoredKey = { privkey: Uint8Array; salt: Uint8Array; pubkey: string }

type ActorRow = {
	uri: string
	username: string
	actor_type: string
	display_name: string
	note: string
	avatar_url: string | null
	header_url: string | null
	locked: number
	discoverable: number | null
	indexable: number | null
	also_known_as: string
	fields: string
	attribution_domains: string
	suspended_at: string | null
	pubkey: string
	created_at: string
	emojis: string | null
}

const LOCAL_BY_USERNAME =
	'FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.domain IS NULL AND lower(a.username) = lower(?)'

export const getInstanceDomain = readOperation<void, string | null>(
	(db) => db.first<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value ?? null
)

// A local actor by username, case-insensitively (local usernames are unique regardless of case).
export function localActorOf(db: Db, username: string): LocalActor | null {
	const row = db.first<ActorRow>(
		`SELECT a.uri, a.username, a.actor_type, a.display_name, a.note, a.avatar_url, a.header_url, a.locked,
			a.discoverable, a.indexable, l.also_known_as, l.fields, l.attribution_domains, l.suspended_at, l.pubkey,
			a.created_at, a.emojis
		${LOCAL_BY_USERNAME}`,
		username
	)
	if (row === undefined) {
		return null
	}
	return {
		username: row.username,
		actorType: row.actor_type,
		displayName: row.display_name,
		note: row.note,
		avatarUrl: row.avatar_url,
		headerUrl: row.header_url,
		locked: row.locked === 1,
		discoverable: row.discoverable === null ? null : row.discoverable === 1,
		indexable: row.indexable === 1,
		alsoKnownAs: JSON.parse(row.also_known_as) as string[],
		fields: fieldSources(row.fields),
		attributionDomains: JSON.parse(row.attribution_domains) as string[],
		suspended: row.suspended_at !== null,
		emojis:
			row.suspended_at === null ? localEmojiTags(db, row.emojis, new URL(row.uri).origin, ACCOUNT_EMOJIS_BYTES) : [],
		pubkey: row.pubkey,
		createdAt: row.created_at,
	}
}

export const getLocalActor = readOperation<{ username: string }, LocalActor | null>((db, { username }) =>
	localActorOf(db, username)
)

type KeyRow = { username: string; privkey: ArrayBuffer; privkey_salt: ArrayBuffer; pubkey: string }

function storedKey(row: Omit<KeyRow, 'username'>): StoredKey {
	return { privkey: new Uint8Array(row.privkey), salt: new Uint8Array(row.privkey_salt), pubkey: row.pubkey }
}

// The wrapped key of the local account `accountId`, for an activity its own request has signed in the Worker (a
// revoke's stamp Delete, DATA-1: unwrapped there, per call).
export function accountKey(db: Db, accountId: string): StoredKey | null {
	const row = db.first<Omit<KeyRow, 'username'>>(
		'SELECT privkey, privkey_salt, pubkey FROM local_accounts WHERE account_id = ?',
		accountId
	)
	return row === undefined ? null : storedKey(row)
}

export const getLocalKey = readOperation<{ username: string }, StoredKey | null>((db, { username }) => {
	const row = db.first<KeyRow>(`SELECT a.username, l.privkey, l.privkey_salt, l.pubkey ${LOCAL_BY_USERNAME}`, username)
	return row === undefined ? null : storedKey(row)
})

// The key of a local account, by its exact username, that signs a fetch as itself (the recipient of a personal inbox, a
// QuoteRequest's quoted author as Mastodon's on_behalf_of), read when it is loaded: only while the account is
// available, so an account suspended or being deleted, before or after the request's round, never signs; null
// otherwise, and the instance actor signs. Publishing its public key is getLocalKey's, which has no such check.
export const getSigningKey = readOperation<{ username: string }, StoredKey | null>((db, { username }) => {
	const row = db.first<KeyRow>(
		`SELECT a.username, l.privkey, l.privkey_salt, l.pubkey FROM accounts a JOIN local_accounts l ON l.account_id = a.id
		WHERE a.domain IS NULL AND a.username = ? AND ${availableLocalSql('l')}`,
		username
	)
	return row === undefined ? null : storedKey(row)
})

// The key of a local account that signs a fetch on a remote account's behalf (FollowerSigner in remote-collections.ts),
// with its username, checked when it is loaded: the local account is available and follows the remote account (an
// accepted follow), and the remote account is available. Null otherwise, and the fetch is signed by the instance actor.
export const getFollowerKey = readOperation<
	{ follower: string; of: string },
	{ username: string; key: StoredKey } | null
>((db, { follower, of }) => {
	const row = db.first<KeyRow>(
		`SELECT a.username, l.privkey, l.privkey_salt, l.pubkey FROM local_accounts l JOIN accounts a ON a.id = l.account_id
		WHERE l.account_id = ?1 AND ${availableLocalSql('l')} AND ${availableSql('?2')}
			AND EXISTS (SELECT 1 FROM follows f WHERE f.account_id = ?1 AND f.target_account_id = ?2 AND f.state = 'accepted')`,
		follower,
		of
	)
	return row === undefined ? null : { username: row.username, key: storedKey(row) }
})

// The instance actor's key pair, wrapped with the KEK, in instance_settings (base64 for the binary parts).
const INSTANCE_ACTOR_KEY = 'instance_actor_key'

export type EncodedKey = { privkey: string; salt: string; pubkey: string }

export function readInstanceKey(db: Db): EncodedKey | null {
	const row = db.first<{ value: string }>('SELECT value FROM instance_settings WHERE name = ?', INSTANCE_ACTOR_KEY)
	return row === undefined ? null : (JSON.parse(row.value) as EncodedKey)
}

export const getInstanceActorKey = readOperation<void, EncodedKey | null>((db) => readInstanceKey(db))

// Stores a freshly generated instance actor key unless one exists, and returns the stored one: two racing first
// requests agree on a single key.
export const ensureInstanceActorKey = writeOperation<EncodedKey, EncodedKey>((db, key) => {
	db.run('INSERT OR IGNORE INTO instance_settings (name, value) VALUES (?, ?)', INSTANCE_ACTOR_KEY, JSON.stringify(key))
	return readInstanceKey(db) ?? key
})

// Every key this instance signs with, for the key check of healthReport. owner is the username, or null for the
// instance actor.
export const listLocalKeys = readOperation<void, { owner: string | null; key: StoredKey }[]>((db) => {
	const users = db
		.all<KeyRow>(
			'SELECT a.username, l.privkey, l.privkey_salt, l.pubkey FROM local_accounts l JOIN accounts a ON a.id = l.account_id ORDER BY a.username'
		)
		.map((row) => ({ owner: row.username, key: storedKey(row) }))
	const instance = readInstanceKey(db)
	return instance === null ? users : [...users, { owner: null, key: decodeKey(instance) }]
})

export function decodeKey(key: EncodedKey): StoredKey {
	return { privkey: base64ToBytes(key.privkey), salt: base64ToBytes(key.salt), pubkey: key.pubkey }
}

// ---- the KEK rewrap (app/key-rewrap.ts, `kopje-admin keys rewrap`): the Store reads pages of the wrapped keys and
// writes a rewrapped key only over the bytes that were read. The cryptography runs in the Worker.

// Local keys per page: each costs the Worker a few PBKDF2 derivations and RSA signatures, so a page stays well within a
// request's CPU time and its Store calls (one listing and at most one write per key).
export const KEY_PAGE = 10

// A key the rewrap may change: account is the local account id, or null for the instance actor; owner is the username,
// or null for the instance actor.
export type RewrapKey = { account: string | null; owner: string | null; key: StoredKey }

// keys: at most KEY_PAGE local users in account id order after `after`, then, on the last page, the instance actor's
// key; next: the account id the page ended at (the next page starts after it); done: nothing is after this page.
export type RewrapKeyPage = { keys: RewrapKey[]; next: string | null; done: boolean }

export const listRewrapKeys = readOperation<{ after: string | null }, RewrapKeyPage>((db, { after }) => {
	const users = db
		.all<KeyRow & { account_id: string }>(
			`SELECT l.account_id, a.username, l.privkey, l.privkey_salt, l.pubkey FROM local_accounts l
			JOIN accounts a ON a.id = l.account_id WHERE l.account_id > ? ORDER BY l.account_id LIMIT ?`,
			after ?? '',
			KEY_PAGE
		)
		.map((row) => ({ account: row.account_id, owner: row.username, key: storedKey(row) }))
	const next = users.at(-1)?.account ?? after
	if (users.length === KEY_PAGE) {
		return { keys: users, next, done: false }
	}
	const instance = readInstanceKey(db)
	return {
		keys: instance === null ? users : [...users, { account: null, owner: null, key: decodeKey(instance) }],
		next,
		done: true,
	}
})

export type RewrapWrite = { status: 'written' } | { status: 'changed' } | { status: 'denied'; reason: string }

// Replaces one wrapped key (bytes and salt; the public key never changes) by its rewrapped form, only while the stored
// key is still exactly the one the Worker read and checked: anything written meanwhile is never overwritten
// ('changed'). An Access admin only, checked again here.
export const rewrapLocalKey = writeOperation<
	{
		authority: ImportAuthority
		account: string | null
		read: StoredKey
		wrapped: { privkey: Uint8Array; salt: Uint8Array }
	},
	RewrapWrite
>((db, { authority, account, read, wrapped }) => {
	const refused = accessAdminRefusal(db, authority, 'only an Access admin rewraps keys')
	if (refused !== null) {
		return { status: 'denied', reason: refused }
	}
	if (account !== null) {
		const written = db.run(
			`UPDATE local_accounts SET privkey = ?, privkey_salt = ?
			WHERE account_id = ? AND privkey = ? AND privkey_salt = ? AND pubkey = ?`,
			wrapped.privkey.slice().buffer,
			wrapped.salt.slice().buffer,
			account,
			read.privkey.slice().buffer,
			read.salt.slice().buffer,
			read.pubkey
		)
		return written === 1 ? { status: 'written' } : { status: 'changed' }
	}
	const stored = readInstanceKey(db)
	if (
		stored === null ||
		stored.privkey !== bytesToBase64(read.privkey) ||
		stored.salt !== bytesToBase64(read.salt) ||
		stored.pubkey !== read.pubkey
	) {
		return { status: 'changed' }
	}
	const key: EncodedKey = {
		privkey: bytesToBase64(wrapped.privkey),
		salt: bytesToBase64(wrapped.salt),
		pubkey: stored.pubkey,
	}
	db.run('UPDATE instance_settings SET value = ? WHERE name = ?', JSON.stringify(key), INSTANCE_ACTOR_KEY)
	return { status: 'written' }
})

export type CollectionKind = 'followers' | 'following'

// hidden: the owner hides its network, so the collection shows its size only and refuses its pages.
export type CollectionPage = {
	total: number
	items: { uri: string; inbox: string | null }[]
	hasNext: boolean
	hidden: boolean
}

export const COLLECTION_PAGE_SIZE = 40

// Accepted follows of a local actor, newest first, one page (1-based) at a time. page null asks for the count only.
// A suspended actor has none, as its outbox has none. A remote server fetches these without a viewer, so an actor that
// hides its network (followListsShownSql with no viewer) shows the count only and no page, as Mastodon's
// FollowerAccountsController and FollowingAccountsController show totalItems only.
export const getCollection = readOperation<
	{ username: string; kind: CollectionKind; page: number | null },
	CollectionPage | null
>((db, { username, kind, page }) => {
	const owner = db.first<{ id: string; shown: number }>(
		`SELECT a.id, ${followListsShownSql('a.id', 'NULL')} AS shown ${LOCAL_BY_USERNAME} AND ${availableLocalSql('l')}`,
		username
	)
	if (owner === undefined) {
		return null
	}
	const [self, other] = kind === 'followers' ? ['target_account_id', 'account_id'] : ['account_id', 'target_account_id']
	const total =
		db.first<{ n: number }>(`SELECT count(*) AS n FROM follows WHERE ${self} = ? AND state = 'accepted'`, owner.id)
			?.n ?? 0
	const hidden = owner.shown === 0
	if (page === null || hidden) {
		return { total, items: [], hasNext: false, hidden }
	}
	const items = db.all<{ uri: string; inbox: string | null }>(
		`SELECT a.uri, a.inbox_url AS inbox FROM follows f JOIN accounts a ON a.id = f.${other}
		WHERE f.${self} = ? AND f.state = 'accepted' ORDER BY f.id DESC LIMIT ? OFFSET ?`,
		owner.id,
		COLLECTION_PAGE_SIZE + 1,
		(page - 1) * COLLECTION_PAGE_SIZE
	)
	return {
		total,
		items: items.slice(0, COLLECTION_PAGE_SIZE),
		hasNext: items.length > COLLECTION_PAGE_SIZE,
		hidden,
	}
})

// The featured hashtags of a local actor (its featuredTags collection, as Mastodon's ActivityPub::CollectionsController
// serves `tags`): each name as the account wrote it and the URL of its statuses with it, oldest first. Null for no such
// actor, or a suspended one, which has no collections, as getCollection answers.
export const featuredTagsOfActor = readOperation<
	{ username: string; origin: string },
	{ name: string; href: string }[] | null
>((db, { username, origin }) => {
	const owner = db.first<{ id: string; username: string }>(
		`SELECT a.id, a.username ${LOCAL_BY_USERNAME} AND ${availableLocalSql('l')}`,
		username
	)
	if (owner === undefined) {
		return null
	}
	// Names read as list keys (tag-bounds.ts): a row either refuses (an import's) is left out.
	return db
		.all<{ name: string | null; display_name: string | null }>(
			`SELECT ${listedTagNameSql('name')} AS name, ${listedTagNameSql('display_name')} AS display_name
			FROM featured_tags WHERE account_id = ? ORDER BY id`,
			owner.id
		)
		.flatMap((row) => {
			const name = listedTagName(row.name)
			const display = listedTagName(row.display_name)
			return name === null || display === null ? [] : [{ name: display, href: taggedUrl(origin, owner.username, name) }]
		})
})

export type NodeInfoUsage = { users: number; activeMonth: number; activeHalfyear: number; localPosts: number }

const DAY_MS = 24 * 60 * 60 * 1000

// Usage for NodeInfo. Active means "posted in the window", the only activity the Store records for local users.
export function nodeInfoUsageOf(db: Db, now: number): NodeInfoUsage {
	const since = (days: number) => new Date(now - days * DAY_MS).toISOString()
	const active = (days: number) =>
		db.first<{ n: number }>(
			`SELECT count(DISTINCT s.account_id) AS n FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id
			WHERE s.published_at >= ?`,
			since(days)
		)?.n ?? 0
	return {
		users:
			db.first<{ n: number }>(`SELECT count(*) AS n FROM local_accounts l WHERE ${availableLocalSql('l')}`)?.n ?? 0,
		activeMonth: active(30),
		activeHalfyear: active(180),
		localPosts:
			db.first<{ n: number }>(
				`SELECT count(*) AS n FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id
				WHERE s.reblog_of_id IS NULL`
			)?.n ?? 0,
	}
}

export const getNodeInfoUsage = readOperation<{ now: number }, NodeInfoUsage>((db, { now }) => nodeInfoUsageOf(db, now))
