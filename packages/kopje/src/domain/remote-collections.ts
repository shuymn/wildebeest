import { availableLocalSql, availableSql, requiresMention, type Visibility } from './audience'
import { displayName, featuredTagNamed, MAX_FEATURED_TAGS, writeFeatured } from './featured-tags'
import { readOperation, writeOperation } from './operation'
import { type RemoteStatusInput, statusByUri, storeRemoteStatus } from './remote-statuses'
import { isHashtagName } from './status-text'
import { normalizeTag } from './tag-name'
import type { Db } from '../db/sql'
import { httpUrl } from '../platform/http-url'

// What Kopje learns of a remote account's collections (Mastodon 4.5's ActivityPub::ProcessAccountService,
// SynchronizeFeaturedCollectionWorker and SynchronizeFeaturedTagsCollectionWorker with their Fetch*Service, and
// ActivityPub::Activity::Add and Remove): its pinned statuses (the featured collection), its featured hashtags (the
// featuredTags collection) and whether it hides its network (hide_collections). They go in the rows a local account's
// go in (status_pins, featured_tags, migration 0025_remote_collections) and accounts.hide_collections, so the profile
// reads (timelines.ts accountStatuses with pinned, featured-tags.ts accountFeaturedTags, and R13 in audience.ts) serve
// a remote account through the same rules.
//
// When the account's document is stored (inbox.ts upsertRemoteActor, every path that stores one), a sync is
// requested (collection_syncs, one row per account): the Worker's inbound job rounds (jobs/queue.ts) claim a few,
// read the collections through the safe loader within one request's fetch budget each (federation/collections.ts),
// and hand back what they read (applyCollectionSync). An Add or a Remove whose target is the actor's own featured or
// featuredTags collection changes one row (inbox.ts add and remove).
//
// Every input is the remote server's: a collection is read only on the actor's own host, an item only when it is the
// actor's own status on that host, at most MAX_REMOTE_PINS pins and MAX_FEATURED_TAGS hashtags are kept, and a hashtag
// must be a valid name.

// The most pins a remote account keeps. Mastodon keeps any number for a remote account (StatusPinValidator limits
// local accounts to five) but reads only the first page of the collection; Kopje bounds them, so the pinned read of a
// remote profile stays bounded.
export const MAX_REMOTE_PINS = 20
// Claims of one sync before it is dropped, and how long a claim holds it from other rounds.
export const MAX_SYNC_ATTEMPTS = 3
export const SYNC_LEASE_MS = 10 * 60 * 1000

// Asks for a sync of the account's collections (ProcessAccountService#check_featured_collection! and
// #check_featured_tags_collection!, and the hide_collections it sets). One request per account waits at a time, as
// Sidekiq's until_executed lock keeps one job. Whether a request waits that no round has claimed.
export function requestCollectionSync(db: Db, accountId: string, now: number): boolean {
	db.run(
		'INSERT INTO collection_syncs (account_id, requested_at) VALUES (?, ?) ON CONFLICT (account_id) DO NOTHING',
		accountId,
		now
	)
	return (
		db.first('SELECT 1 AS x FROM collection_syncs WHERE account_id = ? AND claimed_at IS NULL', accountId) !== undefined
	)
}

// The collections a stored actor document names, http(s) only, as strings (an id given as an object with an id too).
export type ActorCollections = {
	featured: string | null
	featuredTags: string | null
	followers: string | null
	following: string | null
}

function idOf(value: unknown): string | null {
	const id =
		typeof value === 'string'
			? value
			: typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
				? (value as { id: string }).id
				: null
	return httpUrl(id)?.href ?? null
}

export function actorCollections(raw: string | null): ActorCollections {
	let document: Record<string, unknown> = {}
	try {
		const parsed = raw === null ? null : (JSON.parse(raw) as unknown)
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			document = parsed as Record<string, unknown>
		}
	} catch {
		// A stored document always parses; an unreadable one names no collection.
	}
	return {
		featured: idOf(document.featured),
		featuredTags: idOf(document.featuredTags),
		followers: idOf(document.followers),
		following: idOf(document.following),
	}
}

function originOf(uri: string | null): string | null {
	if (uri === null) {
		return null
	}
	try {
		return new URL(uri).origin
	} catch {
		return null
	}
}

// Which of the actor's own collections `target` is (Add#perform and Remove#perform compare it with the account's
// featured_collection_url): its featured collection, or its featuredTags collection, on its own origin; null for
// anything else.
export function collectionOf(db: Db, accountId: string, target: string): 'featured' | 'featuredTags' | null {
	const row = db.first<{ uri: string; raw: string | null }>(
		'SELECT uri, raw FROM accounts WHERE id = ? AND domain IS NOT NULL',
		accountId
	)
	if (row === undefined || originOf(target) === null || originOf(target) !== originOf(row.uri)) {
		return null
	}
	const collections = actorCollections(row.raw)
	return target === collections.featured ? 'featured' : target === collections.featuredTags ? 'featuredTags' : null
}

type Pinnable = { id: string; account_id: string; reblog_of_id: string | null; visibility: Visibility }

// Whether the account may pin the status (StatusPinValidator): its own original, neither direct nor limited.
function pinnable(status: Pinnable | undefined, accountId: string): status is Pinnable {
	return (
		status !== undefined &&
		status.account_id === accountId &&
		status.reblog_of_id === null &&
		!requiresMention(status.visibility)
	)
}

function pinnableStatus(db: Db, statusId: string): Pinnable | undefined {
	return db.first<Pinnable>('SELECT id, account_id, reblog_of_id, visibility FROM statuses WHERE id = ?', statusId)
}

// Add#add_featured: the account pins its stored status, unless it pins it already or keeps MAX_REMOTE_PINS. Whether a
// pin was written.
export function pinRemote(db: Db, accountId: string, statusId: string, now: number): boolean {
	if (!pinnable(pinnableStatus(db, statusId), accountId)) {
		return false
	}
	const pins = db.first<{ n: number }>(
		'SELECT count(*) AS n FROM (SELECT 1 FROM status_pins WHERE account_id = ? LIMIT ?)',
		accountId,
		MAX_REMOTE_PINS
	)
	if ((pins?.n ?? 0) >= MAX_REMOTE_PINS) {
		return false
	}
	return (
		db.run(
			'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
			accountId,
			statusId,
			new Date(now).toISOString()
		) > 0
	)
}

// Remove#remove_featured: the account's pin of its status, if any.
export function unpinRemote(db: Db, accountId: string, statusUri: string): boolean {
	return (
		db.run(
			`DELETE FROM status_pins WHERE account_id = ?1
			AND status_id = (SELECT id FROM statuses WHERE uri = ?2 AND account_id = ?1)`,
			accountId,
			statusUri
		) > 0
	)
}

// FeaturedTag's normalization of a received name (a leading # dropped, surrounding whitespace too), or null when it is
// not a valid hashtag name (FeaturedTag validates the name against Tag::HASHTAG_NAME_RE).
function featuredName(name: string): string | null {
	const display = displayName(name)
	return display !== '' && isHashtagName(display) && normalizeTag(display) !== '' ? display : null
}

// Add#add_featured_tags: the account features the hashtag, unless it does already or features MAX_FEATURED_TAGS.
export function featureRemote(db: Db, accountId: string, name: string, now: number): boolean {
	const display = featuredName(name)
	if (display === null || featuredTagNamed(db, accountId, normalizeTag(display)) !== undefined) {
		return false
	}
	const featured = db.first<{ n: number }>(
		'SELECT count(*) AS n FROM (SELECT 1 FROM featured_tags WHERE account_id = ? LIMIT ?)',
		accountId,
		MAX_FEATURED_TAGS
	)
	if ((featured?.n ?? 0) >= MAX_FEATURED_TAGS) {
		return false
	}
	writeFeatured(db, accountId, display, now)
	return true
}

// Remove#remove_featured_tags: the account's featured hashtag of that name (FeaturedTag.by_name), if any.
export function unfeatureRemote(db: Db, accountId: string, name: string): boolean {
	const display = displayName(name)
	return (
		display !== '' &&
		db.run('DELETE FROM featured_tags WHERE account_id = ? AND name = ?', accountId, normalizeTag(display)) > 0
	)
}

// ---- Syncs

// A sync a round claimed: the account, the collections its stored document names, and the local follower whose key
// signs the fetches (FetchFeaturedCollectionService#local_follower: the first available one), or null for the
// instance actor. pending: another sync waits.
export type CollectionSync = ActorCollections & { accountUri: string; signer: string | null; pending: boolean }

function claimable(db: Db, now: number): { account_id: string; attempts: number } | undefined {
	return db.first<{ account_id: string; attempts: number }>(
		`SELECT account_id, attempts FROM collection_syncs
		WHERE claimed_at IS NULL OR claimed_at <= ? ORDER BY requested_at LIMIT 1`,
		now - SYNC_LEASE_MS
	)
}

// The oldest sync no round holds, claimed for SYNC_LEASE_MS. One claimed MAX_SYNC_ATTEMPTS times already, or of an
// account that is no longer an available remote account, is dropped instead (ProcessAccountService schedules none
// for a suspended account, and the services return for one), and the next is taken; at most MAX_SYNC_ATTEMPTS + 1
// rows are read.
export const claimCollectionSync = writeOperation<{ now: number }, CollectionSync | null>((db, { now }) => {
	for (let round = 0; round <= MAX_SYNC_ATTEMPTS; round++) {
		const row = claimable(db, now)
		if (row === undefined) {
			return null
		}
		const account = db.first<{ uri: string; raw: string | null }>(
			`SELECT a.uri, a.raw FROM accounts a WHERE a.id = ?1 AND a.domain IS NOT NULL AND ${availableSql('?1')}`,
			row.account_id
		)
		if (account === undefined || row.attempts >= MAX_SYNC_ATTEMPTS) {
			db.run('DELETE FROM collection_syncs WHERE account_id = ?', row.account_id)
			continue
		}
		db.run(
			'UPDATE collection_syncs SET claimed_at = ?, attempts = attempts + 1 WHERE account_id = ?',
			now,
			row.account_id
		)
		// Walked from the local accounts, each a key lookup of its follow: the account's remote followers, however many,
		// are never read.
		const signer = db.first<{ username: string }>(
			`SELECT a.username FROM local_accounts l CROSS JOIN accounts a ON a.id = l.account_id
			WHERE ${availableLocalSql('l')} AND EXISTS (SELECT 1 FROM follows f
				WHERE f.account_id = l.account_id AND f.target_account_id = ? AND f.state = 'accepted')
			ORDER BY l.account_id LIMIT 1`,
			row.account_id
		)
		return {
			accountUri: account.uri,
			...actorCollections(account.raw),
			signer: signer?.username ?? null,
			pending: claimable(db, now) !== undefined,
		}
	}
	return null
})

// The statuses among `uris` Kopje stores (the Worker fetches only the others). At most MAX_REMOTE_PINS are looked up,
// each by its key.
export const storedStatusUris = readOperation<{ uris: readonly string[] }, string[]>((db, { uris }) =>
	db
		.all<{ uri: string }>(
			'SELECT uri FROM statuses WHERE uri IN (SELECT value FROM json_each(?))',
			JSON.stringify(uris.slice(0, MAX_REMOTE_PINS))
		)
		.map((row) => row.uri)
)

// What a round read of the account's collections. null: that part could not be read, and stays as it is.
//   pins: the uris the featured collection lists (its first page, in its order), and the statuses fetched among them
//         that Kopje did not store (null: fetched, and not usable).
//   tags: the names of the Hashtags the featuredTags collection lists (or, for an actor without one, the featured
//         collection: FetchFeaturedCollectionService with hashtag).
//   hideCollections: whether its followers or following collection hides its items (no first page).
export type CollectionSyncInput = {
	now: number
	origin: string
	accountUri: string
	pins: { uris: string[]; fetched: Record<string, RemoteStatusInput | null> } | null
	tags: string[] | null
	hideCollections: boolean | null
}

// Applies what a round read (FetchFeaturedCollectionService#process_note_items and #process_hashtag_items,
// FetchFeaturedTagsCollectionService#process_items, ProcessAccountService#set_fetchable_attributes!) and ends the sync.
// Nothing is applied to an account that is gone or unavailable.
export const applyCollectionSync = writeOperation<CollectionSyncInput, void>((db, input) => {
	const account = db.first<{ id: string; uri: string }>(
		'SELECT id, uri FROM accounts WHERE uri = ? AND domain IS NOT NULL',
		input.accountUri
	)
	if (account === undefined) {
		return
	}
	db.run('DELETE FROM collection_syncs WHERE account_id = ?', account.id)
	if (db.first(`SELECT 1 AS x WHERE ${availableSql('?1')}`, account.id) === undefined) {
		return
	}
	if (input.pins !== null) {
		replacePins(db, account, input.pins, input)
	}
	if (input.tags !== null) {
		replaceFeaturedTags(db, account.id, input.tags, input.now)
	}
	if (input.hideCollections !== null) {
		db.run('UPDATE accounts SET hide_collections = ? WHERE id = ?', input.hideCollections ? 1 : 0, account.id)
	}
})

// The account's pins become the statuses the collection lists that are its own, pinnable, and stored (or fetched now,
// stored as a fetched status: Mastodon's FetchRemoteStatusService with expected_actor_uri), the first MAX_REMOTE_PINS
// of them; the others are unpinned. A pin kept keeps its time; a new one is timed so that the collection's order is
// the profile's (the first listed is the newest pin).
function replacePins(
	db: Db,
	account: { id: string; uri: string },
	pins: NonNullable<CollectionSyncInput['pins']>,
	input: CollectionSyncInput
): void {
	const origin = originOf(account.uri)
	const ids: string[] = []
	for (const uri of [...new Set(pins.uris)].slice(0, MAX_REMOTE_PINS)) {
		if (originOf(uri) !== origin) {
			continue
		}
		let status = statusByUri(db, uri)
		const fetched = pins.fetched[uri]
		if (status === undefined && fetched !== undefined && fetched !== null) {
			const stored = storeRemoteStatus(db, account, fetched, {
				now: input.now,
				origin: input.origin,
				deliveredTo: null,
				fetched: true,
			})
			status = stored.statusId === undefined ? undefined : statusByUri(db, uri)
		}
		if (status !== undefined && pinnable(status, account.id)) {
			ids.push(status.id)
		}
	}
	db.run(
		'DELETE FROM status_pins WHERE account_id = ? AND status_id NOT IN (SELECT value FROM json_each(?))',
		account.id,
		JSON.stringify(ids)
	)
	ids.forEach((id, i) => {
		db.run(
			'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
			account.id,
			id,
			new Date(input.now - i).toISOString()
		)
	})
}

// The account's featured hashtags become the valid names listed, the first MAX_FEATURED_TAGS of them: the others are
// deleted, one kept takes the spelling listed, and a new one is counted as a local one is (writeFeatured).
function replaceFeaturedTags(db: Db, accountId: string, names: readonly string[], now: number): void {
	const listed = new Map<string, string>()
	for (const name of names) {
		const display = featuredName(name)
		if (display !== null && !listed.has(normalizeTag(display))) {
			listed.set(normalizeTag(display), display)
		}
		if (listed.size >= MAX_FEATURED_TAGS) {
			break
		}
	}
	db.run(
		'DELETE FROM featured_tags WHERE account_id = ? AND name NOT IN (SELECT value FROM json_each(?))',
		accountId,
		JSON.stringify([...listed.keys()])
	)
	for (const [name, display] of listed) {
		if (featuredTagNamed(db, accountId, name) === undefined) {
			writeFeatured(db, accountId, display, now)
		} else {
			db.run('UPDATE featured_tags SET display_name = ? WHERE account_id = ? AND name = ?', display, accountId, name)
		}
	}
}
