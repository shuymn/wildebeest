import { recordOutbound } from './activities'
import { insertWithFreshId, remoteId } from './ids'
import { notify } from './notifications'
import { readOperation, writeOperation } from './operation'
import { accountSearchText } from './search-text'
import { recountStatus } from './statuses'
import type { Db } from '../db/sql'

// Inbound activities about actors and relationships (B1b-1), applied in one Store transaction each. The Worker has
// already verified the HTTP signature, bound the signer to the actor (ID-1), fetched and sanitized what it needed
// (HTML-1, HTML-3) and checked the shape of the activity; here the authorization table (ID-6) is applied against the
// stored state, and every effect is keyed so that a replay changes nothing twice (ID-7).
//
// ID-6, Mastodon 4.7.3's rules for the types handled here (one negative test each in test/inbox.test.ts):
//   Follow       the object is a local account (exact actor URI); the actor is the follower
//   Accept       the actor is the target of our matching Follow (by its id, or the embedded Follow's object)
//   Reject       as Accept
//   Undo         the undone activity's actor is the actor (embedded actor, or the stored edge's follower/blocker)
//   Block        the object is a local account; the actor is the blocker
//   Move         the object is the actor, and the target lists the actor in alsoKnownAs (ID-4)
//   Update       of an actor: the object is the actor itself
//   Delete       of an actor: the object is the actor itself; of anything else: recorded as a retraction (ID-7)
// The activity id has the actor's origin (checked by the Worker before anything is written, and again here).
// ID-3: no inbound activity changes a local account's own row or a local status; local follows change only as the
// relationship the remote side controls (its follow of us, our pending follow of it).

// A retraction (Undo or Delete) is kept this long; an activity it names that arrives later is ignored (ID-7).
export const RETRACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000
// At most this many live retractions per actor (RES-4): a remote can name any number of ids of its own origin.
export const MAX_RETRACTIONS_PER_ACTOR = 10_000
// Expired retractions removed per inbound activity (RES-4), so the sweep stays bounded and keeps up with the writes.
export const RETRACTION_SWEEP = 100
// A stored actor document is trusted for key ownership this long; after that the Worker fetches it again.
export const ACTOR_REFRESH_MS = 24 * 60 * 60 * 1000
// Bounds of one Move (RES-6): local followers moved, and local blocks and mutes carried over to the target.
export const MOVE_MAX_FOLLOWERS = 100
export const MOVE_MAX_CARRIED = 100
// Statuses and favourites of a deleted actor removed per call (RES-6); the rest is purged by later calls.
export const PURGE_BATCH = 500

// A remote actor as the Worker extracted it from a fetched, origin-checked document (ID-2). Text is bounded,
// display_name is plain text, note is sanitized HTML (HTML-1) and URLs are http(s) or null (HTML-3).
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
	// The document as received; keys, followers, alsoKnownAs and fields are read from it.
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

export type ReceiveResult = { applied: boolean; reason: string; purgeRemaining: boolean }

function ignored(reason: string): ReceiveResult {
	return { applied: false, reason, purgeRemaining: false }
}

function applied(reason: string, purgeRemaining = false): ReceiveResult {
	return { applied: true, reason, purgeRemaining }
}

function originOf(uri: string): string | null {
	try {
		return new URL(uri).origin
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Remote actors
// ---------------------------------------------------------------------------------------------------------------

type RemoteRow = { id: string; uri: string; domain: string; fetched_at: string | null }

function remoteAccount(db: Db, uri: string): RemoteRow | undefined {
	return db.first<RemoteRow>(
		'SELECT id, uri, domain, fetched_at FROM accounts WHERE uri = ? AND domain IS NOT NULL',
		uri
	)
}

// Inserts or refreshes a remote account from its document. Never touches a local row (ID-3): a URI on this
// instance's origin, or one a local account holds, is refused.
export function upsertRemoteActor(db: Db, actor: RemoteActorInput, origin: string, now: number): RemoteRow | undefined {
	if (
		originOf(actor.uri) === origin ||
		db.first('SELECT 1 AS x FROM accounts WHERE uri = ? AND domain IS NULL', actor.uri)
	) {
		return undefined
	}
	const fetchedAt = new Date(now).toISOString()
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
		fetchedAt,
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
	return remoteAccount(db, actor.uri)
}

export type StoredRemoteKey = { owner: string; pem: string; fresh: boolean }

// The public key a stored remote actor document lists under keyId, for signature verification without a fetch (and
// for a Delete of an actor whose documents are gone). Only documents fetched and origin-checked are stored, so the
// owner is the account that listed the key.
export const getRemoteKey = readOperation<{ keyId: string; now: number }, StoredRemoteKey | null>(
	(db, { keyId, now }) => {
		let ownerUri: string
		try {
			const url = new URL(keyId)
			url.hash = ''
			ownerUri = url.href
		} catch {
			return null
		}
		const row = db.first<{ uri: string; raw: string | null; fetched_at: string | null }>(
			'SELECT uri, raw, fetched_at FROM accounts WHERE uri = ? AND domain IS NOT NULL',
			ownerUri
		)
		if (row?.raw == null) {
			return null
		}
		const keys = (JSON.parse(row.raw) as { publicKey?: unknown }).publicKey
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			const { id, publicKeyPem } = (key ?? {}) as { id?: unknown; publicKeyPem?: unknown }
			if (id === keyId && typeof publicKeyPem === 'string') {
				const fetchedAt = row.fetched_at === null ? 0 : Date.parse(row.fetched_at)
				return { owner: row.uri, pem: publicKeyPem, fresh: now - fetchedAt < ACTOR_REFRESH_MS }
			}
		}
		return null
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
	if (live >= MAX_RETRACTIONS_PER_ACTOR) {
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

function sweepRetractions(db: Db, now: number): void {
	db.run(
		`DELETE FROM inbound_retractions WHERE (actor_uri, target_uri) IN
			(SELECT actor_uri, target_uri FROM inbound_retractions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
		now,
		RETRACTION_SWEEP
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

const CONTEXT = 'https://www.w3.org/ns/activitystreams'

// Accept or Reject of a remote Follow, as an outbound intent for B2 (delivery is not done here). Mastodon's ids:
// <actor>#accepts/follows/<follow id> and <actor>#rejects/follows/<follow id>.
function recordFollowAnswer(
	db: Db,
	kind: 'Accept' | 'Reject',
	local: LocalRow,
	follower: RemoteRow,
	followUri: string,
	edgeId: string,
	now: number
): void {
	const path = kind === 'Accept' ? 'accepts' : 'rejects'
	recordOutbound(
		db,
		local.id,
		{
			activity: {
				'@context': CONTEXT,
				id: `${local.uri}#${path}/follows/${edgeId}`,
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
	const existing = db.first<{ id: string; state: string; uri: string | null }>(
		'SELECT CAST(id AS TEXT) AS id, state, uri FROM follows WHERE account_id = ? AND target_account_id = ?',
		actor.id,
		target.id
	)
	if (existing?.state === 'pending') {
		// A repeated request keeps the latest id, so the eventual Accept names it.
		db.run('UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.id, existing.id)
		return existing.uri === activity.id ? ignored('duplicate') : applied('follow-request-updated')
	}
	const blocked = db.first(
		`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM blocks WHERE account_id = ?1 AND target_account_id = ?2)
			OR EXISTS (SELECT 1 FROM domain_blocks WHERE account_id = ?1 AND domain = ?3)`,
		target.id,
		actor.id,
		actor.domain
	)
	if (blocked !== undefined) {
		// Refused with a Reject. The id is recorded as dead, so a replay sends no second Reject (ID-7).
		recordFollowAnswer(db, 'Reject', target, actor, activity.id, `r${now}`, now)
		retract(db, actor.uri, activity.id, now)
		return applied('follow-rejected')
	}
	if (existing !== undefined) {
		if (existing.uri === activity.id) {
			return ignored('duplicate')
		}
		// Mastodon's fast-forward: the follower lost track of our Accept, so it is sent again under the new id. The
		// superseded id is recorded as dead, so replaying it later sends nothing (ID-7).
		db.run('UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.id, existing.id)
		if (existing.uri !== null) {
			retract(db, actor.uri, existing.uri, now)
		}
		recordFollowAnswer(db, 'Accept', target, actor, activity.id, existing.id, now)
		return applied('follow-reaccepted')
	}
	const state = target.locked === 1 ? 'pending' : 'accepted'
	const edge = db.first<{ id: string }>(
		`INSERT INTO follows (account_id, target_account_id, state, uri, created_at) VALUES (?, ?, ?, ?, ?)
		RETURNING CAST(id AS TEXT) AS id`,
		actor.id,
		target.id,
		state,
		activity.id,
		new Date(now).toISOString()
	)
	if (state === 'accepted' && edge !== undefined) {
		recordFollowAnswer(db, 'Accept', target, actor, activity.id, edge.id, now)
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

// Our follow of `actor` that an Accept or Reject names: by the Follow's id with the actor as its target, or by the
// embedded Follow, whose object must be the actor (ID-6: only the followed side answers).
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
		'SELECT CAST(id AS TEXT) AS id FROM follows WHERE account_id = ? AND target_account_id = ?',
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

const undo: Handler<'Undo'> = (db, actor, activity, { now }) => {
	const ref = activity.object
	// ID-6: only the actor of the undone activity may undo it.
	if (ref.actor !== null && ref.actor !== actor.uri) {
		return ignored('not-own')
	}
	if (ref.id !== null && originOf(ref.id) !== originOf(actor.uri)) {
		return ignored('foreign-object')
	}
	const target = localAccount(db, ref.object)
	let undone = false
	if (ref.type === null || ref.type === 'Follow') {
		const edge =
			(ref.id === null
				? undefined
				: db.first<{ target: string }>(
						'SELECT target_account_id AS target FROM follows WHERE account_id = ? AND uri = ?',
						actor.id,
						ref.id
					)) ??
			(ref.type === 'Follow' && target !== undefined
				? db.first<{ target: string }>(
						'SELECT target_account_id AS target FROM follows WHERE account_id = ? AND target_account_id = ?',
						actor.id,
						target.id
					)
				: undefined)
		if (edge !== undefined) {
			undone = removeFollow(db, actor.id, edge.target)
			recountLocal(db, [edge.target])
		}
	}
	if (!undone && (ref.type === null || ref.type === 'Block')) {
		const block =
			(ref.id === null
				? undefined
				: db.first<{ id: string }>(
						'SELECT CAST(id AS TEXT) AS id FROM blocks WHERE account_id = ? AND uri = ?',
						actor.id,
						ref.id
					)) ??
			(ref.type === 'Block' && target !== undefined
				? db.first<{ id: string }>(
						'SELECT CAST(id AS TEXT) AS id FROM blocks WHERE account_id = ? AND target_account_id = ?',
						actor.id,
						target.id
					)
				: undefined)
		if (block !== undefined) {
			undone = db.run('DELETE FROM blocks WHERE id = CAST(? AS INTEGER)', block.id) > 0
		}
	}
	// Recorded whether or not the target was found: an Undo that overtook its activity keeps it from applying later,
	// and a replay of an undone activity does not restore it (ID-7). Likes and Announces (B1b-2) check it too.
	if (ref.id !== null) {
		retract(db, actor.uri, ref.id, now)
	}
	return undone ? applied('undone') : ref.id === null ? ignored('unknown-object') : applied('retraction-recorded')
}

// Mastodon's ActivityPub::Activity::Block: both follows between the two end, then the block is recorded.
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

// Mastodon's ActivityPub::Activity::Move and MoveWorker, bounded: local followers of the actor follow the target
// instead (pending unless the target is an unlocked local account), and local blocks and mutes of the actor carry over.
const move: Handler<'Move'> = (db, actor, activity, input) => {
	const { now, origin } = input
	let target: { id: string; local: boolean; locked: boolean } | undefined
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
		target = { id: local.id, local: true, locked: local.locked === 1 }
	} else {
		const remote = upsertRemoteActor(db, activity.target, origin, now)
		if (remote === undefined) {
			return ignored('unknown-target')
		}
		target = { id: remote.id, local: false, locked: true }
	}
	if (target.id === actor.id) {
		return ignored('self-move')
	}
	const followers = db.all<{ id: string; show_reblogs: number; notify: number; languages: string | null }>(
		`SELECT f.account_id AS id, f.show_reblogs, f.notify, f.languages FROM follows f
		JOIN local_accounts l ON l.account_id = f.account_id
		WHERE f.target_account_id = ? AND f.state = 'accepted' ORDER BY f.id LIMIT ?`,
		actor.id,
		MOVE_MAX_FOLLOWERS
	)
	const changed: string[] = [target.id]
	for (const follower of followers) {
		changed.push(follower.id)
		// TODO(B2): an Undo of the old follow, and a Follow of a remote target, once local follows federate.
		removeFollow(db, follower.id, actor.id)
		if (follower.id === target.id) {
			continue
		}
		const barred = db.first(
			`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM blocks WHERE (account_id = ?1 AND target_account_id = ?2)
				OR (account_id = ?2 AND target_account_id = ?1))
				OR EXISTS (SELECT 1 FROM domain_blocks d JOIN accounts a ON a.id = ?2 WHERE d.account_id = ?1 AND d.domain = a.domain)`,
			follower.id,
			target.id
		)
		if (barred !== undefined) {
			continue
		}
		const state = target.local && !target.locked ? 'accepted' : 'pending'
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
		if (inserted > 0 && target.local) {
			const type = state === 'accepted' ? 'follow' : 'follow_request'
			notify(db, { recipientId: target.id, type, fromId: follower.id, statusId: null, now })
		}
	}
	db.run(
		`INSERT INTO blocks (account_id, target_account_id, created_at)
		SELECT b.account_id, ?2, ?3 FROM blocks b JOIN local_accounts l ON l.account_id = b.account_id
		WHERE b.target_account_id = ?1 AND b.account_id <> ?2 ORDER BY b.id LIMIT ?4
		ON CONFLICT DO NOTHING`,
		actor.id,
		target.id,
		new Date(now).toISOString(),
		MOVE_MAX_CARRIED
	)
	db.run(
		`INSERT INTO mutes (account_id, target_account_id, hide_notifications, created_at)
		SELECT m.account_id, ?2, m.hide_notifications, ?3 FROM mutes m
		WHERE m.target_account_id = ?1 AND m.account_id <> ?2 ORDER BY m.id LIMIT ?4
		ON CONFLICT DO NOTHING`,
		actor.id,
		target.id,
		new Date(now).toISOString(),
		MOVE_MAX_CARRIED
	)
	recountLocal(db, changed)
	return followers.length === 0 ? ignored('no-followers') : applied('moved')
}

// The actor document itself was stored before the handler ran (input.actor).
const updateActor: Handler<'UpdateActor'> = (_db, _actor, _activity, input) =>
	input.actor === null ? ignored('no-document') : applied('actor-updated')

// Mastodon's DeleteAccountService for a remote account, in bounded steps: relationships and notifications at once,
// then statuses and favourites PURGE_BATCH at a time; the account row goes with the last batch. The retraction keeps
// the actor from being stored again for 30 days (ID-7).
const deleteActor: Handler<'DeleteActor'> = (db, actor, _activity, { now }) => {
	retract(db, actor.uri, actor.uri, now)
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
	return applied('actor-deleted', purgeBatch(db, actor.id))
}

// Deletes one batch of the account's statuses and favourites, recounting what they counted on. Returns whether
// anything remains; when nothing does, the account row is deleted too.
function purgeBatch(db: Db, accountId: string): boolean {
	const statuses = db.all<{ id: string; parent: string | null; original: string | null }>(
		`SELECT id, in_reply_to_id AS parent, reblog_of_id AS original FROM statuses WHERE account_id = ?
		ORDER BY id LIMIT ?`,
		accountId,
		PURGE_BATCH
	)
	const favourites = db.all<{ id: string; status: string }>(
		'SELECT CAST(id AS TEXT) AS id, status_id AS status FROM favourites WHERE account_id = ? ORDER BY id LIMIT ?',
		accountId,
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
		accountId
	)
	if (remaining !== undefined) {
		return true
	}
	db.run('DELETE FROM accounts WHERE id = ? AND domain IS NOT NULL', accountId)
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
	sweepRetractions(db, now)
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
	// A deleted actor is not stored again while its retraction lasts.
	if (activity.type !== 'DeleteActor' && isRetracted(db, actorUri, actorUri, now)) {
		return ignored('actor-deleted')
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

// One more batch of a deleted actor's content (the Queue continues a purge the Delete could not finish).
export const purgeRemoteAccount = writeOperation<{ uri: string; now: number }, { remaining: boolean }>(
	(db, { uri, now }) => {
		const account = remoteAccount(db, uri)
		if (account === undefined || !isRetracted(db, uri, uri, now)) {
			return { remaining: false }
		}
		return { remaining: purgeBatch(db, account.id) }
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
