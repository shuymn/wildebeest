import { recordOutbound } from './activities'
import { insertWithFreshId, remoteId } from './ids'
import { notify } from './notifications'
import { readOperation, writeOperation } from './operation'
import { accountSearchText } from './search-text'
import { recountStatus } from './statuses'
import type { Db } from '../db/sql'
import { sha256Hex } from '../platform/sha256'

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
export type ReceiveResult = { applied: boolean; reason: string; jobsPending: boolean }

function ignored(reason: string): ReceiveResult {
	return { applied: false, reason, jobsPending: false }
}

function applied(reason: string, jobsPending = false): ReceiveResult {
	return { applied: true, reason, jobsPending }
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

// Records that actorUri retracted targetUri. Only an id of the actor's own origin is recorded: another origin's
// activity could never be the actor's to retract.
export function retract(db: Db, actorUri: string, targetUri: string, now: number): void {
	if (originOf(targetUri) === null || originOf(targetUri) !== originOf(actorUri)) {
		return
	}
	const live =
		db.first<{ n: number }>(
			'SELECT count(*) AS n FROM inbound_retractions WHERE actor_uri = ? AND expires_at > ?',
			actorUri,
			now
		)?.n ?? 0
	if (live >= MAX_RETRACTIONS_PER_ACTOR && !isRetracted(db, actorUri, targetUri, now)) {
		return
	}
	db.run(
		`INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) VALUES (?, ?, ?)
		ON CONFLICT DO UPDATE SET expires_at = excluded.expires_at`,
		actorUri,
		targetUri,
		now + RETRACTION_TTL_MS
	)
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

const CONTEXT = 'https://www.w3.org/ns/activitystreams'

// Accept or Reject of a remote Follow, as an outbound intent for B2 (delivery is not done here). The id is derived
// from the Follow it answers, so the answers to two generations of a follow are two activities, and a replay of the
// same Follow names the same answer.
function recordFollowAnswer(
	db: Db,
	kind: 'Accept' | 'Reject',
	local: LocalRow,
	follower: RemoteRow,
	followUri: string,
	now: number
): void {
	const path = kind === 'Accept' ? 'accepts' : 'rejects'
	recordOutbound(
		db,
		local.id,
		{
			activity: {
				'@context': CONTEXT,
				id: `${local.uri}#${path}/follows/${sha256Hex(followUri)}`,
				type: kind,
				actor: local.uri,
				object: { id: followUri, type: 'Follow', actor: follower.uri, object: local.uri },
			},
			audience: { followers: false, accounts: [follower.id] },
		},
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
		// Refused with a Reject. The id is recorded as dead, so a replay sends no second Reject (ID-7).
		recordFollowAnswer(db, 'Reject', target, actor, activity.id, now)
		retract(db, actor.uri, activity.id, now)
		return applied('follow-rejected')
	}
	if (existing !== undefined && existing.uri === activity.id) {
		return ignored('duplicate')
	}
	if (existing !== undefined) {
		// A newer generation: the edge takes the new id, and the superseded one is recorded as dead, so a late Undo,
		// or a replay, of it changes nothing (ID-7). A pending request keeps waiting; an accepted follow is accepted
		// again under the new id (Mastodon's fast-forward: the follower lost track of our Accept).
		db.run('UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.id, existing.id)
		if (existing.uri !== null) {
			retract(db, actor.uri, existing.uri, now)
		}
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
// An id that names another generation of the edge (the edge has a different uri) answers nothing.
function ourFollow(db: Db, actor: RemoteRow, ref: ActivityRef): { id: string; follower: string } | 'not-target' | null {
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
	const edge = db.first<{ id: string }>(
		'SELECT CAST(id AS TEXT) AS id FROM follows WHERE account_id = ? AND target_account_id = ? AND uri IS NULL',
		follower.id,
		actor.id
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
	const edge = ourFollow(db, actor, activity.object)
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
// only Misskey's pair-shaped Follow id falls back to the actor's current follow of the embedded local target, and
// never when the id is one recorded as retracted or superseded.
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
	let undone = false
	if (ref.type === null || ref.type === 'Follow') {
		type Edge = { target: string; uri: string | null }
		let edge = db.first<Edge>(
			'SELECT target_account_id AS target, uri FROM follows WHERE account_id = ? AND uri = ?',
			actor.id,
			ref.id
		)
		const target = localAccount(db, ref.object)
		if (edge === undefined && ref.type === 'Follow' && target !== undefined && isMisskeyPairId(ref.id)) {
			edge = db.first<Edge>(
				'SELECT target_account_id AS target, uri FROM follows WHERE account_id = ? AND target_account_id = ?',
				actor.id,
				target.id
			)
		}
		if (edge !== undefined) {
			undone = removeFollow(db, actor.id, edge.target)
			// The removed generation is dead too, whichever id named it.
			if (edge.uri !== null) {
				retract(db, actor.uri, edge.uri, now)
			}
			recountLocal(db, [edge.target])
		}
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
	retract(db, actor.uri, ref.id, now)
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
	if (followUri != null) {
		retract(db, actor.uri, followUri, now)
	}
	removeFollow(db, actor.id, target.id)
	// TODO(B2): Mastodon's UnfollowService also sends an Undo of the local follow; local unfollows do not federate yet.
	removeFollow(db, target.id, actor.id)
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
			: db.first<{ id: string; local: number; locked: number }>(
					'SELECT id, domain IS NULL AS local, locked FROM accounts WHERE id = ?',
					job.target_account_id
				)
	if (job === undefined || source === undefined || target === undefined) {
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
		// TODO(B2): an Undo of the old follow, and a Follow of a remote target, once local follows federate.
		removeFollow(db, follower.id, source.id)
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
		const inserted = db.run(
			`INSERT INTO follows (account_id, target_account_id, state, show_reblogs, notify, languages, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			follower.id,
			target.id,
			state,
			follower.show_reblogs,
			follower.notify,
			follower.languages,
			new Date(now).toISOString()
		)
		if (inserted > 0 && target.local === 1) {
			const type = state === 'accepted' ? 'follow' : 'follow_request'
			notify(db, { recipientId: target.id, type, fromId: follower.id, statusId: null, now })
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
// written with the first batch, relationships and notifications go at once, and statuses and favourites go
// PURGE_BATCH at a time; the account row goes with the last batch.
const deleteActor: Handler<'DeleteActor'> = (db, actor, _activity, { now }) => {
	const job = db.first<{ done_at: number | null }>(
		"SELECT done_at FROM inbound_jobs WHERE kind = 'purge' AND key = ?",
		actor.uri
	)
	if (job === undefined) {
		db.run(
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?, ?, ?)",
			actor.uri,
			actor.uri,
			now
		)
		const locals = db
			.all<{ id: string }>(
				`SELECT target_account_id AS id FROM follows WHERE account_id = ?1
				UNION SELECT account_id FROM follows WHERE target_account_id = ?1`,
				actor.id
			)
			.map((row) => row.id)
		db.run('DELETE FROM follows WHERE account_id = ?1 OR target_account_id = ?1', actor.id)
		db.run('DELETE FROM blocks WHERE account_id = ?1 OR target_account_id = ?1', actor.id)
		db.run('DELETE FROM mutes WHERE target_account_id = ?', actor.id)
		db.run('DELETE FROM list_accounts WHERE account_id = ?', actor.id)
		db.run('DELETE FROM notifications WHERE from_account_id = ?', actor.id)
		recountLocal(db, locals)
	}
	return applied('actor-deleted', purgeBatch(db, actor.uri, now))
}

// Deletes one batch of the deleted actor's statuses and favourites, recounting what they counted on. Returns whether
// anything remains; when nothing does, the account row goes and the job is done.
function purgeBatch(db: Db, uri: string, now: number): boolean {
	const account = remoteAccount(db, uri)
	if (account === undefined) {
		finishJob(db, 'purge', uri, now)
		return false
	}
	const statuses = db.all<{ id: string; parent: string | null; original: string | null }>(
		`SELECT id, in_reply_to_id AS parent, reblog_of_id AS original FROM statuses WHERE account_id = ?
		ORDER BY id LIMIT ?`,
		account.id,
		PURGE_BATCH
	)
	const favourites = db.all<{ id: string; status: string }>(
		'SELECT CAST(id AS TEXT) AS id, status_id AS status FROM favourites WHERE account_id = ? ORDER BY id LIMIT ?',
		account.id,
		PURGE_BATCH
	)
	db.run(
		'DELETE FROM favourites WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))',
		JSON.stringify(favourites.map((f) => f.id))
	)
	db.run('DELETE FROM statuses WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(statuses.map((s) => s.id)))
	const touched = new Set([
		...statuses.flatMap((s) => [s.parent, s.original]).filter((id) => id !== null),
		...favourites.map((f) => f.status),
	])
	for (const id of touched) {
		recountStatus(db, id)
	}
	const remaining = db.first(
		`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM statuses WHERE account_id = ?1)
			OR EXISTS (SELECT 1 FROM favourites WHERE account_id = ?1)`,
		account.id
	)
	if (remaining !== undefined) {
		return true
	}
	db.run('DELETE FROM accounts WHERE id = ? AND domain IS NOT NULL', account.id)
	finishJob(db, 'purge', uri, now)
	return false
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
	if (actor === undefined) {
		return ignored('unknown-actor')
	}
	const handler = HANDLERS[activity.type] as Handler<typeof activity.type>
	return handler(db, actor, activity as never, input)
})

function pendingPurge(db: Db, uri: string): boolean {
	return (
		db.first("SELECT 1 AS x FROM inbound_jobs WHERE kind = 'purge' AND key = ? AND done_at IS NULL", uri) !== undefined
	)
}

// One round of pending jobs, oldest first, at most JOB_BATCHES_PER_RUN batches in all (the Queue and cron call it). Returns
// whether any job still has batches left.
export const runInboundJobs = writeOperation<{ now: number }, { pending: boolean }>((db, { now }) => {
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
	return { pending: db.first('SELECT 1 AS x FROM inbound_jobs WHERE done_at IS NULL') !== undefined }
})

// Whether a personal inbox path names a local account with its exact stored username.
export const inboxOwnerExists = readOperation<{ username: string }, boolean>(
	(db, { username }) =>
		db.first(
			'SELECT 1 AS x FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.domain IS NULL AND a.username = ?',
			username
		) !== undefined
)
