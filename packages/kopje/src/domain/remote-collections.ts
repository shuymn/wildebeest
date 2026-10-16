import { availableLocalSql, availableSql, requiresMention, type Visibility } from './audience'
import { displayName, featuredTagNamed, MAX_FEATURED_TAGS, writeFeatured } from './featured-tags'
import { writeOperation } from './operation'
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
// requested (collection_syncs, one row per account): the Worker's inbound job rounds (jobs/queue.ts) claim a few, read
// the collections and then fetch the pinned statuses Kopje does not have, through the safe loader within one request's
// fetch budget each (federation/collections.ts), and hand back what they read (completeCollectionRead,
// completePinFetches). An Add or a Remove whose target is the actor's own featured or
// featuredTags collection changes one row (inbox.ts add and remove).
//
// Every input is the remote server's: a collection is read only on the actor's own host, an item only when it is the
// actor's own status on that host, at most MAX_REMOTE_PINS pins and MAX_FEATURED_TAGS hashtags are kept, and a hashtag
// must be a valid name.

// The most pins a remote account keeps. Mastodon keeps any number for a remote account (StatusPinValidator limits
// local accounts to five) but reads only the first page of the collection; Kopje bounds them, so the pinned read of a
// remote profile stays bounded.
export const MAX_REMOTE_PINS = 20
// Rounds of one sync that end with nothing done before it is dropped, how long a claim holds it from other rounds, and
// how long a round that did nothing leaves it before it is due again.
export const MAX_SYNC_ATTEMPTS = 3
export const SYNC_LEASE_MS = 10 * 60 * 1000
export const SYNC_RETRY_MS = 15 * 60 * 1000

// Asks for a sync of the account's collections (ProcessAccountService#check_featured_collection! and
// #check_featured_tags_collection!, and the hide_collections it sets). One request per account waits at a time, as
// Sidekiq's until_executed lock keeps one job; a request while a round holds it is a new generation, which the round's
// end leaves due (applyCollectionSync), so the round reading the older document does not end it. Whether a request is
// due (no round holds it).
export function requestCollectionSync(db: Db, accountId: string, now: number): boolean {
	db.run(
		`INSERT INTO collection_syncs (account_id, due_at) VALUES (?, ?)
		ON CONFLICT (account_id) DO UPDATE SET generation = generation + 1`,
		accountId,
		now
	)
	return (
		db.first('SELECT 1 AS x FROM collection_syncs WHERE account_id = ? AND due_at <= ?', accountId, now) !== undefined
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
	if (!pinsBelowCap(db, accountId)) {
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

// Whether the account pins fewer than MAX_REMOTE_PINS statuses.
function pinsBelowCap(db: Db, accountId: string): boolean {
	const pins = db.first<{ n: number }>(
		'SELECT count(*) AS n FROM (SELECT 1 FROM status_pins WHERE account_id = ? LIMIT ?)',
		accountId,
		MAX_REMOTE_PINS
	)
	return (pins?.n ?? 0) < MAX_REMOTE_PINS
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
//
// A sync has two phases, each a round of its own with its own fetch budget, and durable state between them:
//   1. read: the collections (hide_collections, the featured collection's first MAX_REMOTE_PINS items, the featured
//      hashtags), applied at once: the featured hashtags, hide_collections, and the pins of the listed statuses Kopje
//      stores; the listed statuses it does not store go in collection_pins_pending, in their order.
//   2. pins: later rounds fetch the pending statuses within their budgets; one fetched is stored and pinned, one that
//      cannot be used is dropped, and one that may be fetched later stays. The metadata is never read again for them.
// A round makes progress when phase 1 reads everything or the pending statuses shrink; MAX_SYNC_ATTEMPTS claims
// without progress drop the sync.

// The username of the first available local account that follows the account (Mastodon's local_follower), whose key
// signs fetches on the account's behalf, or null. Walked from the local accounts, each a key lookup of its follow: the
// account's remote followers, however many, are never read.
export function localFollower(db: Db, accountId: string): string | null {
	return (
		db.first<{ username: string }>(
			`SELECT a.username FROM local_accounts l CROSS JOIN accounts a ON a.id = l.account_id
			WHERE ${availableLocalSql('l')} AND EXISTS (SELECT 1 FROM follows f
				WHERE f.account_id = l.account_id AND f.target_account_id = ? AND f.state = 'accepted')
			ORDER BY l.account_id LIMIT 1`,
			accountId
		)?.username ?? null
	)
}

// A sync a round claimed: the account, the collections its stored document names, the phase, the pending statuses
// (phase pins, in order), and the local follower whose key signs the fetches (FetchFeaturedCollectionService#
// local_follower: the first available one), or null for the instance actor. generation: the request the round read,
// which it hands back. pending: another sync is due.
export type CollectionSync = ActorCollections & {
	accountUri: string
	generation: number
	phase: 'read' | 'pins'
	uris: string[]
	signer: string | null
	pending: boolean
}

type SyncRow = { account_id: string; attempts: number; generation: number; read_through: number }

// The sync due first, by a seek of collection_syncs_due: the syncs rounds hold are due later, so none is read.
function claimable(db: Db, now: number): SyncRow | undefined {
	return db.first<SyncRow>(
		`SELECT account_id, attempts, generation, read_through FROM collection_syncs
		WHERE due_at <= ? ORDER BY due_at LIMIT 1`,
		now
	)
}

// The account's pending statuses, in the collection's order (the first listed has the latest pin time).
function pendingUris(db: Db, accountId: string): string[] {
	return db
		.all<{ uri: string }>(
			'SELECT uri FROM collection_pins_pending WHERE account_id = ? ORDER BY pinned_at DESC LIMIT ?',
			accountId,
			MAX_REMOTE_PINS
		)
		.map((row) => row.uri)
}

function dropSync(db: Db, accountId: string): void {
	db.run('DELETE FROM collection_pins_pending WHERE account_id = ?', accountId)
	db.run('DELETE FROM collection_syncs WHERE account_id = ?', accountId)
}

// The sync due first, claimed for SYNC_LEASE_MS (due again when the lease ends): phase read while a request has not
// been read through, else phase pins while statuses are pending. One claimed MAX_SYNC_ATTEMPTS times without progress,
// of an account that is no longer an available remote account (ProcessAccountService schedules none for a suspended
// account, and the services return for one), or with nothing left to do, is dropped instead, and the next is taken;
// at most MAX_SYNC_ATTEMPTS + 1 rows are read.
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
		const read = row.generation > row.read_through
		const uris = read ? [] : pendingUris(db, row.account_id)
		if (account === undefined || row.attempts >= MAX_SYNC_ATTEMPTS || (!read && uris.length === 0)) {
			dropSync(db, row.account_id)
			continue
		}
		db.run(
			'UPDATE collection_syncs SET due_at = ?, attempts = attempts + 1 WHERE account_id = ?',
			now + SYNC_LEASE_MS,
			row.account_id
		)
		return {
			accountUri: account.uri,
			generation: row.generation,
			phase: read ? 'read' : 'pins',
			uris,
			...actorCollections(account.raw),
			signer: localFollower(db, row.account_id),
			pending: claimable(db, now) !== undefined,
		}
	}
	return null
})

// The end of a round of the account's sync: kept while a request is not read through or statuses are pending, due at
// once with a fresh count of attempts after progress (or a request since the round claimed it), else after
// SYNC_RETRY_MS; deleted when nothing is left. Returns whether a sync is due.
function endRound(db: Db, accountId: string, generation: number, progressed: boolean, now: number): boolean {
	const row = db.first<{ generation: number; read_through: number }>(
		'SELECT generation, read_through FROM collection_syncs WHERE account_id = ?',
		accountId
	)
	const pinsLeft = db.first('SELECT 1 AS x FROM collection_pins_pending WHERE account_id = ?', accountId) !== undefined
	if (row !== undefined && row.generation <= row.read_through && !pinsLeft) {
		db.run('DELETE FROM collection_syncs WHERE account_id = ?', accountId)
	} else if (row !== undefined) {
		const renewed = progressed || row.generation !== generation
		db.run(
			`UPDATE collection_syncs SET due_at = ?, attempts = CASE WHEN ? THEN 0 ELSE attempts END WHERE account_id = ?`,
			renewed ? now : now + SYNC_RETRY_MS,
			renewed ? 1 : 0,
			accountId
		)
	}
	return claimable(db, now) !== undefined
}

type RoundInput = { now: number; origin: string; accountUri: string; generation: number }

// The account of a round's end, while it is an available remote account; a sync of one that is not is dropped.
function roundAccount(db: Db, input: RoundInput): { id: string; uri: string } | null {
	const account = db.first<{ id: string; uri: string; available: number }>(
		`SELECT id, uri, ${availableSql('accounts.id')} AS available FROM accounts WHERE uri = ? AND domain IS NOT NULL`,
		input.accountUri
	)
	if (account === undefined) {
		return null
	}
	if (account.available !== 1) {
		dropSync(db, account.id)
		return null
	}
	return account
}

// What phase 1 read of the account's collections. null: that part could not be read, and stays as it is.
//   pins: the uris the featured collection lists (its first page, in its order).
//   tags: the names of the Hashtags the featuredTags collection lists (or, for an actor without one, the featured
//         collection: FetchFeaturedCollectionService with hashtag).
//   hideCollections: whether its followers or following collection hides its items (no first page).
//   unfinished: part of it may be read later (a fetch that may pass, or the budget spent): read again later.
export type CollectionReadInput = RoundInput & {
	pins: { uris: string[] } | null
	tags: string[] | null
	hideCollections: boolean | null
	unfinished: boolean
}

// Phase 1's end (FetchFeaturedCollectionService#process_note_items and #process_hashtag_items,
// FetchFeaturedTagsCollectionService#process_items, ProcessAccountService#set_fetchable_attributes!): what was read is
// applied, and the request is read through unless part of it may be read later. Returns whether a sync is due.
export const completeCollectionRead = writeOperation<CollectionReadInput, boolean>((db, input) => {
	const account = roundAccount(db, input)
	if (account === null) {
		return claimable(db, input.now) !== undefined
	}
	if (input.pins !== null) {
		replacePins(db, account, input.pins.uris, input.now)
	}
	if (input.tags !== null) {
		replaceFeaturedTags(db, account.id, input.tags, input.now)
	}
	if (input.hideCollections !== null) {
		db.run('UPDATE accounts SET hide_collections = ? WHERE id = ?', input.hideCollections ? 1 : 0, account.id)
	}
	if (!input.unfinished) {
		db.run(
			'UPDATE collection_syncs SET read_through = max(read_through, ?) WHERE account_id = ?',
			input.generation,
			account.id
		)
	}
	return endRound(db, account.id, input.generation, !input.unfinished, input.now)
})

// What phase 2 fetched of the pending statuses: a usable status, or null for one that is not (refused, gone, not a
// status). One that may be fetched later is left out.
export type PinFetchesInput = RoundInput & { fetched: Record<string, RemoteStatusInput | null> }

// Phase 2's end: each pending status fetched is stored as a fetched status (Mastodon's FetchRemoteStatusService with
// expected_actor_uri) and pinned when it is the account's own and pinnable, with the time phase 1 gave it; one that
// cannot be used is dropped. The round progressed when the pending statuses shrank. Returns whether a sync is due.
export const completePinFetches = writeOperation<PinFetchesInput, boolean>((db, input) => {
	const account = roundAccount(db, input)
	if (account === null) {
		return claimable(db, input.now) !== undefined
	}
	let done = 0
	for (const [uri, fetched] of Object.entries(input.fetched)) {
		const pending = db.first<{ pinned_at: string }>(
			'SELECT pinned_at FROM collection_pins_pending WHERE account_id = ? AND uri = ?',
			account.id,
			uri
		)
		if (pending === undefined) {
			continue
		}
		if (fetched !== null && fetched.uri === uri) {
			const stored = storeRemoteStatus(db, account, fetched, {
				now: input.now,
				origin: input.origin,
				deliveredTo: null,
				fetched: true,
			})
			const status = stored.statusId === undefined ? undefined : statusByUri(db, uri)
			if (status !== undefined && pinnable(status, account.id) && pinsBelowCap(db, account.id)) {
				db.run(
					'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
					account.id,
					status.id,
					pending.pinned_at
				)
			}
		}
		done += db.run('DELETE FROM collection_pins_pending WHERE account_id = ? AND uri = ?', account.id, uri)
	}
	return endRound(db, account.id, input.generation, done > 0, input.now)
})

// The account's pins become the statuses the collection lists that are its own and pinnable, the first
// MAX_REMOTE_PINS of them on its origin: those Kopje stores at once, those it does not left pending for phase 2; the
// others are unpinned, and what was pending before is replaced. A pin kept keeps its time; a new one is timed so that
// the collection's order is the profile's (the first listed is the newest pin).
function replacePins(db: Db, account: { id: string; uri: string }, uris: readonly string[], now: number): void {
	const origin = originOf(account.uri)
	const pinned: { id: string; at: string }[] = []
	const pending: { uri: string; at: string }[] = []
	;[...new Set(uris)].slice(0, MAX_REMOTE_PINS).forEach((uri, i) => {
		if (originOf(uri) !== origin) {
			return
		}
		const at = new Date(now - i).toISOString()
		const status = statusByUri(db, uri)
		if (status === undefined) {
			pending.push({ uri, at })
		} else if (pinnable(status, account.id)) {
			pinned.push({ id: status.id, at })
		}
	})
	db.run(
		'DELETE FROM status_pins WHERE account_id = ? AND status_id NOT IN (SELECT value FROM json_each(?))',
		account.id,
		JSON.stringify(pinned.map((pin) => pin.id))
	)
	for (const pin of pinned) {
		db.run(
			'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
			account.id,
			pin.id,
			pin.at
		)
	}
	db.run('DELETE FROM collection_pins_pending WHERE account_id = ?', account.id)
	for (const pin of pending) {
		db.run(
			'INSERT INTO collection_pins_pending (account_id, uri, pinned_at) VALUES (?, ?, ?)',
			account.id,
			pin.uri,
			pin.at
		)
	}
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
