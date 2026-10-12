import { followActivity, followAnswerActivity, followUri, recordOutbound, undoFollowActivity } from './activities'
import { insertWithFreshId, remoteId } from './ids'
import { notify } from './notifications'
import { readOperation, writeOperation } from './operation'
import { accountSearchText } from './search-text'
import { recountStatus, recountStatuses, withdrawLocalBoost } from './statuses'
import type { Db } from '../db/sql'

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
//   Update       of an actor: the object is the actor itself
//   Delete       of an actor: the object is the actor itself; of anything else: recorded as a retraction (ID-7)
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
// Expired retractions and finished jobs removed per call (RES-4), so the sweep stays bounded and keeps up.
export const SWEEP_BATCH = 100
// A stored key is trusted this long after its actor document was fetched; after that the Worker fetches it again.
// A deleted actor's own Delete is the one exception (federation/inbound.ts).
export const KEY_REFRESH_MS = 24 * 60 * 60 * 1000
// A finished job, and with it a deleted actor's tombstone, is kept this long after it is done.
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// Bounds of one batch of a Move (RES-6): local followers moved, and local blocks and mutes carried over to the target.
export const MOVE_BATCH = 100
export const MOVE_MAX_CARRIED = 100
// Statuses and favourites of a deleted actor removed per batch (RES-6).
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

export type ReceiveInput = {
	now: number
	// This instance's origin: no URI of it is ever written as a remote actor (ID-3).
	origin: string
	actorUri: string
	// A fresh document of the actor to store, or null to use the stored row as it is.
	actor: RemoteActorInput | null
	activity: InboundActivity
}

// jobsPending: a purge or Move has batches left; the Worker asks the Queue to continue (cron continues regardless).
// delivers: the activity recorded deliveries (an Accept, Reject, Follow or Undo); the Worker rings the doorbell.
export type ReceiveResult = { applied: boolean; reason: string; jobsPending: boolean; delivers?: boolean }

function ignored(reason: string): ReceiveResult {
	return { applied: false, reason, jobsPending: false }
}

function applied(reason: string, jobsPending = false): ReceiveResult {
	return { applied: true, reason, jobsPending }
}

// The deliveries id sequence (AUTOINCREMENT): it moves whenever a delivery is recorded, even one deleted since.
function deliverySequence(db: Db): number {
	return db.first<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'deliveries'")?.seq ?? 0
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
	const values = [
		actor.uri,
		actor.username,
		actor.domain,
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
		accountSearchText(actor.username, actor.domain, actor.displayName),
		createdAt,
	]
	insertWithFreshId(
		'accounts',
		() => remoteId(actor.published ?? '', now),
		(id) =>
			db.run(
				`INSERT INTO accounts (id, uri, username, domain, actor_type, display_name, note, url, avatar_url, header_url,
					locked, discoverable, inbox_url, shared_inbox_url, raw, fetched_at, search_text, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (uri) DO UPDATE SET username = excluded.username, actor_type = excluded.actor_type,
					display_name = excluded.display_name, note = excluded.note, url = excluded.url,
					avatar_url = excluded.avatar_url, header_url = excluded.header_url, locked = excluded.locked,
					discoverable = excluded.discoverable, inbox_url = excluded.inbox_url,
					shared_inbox_url = excluded.shared_inbox_url, raw = excluded.raw, fetched_at = excluded.fetched_at,
					search_text = excluded.search_text
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
		`SELECT a.id, a.uri, a.locked, l.suspended_at IS NOT NULL AS suspended
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

function blockedEitherWay(db: Db, a: string, b: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x FROM blocks WHERE (account_id = ?1 AND target_account_id = ?2)
				OR (account_id = ?2 AND target_account_id = ?1)`,
			a,
			b
		) !== undefined
	)
}

// Accept or Reject of a remote Follow, as an outbound intent delivered to the follower's personal inbox (B2). Its id
// derives from the Follow it answers (followAnswerActivity).
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
	if (db.first('SELECT 1 AS x FROM blocks WHERE account_id = ? AND target_account_id = ?', actor.id, target.id)) {
		return ignored('blocked')
	}
	const existing = db.first<{ id: string; state: string; uri: string | null }>(
		'SELECT CAST(id AS TEXT) AS id, state, uri FROM follows WHERE account_id = ? AND target_account_id = ?',
		actor.id,
		target.id
	)
	const blocked = db.first(
		`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM blocks WHERE account_id = ?1 AND target_account_id = ?2)
			OR EXISTS (SELECT 1 FROM domain_blocks WHERE account_id = ?1 AND domain = ?3)`,
		target.id,
		actor.id,
		actor.domain
	)
	if (blocked !== undefined) {
		// Refused with a Reject. The id is recorded as dead, so a replay sends no second Reject (ID-7); if it cannot be
		// recorded, no Reject is recorded either.
		if (!retract(db, actor.uri, activity.id, now)) {
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
		if (existing.uri !== null && !isMisskeyPairId(existing.uri) && !retract(db, actor.uri, existing.uri, now)) {
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
function isMisskeyPairId(id: string): boolean {
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
	// Everything this Undo records as retracted must fit, or nothing changes (ID-7).
	// Pair ids name every generation, so they are never recorded, whichever side carries them.
	const retracted = [ref.id, ...(edge?.uri == null ? [] : [edge.uri])].filter((uri) => !isMisskeyPairId(uri))
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
	// and a replay of an undone activity does not restore it (ID-7). Likes and Announces (B1b-2) check it too.
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
		db.run('UPDATE blocks SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.id, existing.id)
		return existing.uri === activity.id ? ignored('duplicate') : applied('block-updated')
	}
	const followUri = db.first<{ uri: string | null }>(
		'SELECT uri FROM follows WHERE account_id = ? AND target_account_id = ?',
		actor.id,
		target.id
	)?.uri
	// The removed follow's generation must be recorded, or the Block changes nothing (ID-7).
	if (followUri != null && !isMisskeyPairId(followUri) && !retract(db, actor.uri, followUri, now)) {
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
		`INSERT INTO mutes (account_id, target_account_id, hide_notifications, created_at)
		SELECT m.account_id, ?2, m.hide_notifications, ?3 FROM mutes m
		WHERE m.target_account_id = ?1 AND m.account_id <> ?2 ORDER BY m.id LIMIT ?4
		ON CONFLICT DO NOTHING`,
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
		// Mastodon's MoveWorker: UnfollowService for the source (undone there), FollowService for the target.
		const local = db.first<LocalRow>(
			'SELECT a.id, a.uri, a.locked, 0 AS suspended FROM accounts a WHERE a.id = ?',
			follower.id
		)
		if (local !== undefined) {
			unfollowRemote(db, local, source, now)
		}
		const barred =
			follower.id === target.id ||
			blockedEitherWay(db, follower.id, target.id) ||
			db.first(
				`SELECT 1 AS x FROM domain_blocks d JOIN accounts a ON a.id = ?2 WHERE d.account_id = ?1 AND d.domain = a.domain`,
				follower.id,
				target.id
			) !== undefined
		if (barred) {
			continue
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

function finishJob(db: Db, kind: 'purge' | 'move', key: string, now: number): void {
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
// account row goes with the last one.
const deleteActor: Handler<'DeleteActor'> = (db, actor, _activity, { now }) => {
	db.run(
		"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?, ?, ?) ON CONFLICT DO NOTHING",
		actor.uri,
		actor.uri,
		now
	)
	return applied('actor-deleted', purgeBatch(db, actor.uri, now))
}

// One batch of a deleted actor's purge, at most PURGE_BATCH rows written in all, whatever the account has (RES-6):
//   1. its relationships, notifications, mentions, favourites and keys, recounting what they counted;
//   2. local boosts of its statuses: each boost's Undo is recorded through the boost's own path (B2,
//      withdrawLocalBoost; the job's cursor keeps the boost being withdrawn so it is recorded once), then the boost goes;
//   3. remote boosts of its statuses, then its own statuses.
// A status is deleted only once its children (edits, media, mentions, tags, favourites, bookmarks, notifications,
// receipts, boosts and the reply links to it) are gone, so deleting it cascades nothing. Local media is detached for
// the media sweep (its R2 objects go only through B4b's path), never deleted here. Returns whether anything remains;
// when nothing does, the account row goes and the job is done.
function purgeBatch(db: Db, uri: string, now: number): boolean {
	const account = remoteAccount(db, uri)
	if (account === undefined) {
		finishJob(db, 'purge', uri, now)
		return false
	}
	const id = account.id
	const budget = { left: PURGE_BATCH }
	purgeRelationships(db, id, budget)
	withdrawLocalBoosts(db, uri, id, budget, now)
	while (budget.left > 0) {
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
	if (budget.left === 0 || accountHasRows(db, id)) {
		return true
	}
	db.run('DELETE FROM accounts WHERE id = ? AND domain IS NOT NULL', id)
	finishJob(db, 'purge', uri, now)
	return false
}

type Budget = { left: number }

// Runs a bounded write over the budget: `sql` must take the row limit as its last parameter.
function spend(db: Db, budget: Budget, sql: string, ...params: SqlStorageValue[]): number {
	if (budget.left <= 0) {
		return 0
	}
	const written = db.run(sql, ...params, budget.left)
	budget.left -= written
	return written
}

function purgeRelationships(db: Db, id: string, budget: Budget): void {
	const follows = db.all<{ id: string; other: string }>(
		`SELECT CAST(id AS TEXT) AS id, CASE WHEN account_id = ?1 THEN target_account_id ELSE account_id END AS other
		FROM follows WHERE account_id = ?1 OR target_account_id = ?1 ORDER BY id LIMIT ?2`,
		id,
		budget.left
	)
	budget.left -= db.run(
		'DELETE FROM follows WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))',
		JSON.stringify(follows.map((f) => f.id))
	)
	recountLocal(
		db,
		follows.map((f) => f.other)
	)
	const favourites = db.all<{ id: string; status: string }>(
		'SELECT CAST(id AS TEXT) AS id, status_id AS status FROM favourites WHERE account_id = ? ORDER BY id LIMIT ?',
		id,
		Math.max(budget.left, 0)
	)
	budget.left -= db.run(
		'DELETE FROM favourites WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))',
		JSON.stringify(favourites.map((f) => f.id))
	)
	for (const status of new Set(favourites.map((f) => f.status))) {
		recountStatus(db, status)
	}
	spend(
		db,
		budget,
		'DELETE FROM blocks WHERE id IN (SELECT id FROM blocks WHERE account_id = ?1 OR target_account_id = ?1 LIMIT ?2)',
		id
	)
	spend(db, budget, 'DELETE FROM mutes WHERE id IN (SELECT id FROM mutes WHERE target_account_id = ? LIMIT ?)', id)
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
		'DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE from_account_id = ? LIMIT ?)',
		id
	)
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

// Local boosts of the account's statuses, each withdrawn once through B2 (the purge job's cursor holds the boost
// whose Undo is recorded), then deleted like any status, and its booster's statuses_count recounted.
function withdrawLocalBoosts(db: Db, uri: string, id: string, budget: Budget, now: number): void {
	while (budget.left > 0) {
		const cursor = db.first<{ cursor: string | null }>(
			"SELECT cursor FROM inbound_jobs WHERE kind = 'purge' AND key = ?",
			uri
		)?.cursor
		const boost = db.first<{ id: string; booster: string }>(
			`SELECT r.id, r.account_id AS booster FROM statuses r JOIN statuses o ON o.id = r.reblog_of_id
				JOIN local_accounts l ON l.account_id = r.account_id
			WHERE o.account_id = ? ORDER BY r.id = ? DESC, r.id LIMIT 1`,
			id,
			cursor ?? ''
		)
		if (boost === undefined) {
			return
		}
		if (cursor !== boost.id) {
			withdrawLocalBoost(db, boost.id, now)
			db.run("UPDATE inbound_jobs SET cursor = ? WHERE kind = 'purge' AND key = ?", boost.id, uri)
			budget.left--
		}
		if (!deleteStatusWithin(db, boost.id, budget)) {
			return
		}
		recountStatuses(db, boost.booster)
		db.run("UPDATE inbound_jobs SET cursor = NULL WHERE kind = 'purge' AND key = ?", uri)
	}
}

// Deletes a status's children within the budget, and the status itself once none remain (so nothing cascades).
// Returns whether the status is gone.
function deleteStatusWithin(db: Db, statusId: string, budget: Budget): boolean {
	const row = db.first<{ parent: string | null; original: string | null }>(
		'SELECT in_reply_to_id AS parent, reblog_of_id AS original FROM statuses WHERE id = ?',
		statusId
	)
	if (row === undefined) {
		return true
	}
	spend(
		db,
		budget,
		'DELETE FROM status_edits WHERE id IN (SELECT id FROM status_edits WHERE status_id = ? LIMIT ?)',
		statusId
	)
	// Local uploads are detached for the media sweep, which deletes their R2 objects; remote rows only name URLs.
	spend(
		db,
		budget,
		`UPDATE media_attachments SET status_id = NULL, position = 0, gc_at = ?1
		WHERE id IN (SELECT id FROM media_attachments WHERE status_id = ?2 AND file_token IS NOT NULL LIMIT ?3)`,
		new Date(0).toISOString(),
		statusId
	)
	spend(
		db,
		budget,
		'DELETE FROM media_attachments WHERE id IN (SELECT id FROM media_attachments WHERE status_id = ? AND file_token IS NULL LIMIT ?)',
		statusId
	)
	spend(
		db,
		budget,
		`DELETE FROM status_mentions WHERE status_id = ?1
			AND account_id IN (SELECT account_id FROM status_mentions WHERE status_id = ?1 LIMIT ?2)`,
		statusId
	)
	spend(
		db,
		budget,
		'DELETE FROM status_tags WHERE status_id = ?1 AND name IN (SELECT name FROM status_tags WHERE status_id = ?1 LIMIT ?2)',
		statusId
	)
	spend(
		db,
		budget,
		'DELETE FROM favourites WHERE id IN (SELECT id FROM favourites WHERE status_id = ? LIMIT ?)',
		statusId
	)
	spend(
		db,
		budget,
		'DELETE FROM bookmarks WHERE id IN (SELECT id FROM bookmarks WHERE status_id = ? LIMIT ?)',
		statusId
	)
	spend(
		db,
		budget,
		'DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE status_id = ? LIMIT ?)',
		statusId
	)
	spend(
		db,
		budget,
		`DELETE FROM outbound_receipts WHERE status_id = ?1
			AND inbox_url IN (SELECT inbox_url FROM outbound_receipts WHERE status_id = ?1 LIMIT ?2)`,
		statusId
	)
	spend(
		db,
		budget,
		'UPDATE statuses SET in_reply_to_id = NULL WHERE id IN (SELECT id FROM statuses WHERE in_reply_to_id = ? LIMIT ?)',
		statusId
	)
	const children = db.first(
		`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM status_edits WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM media_attachments WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM status_mentions WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM status_tags WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM favourites WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM bookmarks WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM notifications WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM outbound_receipts WHERE status_id = ?1)
			OR EXISTS (SELECT 1 FROM statuses WHERE in_reply_to_id = ?1 OR reblog_of_id = ?1)`,
		statusId
	)
	if (children !== undefined || budget.left <= 0) {
		return false
	}
	db.run('DELETE FROM statuses WHERE id = ?', statusId)
	budget.left--
	recountStatus(db, row.parent)
	recountStatus(db, row.original)
	return true
}

function accountHasRows(db: Db, id: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM statuses WHERE account_id = ?1)
				OR EXISTS (SELECT 1 FROM favourites WHERE account_id = ?1)
				OR EXISTS (SELECT 1 FROM follows WHERE account_id = ?1 OR target_account_id = ?1)
				OR EXISTS (SELECT 1 FROM blocks WHERE account_id = ?1 OR target_account_id = ?1)
				OR EXISTS (SELECT 1 FROM mutes WHERE target_account_id = ?1)
				OR EXISTS (SELECT 1 FROM list_accounts WHERE account_id = ?1)
				OR EXISTS (SELECT 1 FROM notifications WHERE from_account_id = ?1)
				OR EXISTS (SELECT 1 FROM status_mentions WHERE account_id = ?1)
				OR EXISTS (SELECT 1 FROM statuses WHERE in_reply_to_account_id = ?1)
				OR EXISTS (SELECT 1 FROM media_attachments WHERE account_id = ?1)
				OR EXISTS (SELECT 1 FROM remote_keys WHERE account_id = ?1)
				OR EXISTS (SELECT 1 FROM inbound_jobs WHERE target_account_id = ?1)`,
			id
		) !== undefined
	)
}

// A Delete of something other than the actor. Deleting a stored remote status is B1b-2; here the retraction is
// recorded so that the object cannot appear afterwards (ID-7), whether or not it was seen before.
const deleteObject: Handler<'Delete'> = (db, actor, activity, { now }) => {
	if (originOf(activity.object) !== originOf(actor.uri)) {
		return ignored('foreign-object')
	}
	retract(db, actor.uri, activity.object, now)
	return applied('retraction-recorded')
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
}

export const receiveActivity = writeOperation<ReceiveInput, ReceiveResult>((db, input) => {
	const before = deliverySequence(db)
	const result = receive(db, input)
	return { ...result, delivers: deliverySequence(db) > before }
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
			VALUES ('purge', ?1, ?1, ?2, ?3, ?2) ON CONFLICT DO NOTHING`,
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
		const before = deliverySequence(db)
		sweep(db, now)
		for (let batch = 0; batch < JOB_BATCHES_PER_RUN; batch++) {
			const job = db.first<{ kind: 'purge' | 'move'; key: string }>(
				'SELECT kind, key FROM inbound_jobs WHERE done_at IS NULL ORDER BY created_at, kind, key LIMIT 1'
			)
			if (job === undefined) {
				break
			}
			if (job.kind === 'purge') {
				purgeBatch(db, job.key, now)
			} else {
				moveBatch(db, job.key, now)
			}
		}
		return {
			pending: db.first('SELECT 1 AS x FROM inbound_jobs WHERE done_at IS NULL') !== undefined,
			delivers: deliverySequence(db) > before,
		}
	}
)

// Whether a personal inbox path names a local account with its exact stored username.
export const inboxOwnerExists = readOperation<{ username: string }, boolean>(
	(db, { username }) =>
		db.first(
			'SELECT 1 AS x FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.domain IS NULL AND a.username = ?',
			username
		) !== undefined
)
