import { followActivity, followAnswerActivity, followUri, recordOutbound, undoFollowActivity } from './activities'
import {
	activeMuteSql,
	availableLocalSql,
	blockedSql,
	blocksSql,
	canView,
	followableBySql,
	isDistributable,
	isPublicCollection,
	MENTION_STATUS_COLUMNS,
	mentionStatusSql,
	type Visibility,
} from './audience'
import { stageRetraction } from './deliveries'
import { insertWithFreshId, remoteId } from './ids'
import { listsHolding } from './lists'
import { notify } from './notifications'
import { readOperation, writeOperation } from './operation'
import { deleteAccountVotes, deletePollVotes, hasPollVotes } from './polls'
import { pushSequence } from './push'
import {
	followersUri,
	hasLocalFollowers,
	MAX_STATUS_AUDIENCE,
	MAX_STATUS_MENTION_ROWS,
	type RemoteStatusInput,
	statusByUri,
	type StoreContext,
	storeRemoteStatus,
	updateRemoteStatus,
	visibilityOf,
} from './remote-statuses'
import { accountSearchText } from './search-text'
import { recountStatus, recountStatuses, withdrawLocalBoost } from './statuses'
import type { Db } from '../db/sql'
import { hostDomain } from '../platform/domain-name'

// Inbound activities about actors and relationships (B1b-1), applied in one Store transaction each. The Worker has
// already verified the HTTP signature, bound the signer to the actor (ID-1), fetched and sanitized what it needed
// (HTML-1, HTML-3) and checked the shape of the activity; here the authorization table (ID-6) is applied against the
// stored state, and every effect is keyed so that a replay changes nothing twice (ID-7).
//
// ID-6, Mastodon 4.7.3's rules for the types handled here (one negative test each in test/inbox.test.ts):
//   Follow       the object is a local account (exact actor URI); the actor is the follower; refused while either
//                side blocks the other
//   Accept       the actor is the target of our matching Follow (see ourFollow)
//   Reject       as Accept
//   Undo         the undone activity's actor is the actor, and it names the current Follow or Block (see undo)
//   Block        the object is a local account; the actor is the blocker
//   Move         the object is the actor, and the target lists the actor in alsoKnownAs (ID-4)
//   Update       of an actor: the object is the actor itself; of a status: the stored status's author is the actor
//                (and a local status never is, ID-3)
//   Delete       of an actor: the object is the actor itself; of a status or boost: its author is the actor; of
//                anything else of the actor's origin: recorded as a retraction (ID-7)
//   Create       the object has the actor's origin and names no other author (attributedTo)
//   Like         the object is a local status the actor may see (VIS-1); the actor is the one who likes it
//   Announce     the actor is the booster; the original is public, unlisted or the actor's own (VIS-6)
// B1b-2's rows (Create, Update and Delete of statuses, Like, Announce) are applied in domain/remote-statuses.ts and
// below; test/inbox-statuses.test.ts has one negative test per row.
// The activity id has the actor's origin (checked by the Worker before anything is written, and again here).
// ID-3: no inbound activity changes a local account's own row or a local status; local follows change only as the
// relationship the remote side controls (its follow of us, our pending follow of it).
//
// A Follow has generations: a repeated Follow replaces the edge's uri, and the superseded id is recorded as retracted.
// An Undo, Accept or Reject naming a superseded or unknown id never reaches the current edge, except through the
// narrow pair fallbacks documented at ourFollow and undo.

// A retraction (Undo or Delete) is kept this long; an activity it names that arrives later is ignored (ID-7).
export const RETRACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000
// At most this many live retractions per actor (RES-4): a remote can name any number of ids of its own origin. An
// actor's own deletion does not depend on it (inbound_jobs).
export const MAX_RETRACTIONS_PER_ACTOR = 10_000
// Expired retractions, finished jobs and expired mutes removed per call (RES-4), so the sweep stays bounded and
// keeps up.
export const SWEEP_BATCH = 100
// A stored key is trusted this long after its actor document was fetched; after that the Worker fetches it again.
// A deleted actor's own Delete is the one exception (federation/inbound.ts).
export const KEY_REFRESH_MS = 24 * 60 * 60 * 1000
// A finished job, and with it a deleted actor's tombstone, is kept this long after it is done.
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// Bounds of one batch of a Move (RES-6): local followers moved, and local blocks and mutes carried over to the target.
export const MOVE_BATCH = 100
export const MOVE_MAX_CARRIED = 100
// Rows one batch of a deleted actor's purge, or of a deleted status's removal, writes at most (RES-6).
export const PURGE_BATCH = 500
// Job batches one runInboundJobs call does at most.
export const JOB_BATCHES_PER_RUN = 4

// A remote actor as the Worker extracted it from a fetched, origin-checked document (ID-2). Text is bounded,
// display_name is plain text, note is sanitized HTML (HTML-1) and URLs are http(s) or null (HTML-3). keys are the
// public keys the document lists whose owner is this actor and whose id has its origin.
export type RemoteActorInput = {
	uri: string
	username: string
	domain: string
	actorType: string
	displayName: string
	note: string
	url: string | null
	avatarUrl: string | null
	headerUrl: string | null
	locked: boolean
	discoverable: boolean | null
	inboxUrl: string | null
	sharedInboxUrl: string | null
	published: string | null
	keys: { id: string; pem: string }[]
	// The document as received; followers, alsoKnownAs and fields are read from it.
	raw: string
	// The canonical domain of the actor's address for this username, set by the search resolver only after the actor's
	// host declared it and that domain confirmed it (declaredDomain in federation/resolve.ts); the host itself when
	// the host's own answer names it there. Never set from a document.
	confirmedDomain?: string
}

// The object of an Accept, Reject or Undo: an id, or an embedded activity (id optional).
export type ActivityRef = { id: string | null; type: string | null; actor: string | null; object: string | null }

export type InboundActivity =
	| { type: 'Follow'; id: string; object: string }
	| { type: 'Accept'; id: string; object: ActivityRef }
	| { type: 'Reject'; id: string; object: ActivityRef }
	| { type: 'Undo'; id: string; object: ActivityRef }
	| { type: 'Block'; id: string; object: string }
	// target: the verified remote target (its alsoKnownAs was checked by the Worker), or a local actor URI.
	| { type: 'Move'; id: string; target: RemoteActorInput | { local: string } }
	| { type: 'UpdateActor'; id: string }
	| { type: 'DeleteActor'; id: string }
	| { type: 'Delete'; id: string; object: string }
	| { type: 'Create'; id: string; object: RemoteStatusInput }
	| { type: 'UpdateStatus'; id: string; object: RemoteStatusInput }
	// A Like, a Misskey reaction (Like with _misskey_reaction) or an EmojiReact: a favourite of `object`.
	| { type: 'Like'; id: string; object: string }
	// embedded: the object as the Announce carried it (used only for the actor's own status, as Mastodon does).
	| {
			type: 'Announce'
			id: string
			object: string
			embedded: RemoteStatusInput | null
			to: string[]
			cc: string[]
			published: string | null
			raw: string
	  }

// Documents the Worker fetched because the Store asked for them (ReceiveResult.need), by the uri asked for: a parsed
// status or actor, or null when it could not be fetched or used.
export type Prefetched = {
	statuses: Record<string, RemoteStatusInput | null>
	actors: Record<string, RemoteActorInput | null>
}

export type ReceiveInput = {
	now: number
	// This instance's origin: no URI of it is ever written as a remote actor (ID-3).
	origin: string
	actorUri: string
	// A fresh document of the actor to store, or null to use the stored row as it is.
	actor: RemoteActorInput | null
	activity: InboundActivity
	// The username of the personal inbox the activity was delivered to (null: the shared inbox).
	recipient?: string | null
	prefetched?: Prefetched
}

// jobsPending: a purge, Move or status deletion has batches left; the Worker asks the Queue to continue (cron
// continues regardless). delivers: the activity recorded deliveries (an Accept, Reject, Follow or Undo) or pushes (a
// notification); the Worker rings the doorbell. need: nothing was written; the Store needs this document to apply the
// activity, and the Worker asks again with it in prefetched.
export type ReceiveResult = {
	applied: boolean
	reason: string
	jobsPending: boolean
	delivers?: boolean
	need?: { kind: 'status' | 'actor'; uri: string }
	// Nothing changed, and the activity may apply later (its retraction could not be recorded): answered 503.
	retry?: boolean
}

function ignored(reason: string): ReceiveResult {
	return { applied: false, reason, jobsPending: false }
}

// A refusal that must leave no trace: thrown out of the operation, so its transaction rolls back (the actor's
// document and keys stored before the handler ran included), and turned into a retryable answer by the Store's RPC
// (store.ts), which the Worker answers 503.
export class RetryLater extends Error {
	constructor(readonly reason: string) {
		super(`retry later: ${reason}`)
	}
}

function retryLater(reason: string): never {
	throw new RetryLater(reason)
}

export function retryResult(error: RetryLater): ReceiveResult {
	return { ...ignored(error.reason), retry: true }
}

function applied(reason: string, jobsPending = false): ReceiveResult {
	return { applied: true, reason, jobsPending }
}

// Moves whenever a delivery or an outbound intent is recorded: the deliveries id sequence (AUTOINCREMENT, so a row
// deleted since still counts) and the newest intent (one recorded without its deliveries yet, which a delivery round
// expands).
function deliverySequence(db: Db): number {
	const row = db.first<{ seq: number; intent: number }>(
		`SELECT IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'deliveries'), 0) AS seq,
			IFNULL((SELECT max(id) FROM outbound_activities), 0) AS intent`
	)
	return row === undefined ? 0 : row.seq * 2 ** 26 + row.intent
}

// Whether anything for the doorbell was recorded since `before`: a delivery or intent, or a push of a new notification
// (domain/push.ts).
function outboundMark(db: Db): { deliveries: number; pushes: number } {
	return { deliveries: deliverySequence(db), pushes: pushSequence(db) }
}

function outboundSince(db: Db, before: { deliveries: number; pushes: number }): boolean {
	return deliverySequence(db) > before.deliveries || pushSequence(db) > before.pushes
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

// ---------------------------------------------------------------------------------------------------------------
// Remote actors and their keys
// ---------------------------------------------------------------------------------------------------------------

type RemoteRow = { id: string; uri: string; domain: string }

function remoteAccount(db: Db, uri: string): RemoteRow | undefined {
	return db.first<RemoteRow>('SELECT id, uri, domain FROM accounts WHERE uri = ? AND domain IS NOT NULL', uri)
}

// Whether the actor deleted itself: its purge job is its tombstone while it lasts (ID-7, independent of the
// retraction cap and TTL).
export function isDeletedActor(db: Db, uri: string, now: number): boolean {
	return (
		db.first(
			"SELECT 1 AS x FROM inbound_jobs WHERE kind = 'purge' AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
			uri,
			now
		) !== undefined
	)
}

// The domain of a remote account's address (its acct), decided here for every path that stores an actor. A domain
// other than the actor's host holds only for the (username, domain, actor id) it was confirmed for: the actor id is
// the row's own, and confirmed_username the username. So:
//   - a confirmation in hand (confirmedDomain) sets it: another domain with this username, or the host (clearing any);
//   - otherwise a stored confirmation is kept while the username is unchanged;
//   - otherwise, a changed username included, the address falls back to the actor's host until it is confirmed again.
// Inbound documents never carry a confirmation (Gap: inbound processing does not look up WebFinger), so they keep a
// confirmed address while the username is unchanged and never set one. Domain blocks also match the actor's host
// (inDomainSql in audience.ts).
export function accountDomain(
	stored: { domain: string; confirmed_username: string | null } | undefined,
	actor: RemoteActorInput
): { domain: string; confirmedUsername: string | null } {
	const host = hostDomain(actor.uri)
	if (actor.confirmedDomain !== undefined) {
		return actor.confirmedDomain === host
			? { domain: host, confirmedUsername: null }
			: { domain: actor.confirmedDomain, confirmedUsername: actor.username }
	}
	if (stored !== undefined && stored.confirmed_username !== null && stored.confirmed_username === actor.username) {
		return { domain: stored.domain, confirmedUsername: stored.confirmed_username }
	}
	return { domain: host, confirmedUsername: null }
}

// Inserts or refreshes a remote account and its keys from its document. Never touches a local row (ID-3): a URI on
// this instance's origin, or one a local account holds, is refused, and so is a deleted actor.
export function upsertRemoteActor(db: Db, actor: RemoteActorInput, origin: string, now: number): RemoteRow | undefined {
	if (
		originOf(actor.uri) === origin ||
		db.first('SELECT 1 AS x FROM accounts WHERE uri = ? AND domain IS NULL', actor.uri) !== undefined ||
		isDeletedActor(db, actor.uri, now)
	) {
		return undefined
	}
	const published = actor.published === null ? NaN : Date.parse(actor.published)
	const createdAt = new Date(Number.isNaN(published) || published > now ? now : published).toISOString()
	const stored = db.first<{ domain: string; confirmed_username: string | null }>(
		'SELECT domain, confirmed_username FROM accounts WHERE uri = ? AND domain IS NOT NULL',
		actor.uri
	)
	const { domain, confirmedUsername } = accountDomain(stored, actor)
	const values = [
		actor.uri,
		actor.username,
		domain,
		actor.actorType,
		actor.displayName,
		actor.note,
		actor.url,
		actor.avatarUrl,
		actor.headerUrl,
		actor.locked ? 1 : 0,
		actor.discoverable === null ? null : actor.discoverable ? 1 : 0,
		actor.inboxUrl,
		actor.sharedInboxUrl,
		actor.raw,
		new Date(now).toISOString(),
		accountSearchText(actor.username, domain, actor.displayName),
		createdAt,
		confirmedUsername,
	]
	insertWithFreshId(
		'accounts',
		() => remoteId(actor.published ?? '', now),
		(id) =>
			db.run(
				`INSERT INTO accounts (id, uri, username, domain, actor_type, display_name, note, url, avatar_url, header_url,
					locked, discoverable, inbox_url, shared_inbox_url, raw, fetched_at, search_text, created_at,
					confirmed_username)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (uri) DO UPDATE SET username = excluded.username, actor_type = excluded.actor_type,
					display_name = excluded.display_name, note = excluded.note, url = excluded.url,
					avatar_url = excluded.avatar_url, header_url = excluded.header_url, locked = excluded.locked,
					discoverable = excluded.discoverable, inbox_url = excluded.inbox_url,
					shared_inbox_url = excluded.shared_inbox_url, raw = excluded.raw, fetched_at = excluded.fetched_at,
					search_text = excluded.search_text, domain = excluded.domain,
					confirmed_username = excluded.confirmed_username
				WHERE accounts.domain IS NOT NULL`,
				id,
				...values
			)
	)
	const row = remoteAccount(db, actor.uri)
	if (row !== undefined) {
		// The document lists the actor's current keys; keys it no longer lists are not trusted any more.
		db.run('DELETE FROM remote_keys WHERE account_id = ?', row.id)
		for (const key of actor.keys) {
			if (originOf(key.id) !== originOf(actor.uri)) {
				continue
			}
			db.run(
				`INSERT INTO remote_keys (key_id, account_id, pem, fetched_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (key_id) DO UPDATE SET account_id = excluded.account_id, pem = excluded.pem,
					fetched_at = excluded.fetched_at`,
				key.id,
				row.id,
				key.pem,
				now
			)
		}
	}
	return row
}

export type StoredRemoteKey = { owner: string; pem: string; fresh: boolean }

// A key by its id, as a verified actor document listed it, with its owner (ID-1). fresh: listed within the last 24 hours.
export const getRemoteKey = readOperation<{ keyId: string; now: number }, StoredRemoteKey | null>(
	(db, { keyId, now }) => {
		const row = db.first<{ owner: string; pem: string; fetched_at: number }>(
			`SELECT a.uri AS owner, k.pem, k.fetched_at FROM remote_keys k JOIN accounts a ON a.id = k.account_id
			WHERE k.key_id = ? AND a.domain IS NOT NULL`,
			keyId
		)
		return row === undefined ? null : { owner: row.owner, pem: row.pem, fresh: now - row.fetched_at < KEY_REFRESH_MS }
	}
)

// ---------------------------------------------------------------------------------------------------------------
// Retractions (ID-7)
// ---------------------------------------------------------------------------------------------------------------

export function isRetracted(db: Db, actorUri: string, targetUri: string, now: number): boolean {
	return (
		db.first(
			'SELECT 1 AS x FROM inbound_retractions WHERE actor_uri = ? AND target_uri = ? AND expires_at > ?',
			actorUri,
			targetUri,
			now
		) !== undefined
	)
}

// The actor_uri of a deletion that holds for every actor: a status or boost that was stored and deleted by its author
// is not created again under that uri by anyone, its author or another actor of the same origin (ID-6, ID-7). A Delete
// of an unknown object stays the actor's own (it cannot suppress another actor's objects never seen here).
export const ANY_ACTOR = '*'

// Records that the stored object `uri` was deleted. Bounded by the authors' caps: it is written only together with
// the author's own retraction of the same uri, which counts against MAX_RETRACTIONS_PER_ACTOR, and expires and is
// swept with it.
function recordDeletedObject(db: Db, uri: string, now: number): void {
	db.run(
		`INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) VALUES (?, ?, ?)
		ON CONFLICT DO UPDATE SET expires_at = excluded.expires_at`,
		ANY_ACTOR,
		uri,
		now + RETRACTION_TTL_MS
	)
}

// Whether `uri` may not be created by `actorUri`: the actor retracted it, or it was stored and deleted.
export function isDeleted(db: Db, actorUri: string, uri: string, now: number): boolean {
	return isRetracted(db, actorUri, uri, now) || isRetracted(db, ANY_ACTOR, uri, now)
}

function recordable(actorUri: string, targetUri: string): boolean {
	return originOf(targetUri) !== null && originOf(targetUri) === originOf(actorUri)
}

// Whether every one of targetUris can be recorded as retracted by actorUri now: those not recorded yet fit under the
// cap. A change whose generation could not be recorded is not made (ID-7: it could come back).
export function canRetract(db: Db, actorUri: string, targetUris: readonly string[], now: number): boolean {
	const missing = new Set(targetUris.filter((uri) => recordable(actorUri, uri) && !isRetracted(db, actorUri, uri, now)))
		.size
	if (missing === 0) {
		return true
	}
	const live =
		db.first<{ n: number }>(
			'SELECT count(*) AS n FROM inbound_retractions WHERE actor_uri = ? AND expires_at > ?',
			actorUri,
			now
		)?.n ?? 0
	return live + missing <= MAX_RETRACTIONS_PER_ACTOR
}

// Records that actorUri retracted targetUri, and reports whether it is recorded. Only an id of the actor's own origin
// is recorded (another origin's activity could never be the actor's to retract), and at most
// MAX_RETRACTIONS_PER_ACTOR live ones per actor.
export function retract(db: Db, actorUri: string, targetUri: string, now: number): boolean {
	if (!recordable(actorUri, targetUri) || !canRetract(db, actorUri, [targetUri], now)) {
		return false
	}
	db.run(
		`INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) VALUES (?, ?, ?)
		ON CONFLICT DO UPDATE SET expires_at = excluded.expires_at`,
		actorUri,
		targetUri,
		now + RETRACTION_TTL_MS
	)
	return true
}

// Records a Follow id as retracted: the one way every path (Undo, Block, a refused or superseded Follow, a local
// reject) records a Follow generation. A Misskey pair id (`/follows/<follower>/<followee>`) names every generation of a
// follow, so it is never recorded: true without writing anything. Its limit, on every path: a pair activity delivered
// again after a new Follow cannot be told from a new one.
export function retractFollow(db: Db, actorUri: string, followUri: string, now: number): boolean {
	return isMisskeyPairId(followUri) || retract(db, actorUri, followUri, now)
}

function sweep(db: Db, now: number): void {
	db.run(
		`DELETE FROM inbound_retractions WHERE (actor_uri, target_uri) IN
			(SELECT actor_uri, target_uri FROM inbound_retractions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
		now,
		SWEEP_BATCH
	)
	db.run(
		`DELETE FROM inbound_jobs WHERE (kind, key) IN
			(SELECT kind, key FROM inbound_jobs WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
		now,
		SWEEP_BATCH
	)
	// Expired mutes no longer apply (activeMuteSql); their rows go here, through the partial index on expires_at.
	db.run(
		`DELETE FROM mutes WHERE id IN
			(SELECT id FROM mutes WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
		new Date(now).toISOString(),
		SWEEP_BATCH
	)
}

// ---------------------------------------------------------------------------------------------------------------
// Local accounts and counters
// ---------------------------------------------------------------------------------------------------------------

type LocalRow = { id: string; uri: string; locked: number; suspended: number }

// A local account by its exact actor URI (ID-5: another spelling is not this actor).
function localAccount(db: Db, uri: string | null): LocalRow | undefined {
	if (uri === null) {
		return undefined
	}
	return db.first<LocalRow>(
		`SELECT a.id, a.uri, a.locked, NOT ${availableLocalSql('l')} AS suspended
		FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.domain IS NULL AND a.uri = ?`,
		uri
	)
}

function recountLocal(db: Db, ids: Iterable<string>): void {
	for (const id of new Set(ids)) {
		db.run(
			`UPDATE accounts SET
				followers_count = (SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted'),
				following_count = (SELECT COUNT(*) FROM follows WHERE account_id = ?1 AND state = 'accepted')
			WHERE id = ?1 AND domain IS NULL`,
			id
		)
	}
}

// Removes a follow edge and the follow notifications it caused, as Mastodon destroys them with the follow.
function removeFollow(db: Db, followerId: string, targetId: string): boolean {
	const removed = db.run('DELETE FROM follows WHERE account_id = ? AND target_account_id = ?', followerId, targetId)
	db.run(
		"DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type IN ('follow', 'follow_request')",
		targetId,
		followerId
	)
	return removed > 0
}

// Ends a local account's follow of a remote account and records its Undo (Mastodon's UnfollowService), as the
// unfollow API does. A migrated edge without a uri is named as this instance would have named it.
function unfollowRemote(
	db: Db,
	local: { id: string; uri: string },
	remote: { id: string; uri: string },
	now: number
): void {
	const removed = db.first<{ id: string; uri: string | null }>(
		'SELECT CAST(id AS TEXT) AS id, uri FROM follows WHERE account_id = ? AND target_account_id = ?',
		local.id,
		remote.id
	)
	if (removed === undefined) {
		return
	}
	removeFollow(db, local.id, remote.id)
	recordOutbound(
		db,
		local.id,
		undoFollowActivity({
			followUri: removed.uri ?? followUri(local.uri, removed.id),
			actorUri: local.uri,
			targetUri: remote.uri,
			targetId: remote.id,
		}),
		now
	)
}

// Accept or Reject of a remote Follow, as an outbound intent delivered to the follower's shared inbox, or its personal
// inbox without one (B2). Its id derives from the Follow it answers (followAnswerActivity).
function recordFollowAnswer(
	db: Db,
	kind: 'Accept' | 'Reject',
	local: LocalRow,
	follower: RemoteRow,
	followUri: string,
	now: number
): void {
	recordOutbound(
		db,
		local.id,
		followAnswerActivity(kind, {
			localActorUri: local.uri,
			followerUri: follower.uri,
			followerId: follower.id,
			followUri,
			edgeId: '',
		}),
		now
	)
}

// ---------------------------------------------------------------------------------------------------------------
// The activities
// ---------------------------------------------------------------------------------------------------------------

type Handler<T extends InboundActivity['type']> = (
	db: Db,
	actor: RemoteRow,
	activity: Extract<InboundActivity, { type: T }>,
	input: ReceiveInput
) => ReceiveResult

// Mastodon's ActivityPub::Activity::Follow, for a local target.
const follow: Handler<'Follow'> = (db, actor, activity, { now }) => {
	const target = localAccount(db, activity.object)
	if (target === undefined || target.suspended === 1) {
		return ignored('unknown-target')
	}
	if (isRetracted(db, actor.uri, activity.id, now)) {
		return ignored('retracted')
	}
	// The follower blocks the target: Mastodon would not have sent this; nothing is recorded.
	if (db.first(`SELECT 1 AS x WHERE ${blocksSql('?1', '?2')}`, actor.id, target.id)) {
		return ignored('blocked')
	}
	const existing = db.first<{ id: string; state: string; uri: string | null }>(
		'SELECT CAST(id AS TEXT) AS id, state, uri FROM follows WHERE account_id = ? AND target_account_id = ?',
		actor.id,
		target.id
	)
	const blocked = db.first(`SELECT 1 AS x WHERE ${blockedSql('?1', '?2')}`, target.id, actor.id)
	if (blocked !== undefined) {
		// Refused with a Reject. The id is recorded as dead, so a replay sends no second Reject (ID-7); if it cannot be
		// recorded, no Reject is recorded either.
		if (!retractFollow(db, actor.uri, activity.id, now)) {
			return ignored('retraction-cap')
		}
		recordFollowAnswer(db, 'Reject', target, actor, activity.id, now)
		return applied('follow-rejected')
	}
	if (existing !== undefined && existing.uri === activity.id) {
		return ignored('duplicate')
	}
	if (existing !== undefined) {
		// A newer generation: the edge takes the new id, and the superseded one is recorded as dead, so a late Undo,
		// or a replay, of it changes nothing (ID-7). A pending request keeps waiting; an accepted follow is accepted
		// again under the new id (Mastodon's fast-forward: the follower lost track of our Accept).
		if (existing.uri !== null && !retractFollow(db, actor.uri, existing.uri, now)) {
			return ignored('retraction-cap')
		}
		db.run('UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.id, existing.id)
		if (existing.state === 'pending') {
			return applied('follow-request-updated')
		}
		recordFollowAnswer(db, 'Accept', target, actor, activity.id, now)
		return applied('follow-reaccepted')
	}
	const state = target.locked === 1 ? 'pending' : 'accepted'
	db.run(
		'INSERT INTO follows (account_id, target_account_id, state, uri, created_at) VALUES (?, ?, ?, ?, ?)',
		actor.id,
		target.id,
		state,
		activity.id,
		new Date(now).toISOString()
	)
	if (state === 'accepted') {
		recordFollowAnswer(db, 'Accept', target, actor, activity.id, now)
	}
	notify(db, {
		recipientId: target.id,
		type: state === 'accepted' ? 'follow' : 'follow_request',
		fromId: actor.id,
		statusId: null,
		now,
	})
	recountLocal(db, [target.id])
	return applied(state === 'accepted' ? 'followed' : 'follow-requested')
}

// Our follow of `actor` that an Accept or Reject answers (ID-6: only the followed side answers):
//   - the Follow's id equals the edge's uri, with the actor as its target; or
//   - the edge has no uri (it never named an id: local follows do not federate before B2, and migrated rows), and the
//     embedded Follow names its follower and the actor as its pair.
// An id that names another generation of the edge (the edge has a different uri) answers nothing. The one exception is
// a Reject with Misskey's pair-shaped id (`/follows/<follower>/<followee>`): Misskey rejects a follower it removes with
// the pair, not with our Follow's id, so for a Reject (pairReject) the pair matches our follow whatever its uri. As
// with the pair Undo, a redelivered pair Reject cannot be told from a new one, and ends a later generation too.
function ourFollow(
	db: Db,
	actor: RemoteRow,
	ref: ActivityRef,
	pairReject = false
): { id: string; follower: string } | 'not-target' | null {
	if (ref.object !== null && ref.object !== actor.uri) {
		return 'not-target'
	}
	if (ref.type !== null && ref.type !== 'Follow') {
		return null
	}
	if (ref.id !== null) {
		const byUri = db.first<{ id: string; follower: string }>(
			`SELECT CAST(f.id AS TEXT) AS id, f.account_id AS follower FROM follows f JOIN local_accounts l ON l.account_id = f.account_id
			WHERE f.uri = ? AND f.target_account_id = ?`,
			ref.id,
			actor.id
		)
		if (byUri !== undefined) {
			return byUri
		}
	}
	if (ref.object === null) {
		return null
	}
	const follower = localAccount(db, ref.actor)
	if (follower === undefined) {
		return null
	}
	const anyGeneration = pairReject && ref.id !== null && isMisskeyPairId(ref.id)
	const edge = db.first<{ id: string }>(
		`SELECT CAST(id AS TEXT) AS id FROM follows WHERE account_id = ? AND target_account_id = ?
			AND (uri IS NULL OR ?)`,
		follower.id,
		actor.id,
		anyGeneration ? 1 : 0
	)
	return edge === undefined ? null : { id: edge.id, follower: follower.id }
}

const accept: Handler<'Accept'> = (db, actor, activity) => {
	const edge = ourFollow(db, actor, activity.object)
	if (edge === null || edge === 'not-target') {
		return ignored(edge ?? 'unknown-follow')
	}
	const changed = db.run(
		"UPDATE follows SET state = 'accepted' WHERE id = CAST(? AS INTEGER) AND state = 'pending'",
		edge.id
	)
	recountLocal(db, [edge.follower])
	return changed > 0 ? applied('follow-accepted') : ignored('duplicate')
}

// Mastodon's Reject removes our request, or our follow if it was already accepted.
const reject: Handler<'Reject'> = (db, actor, activity) => {
	const edge = ourFollow(db, actor, activity.object, true)
	if (edge === null || edge === 'not-target') {
		return ignored(edge ?? 'unknown-follow')
	}
	db.run('DELETE FROM follows WHERE id = CAST(? AS INTEGER)', edge.id)
	recountLocal(db, [edge.follower])
	return applied('follow-rejected')
}

// Misskey's Undo of a Follow names the follow by its pair (ApRendererService#renderFollow without a request id:
// <origin>/follows/<follower id>/<followee id>), not by the id of the Follow it sent.
export function isMisskeyPairId(id: string): boolean {
	try {
		return /^\/follows\/[^/]+\/[^/]+$/.test(new URL(id).pathname)
	} catch {
		return false
	}
}

// Undo of a Follow or a Block. The undone activity is found by its id among the actor's own edges. Without a match,
// only Misskey's pair-shaped Follow id falls back to the actor's current follow of the embedded local target.
//
// A pair id names every generation of a follow, so it is never recorded as retracted itself: the generation it undid
// is (that Follow's own id), and a later Follow and its Undo by the same pair id work again. The limit: a pair Undo
// delivered again after a new Follow cannot be told from a new Undo, and undoes the new follow.
const undo: Handler<'Undo'> = (db, actor, activity, { now }) => {
	const ref = activity.object
	// ID-6: only the actor of the undone activity may undo it.
	if (ref.actor !== null && ref.actor !== actor.uri) {
		return ignored('not-own')
	}
	if (ref.id === null) {
		return ignored('unknown-object')
	}
	if (originOf(ref.id) !== originOf(actor.uri)) {
		return ignored('foreign-object')
	}
	if (isRetracted(db, actor.uri, ref.id, now)) {
		return ignored('retracted')
	}
	if (
		ref.type === 'Like' ||
		ref.type === 'EmojiReact' ||
		ref.type === 'Announce' ||
		(ref.type === null && interactionOf(db, actor, ref.id))
	) {
		return undoInteraction(db, actor, { ...ref, id: ref.id }, now)
	}
	const pair = ref.type === 'Follow' && isMisskeyPairId(ref.id)
	type Edge = { target: string; uri: string | null }
	let edge: Edge | undefined
	if (ref.type === null || ref.type === 'Follow') {
		edge = db.first<Edge>(
			'SELECT target_account_id AS target, uri FROM follows WHERE account_id = ? AND uri = ?',
			actor.id,
			ref.id
		)
		const target = localAccount(db, ref.object)
		if (edge === undefined && pair && target !== undefined) {
			edge = db.first<Edge>(
				'SELECT target_account_id AS target, uri FROM follows WHERE account_id = ? AND target_account_id = ?',
				actor.id,
				target.id
			)
		}
	}
	// Everything this Undo records as retracted must fit, or nothing changes (ID-7). The undone activity's type is
	// decided first: a Block (typed, or untyped and matching a stored block) is always recorded, whatever its id's
	// shape. Only a Follow's pair id names every generation, so it is never recorded, whichever side carries it.
	const undoesBlock =
		ref.type === 'Block' ||
		(ref.type === null &&
			edge === undefined &&
			db.first('SELECT 1 AS x FROM blocks WHERE account_id = ? AND uri = ?', actor.id, ref.id) !== undefined)
	const undoesFollow = !undoesBlock && (ref.type === null || ref.type === 'Follow')
	const retracted = [
		...(undoesFollow && isMisskeyPairId(ref.id) ? [] : [ref.id]),
		...(edge?.uri == null || isMisskeyPairId(edge.uri) ? [] : [edge.uri]),
	]
	if (!canRetract(db, actor.uri, retracted, now)) {
		return ignored('retraction-cap')
	}
	let undone = false
	if (edge !== undefined) {
		undone = removeFollow(db, actor.id, edge.target)
		recountLocal(db, [edge.target])
	}
	if (!undone && (ref.type === null || ref.type === 'Block')) {
		undone =
			db.run('DELETE FROM blocks WHERE account_id = ? AND uri = ?', actor.id, ref.id) > 0 ||
			(ref.type === 'Block' &&
				db.run(
					`DELETE FROM blocks WHERE account_id = ? AND uri IS NULL
						AND target_account_id = (SELECT a.id FROM accounts a WHERE a.uri = ? AND a.domain IS NULL)`,
					actor.id,
					ref.object
				) > 0)
	}
	// Recorded whether or not the target was found: an Undo that overtook its activity keeps it from applying later,
	// and a replay of an undone activity does not restore it (ID-7). Likes and Announces check it too.
	for (const uri of retracted) {
		retract(db, actor.uri, uri, now)
	}
	return undone ? applied('undone') : applied('retraction-recorded')
}

// Mastodon's ActivityPub::Activity::Block: both follows between the two end, then the block is recorded. The ids of
// the removed follows are recorded as retracted, so a replayed Follow does not restore them (ID-7).
const block: Handler<'Block'> = (db, actor, activity, { now }) => {
	const target = localAccount(db, activity.object)
	if (target === undefined) {
		return ignored('unknown-target')
	}
	if (isRetracted(db, actor.uri, activity.id, now)) {
		return ignored('retracted')
	}
	const existing = db.first<{ id: string; uri: string | null }>(
		'SELECT CAST(id AS TEXT) AS id, uri FROM blocks WHERE account_id = ? AND target_account_id = ?',
		actor.id,
		target.id
	)
	if (existing !== undefined) {
		if (existing.uri === activity.id) {
			return ignored('duplicate')
		}
		// A new id for the same block: the old one is recorded as retracted first, so a redelivery of it after an Undo
		// of the new one does not bring the block back (ID-7). If it cannot be recorded, nothing changes.
		if (existing.uri !== null && !retract(db, actor.uri, existing.uri, now)) {
			return ignored('retraction-cap')
		}
		db.run('UPDATE blocks SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.id, existing.id)
		return applied('block-updated')
	}
	const followUri = db.first<{ uri: string | null }>(
		'SELECT uri FROM follows WHERE account_id = ? AND target_account_id = ?',
		actor.id,
		target.id
	)?.uri
	// The removed follow's generation must be recorded, or the Block changes nothing (ID-7).
	if (followUri != null && !retractFollow(db, actor.uri, followUri, now)) {
		return ignored('retraction-cap')
	}
	removeFollow(db, actor.id, target.id)
	// Mastodon's UnfollowService: the local account's follow of the blocker ends, and is undone there too.
	unfollowRemote(db, target, actor, now)
	db.run(
		'INSERT INTO blocks (account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, ?)',
		actor.id,
		target.id,
		activity.id,
		new Date(now).toISOString()
	)
	recountLocal(db, [target.id])
	return applied('blocked')
}

// Mastodon's ActivityPub::Activity::Move and MoveWorker. The Move is a job keyed by its id: the first delivery fixes
// the target and the newest follow it covers (bound), carries local blocks and mutes over, and moves the first batch;
// later batches come from the Queue or cron. A replay continues the job and never moves a follow made after it.
const move: Handler<'Move'> = (db, actor, activity, input) => {
	const { now, origin } = input
	const job = db.first<{ done_at: number | null }>(
		"SELECT done_at FROM inbound_jobs WHERE kind = 'move' AND key = ?",
		activity.id
	)
	if (job !== undefined) {
		if (job.done_at !== null) {
			return ignored('duplicate')
		}
		return applied('moved', moveBatch(db, activity.id, now))
	}
	let targetId: string
	if ('local' in activity.target) {
		const local = localAccount(db, activity.target.local)
		const aliases = db.first<{ also_known_as: string }>(
			'SELECT also_known_as FROM local_accounts WHERE account_id = ?',
			local?.id ?? ''
		)
		// ID-4: a local target must list the actor among its aliases.
		if (local === undefined || local.suspended === 1 || aliases === undefined) {
			return ignored('unknown-target')
		}
		if (!(JSON.parse(aliases.also_known_as) as unknown[]).includes(actor.uri)) {
			return ignored('not-alias')
		}
		targetId = local.id
	} else {
		const remote = upsertRemoteActor(db, activity.target, origin, now)
		if (remote === undefined) {
			return ignored('unknown-target')
		}
		targetId = remote.id
	}
	if (targetId === actor.id) {
		return ignored('self-move')
	}
	const bound =
		db.first<{ bound: string | null }>(
			"SELECT CAST(max(id) AS TEXT) AS bound FROM follows WHERE target_account_id = ? AND state = 'accepted'",
			actor.id
		)?.bound ?? '0'
	db.run(
		`INSERT INTO inbound_jobs (kind, key, actor_uri, target_account_id, bound, cursor, created_at)
		VALUES ('move', ?, ?, ?, ?, '0', ?)`,
		activity.id,
		actor.uri,
		targetId,
		bound,
		now
	)
	const carried = [new Date(now).toISOString(), MOVE_MAX_CARRIED] as const
	db.run(
		`INSERT INTO blocks (account_id, target_account_id, created_at)
		SELECT b.account_id, ?2, ?3 FROM blocks b JOIN local_accounts l ON l.account_id = b.account_id
		WHERE b.target_account_id = ?1 AND b.account_id <> ?2 ORDER BY b.id LIMIT ?4
		ON CONFLICT DO NOTHING`,
		actor.id,
		targetId,
		...carried
	)
	db.run(
		`INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at, created_at)
		SELECT m.account_id, ?2, m.hide_notifications, m.expires_at, ?3 FROM mutes m
		WHERE m.target_account_id = ?1 AND m.account_id <> ?2 AND ${activeMuteSql('m', '?3')} ORDER BY m.id LIMIT ?4
		ON CONFLICT (account_id, target_account_id) DO UPDATE SET hide_notifications = excluded.hide_notifications,
			expires_at = excluded.expires_at, created_at = excluded.created_at
		WHERE NOT ${activeMuteSql('mutes', '?3')}`,
		actor.id,
		targetId,
		...carried
	)
	return applied('moved', moveBatch(db, activity.id, now))
}

// Moves the next MOVE_BATCH local followers covered by the Move. Returns whether any remain.
function moveBatch(db: Db, key: string, now: number): boolean {
	const job = db.first<{ actor_uri: string; target_account_id: string; bound: string; cursor: string }>(
		"SELECT actor_uri, target_account_id, bound, cursor FROM inbound_jobs WHERE kind = 'move' AND key = ? AND done_at IS NULL",
		key
	)
	const source = job === undefined ? undefined : remoteAccount(db, job.actor_uri)
	const target =
		job === undefined
			? undefined
			: db.first<{ id: string; uri: string; local: number; locked: number }>(
					'SELECT id, uri, domain IS NULL AS local, locked FROM accounts WHERE id = ?',
					job.target_account_id
				)
	// Checked before every batch: a Move whose source or target has since deleted itself ends here, before it changes
	// anything (ID-7: a purged actor gets no new follows).
	if (
		job === undefined ||
		source === undefined ||
		target === undefined ||
		isDeletedActor(db, source.uri, now) ||
		(target.local === 0 && isDeletedActor(db, target.uri, now))
	) {
		finishJob(db, 'move', key, now)
		return false
	}
	const followers = db.all<{
		edge: string
		id: string
		show_reblogs: number
		notify: number
		languages: string | null
	}>(
		`SELECT CAST(f.id AS TEXT) AS edge, f.account_id AS id, f.show_reblogs, f.notify, f.languages FROM follows f
		JOIN local_accounts l ON l.account_id = f.account_id
		WHERE f.target_account_id = ? AND f.state = 'accepted'
			AND f.id > CAST(? AS INTEGER) AND f.id <= CAST(? AS INTEGER)
		ORDER BY f.id LIMIT ?`,
		source.id,
		job.cursor,
		job.bound,
		MOVE_BATCH
	)
	const changed: string[] = [target.id]
	for (const follower of followers) {
		changed.push(follower.id)
		// FollowService: a follow the follower could not make itself is not made for it, and then nothing changes for
		// this follower: Mastodon's FollowMigrationService raises before its UnfollowService runs (UnfollowFollowWorker
		// rescues it), so the follow of the source and its list memberships stay.
		if (db.first(`SELECT 1 AS x WHERE ${followableBySql('?2', '?1')}`, follower.id, target.id) === undefined) {
			continue
		}
		// The follower's lists that hold the source, read before the unfollow takes it out of them (migration
		// 0007_list_members): FollowMigrationService#migrate_list_accounts! puts the target in them.
		const lists = listsHolding(db, follower.id, source.id)
		// Mastodon's MoveWorker: UnfollowService for the source (undone there), FollowService for the target.
		const local = db.first<LocalRow>(
			'SELECT a.id, a.uri, a.locked, 0 AS suspended FROM accounts a WHERE a.id = ?',
			follower.id
		)
		if (local !== undefined) {
			unfollowRemote(db, local, source, now)
		}
		const state = target.local === 1 && target.locked === 0 ? 'accepted' : 'pending'
		const edge = db.first<{ id: string }>(
			`INSERT INTO follows (account_id, target_account_id, state, show_reblogs, notify, languages, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING CAST(id AS TEXT) AS id`,
			follower.id,
			target.id,
			state,
			follower.show_reblogs,
			follower.notify,
			follower.languages,
			new Date(now).toISOString()
		)
		// The target is followed now, or was already (followed or asked), so it may be a member of those lists.
		db.run(
			'INSERT OR IGNORE INTO list_accounts (list_id, account_id) SELECT value, ? FROM json_each(?)',
			target.id,
			JSON.stringify(lists)
		)
		if (edge === undefined) {
			continue
		}
		if (target.local === 1) {
			const type = state === 'accepted' ? 'follow' : 'follow_request'
			notify(db, { recipientId: target.id, type, fromId: follower.id, statusId: null, now })
		} else if (local !== undefined) {
			// A Follow of the remote target, pending until its Accept (as the follow API records it).
			const uri = followUri(local.uri, edge.id)
			db.run('UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)', uri, edge.id)
			recordOutbound(
				db,
				local.id,
				followActivity({ followUri: uri, actorUri: local.uri, targetUri: target.uri, targetId: target.id }),
				now
			)
		}
	}
	recountLocal(db, changed)
	const last = followers.at(-1)?.edge ?? job.bound
	const more = db.first(
		`SELECT 1 AS x FROM follows f JOIN local_accounts l ON l.account_id = f.account_id
		WHERE f.target_account_id = ? AND f.state = 'accepted' AND f.id > CAST(? AS INTEGER) AND f.id <= CAST(? AS INTEGER)`,
		source.id,
		last,
		job.bound
	)
	if (more === undefined) {
		finishJob(db, 'move', key, now)
		return false
	}
	db.run("UPDATE inbound_jobs SET cursor = ? WHERE kind = 'move' AND key = ?", last, key)
	return true
}

function finishJob(db: Db, kind: JobKind, key: string, now: number): void {
	db.run(
		'UPDATE inbound_jobs SET done_at = ?, expires_at = ? WHERE kind = ? AND key = ? AND done_at IS NULL',
		now,
		now + JOB_RETENTION_MS,
		kind,
		key
	)
}

// The actor document itself was stored before the handler ran (input.actor).
const updateActor: Handler<'UpdateActor'> = (_db, _actor, _activity, input) =>
	input.actor === null ? ignored('no-document') : applied('actor-updated')

// Mastodon's DeleteAccountService for a remote account, as a durable job: the purge job (the actor's tombstone) is
// written with the first batch, and each batch removes a bounded part of what the account has (purgeBatch); the
// account row goes with the last one. The account is unavailable from this transaction on (accounts.deleted_at,
// availableSql), so nothing of it is shown while the batches remove it, whatever order they remove it in.
const deleteActor: Handler<'DeleteActor'> = (db, actor, _activity, { now }) => {
	// A finished purge whose tombstone expired before the sweep removed it (the actor was stored again since) starts
	// over, so this purge runs to its end and renews the tombstone.
	db.run(
		`INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, ?2)
		ON CONFLICT (kind, key) DO UPDATE SET cursor = NULL, done_at = NULL, expires_at = NULL, created_at = excluded.created_at
		WHERE done_at IS NOT NULL`,
		actor.uri,
		now
	)
	db.run(
		'UPDATE accounts SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND domain IS NOT NULL',
		new Date(now).toISOString(),
		actor.id
	)
	return applied('actor-deleted', purgeBatch(db, actor.uri, now))
}

// One batch of a deleted actor's purge (RES-6). Every row the batch writes counts against PURGE_BATCH, measured with
// SQLite's total_changes() so that nothing escapes the count: deletions, counter recounts, and the Undo intent of a
// local boost and its target chunks. Each step is limited beforehand to what is left, so a batch never writes more
// than PURGE_BATCH rows:
//   1. the account's list memberships, the endorsements of it and the notes on it, its follows, notifications,
//      mentions, favourites and keys, with the counters they counted;
//   2. local boosts of its statuses: each boost's Undo is recorded once (withdrawLocalBoost; the job's cursor keeps
//      the boost being withdrawn), its targets are written a chunk per row over as many batches as they need
//      (stageRetraction), and B2's delivery rounds expand them in their own bounded steps; then the boost is deleted
//      like any status, its receipts included, and its booster's count recounted;
//   3. remote boosts of its statuses, then its own statuses;
//   4. once nothing else of it is left, the blocks and mutes of it, which filter what remains until then.
// A status is deleted only once its children (edits, media, mentions, tags, favourites, bookmarks, notifications,
// receipts, boosts and the reply links to it) are gone, so deleting it cascades nothing. Local media is detached for
// the media sweep (its R2 objects go only through B4b's path), never deleted here. Returns whether anything remains;
// when nothing does, the account row goes and the job is done.
export function purgeBatch(db: Db, uri: string, now: number): boolean {
	const account = remoteAccount(db, uri)
	if (account === undefined) {
		finishJob(db, 'purge', uri, now)
		return false
	}
	const id = account.id
	const budget = new Budget(db, PURGE_BATCH)
	purgeRelationships(db, id, budget)
	withdrawLocalBoosts(db, { kind: 'purge', key: uri }, 'o.account_id', id, budget, now)
	while (budget.left() > 0) {
		const status = db.first<{ id: string }>(
			`SELECT r.id FROM statuses r JOIN statuses o ON o.id = r.reblog_of_id
				LEFT JOIN local_accounts l ON l.account_id = r.account_id
			WHERE o.account_id = ?1 AND l.account_id IS NULL
			UNION ALL SELECT * FROM (SELECT id FROM statuses WHERE account_id = ?1 ORDER BY id)
			LIMIT 1`,
			id
		)
		if (status === undefined || !deleteStatusWithin(db, status.id, budget)) {
			break
		}
	}
	// Blocks and mutes of the account go last, once nothing they filter is left: no status, mention, reply link or
	// notification of it.
	const others = accountHasRows(db, id, false)
	if (!others) {
		spend(
			db,
			budget,
			'DELETE FROM blocks WHERE id IN (SELECT id FROM blocks WHERE account_id = ?1 OR target_account_id = ?1 LIMIT ?2)',
			id
		)
		spend(db, budget, 'DELETE FROM mutes WHERE id IN (SELECT id FROM mutes WHERE target_account_id = ? LIMIT ?)', id)
	}
	// The final account delete and the job's completion are two more rows.
	if (others || budget.left() < 2 || accountHasRows(db, id)) {
		return true
	}
	db.run('DELETE FROM accounts WHERE id = ? AND domain IS NOT NULL', id)
	finishJob(db, 'purge', uri, now)
	return false
}

// The rows a purge batch may still write: PURGE_BATCH less every row changed since the batch began.
class Budget {
	readonly #start: number

	constructor(
		private readonly db: Db,
		private readonly limit: number
	) {
		this.#start = changes(db)
	}

	left(): number {
		return Math.max(this.limit - (changes(this.db) - this.#start), 0)
	}
}

function changes(db: Db): number {
	return db.first<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0
}

// Runs a write limited to the rows left: `sql` takes the row limit as its last parameter.
function spend(db: Db, budget: Budget, sql: string, ...params: SqlStorageValue[]): number {
	const left = budget.left()
	return left === 0 ? 0 : db.run(sql, ...params, left)
}

function purgeRelationships(db: Db, id: string, budget: Budget): void {
	// The account's list memberships and endorsements go before its follows: a follow's delete also deletes the followed
	// account's rows in the follower's lists and its endorsement (migrations 0007_list_members and
	// 0014_account_notes_and_pins), and with them gone it deletes none, so a follow stays two rows. Until they are all
	// gone, the budget is spent and no follow is read.
	spend(
		db,
		budget,
		`DELETE FROM list_accounts WHERE account_id = ?1
			AND list_id IN (SELECT list_id FROM list_accounts WHERE account_id = ?1 LIMIT ?2)`,
		id
	)
	spend(
		db,
		budget,
		`DELETE FROM account_pins WHERE target_account_id = ?1
			AND account_id IN (SELECT account_id FROM account_pins WHERE target_account_id = ?1 LIMIT ?2)`,
		id
	)
	// Local users' private notes on the account.
	spend(
		db,
		budget,
		`DELETE FROM account_notes WHERE target_account_id = ?1
			AND account_id IN (SELECT account_id FROM account_notes WHERE target_account_id = ?1 LIMIT ?2)`,
		id
	)
	// A follow's delete and its local side's recount: two rows each at most.
	const follows = db.all<{ id: string; other: string }>(
		`SELECT CAST(id AS TEXT) AS id, CASE WHEN account_id = ?1 THEN target_account_id ELSE account_id END AS other
		FROM follows WHERE account_id = ?1 OR target_account_id = ?1 ORDER BY id LIMIT ?2`,
		id,
		Math.floor(budget.left() / 2)
	)
	db.run(
		'DELETE FROM follows WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))',
		JSON.stringify(follows.map((f) => f.id))
	)
	recountLocal(
		db,
		follows.map((f) => f.other)
	)
	// A favourite's delete and its status's recount.
	const favourites = db.all<{ id: string; status: string }>(
		'SELECT CAST(id AS TEXT) AS id, status_id AS status FROM favourites WHERE account_id = ? ORDER BY id LIMIT ?',
		id,
		Math.floor(budget.left() / 2)
	)
	db.run(
		'DELETE FROM favourites WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))',
		JSON.stringify(favourites.map((f) => f.id))
	)
	for (const status of new Set(favourites.map((f) => f.status))) {
		recountStatus(db, status)
	}
	spend(
		db,
		budget,
		'DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE from_account_id = ? LIMIT ?)',
		id
	)
	// The local users' notification permissions for the account, its requests to them and the jobs of those answered
	// (migration 0020_notification_policies), any number of each.
	spend(
		db,
		budget,
		`DELETE FROM notification_permissions WHERE from_account_id = ?1
			AND account_id IN (SELECT account_id FROM notification_permissions WHERE from_account_id = ?1 LIMIT ?2)`,
		id
	)
	spend(
		db,
		budget,
		'DELETE FROM notification_requests WHERE id IN (SELECT id FROM notification_requests WHERE from_account_id = ? LIMIT ?)',
		id
	)
	spend(
		db,
		budget,
		`DELETE FROM notification_request_jobs
			WHERE id IN (SELECT id FROM notification_request_jobs WHERE from_account_id = ? LIMIT ?)`,
		id
	)
	// The local users' reports of the account (migration 0022_reports), as Mastodon's DeleteAccountService destroys an
	// account's targeted_reports.
	spend(db, budget, 'DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE target_account_id = ? LIMIT ?)', id)
	// Its votes (the polls keep their counts).
	deleteAccountVotes(db, id, budget.left())
	spend(
		db,
		budget,
		`DELETE FROM status_mentions WHERE account_id = ?1
			AND status_id IN (SELECT status_id FROM status_mentions WHERE account_id = ?1 LIMIT ?2)`,
		id
	)
	spend(
		db,
		budget,
		`UPDATE statuses SET in_reply_to_account_id = NULL
		WHERE id IN (SELECT id FROM statuses WHERE in_reply_to_account_id = ?1 AND account_id <> ?1 LIMIT ?2)`,
		id
	)
	spend(
		db,
		budget,
		'DELETE FROM media_attachments WHERE id IN (SELECT id FROM media_attachments WHERE account_id = ? AND status_id IS NULL AND file_token IS NULL LIMIT ?)',
		id
	)
	spend(
		db,
		budget,
		'DELETE FROM remote_keys WHERE key_id IN (SELECT key_id FROM remote_keys WHERE account_id = ? LIMIT ?)',
		id
	)
	spend(
		db,
		budget,
		`DELETE FROM inbound_jobs WHERE kind = 'move' AND key IN
			(SELECT key FROM inbound_jobs WHERE kind = 'move' AND target_account_id = ? LIMIT ?)`,
		id
	)
}

type JobKind = 'purge' | 'move' | 'delete'

// Local boosts of the originals `column` = `id` selects (an account's statuses, or one status), each withdrawn once
// (the job's cursor holds the boost whose Undo is recorded), then deleted like any status (its receipts a batch at a
// time), and its booster's statuses_count recounted.
function withdrawLocalBoosts(
	db: Db,
	job: { kind: JobKind; key: string },
	column: 'o.account_id' | 'o.id',
	id: string,
	budget: Budget,
	now: number
): void {
	while (budget.left() > 0) {
		const cursor = db.first<{ cursor: string | null }>(
			'SELECT cursor FROM inbound_jobs WHERE kind = ? AND key = ?',
			job.kind,
			job.key
		)?.cursor
		const boost = db.first<{ id: string; uri: string; booster: string; withdrawn: number }>(
			`SELECT r.id, r.uri, r.account_id AS booster, r.withdrawn FROM statuses r JOIN statuses o ON o.id = r.reblog_of_id
				JOIN local_accounts l ON l.account_id = r.account_id
			WHERE ${column} = ? ORDER BY r.id = ? DESC, r.id LIMIT 1`,
			id,
			cursor ?? ''
		)
		if (boost === undefined) {
			return
		}
		// A boost is withdrawn once whichever job reaches it first (a status's deletion or its author's purge): the
		// boost row's own marker says its Undo is recorded, however long the intent itself lives (it goes once its
		// deliveries settle), and both jobs wait for the intent to finish staging before they delete the receipts and
		// the boost, which takes the marker with it.
		if (cursor !== boost.id && boost.withdrawn === 0) {
			// The Undo intent and the earlier intents about the boost it supersedes, then the marker and the cursor.
			if (!withdrawLocalBoost(db, boost.id, now, budget.left() - 2)) {
				return
			}
			db.run('UPDATE statuses SET withdrawn = 1 WHERE id = ?', boost.id)
			db.run('UPDATE inbound_jobs SET cursor = ? WHERE kind = ? AND key = ?', boost.id, job.kind, job.key)
		}
		// Its targets, a chunk per row, over as many batches as they need; the receipts stay until all are written.
		if (!stageRetraction(db, boost.booster, boost.uri, budget.left())) {
			return
		}
		// The boost's deletion, its booster's recount and the cursor's reset.
		if (!deleteStatusWithin(db, boost.id, budget, 2)) {
			return
		}
		recountStatuses(db, boost.booster)
		db.run('UPDATE inbound_jobs SET cursor = NULL WHERE kind = ? AND key = ?', job.kind, job.key)
	}
}

// The tables whose rows name a status (a foreign key to statuses.id that cascades or sets null), each with its
// column and its bounded delete or detach statements, in order: `?1` the status id, `?2` the row limit.
// deleteStatusWithin spends each statement and deletes the status only once none of these tables names it, so a new
// child table goes here, or its rows would go in the status's delete unbounded; test/cascade-guard.test.ts checks the
// list against the schema. Votes (deletePollVotes) and the status's replies and boosts have their own steps.
export const STATUS_CHILDREN: readonly { table: string; column: string; remove: readonly string[] }[] = [
	{
		table: 'status_edits',
		column: 'status_id',
		remove: ['DELETE FROM status_edits WHERE id IN (SELECT id FROM status_edits WHERE status_id = ? LIMIT ?)'],
	},
	// Local uploads, also those an edit dropped, are detached for the media sweep, which deletes their R2 objects
	// (gc_at the epoch: due at once; media.ts's DOOMED_AT written out, since media.ts reaches this module through
	// accounts.ts and the list is built as the module loads); remote rows only name URLs.
	{
		table: 'media_attachments',
		column: 'status_id',
		remove: [
			`UPDATE media_attachments SET status_id = NULL, position = 0, shown = 1, gc_at = '1970-01-01T00:00:00.000Z'
			WHERE id IN (SELECT id FROM media_attachments WHERE status_id = ?1 AND file_token IS NOT NULL LIMIT ?2)`,
			'DELETE FROM media_attachments WHERE id IN (SELECT id FROM media_attachments WHERE status_id = ? AND file_token IS NULL LIMIT ?)',
		],
	},
	{
		table: 'status_mentions',
		column: 'status_id',
		remove: [
			`DELETE FROM status_mentions WHERE status_id = ?1
			AND account_id IN (SELECT account_id FROM status_mentions WHERE status_id = ?1 LIMIT ?2)`,
		],
	},
	{
		table: 'status_tags',
		column: 'status_id',
		remove: [
			'DELETE FROM status_tags WHERE status_id = ?1 AND name IN (SELECT name FROM status_tags WHERE status_id = ?1 LIMIT ?2)',
		],
	},
	{
		table: 'favourites',
		column: 'status_id',
		remove: ['DELETE FROM favourites WHERE id IN (SELECT id FROM favourites WHERE status_id = ? LIMIT ?)'],
	},
	{
		table: 'bookmarks',
		column: 'status_id',
		remove: ['DELETE FROM bookmarks WHERE id IN (SELECT id FROM bookmarks WHERE status_id = ? LIMIT ?)'],
	},
	{
		table: 'notifications',
		column: 'status_id',
		remove: ['DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE status_id = ? LIMIT ?)'],
	},
	// Pins of the status (migration 0018_status_pins_and_conversation_mutes): only its author pins it, so a remote
	// status has none, but none outlives it.
	{
		table: 'status_pins',
		column: 'status_id',
		remove: [
			`DELETE FROM status_pins WHERE status_id = ?1
			AND account_id IN (SELECT account_id FROM status_pins WHERE status_id = ?1 LIMIT ?2)`,
		],
	},
	// Filters naming the status (migration 0012_filters): any number of them, of any accounts.
	{
		table: 'filter_statuses',
		column: 'status_id',
		remove: ['DELETE FROM filter_statuses WHERE id IN (SELECT id FROM filter_statuses WHERE status_id = ? LIMIT ?)'],
	},
	// Notification requests whose last status it is (migration 0020_notification_policies): one per recipient and
	// sender, any number of recipients; the request stays, without a last status (ON DELETE SET NULL, as Mastodon's
	// foreign key nullifies it).
	{
		table: 'notification_requests',
		column: 'last_status_id',
		remove: [
			`UPDATE notification_requests SET last_status_id = NULL
			WHERE id IN (SELECT id FROM notification_requests WHERE last_status_id = ? LIMIT ?)`,
		],
	},
	// Receipts of a withdrawn local boost are deleted here, a batch at a time, after its Undo has taken them as targets.
	{
		table: 'outbound_receipts',
		column: 'status_id',
		remove: [
			`DELETE FROM outbound_receipts WHERE status_id = ?1
			AND inbox_url IN (SELECT inbox_url FROM outbound_receipts WHERE status_id = ?1 LIMIT ?2)`,
		],
	},
	// The conversations holding the status (migration 0009_conversations): one row per conversation, which a status
	// can join again under other participants after an Update, so any number. Each delete fires the trigger
	// conversation_statuses_removed, which writes that conversation once (AccountConversation.remove_status), so a
	// batch takes half the rows left.
	{
		table: 'conversation_statuses',
		column: 'status_id',
		remove: [
			`DELETE FROM conversation_statuses WHERE status_id = ?1
			AND conversation_id IN (SELECT conversation_id FROM conversation_statuses WHERE status_id = ?1 LIMIT CAST(?2 / 2 AS INTEGER))`,
		],
	},
]

const STATUS_CHILDREN_EXIST = STATUS_CHILDREN.map(
	(child) => `EXISTS (SELECT 1 FROM ${child.table} WHERE ${child.column} = ?1)`
).join(' OR ')

// Deletes a status's children within the budget, and the status itself once none remain (so nothing cascades).
// `after` is how many rows the caller writes once the status is gone. Returns whether the status is gone.
function deleteStatusWithin(db: Db, statusId: string, budget: Budget, after = 0): boolean {
	const row = db.first<{ parent: string | null; original: string | null }>(
		'SELECT in_reply_to_id AS parent, reblog_of_id AS original FROM statuses WHERE id = ?',
		statusId
	)
	if (row === undefined) {
		return true
	}
	// The votes in its poll; the poll itself, one row, goes with the status.
	deletePollVotes(db, statusId, budget.left())
	for (const child of STATUS_CHILDREN) {
		for (const sql of child.remove) {
			spend(db, budget, sql, statusId)
		}
	}
	spend(
		db,
		budget,
		'UPDATE statuses SET in_reply_to_id = NULL WHERE id IN (SELECT id FROM statuses WHERE in_reply_to_id = ? LIMIT ?)',
		statusId
	)
	const children = db.first(
		`SELECT 1 AS x WHERE ${STATUS_CHILDREN_EXIST}
			OR EXISTS (SELECT 1 FROM statuses WHERE in_reply_to_id = ?1 OR reblog_of_id = ?1)`,
		statusId
	)
	// The status's delete (with its poll) and the recounts of its parent and original.
	if (children !== undefined || hasPollVotes(db, { statusId }) || budget.left() < 3 + after) {
		return false
	}
	db.run('DELETE FROM statuses WHERE id = ?', statusId)
	recountStatus(db, row.parent)
	recountStatus(db, row.original)
	return true
}

// What of a remote account its purge removes before the account row (a foreign key to accounts.id that cascades or
// sets null), each with the condition on `?1`, the account id, that finds a row left. accountHasRows tests them all,
// and the purge deletes the account only once none holds, so a new table naming accounts goes here, or its rows would
// go in the account's delete unbounded; test/cascade-guard.test.ts checks the list against the schema. `filter`
// marks the blocks and mutes, which go last (see purgeBatch). Votes are checked apart (hasPollVotes).
export const PURGED_ACCOUNT_CHILDREN: readonly { table: string; check: string; filter?: true }[] = [
	{ table: 'statuses', check: 'account_id = ?1' },
	{ table: 'favourites', check: 'account_id = ?1' },
	{ table: 'follows', check: 'account_id = ?1 OR target_account_id = ?1' },
	{ table: 'blocks', check: 'account_id = ?1 OR target_account_id = ?1', filter: true },
	{ table: 'mutes', check: 'target_account_id = ?1', filter: true },
	{ table: 'list_accounts', check: 'account_id = ?1' },
	{ table: 'account_pins', check: 'target_account_id = ?1' },
	{ table: 'account_notes', check: 'target_account_id = ?1' },
	{ table: 'notifications', check: 'from_account_id = ?1' },
	{ table: 'notification_permissions', check: 'from_account_id = ?1' },
	{ table: 'notification_requests', check: 'from_account_id = ?1' },
	{ table: 'notification_request_jobs', check: 'from_account_id = ?1' },
	{ table: 'status_mentions', check: 'account_id = ?1' },
	{ table: 'statuses', check: 'in_reply_to_account_id = ?1' },
	{ table: 'media_attachments', check: 'account_id = ?1' },
	{ table: 'remote_keys', check: 'account_id = ?1' },
	{ table: 'inbound_jobs', check: 'target_account_id = ?1' },
	{ table: 'reports', check: 'target_account_id = ?1' },
]

const ACCOUNT_CHILDREN_EXIST = PURGED_ACCOUNT_CHILDREN.map((child) => {
	const exists = `EXISTS (SELECT 1 FROM ${child.table} WHERE ${child.check})`
	return child.filter ? `(?2 AND ${exists})` : exists
}).join(' OR ')

// Whether rows of the account remain; with filters false, rows other than its blocks and mutes.
function accountHasRows(db: Db, id: string, filters = true): boolean {
	return (
		hasPollVotes(db, { accountId: id }) ||
		db.first(`SELECT 1 AS x WHERE ${ACCOUNT_CHILDREN_EXIST}`, id, filters ? 1 : 0) !== undefined
	)
}

// A Delete of something other than the actor (Mastodon's Delete#delete_object). The retraction is recorded so that
// the object cannot appear afterwards (ID-7), whether or not it was seen before, for any id of the actor's origin
// (design: a Delete of an unknown object is recorded). A stored status or boost is removed only by its author (ID-6;
// a local status never has a remote author, ID-3): a boost at once, a status in bounded batches (deleteStatusBatch).
// The removal needs its retraction: at the per-actor cap nothing changes and the Delete is answered 503, to be
// delivered again (a Delete of an unknown object at the cap is not recorded, and answered 202).
const deleteObject: Handler<'Delete'> = (db, actor, activity, { now }) => {
	if (originOf(activity.object) !== originOf(actor.uri)) {
		return ignored('foreign-object')
	}
	const status = db.first<{ id: string; account_id: string; reblog_of_id: string | null }>(
		'SELECT id, account_id, reblog_of_id FROM statuses WHERE uri = ?',
		activity.object
	)
	if (status !== undefined && status.account_id !== actor.id) {
		return ignored('not-author')
	}
	if (status === undefined) {
		return retract(db, actor.uri, activity.object, now) ? applied('retraction-recorded') : ignored('retraction-cap')
	}
	if (!retract(db, actor.uri, activity.object, now)) {
		return retryLater('retraction-cap')
	}
	recordDeletedObject(db, activity.object, now)
	if (status.reblog_of_id !== null) {
		removeBoost(db, actor.id, { id: status.id, original: status.reblog_of_id })
		return applied('boost-deleted')
	}
	db.run(
		"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, ?) ON CONFLICT DO NOTHING",
		status.id,
		actor.uri,
		now
	)
	return applied('status-deleted', deleteStatusBatch(db, status.id, now))
}

// One batch of a deleted remote status's removal (Mastodon's RemoveStatusService, RES-6), at most PURGE_BATCH rows
// in all: the status is hidden first (its mentions removed, then no content and no audience but its author), so it
// is gone from every view at once however many batches the rest takes; then local boosts of it are withdrawn (their
// Undo recorded once, see withdrawLocalBoosts) and deleted, then remote boosts, then the status's children and the
// status itself (deleteStatusWithin, so nothing cascades). Returns whether anything remains.
export function deleteStatusBatch(db: Db, statusId: string, now: number): boolean {
	if (db.first('SELECT 1 AS x FROM statuses WHERE id = ?', statusId) === undefined) {
		finishJob(db, 'delete', statusId, now)
		return false
	}
	const budget = new Budget(db, PURGE_BATCH)
	spend(
		db,
		budget,
		`DELETE FROM status_mentions WHERE status_id = ?1
			AND account_id IN (SELECT account_id FROM status_mentions WHERE status_id = ?1 LIMIT ?2)`,
		statusId
	)
	if (budget.left() > 0) {
		db.run(
			`UPDATE statuses SET visibility = 'direct', content = '', spoiler_text = '', search_text = NULL
			WHERE id = ? AND (visibility <> 'direct' OR content <> '' OR spoiler_text <> '' OR search_text IS NOT NULL)`,
			statusId
		)
		// No longer public, so its hashtags leave the index tag reads walk (status_tags.public), in the same write. A
		// remote status holds at most MAX_STATUS_TAGS of them, and they are cleared once (later batches find none), so
		// a batch exceeds PURGE_BATCH by that many rows at most; the budget counts them, so the rest of this batch does
		// that much less.
		db.run('UPDATE status_tags SET public = 0 WHERE status_id = ? AND public = 1', statusId)
	}
	withdrawLocalBoosts(db, { kind: 'delete', key: statusId }, 'o.id', statusId, budget, now)
	while (budget.left() > 0) {
		const boost = db.first<{ id: string }>(
			`SELECT r.id FROM statuses r LEFT JOIN local_accounts l ON l.account_id = r.account_id
			WHERE r.reblog_of_id = ? AND l.account_id IS NULL LIMIT 1`,
			statusId
		)
		if (boost === undefined || !deleteStatusWithin(db, boost.id, budget)) {
			break
		}
	}
	if (deleteStatusWithin(db, statusId, budget, 1)) {
		finishJob(db, 'delete', statusId, now)
		return false
	}
	return true
}

// ---------------------------------------------------------------------------------------------------------------
// Statuses, favourites and boosts (B1b-2)
// ---------------------------------------------------------------------------------------------------------------

// The local account whose personal inbox received the activity, by its exact username (ID-5).
function deliveredTo(db: Db, recipient: string | null | undefined): string | null {
	if (recipient === null || recipient === undefined) {
		return null
	}
	return (
		db.first<{ id: string }>(
			`SELECT a.id FROM accounts a JOIN local_accounts l ON l.account_id = a.id
			WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1 AND ${availableLocalSql('l')}`,
			recipient
		)?.id ?? null
	)
}

function storeContext(db: Db, input: ReceiveInput): StoreContext {
	return { now: input.now, origin: input.origin, deliveredTo: deliveredTo(db, input.recipient), fetched: false }
}

function outcome(result: { applied: boolean; reason: string }): ReceiveResult {
	return result.applied ? applied(result.reason) : ignored(result.reason)
}

const create: Handler<'Create'> = (db, actor, activity, input) =>
	outcome(storeRemoteStatus(db, actor, activity.object, storeContext(db, input)))

const updateStatus: Handler<'UpdateStatus'> = (db, actor, activity, input) =>
	outcome(updateRemoteStatus(db, actor, activity.object, storeContext(db, input)))

// What an inbound Like or Announce of a status requires of its actor: that it may see the status by itself (canView, as
// a remote viewer). So an author who blocks the actor (VIS-13) or its domain (VIS-15) refuses both. Mastodon's Like and
// Announce handlers do not check the read rule; Kopje does.
function mayInteract(db: Db, actor: RemoteRow, statusId: string): boolean {
	return canView(db, actor.id, statusId)
}

// Mastodon's ActivityPub::Activity::Like: a favourite of a local status, once per account, unless an Undo of this Like
// arrived first (ID-7), by an actor that may interact with it (mayInteract).
const like: Handler<'Like'> = (db, actor, activity, { now }) => {
	const status = db.first<{ id: string; account_id: string }>(
		`SELECT s.id, s.account_id FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id
		WHERE s.uri = ? AND s.reblog_of_id IS NULL`,
		activity.object
	)
	if (status === undefined) {
		return ignored('unknown-object')
	}
	if (isRetracted(db, actor.uri, activity.id, now)) {
		return ignored('retracted')
	}
	if (!mayInteract(db, actor, status.id)) {
		return ignored('not-visible')
	}
	const inserted = db.first<{ id: number }>(
		`INSERT INTO favourites (account_id, status_id, uri, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT DO NOTHING RETURNING id`,
		actor.id,
		status.id,
		activity.id,
		new Date(now).toISOString()
	)
	if (inserted === undefined) {
		return ignored('duplicate')
	}
	recountStatus(db, status.id)
	notify(db, { recipientId: status.account_id, type: 'favourite', fromId: actor.id, statusId: status.id, now })
	return applied('favourited')
}

type Original = { id: string; account_id: string; visibility: Visibility; local: number }

function originalByUri(db: Db, uri: string): Original | undefined {
	return db.first<Original>(
		`SELECT s.id, s.account_id, s.visibility, l.account_id IS NOT NULL AS local
		FROM statuses s LEFT JOIN local_accounts l ON l.account_id = s.account_id
		WHERE s.uri = ? AND s.reblog_of_id IS NULL`,
		uri
	)
}

function followersOf(raw: string | null): string | null {
	if (raw === null) {
		return null
	}
	const followers = (JSON.parse(raw) as { followers?: unknown }).followers
	return typeof followers === 'string' ? followers : null
}

// Mastodon's Announce#visibility_from_audience.
function boostVisibility(db: Db, actor: RemoteRow, to: readonly string[], cc: readonly string[]): Visibility {
	if (to.some(isPublicCollection)) {
		return 'public'
	}
	if (cc.some(isPublicCollection)) {
		return 'unlisted'
	}
	const followers = followersUri(db, actor.id)
	return followers !== null && to.includes(followers) ? 'private' : 'direct'
}

// VIS-6 (StatusPolicy#reblog? as Mastodon's Announce#announceable? applies it): a boost wraps a public or unlisted
// original, or the booster's own.
function announceable(authorId: string, actorId: string, visibility: Visibility): boolean {
	return authorId === actorId || isDistributable(visibility)
}

// The boosted original of an Announce that is not stored yet, stored now if it may be boosted: the actor's own
// embedded status (Mastodon's status_from_object), or the original fetched by its id with its author (asked of the
// Worker through `need`). VIS-6: whether it may be boosted is decided before anything is stored, so a boost of a
// private, direct or limited object, or of one that cannot be fetched, stores nothing.
function newOriginal(
	db: Db,
	actor: RemoteRow,
	activity: Extract<InboundActivity, { type: 'Announce' }>,
	input: ReceiveInput
): Original | ReceiveResult {
	const { now, origin } = input
	const context = { now, origin, deliveredTo: null, fetched: true }
	const embedded = activity.embedded
	if (embedded !== null && embedded.uri === activity.object && embedded.attributedTo === actor.uri) {
		const stored = storeRemoteStatus(db, actor, embedded, context)
		const original = stored.statusId === undefined ? undefined : originalByUri(db, embedded.uri)
		return original ?? ignored(stored.reason)
	}
	const fetched = input.prefetched?.statuses[activity.object]
	if (fetched === undefined) {
		return { ...ignored('need-object'), need: { kind: 'status', uri: activity.object } }
	}
	if (fetched === null) {
		return ignored('unfetchable')
	}
	const authorUri = fetched.attributedTo
	if (authorUri === null || originOf(authorUri) !== originOf(fetched.uri)) {
		return ignored('unusable-object')
	}
	// Nothing new of an author whose deletion has started is stored, its stored row or not (ID-7).
	if (isDeletedActor(db, authorUri, now)) {
		return ignored('author-deleted')
	}
	const known = originalByUri(db, fetched.uri)
	if (known !== undefined) {
		return known
	}
	let author = remoteAccount(db, authorUri)
	let followers = author === undefined ? null : followersUri(db, author.id)
	const document = author === undefined ? input.prefetched?.actors[authorUri] : undefined
	if (author === undefined) {
		if (document === undefined) {
			return { ...ignored('need-author'), need: { kind: 'actor', uri: authorUri } }
		}
		if (document === null || document.uri !== authorUri) {
			return ignored('unfetchable')
		}
		followers = followersOf(document.raw)
	}
	if (authorUri !== actor.uri && !isDistributable(visibilityOf(fetched, followers))) {
		return ignored('not-announceable')
	}
	if (author === undefined && document !== undefined && document !== null) {
		author = upsertRemoteActor(db, document, origin, now)
	}
	if (author === undefined) {
		return ignored('unknown-author')
	}
	const stored = storeRemoteStatus(db, author, fetched, context)
	return (stored.statusId === undefined ? undefined : originalByUri(db, fetched.uri)) ?? ignored(stored.reason)
}

// Mastodon's ActivityPub::Activity::Announce: a boost row (reblog_of_id) by the actor, once per original (ID-7), only
// when it concerns this instance (a local follower of the booster, or a local original), only of an original it may
// wrap (VIS-6), and by an actor that may interact with it (mayInteract). The local author is notified.
const announce: Handler<'Announce'> = (db, actor, activity, input) => {
	const { now } = input
	if (isDeleted(db, actor.uri, activity.id, now)) {
		return ignored('retracted')
	}
	if (statusByUri(db, activity.id) !== undefined) {
		return ignored('duplicate')
	}
	let original = originalByUri(db, activity.object)
	if (original?.local !== 1 && !hasLocalFollowers(db, actor.id)) {
		return ignored('unrelated')
	}
	if (original === undefined) {
		if (originOf(activity.object) === input.origin) {
			return ignored('unknown-object')
		}
		const resolved = newOriginal(db, actor, activity, input)
		if ('reason' in resolved) {
			return resolved
		}
		original = resolved
	}
	if (!announceable(original.account_id, actor.id, original.visibility)) {
		return ignored('not-announceable')
	}
	// An original whose author is being deleted is on its way out with its boosts: none is added.
	if (authorDeleted(db, original.account_id, now)) {
		return ignored('author-deleted')
	}
	if (!mayInteract(db, actor, original.id)) {
		return ignored('not-visible')
	}
	const originalId = original.id
	if (
		db.first('SELECT 1 AS x FROM statuses WHERE account_id = ? AND reblog_of_id = ?', actor.id, originalId) !==
		undefined
	) {
		return ignored('duplicate')
	}
	const published = Date.parse(activity.published ?? '')
	const publishedAt = new Date(Number.isNaN(published) || published > now ? now : published).toISOString()
	const boostId = insertWithFreshId(
		'statuses',
		() => remoteId(publishedAt, now),
		(id) => {
			db.run(
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, raw, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				activity.id,
				actor.id,
				originalId,
				boostVisibility(db, actor, activity.to, activity.cc),
				publishedAt,
				activity.raw,
				new Date(now).toISOString()
			)
			return id
		}
	)
	// The wrapper's own audience: known accounts it addresses are its silent recipients (bounded, local first), so the
	// audience rule decides who may see the boost, its reblog notification included (notifications.ts).
	const addressed = db.all<{ id: string }>(
		`SELECT a.id FROM accounts a LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE a.uri IN (SELECT value FROM json_each(?)) AND a.id <> ?
		ORDER BY l.account_id IS NULL LIMIT ?`,
		JSON.stringify([...activity.to, ...activity.cc].slice(0, MAX_STATUS_AUDIENCE)),
		actor.id,
		MAX_STATUS_MENTION_ROWS
	)
	db.run(
		`INSERT INTO status_mentions (status_id, account_id, silent, ${MENTION_STATUS_COLUMNS})
		SELECT ?1, value, 1, ${mentionStatusSql('?1')} FROM json_each(?2) WHERE true`,
		boostId,
		JSON.stringify(addressed.map((row) => row.id))
	)
	recountStatus(db, originalId)
	// The local author hears of the boost only if they may see it (notify applies the rule to the wrapper too).
	notify(db, { recipientId: original.account_id, type: 'reblog', fromId: actor.id, statusId: originalId, now })
	return applied('boosted')
}

// Whether the remote account `id` deleted itself (its tombstone, as isDeletedActor).
function authorDeleted(db: Db, id: string, now: number): boolean {
	const uri = db.first<{ uri: string }>('SELECT uri FROM accounts WHERE id = ? AND domain IS NOT NULL', id)?.uri
	return uri !== undefined && isDeletedActor(db, uri, now)
}

// A favourite or boost the actor made under this id.
function interactionOf(db: Db, actor: RemoteRow, uri: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM favourites WHERE account_id = ?1 AND uri = ?2)
				OR EXISTS (SELECT 1 FROM statuses WHERE account_id = ?1 AND uri = ?2 AND reblog_of_id IS NOT NULL)`,
			actor.id,
			uri
		) !== undefined
	)
}

function removeFavourite(db: Db, actorId: string, favourite: { id: string; status_id: string }): void {
	db.run('DELETE FROM favourites WHERE id = CAST(? AS INTEGER)', favourite.id)
	recountStatus(db, favourite.status_id)
	db.run(
		`DELETE FROM notifications WHERE type = 'favourite' AND from_account_id = ? AND status_id = ?`,
		actorId,
		favourite.status_id
	)
}

// A boost has no children but its recipients (bounded) and its reblog notification, which names the original.
function removeBoost(db: Db, actorId: string, boost: { id: string; original: string }): void {
	db.run('DELETE FROM status_mentions WHERE status_id = ?', boost.id)
	db.run('DELETE FROM statuses WHERE id = ?', boost.id)
	recountStatus(db, boost.original)
	db.run(
		`DELETE FROM notifications WHERE type = 'reblog' AND from_account_id = ? AND status_id = ?`,
		actorId,
		boost.original
	)
}

// Undo of a Like (or a reaction) or an Announce. A Like is found by its id or, as Mastodon's undo_like does, as the
// actor's favourite of the embedded Like's object; an Announce by its id. Every id involved is recorded as retracted:
// the Undo's own reference, and the id the matched favourite was stored under (another Like of the same status, which
// a replay must not restore). An Undo that overtook its activity keeps it from applying (ID-7). If they cannot all be
// recorded (the per-actor cap), nothing changes and the Undo is answered 503.
function undoInteraction(db: Db, actor: RemoteRow, ref: ActivityRef & { id: string }, now: number): ReceiveResult {
	type Favourite = { id: string; status_id: string; uri: string | null }
	const favourite =
		ref.type === 'Announce'
			? undefined
			: (db.first<Favourite>(
					'SELECT CAST(id AS TEXT) AS id, status_id, uri FROM favourites WHERE account_id = ? AND uri = ?',
					actor.id,
					ref.id
				) ??
				(ref.object === null
					? undefined
					: db.first<Favourite>(
							`SELECT CAST(f.id AS TEXT) AS id, f.status_id, f.uri FROM favourites f JOIN statuses s ON s.id = f.status_id
							WHERE f.account_id = ? AND s.uri = ?`,
							actor.id,
							ref.object
						)))
	const boost =
		ref.type === 'Like' || ref.type === 'EmojiReact'
			? undefined
			: db.first<{ id: string; original: string }>(
					`SELECT id, reblog_of_id AS original FROM statuses
					WHERE account_id = ? AND uri = ? AND reblog_of_id IS NOT NULL`,
					actor.id,
					ref.id
				)
	const retracted = [ref.id, ...(favourite?.uri == null || favourite.uri === ref.id ? [] : [favourite.uri])]
	if (!canRetract(db, actor.uri, retracted, now)) {
		return retryLater('retraction-cap')
	}
	if (favourite !== undefined) {
		removeFavourite(db, actor.id, favourite)
	}
	if (boost !== undefined) {
		removeBoost(db, actor.id, boost)
	}
	for (const uri of retracted) {
		retract(db, actor.uri, uri, now)
	}
	return favourite !== undefined || boost !== undefined ? applied('undone') : applied('retraction-recorded')
}

const HANDLERS: { [T in InboundActivity['type']]: Handler<T> } = {
	Follow: follow,
	Accept: accept,
	Reject: reject,
	Undo: undo,
	Block: block,
	Move: move,
	UpdateActor: updateActor,
	DeleteActor: deleteActor,
	Delete: deleteObject,
	Create: create,
	UpdateStatus: updateStatus,
	Like: like,
	Announce: announce,
}

export const receiveActivity = writeOperation<ReceiveInput, ReceiveResult>((db, input) => {
	const before = outboundMark(db)
	const result = receive(db, input)
	return { ...result, delivers: outboundSince(db, before) }
})

function receive(db: Db, input: ReceiveInput): ReceiveResult {
	const { activity, actorUri, now, origin } = input
	sweep(db, now)
	// ID-1/ID-3, again where it is written: a remote actor only, and an activity id of its origin.
	if (originOf(actorUri) === null || originOf(actorUri) === origin) {
		return ignored('local-actor')
	}
	if (originOf(activity.id) !== originOf(actorUri)) {
		return ignored('foreign-id')
	}
	if (input.actor !== null && input.actor.uri !== actorUri) {
		return ignored('actor-mismatch')
	}
	// A deleted actor does nothing more while its tombstone lasts; a repeated Delete only continues the purge.
	if (isDeletedActor(db, actorUri, now)) {
		return activity.type === 'DeleteActor'
			? { ...ignored('duplicate'), jobsPending: pendingPurge(db, actorUri) }
			: ignored('actor-deleted')
	}
	const actor =
		input.actor === null || activity.type === 'DeleteActor'
			? remoteAccount(db, actorUri)
			: upsertRemoteActor(db, input.actor, origin, now)
	if (actor === undefined && activity.type === 'DeleteActor' && input.actor !== null) {
		// Verified against the actor's current document, but never stored: the tombstone alone keeps it from being
		// stored by a late activity (ID-7).
		db.run(
			`INSERT INTO inbound_jobs (kind, key, actor_uri, done_at, expires_at, created_at)
			VALUES ('purge', ?1, ?1, ?2, ?3, ?2)
			ON CONFLICT (kind, key) DO UPDATE SET done_at = excluded.done_at, expires_at = excluded.expires_at,
				created_at = excluded.created_at`,
			actorUri,
			now,
			now + JOB_RETENTION_MS
		)
		return applied('actor-deleted')
	}
	if (actor === undefined) {
		return ignored('unknown-actor')
	}
	const handler = HANDLERS[activity.type] as Handler<typeof activity.type>
	return handler(db, actor, activity as never, input)
}

function pendingPurge(db: Db, uri: string): boolean {
	return (
		db.first("SELECT 1 AS x FROM inbound_jobs WHERE kind = 'purge' AND key = ? AND done_at IS NULL", uri) !== undefined
	)
}

// One round of pending jobs, oldest first, at most JOB_BATCHES_PER_RUN batches in all (the Queue and cron call it). Returns
// whether any job still has batches left.
export const runInboundJobs = writeOperation<{ now: number }, { pending: boolean; delivers: boolean }>(
	(db, { now }) => {
		const before = outboundMark(db)
		sweep(db, now)
		for (let batch = 0; batch < JOB_BATCHES_PER_RUN; batch++) {
			const job = db.first<{ kind: JobKind; key: string }>(
				'SELECT kind, key FROM inbound_jobs WHERE done_at IS NULL ORDER BY created_at, kind, key LIMIT 1'
			)
			if (job === undefined) {
				break
			}
			if (job.kind === 'purge') {
				purgeBatch(db, job.key, now)
			} else if (job.kind === 'delete') {
				deleteStatusBatch(db, job.key, now)
			} else {
				moveBatch(db, job.key, now)
			}
		}
		return {
			pending: db.first('SELECT 1 AS x FROM inbound_jobs WHERE done_at IS NULL') !== undefined,
			delivers: outboundSince(db, before),
		}
	}
)

// Writes nothing: admitted only where receiveActivity would be (the Store gate refuses it while maintenance, a dump,
// an import or an unpublished import holds writes). Checked before an inbound request is verified, so that nothing is
// fetched, signed with a local key, for a request the Store would refuse anyway (OPS-8).
export const inboxWritable = writeOperation<undefined, true>(() => true)

// Whether a personal inbox path names a local account with its exact stored username.
export const inboxOwnerExists = readOperation<{ username: string }, boolean>(
	(db, { username }) =>
		db.first(
			`SELECT 1 AS x FROM accounts a JOIN local_accounts l ON l.account_id = a.id
			WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1`,
			username
		) !== undefined
)
