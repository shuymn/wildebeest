import { presentedRemoteFields } from './accounts'
import { followActivity, followAnswerActivity, followUri, recordOutbound, undoFollowActivity } from './activities'
import { type FetchSigner, fetchSignerOf, instanceDomainOf } from './actors'
import {
	activeMuteSql,
	availableLocalSql,
	availableSql,
	blockedSql,
	blocksSql,
	canView,
	deletingSql,
	domainCoveredSql,
	followableBySql,
	individuallySuspendedSql,
	isDistributable,
	isPublicCollection,
	MENTION_STATUS_COLUMNS,
	mentionStatusSql,
	type Visibility,
} from './audience'
import { type EmojiCandidate, emojiSnapshot } from './custom-emojis'
import { cancelFollowAnswers, followAnswersOf, stageRetraction } from './deliveries'
import { insertWithFreshId, NEW_GENERATION, remoteId } from './ids'
import { actorDomainBlocked, hostCovered, type PolicyTicket, ticketFor } from './instance-domain-blocks'
import { deleteCard } from './link-cards'
import { listsHolding } from './lists'
import { notify } from './notifications'
import { readOperation, writeOperation } from './operation'
import { deleteAccountVotes, deletePollVotes, hasPollVotes } from './polls'
import { pushSequence } from './push'
import {
	acceptOurQuote,
	answerQuoteRequest,
	continueRevocations,
	holdsLocalStamp,
	promoteQuote,
	type QuoteAnswerRef,
	quotesDue,
	quoteArrival,
	recheckStamp,
	rejectOurQuote,
	retireQuoteOf,
	revokeStamp,
	sweepQuoteRequests,
} from './quotes'
import {
	actorCollections,
	collectionOf,
	featureRemote,
	type FollowerSigner,
	localFollower,
	pinRemote,
	requestCollectionSync,
	unfeatureRemote,
	unpinRemote,
} from './remote-collections'
import { armRemoteFieldLinks, remoteLinkBack } from './remote-field-links'
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
import { fileRemoteReports } from './reports'
import { accountSearchText } from './search-text'
import { recountStatus, recountStatuses, withdrawLocalBoost } from './statuses'
import { streamDelete } from './streaming'
import { type ByIds, writeEach } from '../db/by-ids'
import {
	ACCOUNTS_URI_INDEX,
	FEATURED_TAGS_ACCOUNT_INDEX,
	FEATURED_TAGS_ID_INDEX,
	FILTER_STATUSES_ID_INDEX,
	MEDIA_ID_INDEX,
	QUOTES_STATUS_INDEX,
	STATUSES_ID_INDEX,
} from '../db/indexes'
import type { Db } from '../db/sql'
import { hostDomain } from '../platform/domain-name'
import { ACTIVITY_ID_LIMIT, withinIdentityBound } from '../platform/identity-bounds'
import { ACCOUNT_EMOJIS_BYTES, isoTimeSql, MOVED_TO_INDEX, nextDocumentRevisionSql } from '../platform/stored-bounds'

// Inbound activities about actors and relationships (B1b-1), applied in one Store transaction each. The Worker has
// already verified the HTTP signature, bound the signer to the actor (ID-1), fetched and sanitized what it needed
// (HTML-1, HTML-3) and checked the shape of the activity; here the authorization table (ID-6) is applied against the
// stored state, and every effect is keyed so that a replay changes nothing twice (ID-7).
//
// ID-6, Mastodon 4.7.3's rules for the types handled here (one negative test each in test/inbox.test.ts):
//   Follow       the object is a local account (exact actor URI); the actor is the follower; refused while either
//                side blocks the other
//   Accept       the actor is the target of our matching Follow (see ourFollow); of our QuoteRequest, the quoted
//                author of our pending quote, with a result on its origin (quotes.ts acceptOurQuote;
//                test/quote-authoring.test.ts)
//   Reject       as Accept (quotes.ts rejectOurQuote)
//   Undo         the undone activity's actor is the actor, and it names the current Follow or Block (see undo), a Like
//                its favourite tracks or a legacy favourite's status, or its boost (undoInteraction)
//   Block        the object is a local account; the actor is the blocker
//   Move         the object is the actor, and the target lists the actor in alsoKnownAs (ID-4)
//   Update       of an actor: the object is the actor itself; of a status: the stored status's author is the actor
//                (and a local status never is, ID-3)
//   Delete       of an actor: the object is the actor itself; of a status or boost: its author is the actor; of
//                anything else of the actor's origin: recorded as a retraction (ID-7); of a quote's stamp
//                (QuoteAuthorization): the quoted status's author is the actor, and only the quotes naming that stamp
//                and quoting the actor's statuses are revoked (quotes.ts revokeStamp; test/quotes.test.ts); a local
//                quote holding it is forwarded the Delete only when the actor's own proof verifies
//   Delete       relayed by another server (its HTTP signer is not the actor, ID-1's one exception): only of what is
//                neither an actor, a status nor a boost, so of a stamp at most; with the actor's own proof
//                (RsaSignature2017 or FEP-8b32, federation/author-proof.ts) applied as the actor's revocation, without
//                one only a reason to verify the accepted quote naming it again (relayedDelete; test/quotes.test.ts)
//   QuoteRequest the object is a local original of an available author, public or unlisted (else no answer); the
//                actor may quote it (R36, mayQuoteSql, else a Reject); the instrument is the actor's own status, on its
//                origin, and its stored quote names the object (else no answer); one answer per request id
//                (quotes.ts answerQuoteRequest; test/quote-requests.test.ts)
//   Create       the object has the actor's origin and names no other author (attributedTo)
//   Like         the object is a local status the actor may see (VIS-1); the actor is the one who likes it
//   Announce     the actor is the booster; the original is public, unlisted or the actor's own (VIS-6)
//   Add, Remove  the target is the actor's own featured or featuredTags collection, on its origin; a pinned status
//                is the actor's own (remote-collections.ts; test/remote-collections.test.ts)
//   Flag         the actor is the reporter; the reported accounts are local, or remote with a named status replying
//                to a local account, and available; the statuses are the reported accounts' own (reports.ts
//                fileRemoteReports; test/inbox-flag.test.ts)
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
// A stored remote account whose document was stored this long ago (accounts.fetched_at, inclusive) is fetched again
// before a status Kopje fetched by it is stored (staleAccount): Mastodon's Account::STALE_THRESHOLD and
// possibly_stale? (account.rb:71,254-256), a policy separate from KEY_REFRESH_MS.
export const ACCOUNT_STALE_MS = 24 * 60 * 60 * 1000
// A finished job, and with it a deleted actor's tombstone, is kept this long after it is done.
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// Bounds of one batch of a Move (RES-6): local followers moved, and local blocks and mutes carried over to the target.
export const MOVE_BATCH = 100
export const MOVE_MAX_CARRIED = 100
// Rows one batch of a deleted actor's purge, or of a deleted status's removal, writes at most (RES-6).
export const PURGE_BATCH = 500
// Job batches one runInboundJobs call does at most.
export const JOB_BATCHES_PER_RUN = 4
// Outstanding Like ids one remote favourite tracks at most (favourite_likes; its trigger favourite_likes_cap holds the
// bound for imports too, so a favourite's delete cascades at most this many rows, RES-6). A server that replaces a
// reaction (Undo of the old Like, then a new Like) has one outstanding once its deliveries settle; more are transient,
// while reordered changes are in flight. A Like past the cap is answered 503 with nothing written (the Undos it waits
// for free the room), unless a tracked id older than LIKE_RETIRE_AFTER_MS makes room.
export const MAX_TRACKED_LIKES = 4
// A tracked Like id this old exceeds the default Undo retry windows below: Mastodon retries a delivery 16 times with
// Sidekiq's (count^4 + 15) s backoff plus at most 50% jitter, about 3.1 days in all (ActivityPub::DeliveryWorker), and
// Misskey 12 times by default with 1 min to 8 h backoff plus at most 20% jitter, about 1.6 days (core/QueueService.ts,
// queue/QueueProcessorService.ts httpRelatedBackoff). At the cap, treat its Undo as lost: it is retired only to make
// room.
export const LIKE_RETIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

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
	// The actor's toot:indexable, true only when the document says so (ProcessAccountService: `@json['indexable']`).
	indexable: boolean
	inboxUrl: string | null
	sharedInboxUrl: string | null
	published: string | null
	keys: { id: string; pem: string }[]
	// Emoji tags as read (federation/remote-emoji.ts); the snapshot is chosen when the account is written.
	emojiTags: EmojiCandidate[]
	// The document as received; followers, alsoKnownAs and fields are read from it.
	raw: string
	// The actor id the document's movedTo names (Fedify's successorId), when Kopje stores such an id; else null.
	movedTo: string | null
	// The canonical domain of the actor's address for this username, set by the search resolver only after the actor's
	// host declared it and that domain confirmed it (declaredDomain in federation/resolve.ts); the host itself when
	// the host's own answer names it there. Never set from a document.
	confirmedDomain?: string
}

// The object of an Accept, Reject or Undo: an id, or an embedded activity (id optional; instrument: an inlined
// QuoteRequest's, by id).
export type ActivityRef = {
	id: string | null
	type: string | null
	actor: string | null
	object: string | null
	instrument?: string | null
}

export type InboundActivity =
	| { type: 'Follow'; id: string; object: string }
	// result: an Accept of a QuoteRequest's stamp (its first value, by id).
	| { type: 'Accept'; id: string; object: ActivityRef; result?: string | null }
	| { type: 'Reject'; id: string; object: ActivityRef }
	| { type: 'Undo'; id: string; object: ActivityRef }
	| { type: 'Block'; id: string; object: string }
	// target: the verified remote target (its alsoKnownAs was checked by the Worker) with the revision read before its
	// fetch (DocumentRevision), or a local actor URI.
	| {
			type: 'Move'
			id: string
			target: { document: RemoteActorInput; revision: DocumentRevision } | { local: string }
	  }
	| { type: 'UpdateActor'; id: string }
	| { type: 'DeleteActor'; id: string }
	// signed: the body carries an author proof the Worker has not verified; proven: the body as received, its proof
	// verified (federation/author-proof.ts), which the Store forwards for a local quote's stamp (quotes.ts revokeStamp).
	| { type: 'Delete'; id: string; object: string; signed?: boolean; proven?: Record<string, unknown> }
	// A Delete another server relayed (its HTTP signer is not the actor). proven: it carries the actor's own proof,
	// verified by the Worker (federation/author-proof.ts); body: then, the body as received.
	| { type: 'RelayedDelete'; id: string; object: string; proven: boolean; body?: Record<string, unknown> }
	// A request to quote a local status (FEP-044f): object the quoted status, instrument the quoting status, embedded
	// the instrument as the request inlined it.
	| { type: 'QuoteRequest'; id: string; object: string; instrument: string; embedded: RemoteStatusInput | null }
	| { type: 'Create'; id: string; object: RemoteStatusInput }
	| { type: 'UpdateStatus'; id: string; object: RemoteStatusInput }
	// A Like in any spelling federation/inbound.ts reads as one (LIKE_TYPES): a favourite of `object`.
	| { type: 'Like'; id: string; object: string }
	// A report of the accounts and statuses `objects` names (reports.ts fileRemoteReports), with its comment.
	| { type: 'Flag'; id: string; objects: string[]; content: string }
	// An Add or Remove of a status (by its id) or of a Hashtag (by its name) to or from the collection `target`.
	| { type: 'Add'; id: string; target: string; object: CollectionItem }
	| { type: 'Remove'; id: string; target: string; object: CollectionItem }
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

// What an Add or Remove names: a status by its id, or a Hashtag by its name.
export type CollectionItem = { status: string } | { hashtag: string }

// Documents the Worker fetched because the Store asked for them (ReceiveResult.need), by the uri asked for: a parsed
// status or actor, or null when it could not be fetched or used; 'gone': the actor's document answered 404 or 410.
// A refresh need's failure that may pass is null too (applyRefresh).
export type Prefetched = {
	statuses: Record<string, RemoteStatusInput | null>
	actors: Record<string, RemoteActorInput | null | 'gone'>
}

export type ReceiveInput = {
	now: number
	// This instance's origin: no URI of it is ever written as a remote actor (ID-3).
	origin: string
	actorUri: string
	// A fresh document of the actor to store, or null to use the stored row as it is.
	actor: RemoteActorInput | null
	// The actor's revision as the Worker read it before it fetched `actor` (inboxGate), the same in every round: the
	// document is stored only while it holds (upsertRemoteActor), so a later round never stores it again.
	actorRevision: DocumentRevision
	activity: InboundActivity
	// The username of the personal inbox the activity was delivered to (null: the shared inbox).
	recipient?: string | null
	prefetched?: Prefetched
}

// A document the Store needs to apply an activity. signer: whose key signs the fetch: a local follower of the status's
// author, a local account by username while it is available (a QuoteRequest's instrument, fetched as the quoted
// author), or 'instance' for the instance actor; absent, the inbox's own (the recipient's for a personal inbox).
// kind 'proof': verify the Delete's author proof before forwarding (quotes.ts revokeStamp); uri is the actor's.
// refresh (kind 'actor' only): the stale stored row is usable without this document, so a fetch that may pass does not
// fail the request (staleAccount, applyRefresh).
export type Need = {
	kind: 'status' | 'actor' | 'proof'
	uri: string
	signer?: FollowerSigner | { local: string } | 'instance'
	refresh?: true
}

// jobsPending: a purge, Move or status deletion has batches left; the Worker asks the Queue to continue (cron
// continues regardless). delivers: the activity recorded deliveries (an Accept, Reject, Follow or Undo) or pushes (a
// notification); the Worker rings the doorbell. need: the activity is not applied yet; the Store needs this document to
// apply it, and the Worker asks again with it in prefetched. What the round stored before it decided so (the actor's
// document or its routing, and their new revision) is committed.
export type ReceiveResult = {
	applied: boolean
	reason: string
	jobsPending: boolean
	delivers?: boolean
	need?: Need
	// Nothing changed, and the activity may apply later (its retraction could not be recorded): answered 503.
	retry?: boolean
}

// The signer a need's own designation names (fetchSignerOf's `by`): a local follower, a local account by username, or
// null for the instance actor.
export function designatedSigner(signer: NonNullable<Need['signer']>): string | FollowerSigner | null {
	return signer === 'instance' ? null : 'local' in signer ? signer.local : signer
}

// What receiveActivity answers: a need comes with its fetch's preparation (fetchPreparation).
export type ReceiveAnswer = Omit<ReceiveResult, 'need'> & { need?: Need & { prefetch: FetchPreparation | null } }

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

export function retryResult(error: RetryLater): ReceiveAnswer {
	return { applied: false, reason: error.reason, jobsPending: false, retry: true }
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

export type RemoteRow = { id: string; uri: string; domain: string }

// What upsertRemoteActor stored.
export type StoredActor = RemoteRow & { syncWaiting: boolean; frozen: boolean }

// ID-1's revision fence. accounts.document_revision changes with every store of a remote actor's document (its profile,
// keys, movedTo or routing), the Move handler's movedTo included (nextDocumentRevisionSql, migration 0073). A writer
// that fetches a document reads the revision first, in the Store, and passes it as its expectation: the stored
// revision, or null when no remote row of the uri was stored. Read before the fetch on purpose: it is no credential
// but the state the document must still find, so a document fetched before another store committed is never stored
// over it, however late it arrives. The comparison (revisionHolds), in the transaction that would store it:
//   expectation   row absent              row present with revision g
//   null          stored (a new row)      superseded, g = 0 included
//   n             superseded              stored only when n = g
//   (none)        stored                  stored
// A writer without one (none) stores what it fetched as Mastodon's ProcessAccountService does, the last to commit
// winning: an author stored only while absent or stale (boosts, quotes, applyRefresh). It still issues a new revision,
// so a fenced document fetched before it is superseded.
export type DocumentRevision = number | null

// The remote row of `uri` with its revision (the trigger of migration 0073 holds it to an integer), if any.
function storedRevision(db: Db, uri: string): { revision: number | null } | undefined {
	return db.first<{ revision: number | null }>(
		`SELECT CASE WHEN typeof(document_revision) = 'integer' THEN document_revision END AS revision
		FROM accounts INDEXED BY ${ACCOUNTS_URI_INDEX} WHERE uri = ? AND domain IS NOT NULL`,
		uri
	)
}

// The stored revision of the remote actor `uri`, or null when it has no remote row. A local row reads as null too: no
// document of it is ever stored (ID-3).
export function actorRevision(db: Db, uri: string): DocumentRevision {
	return storedRevision(db, uri)?.revision ?? null
}

// What a writer read before its fetch (federation/resolve.ts): the actor's revision (actorRevision).
export const getActorRevision = readOperation<{ uri: string }, DocumentRevision>((db, { uri }) =>
	actorRevision(db, uri)
)

// Whether a document of `uri` fetched under the expectation `expected` may be stored (the table at DocumentRevision).
function revisionHolds(db: Db, uri: string, expected: DocumentRevision | undefined): boolean {
	if (expected === undefined) {
		return true
	}
	const row = storedRevision(db, uri)
	return expected === null ? row === undefined : row !== undefined && row.revision === expected
}

// The stored remote account of `uri` (none for a local one), available or not.
export function remoteAccount(db: Db, uri: string): RemoteRow | undefined {
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

// R38 (Mastodon's set_immediate_protocol_attributes!): a verified document of an individually suspended account updates
// its inbox and shared inbox only, so that moderation's Rejects reach a current inbox. Its profile, keys and stored
// domain stay frozen; the values passed remote-actor.ts's checks as any refresh's. An account an instance domain block
// covers takes no refresh at all (its documents are not fetched).
// A change of the routing issues a new revision (DocumentRevision); the caller has compared the expectation first.
function refreshRouting(db: Db, accountId: string, actor: RemoteActorInput): void {
	db.run(
		`UPDATE accounts SET inbox_url = ?2, shared_inbox_url = ?3,
			document_revision = ${nextDocumentRevisionSql('document_revision')}
		WHERE id = ?1 AND ${individuallySuspendedSql('accounts')} AND (inbox_url IS NOT ?2 OR shared_inbox_url IS NOT ?3)
			AND NOT ${domainCoveredSql('accounts')}`,
		accountId,
		actor.inboxUrl,
		actor.sharedInboxUrl
	)
}

// The stored remote account of `uri` when it is unavailable (R1): the account the instance suspended (R38).
function unavailableRemote(db: Db, uri: string): RemoteRow | undefined {
	return db.first<RemoteRow>(
		`SELECT a.id, a.uri, a.domain FROM accounts a WHERE a.uri = ? AND a.domain IS NOT NULL AND NOT ${availableSql('a.id')}`,
		uri
	)
}

// Inserts or refreshes a remote account and its keys from its document. Never touches a local row (ID-3): a URI on
// this instance's origin, or one a local account holds, is refused, and so is a deleted actor. An unavailable account
// (R38, VIS-30) is never refreshed: its stored row is returned unchanged (frozen), but for a routing refresh
// (refreshRouting), as Mastodon leaves a suspended account's key and attributes as they were. No account is stored, and
// none moves, under an instance domain block: a document whose actor host or domain is covered stores nothing, and
// leaves a stored row unchanged (Mastodon's ProcessAccountService stores nothing on a blocked domain), so the set of
// accounts a block covers is fixed when it commits. A refresh stores only an account no block covers, by its stored
// keys or its new ones, so it clears a domain mark left from a lifted block (R38) in its own transaction: the mark
// never outlives the account's move to another domain. A document that names
// any of its collections asks for them to be read (remote-collections.ts, as ActivityPub::ProcessAccountService
// schedules its syncs each time it processes the account); syncWaiting: a request waits for a round.
// expected: the revision the writer read before it fetched the document (DocumentRevision). When it no longer holds,
// nothing of the document is stored, the routing of a frozen row included, and the answer is 'superseded': the caller
// decides what the stored row is worth to it. Every store issues a new revision.
export function upsertRemoteActor(db: Db, actor: RemoteActorInput, origin: string, now: number): StoredActor | undefined
export function upsertRemoteActor(
	db: Db,
	actor: RemoteActorInput,
	origin: string,
	now: number,
	expected: DocumentRevision
): StoredActor | 'superseded' | undefined
export function upsertRemoteActor(
	db: Db,
	actor: RemoteActorInput,
	origin: string,
	now: number,
	expected?: DocumentRevision
): StoredActor | 'superseded' | undefined {
	if (
		originOf(actor.uri) === origin ||
		db.first('SELECT 1 AS x FROM accounts WHERE uri = ? AND domain IS NULL', actor.uri) !== undefined ||
		isDeletedActor(db, actor.uri, now)
	) {
		return undefined
	}
	if (!revisionHolds(db, actor.uri, expected)) {
		return 'superseded'
	}
	const frozen = unavailableRemote(db, actor.uri)
	if (frozen !== undefined) {
		refreshRouting(db, frozen.id, actor)
		return { ...frozen, syncWaiting: false, frozen: true }
	}
	const published = actor.published === null ? NaN : Date.parse(actor.published)
	const createdAt = new Date(Number.isNaN(published) || published > now ? now : published).toISOString()
	const stored = db.first<{ domain: string; confirmed_username: string | null }>(
		'SELECT domain, confirmed_username FROM accounts WHERE uri = ? AND domain IS NOT NULL',
		actor.uri
	)
	const { domain, confirmedUsername } = accountDomain(stored, actor)
	if (hostCovered(db, hostDomain(actor.uri)) || hostCovered(db, domain)) {
		const row = remoteAccount(db, actor.uri)
		return row === undefined ? undefined : { ...row, syncWaiting: false, frozen: true }
	}
	// The snapshot of the emoji the stored name, bio and presented fields reference (custom-emojis.ts), replaced by
	// every refresh and Update(Person).
	const { fields, links } = presentedRemoteFields(db, actor.raw, domain)
	const emojis = emojiSnapshot(
		actor.emojiTags,
		[actor.displayName, actor.note, ...fields.flatMap((field) => [field.name, field.value])],
		ACCOUNT_EMOJIS_BYTES
	)
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
		actor.indexable ? 1 : 0,
		actor.inboxUrl,
		actor.sharedInboxUrl,
		actor.raw,
		new Date(now).toISOString(),
		accountSearchText(actor.username, domain, actor.displayName),
		createdAt,
		confirmedUsername,
		emojis,
	]
	insertWithFreshId(
		'accounts',
		() => remoteId(actor.published ?? '', now),
		(id) =>
			db.run(
				`INSERT INTO accounts (id, uri, username, domain, actor_type, display_name, note, url, avatar_url, header_url,
					locked, discoverable, indexable, inbox_url, shared_inbox_url, raw, fetched_at, search_text, created_at,
					confirmed_username, emojis, document_revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nextDocumentRevisionSql('NULL')})
				ON CONFLICT (uri) DO UPDATE SET username = excluded.username,
					document_revision = ${nextDocumentRevisionSql('accounts.document_revision')}, actor_type = excluded.actor_type,
					display_name = excluded.display_name, note = excluded.note, url = excluded.url,
					avatar_url = excluded.avatar_url, header_url = excluded.header_url, locked = excluded.locked,
					discoverable = excluded.discoverable, indexable = excluded.indexable, inbox_url = excluded.inbox_url,
					shared_inbox_url = excluded.shared_inbox_url, raw = excluded.raw, fetched_at = excluded.fetched_at,
					search_text = excluded.search_text, domain = excluded.domain,
					confirmed_username = excluded.confirmed_username, emojis = excluded.emojis,
					suspended_at = CASE WHEN accounts.suspension_source = 'domain' THEN NULL ELSE accounts.suspended_at END,
					suspension_source = CASE WHEN accounts.suspension_source = 'domain' THEN NULL
						ELSE accounts.suspension_source END
				WHERE accounts.domain IS NOT NULL`,
				id,
				...values
			)
	)
	const row = remoteAccount(db, actor.uri)
	if (row !== undefined) {
		// The account's move as its document states it, set or cleared by every store (Mastodon's
		// ProcessAccountService: process_account_service.rb:166), written once the row is stored, by its id: an account
		// other than itself, stored and not being purged, by its actor id; one Kopje does not know reads as none, as it is
		// not fetched (process_account_service.rb:310-314 fetches it).
		db.run(
			`UPDATE accounts SET moved_to_account_id = (SELECT m.id FROM accounts m INDEXED BY ${ACCOUNTS_URI_INDEX}
				WHERE m.uri = ?2 AND m.id <> ?1 AND NOT ${deletingSql('m')})
			WHERE id = ?1 AND domain IS NOT NULL`,
			row.id,
			actor.movedTo
		)
		// The links of its fields to verify, from the same projection (remote-field-links.ts).
		armRemoteFieldLinks(db, row.id, remoteLinkBack(actor.uri, actor.url), links, now)
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
	if (row === undefined) {
		return undefined
	}
	const collections = actorCollections(actor.raw)
	const named = Object.values(collections).some((url) => url !== null)
	return { ...row, syncWaiting: named && requestCollectionSync(db, row.id, now), frozen: false }
}

// Whether the remote account `id` is fetched again before a status Kopje fetched by it is stored (ACCOUNT_STALE_MS,
// Mastodon's possibly_stale?): a remote row that is available (R38, VIS-30: never refetched) and whose fetched_at is
// ACCOUNT_STALE_MS old or older, or not a stored time (NULL, or an imported value isoTimeSql does not read).
export function staleAccount(db: Db, id: string, now: number): boolean {
	return (
		db.first(
			`SELECT 1 AS x FROM accounts a
			WHERE a.id = ?1 AND a.domain IS NOT NULL AND ${availableSql('a.id')}
				AND COALESCE(${isoTimeSql('a.fetched_at')} <= ?2, 1)`,
			id,
			new Date(now - ACCOUNT_STALE_MS).toISOString()
		) !== undefined
	)
}

// The outcome of refetching a stale stored author (staleAccount), applied in the transaction that stores its status.
// Applied only while the row is still stale, so the first outcome to commit wins and a delayed older document never
// replaces a newer one: a row refreshed, stamped or made unavailable meanwhile is kept as it is ('current').
// While it is stale:
//   - a usable document of this actor (ok) is stored (upsertRemoteActor): 'refreshed', frozen if it stored nothing;
//   - 'gone' (404 or 410) writes nothing, and nothing is stored under the account ('refused'), as for an author that
//     cannot be fetched;
//   - any other failure (null: unusable, another id, or one that may pass, budget and deadline included) stamps
//     fetched_at only ('stamped'): the stored row is used, and refetched a day later. remote_keys are not touched,
//     so key trust (ID-1) is not extended.
// Limitation: a 'gone' that commits after another request's stamp finds the row fresh and is not applied.
export function applyRefresh(
	db: Db,
	author: RemoteRow,
	document: RemoteActorInput | null | 'gone',
	origin: string,
	now: number
): { kind: 'current' | 'refreshed' | 'stamped'; author: RemoteRow; frozen: boolean } | { kind: 'refused' } {
	if (!staleAccount(db, author.id, now)) {
		return { kind: 'current', author: remoteAccount(db, author.uri) ?? author, frozen: false }
	}
	if (document === 'gone') {
		return { kind: 'refused' }
	}
	if (document === null || document.uri !== author.uri) {
		db.run(
			'UPDATE accounts SET fetched_at = ?2 WHERE id = ?1 AND domain IS NOT NULL',
			author.id,
			new Date(now).toISOString()
		)
		return { kind: 'stamped', author, frozen: false }
	}
	// Unfenced: applied only while the row is stale, which any store since the need was decided ends (fetched_at).
	const stored = upsertRemoteActor(db, document, origin, now)
	return stored === undefined ? { kind: 'refused' } : { kind: 'refreshed', author: stored, frozen: stored.frozen }
}

export type StoredRemoteKey = { owner: string; pem: string; fresh: boolean }

// A stored key as the inbox gate returns it: fetchedAt is judged when the key is looked up (keyFresh), null when the
// stored time is not a number (an imported row).
export type GateKey = { owner: string; pem: string; fetchedAt: number | null }

// ID-1: a key listed within the last 24 hours.
export function keyFresh(fetchedAt: number | null, now: number): boolean {
	return fetchedAt !== null && now - fetchedAt < KEY_REFRESH_MS
}

function remoteKeyOf(db: Db, keyId: string): GateKey | null {
	const row = db.first<{ owner: string; pem: string; fetched_at: number | null }>(
		`SELECT a.uri AS owner, k.pem,
			CASE WHEN typeof(k.fetched_at) IN ('integer', 'real') THEN k.fetched_at END AS fetched_at
		FROM remote_keys k JOIN accounts a ON a.id = k.account_id
		WHERE k.key_id = ? AND a.domain IS NOT NULL`,
		keyId
	)
	return row === undefined ? null : { owner: row.owner, pem: row.pem, fetchedAt: row.fetched_at }
}

// A key by its id, as a verified actor document listed it, with its owner (ID-1). fresh: listed within the last 24 hours.
export const getRemoteKey = readOperation<{ keyId: string; now: number }, StoredRemoteKey | null>(
	(db, { keyId, now }) => {
		const key = remoteKeyOf(db, keyId)
		return key === null ? null : { owner: key.owner, pem: key.pem, fresh: keyFresh(key.fetchedAt, now) }
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
	sweepQuoteRequests(db, now)
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

// What the Store's RPC adds to a receive (store.ts): its own clock, which ages tracked Like ids (LIKE_RETIRE_AFTER_MS),
// whatever the Worker's clock (`now`) says or however late the call comes.
export type StoreReceiveInput = ReceiveInput & { storeNow: number }

type Handler<T extends InboundActivity['type']> = (
	db: Db,
	actor: RemoteRow,
	activity: Extract<InboundActivity, { type: T }>,
	input: StoreReceiveInput
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
	// Every Follow stored from here on defines the pair's next state (its own answer, or the owner's decision on a
	// request), so the pair's answers that are not leased, and the unexpanded ones, are cancelled and a leased one is
	// superseded (cancelFollowAnswers in deliveries.ts) once nothing below can bail out, in this transaction. Over the
	// bound (RES-6): 503, nothing written.
	const answers = followAnswersOf(db, target.id, actor.id)
	if (answers === null) {
		return retryLater('follow-answer-backlog')
	}
	if (existing !== undefined) {
		// A newer generation: the edge takes the new id, and the superseded one is recorded as dead, so a late Undo,
		// or a replay, of it changes nothing (ID-7). A pending request keeps waiting; an accepted follow is accepted
		// again under the new id (Mastodon's fast-forward: the follower lost track of our Accept).
		// Checked before the cancellation, so a Follow ignored at the cap cancels nothing; then it is recorded.
		if (existing.uri !== null && !isMisskeyPairId(existing.uri) && !canRetract(db, actor.uri, [existing.uri], now)) {
			return ignored('retraction-cap')
		}
		cancelFollowAnswers(db, answers, now)
		if (existing.uri !== null) {
			retractFollow(db, actor.uri, existing.uri, now)
		}
		db.run('UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)', activity.id, existing.id)
		if (existing.state === 'pending') {
			return applied('follow-request-updated')
		}
		recordFollowAnswer(db, 'Accept', target, actor, activity.id, now)
		return applied('follow-reaccepted')
	}
	cancelFollowAnswers(db, answers, now)
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

const accept: Handler<'Accept'> = (db, actor, activity, { now }) => {
	if (isQuoteAnswer(activity.object)) {
		return acceptOurQuote(db, actor, quoteAnswerRef(activity.object), activity.result ?? null, now)
			? applied('quote-accepted')
			: ignored('quote-unchanged')
	}
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

// Mastodon's Reject removes our Follow, including an accepted one; quote handling: quotes.ts rejectOurQuote.
const reject: Handler<'Reject'> = (db, actor, activity, { now }) => {
	if (isQuoteAnswer(activity.object)) {
		return rejectOurQuote(db, actor, quoteAnswerRef(activity.object), now)
			? applied('quote-rejected')
			: ignored('quote-unchanged')
	}
	const edge = ourFollow(db, actor, activity.object, true)
	if (edge === null || edge === 'not-target') {
		return ignored(edge ?? 'unknown-follow')
	}
	db.run('DELETE FROM follows WHERE id = CAST(? AS INTEGER)', edge.id)
	recountLocal(db, [edge.follower])
	return applied('follow-rejected')
}

// An answer to our QuoteRequest: an inlined QuoteRequest, or its id (the quoting status's uri with #quote-request,
// activities.ts quoteRequestUri), which no Follow of ours carries.
function isQuoteAnswer(ref: ActivityRef): boolean {
	return ref.type === 'QuoteRequest' || (ref.type === null && ref.id !== null && ref.id.endsWith('#quote-request'))
}

function quoteAnswerRef(ref: ActivityRef): QuoteAnswerRef {
	return { id: ref.id, type: ref.type, object: ref.object, instrument: ref.instrument ?? null }
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
	// A retracted id that a favourite or boost still holds is undone all the same (a Delete of it may have recorded the
	// retraction first), so no interaction is stranded behind its own tombstone.
	const held = ref.type !== 'Follow' && ref.type !== 'Block' && interactionOf(db, actor, ref.id)
	if (!held && isRetracted(db, actor.uri, ref.id, now)) {
		return ignored('retracted')
	}
	if (ref.type === 'Like' || ref.type === 'Announce' || held) {
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
		// An untyped Undo that matches nothing stored may name a Like or Announce still on its way: answered 503, so its
		// tombstone is not lost (ID-7). One that names a stored follow or block keeps its answer.
		return ref.type === null && edge === undefined && !undoesBlock
			? retryLater('retraction-cap')
			: ignored('retraction-cap')
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
		// A target stored since the Worker read its revision (ID-1): the alias check was made on a document that is no
		// longer current, so the Move waits for a retry, which fetches the target again (ID-4).
		const remote = upsertRemoteActor(db, activity.target.document, origin, now, activity.target.revision)
		if (remote === 'superseded') {
			retryLater('target-changed')
		}
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
	// The source shows the move (Mastodon's move.rb:18), set once, when the job is first written: a replay of a known
	// Move writes nothing, and a later document of the source sets or clears it again (upsertRemoteActor). It issues a
	// new revision of the source (DocumentRevision), so a document of it fetched before the Move never clears it (ID-4).
	db.run(
		`UPDATE accounts SET moved_to_account_id = ?2, document_revision = ${nextDocumentRevisionSql('document_revision')}
		WHERE id = ?1 AND domain IS NOT NULL AND ?2 <> ?1`,
		actor.id,
		targetId
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
	// Checked before every batch: a Move whose source or target has since deleted itself, or whose source has become
	// unavailable (R38: suspended), ends here, before it changes anything (ID-7: a purged actor gets no new follows).
	if (
		job === undefined ||
		source === undefined ||
		target === undefined ||
		isDeletedActor(db, source.uri, now) ||
		db.first(`SELECT 1 AS x WHERE ${availableSql('?1')}`, source.id) === undefined ||
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

// The actor document itself was stored before the handler ran (input.actor); receive answers retryLater instead of
// running it when that store was superseded (upsertRemoteActor), so a document reaching it was stored.
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
//      mentions, favourites (their tracked Like ids first) and keys, with the counters they counted;
//   2. local boosts of its statuses: each boost's Undo is recorded once (withdrawLocalBoost; the job's cursor keeps
//      the boost being withdrawn), its targets are written a chunk per row over as many batches as they need
//      (stageRetraction), and B2's delivery rounds expand them in their own bounded steps; then the boost is deleted
//      like any status, its receipts included, and its booster's count recounted;
//   3. remote boosts of its statuses, then its own statuses;
//   4. once nothing else of it is left, the blocks and mutes of it, which filter what remains until then.
// A status is deleted only once its children (edits, media, mentions, tags, favourites and their tracked Like ids,
// bookmarks, notifications, receipts, boosts and the reply links to it) are gone, so deleting it cascades nothing.
// Local media is detached for the media sweep (its R2 objects go only through B4b's path), never deleted here. Returns
// whether anything remains; when nothing does, the account row goes and the job is done.
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
			`SELECT r.id FROM statuses o INDEXED BY statuses_account
				CROSS JOIN statuses r INDEXED BY statuses_reblog ON r.reblog_of_id = o.id
				LEFT JOIN local_accounts l ON l.account_id = r.account_id
			WHERE o.account_id = ?1 AND r.reblog_of_id IS NOT NULL AND l.account_id IS NULL
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
			{
				ids: `SELECT CAST(id AS TEXT) AS id FROM (SELECT id FROM blocks INDEXED BY blocks_pair WHERE account_id = ?1
				UNION ALL SELECT id FROM blocks INDEXED BY blocks_target WHERE target_account_id = ?1) LIMIT ?2`,
				each: 'DELETE FROM blocks WHERE id = CAST(?1 AS INTEGER)',
			},
			id
		)
		spend(
			db,
			budget,
			{
				ids: 'SELECT CAST(id AS TEXT) AS id FROM mutes INDEXED BY mutes_target WHERE target_account_id = ?1 LIMIT ?2',
				each: 'DELETE FROM mutes WHERE id = CAST(?1 AS INTEGER)',
			},
			id
		)
	}
	// The final account delete, its account_trend_reviews row (cascaded, one at most) and the job's completion are three
	// more rows.
	if (others || budget.left() < 3 || accountHasRows(db, id)) {
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

// Runs a write limited to the rows left: `write` (a statement, or a ByIds write's selection) takes the row limit as its
// last parameter.
function spend(db: Db, budget: Budget, write: string | ByIds, ...params: SqlStorageValue[]): number {
	const left = budget.left()
	if (left === 0) {
		return 0
	}
	return typeof write === 'string' ? db.run(write, ...params, left) : writeEach(db, write, ...params, left)
}

// The first ?2 reports of the account ?1 in the order reports_target_state holds them (resolution state, then id), so
// the window is one bounded range of the index (purgeRelationships).
const REPORT_WINDOW = `SELECT id FROM reports INDEXED BY reports_target_state WHERE target_account_id = ?1
	ORDER BY (action_taken_at IS NULL), id LIMIT ?2`

// The first ?2 reports by the account ?1, in reports_account_state's order, as REPORT_WINDOW.
const REPORTER_WINDOW = `SELECT id FROM reports INDEXED BY reports_account_state WHERE account_id = ?1
	ORDER BY (action_taken_at IS NULL), id LIMIT ?2`

// The first ?2 notifications from the account ?1 by id, one bounded range of notifications_from.
const SENDER_WINDOW = `SELECT id FROM notifications INDEXED BY notifications_from WHERE from_account_id = ?1
	ORDER BY id LIMIT ?2`

// The reports of a window (REPORT_WINDOW, REPORTER_WINDOW) of the account ?1, child-first so no delete cascades, as
// Mastodon's DeleteAccountService destroys an account's reports and targeted_reports: the pushes of their admin.report
// notifications (up to MAX_PUSH_BACKLOG each), then the notifications (one per report and recipient, migration
// 0040_report_notifications), then the reports. Each statement reads only the window, as many reports as the budget
// has left, and takes what it deletes from them: a report waits until its notifications are gone, a notification
// until its pushes are, so every row written is counted and none is read past the window, however many reports the
// account has or made.
function purgeReports(db: Db, budget: Budget, id: string, window: string): void {
	spend(
		db,
		budget,
		{
			ids: `SELECT CAST(d.id AS TEXT) AS id FROM (${window}) w
				CROSS JOIN notifications n INDEXED BY notifications_report ON n.report_id = w.id
				CROSS JOIN push_deliveries d INDEXED BY push_deliveries_notification ON d.notification_id = n.id LIMIT ?2`,
			each: 'DELETE FROM push_deliveries WHERE id = CAST(?1 AS INTEGER)',
		},
		id
	)
	spend(
		db,
		budget,
		{
			ids: `SELECT CAST(n.id AS TEXT) AS id FROM (${window}) w
				CROSS JOIN notifications n INDEXED BY notifications_report ON n.report_id = w.id
			WHERE NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.notification_id = n.id) LIMIT ?2`,
			each: 'DELETE FROM notifications WHERE id = CAST(?1 AS INTEGER)',
		},
		id
	)
	spend(
		db,
		budget,
		{
			ids: `SELECT CAST(w.id AS TEXT) AS id FROM (${window}) w
			WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.report_id = w.id) LIMIT ?2`,
			each: 'DELETE FROM reports WHERE id = CAST(?1 AS INTEGER)',
		},
		id
	)
}

// The first ?2 favourites of the account ?1 by id (favourites_account), so the purge reads one bounded range for
// their tracked Like ids and for the favourites themselves, however many the account has (purgeRelationships).
const FAVOURITE_WINDOW = 'SELECT id, status_id FROM favourites WHERE account_id = ?1 ORDER BY id LIMIT ?2'

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
	// Local users' dismissals of the account from their suggestions (migration 0050_follow_recommendation_mutes).
	spend(
		db,
		budget,
		`DELETE FROM follow_recommendation_mutes WHERE target_account_id = ?1
			AND account_id IN (SELECT account_id FROM follow_recommendation_mutes WHERE target_account_id = ?1 LIMIT ?2)`,
		id
	)
	// The accounts that name it as their move (PURGED_ACCOUNT_REFERENCES), each cleared by its key.
	for (const reference of PURGED_ACCOUNT_REFERENCES) {
		spend(
			db,
			budget,
			{
				ids: `SELECT id FROM ${reference.table} INDEXED BY ${reference.index} WHERE ${reference.column} = ?1 LIMIT ?2`,
				each: `UPDATE ${reference.table} SET ${reference.column} = NULL WHERE id = ?1`,
			},
			id
		)
	}
	// A follow's delete and its local side's recount: two rows each at most.
	// Its follows of either side, each side through its own index (an OR of the two lets statistics older than the
	// Store's growth scan the follows: RES-7), the first of both in the order of their ids as text.
	const follows = db.all<{ id: string; other: string }>(
		`SELECT id, other FROM (
			SELECT * FROM (SELECT CAST(id AS TEXT) AS id, target_account_id AS other FROM follows INDEXED BY follows_pair
				WHERE account_id = ?1 ORDER BY 1 LIMIT ?2)
			UNION ALL SELECT * FROM (SELECT CAST(id AS TEXT), account_id FROM follows INDEXED BY follows_target
				WHERE target_account_id = ?1 ORDER BY 1 LIMIT ?2))
		ORDER BY id LIMIT ?2`,
		id,
		Math.floor(budget.left() / 2)
	)
	for (const follow of follows) {
		db.run('DELETE FROM follows WHERE id = CAST(? AS INTEGER)', follow.id)
	}
	recountLocal(
		db,
		follows.map((f) => f.other)
	)
	// The tracked Like ids of its first favourites (FAVOURITE_WINDOW), at most MAX_TRACKED_LIKES each; then each
	// favourite of the window that tracks none: its delete and its status's recount, two rows, cascading nothing.
	spend(
		db,
		budget,
		{
			ids: `SELECT CAST(l.id AS TEXT) AS id FROM (${FAVOURITE_WINDOW}) w
				CROSS JOIN favourite_likes l INDEXED BY favourite_likes_favourite ON l.favourite_id = w.id LIMIT ?2`,
			each: 'DELETE FROM favourite_likes WHERE id = CAST(?1 AS INTEGER)',
		},
		id
	)
	const favourites = db.all<{ id: string; status: string }>(
		`SELECT CAST(w.id AS TEXT) AS id, w.status_id AS status FROM (${FAVOURITE_WINDOW}) w
		WHERE NOT EXISTS (SELECT 1 FROM favourite_likes l WHERE l.favourite_id = w.id)`,
		id,
		Math.floor(budget.left() / 2)
	)
	for (const favourite of favourites) {
		db.run('DELETE FROM favourites WHERE id = CAST(? AS INTEGER)', favourite.id)
	}
	for (const status of new Set(favourites.map((f) => f.status))) {
		recountStatus(db, status)
	}
	// The reports of the account and by it (migrations 0022_reports and 0054_remote_reports), each window child-first
	// (purgeReports), before its other notifications: a report's admin.report is from its reporter.
	purgeReports(db, budget, id, REPORT_WINDOW)
	purgeReports(db, budget, id, REPORTER_WINDOW)
	// Its other notifications, child-first from its first ones by id (SENDER_WINDOW): their pushes (up to
	// MAX_PUSH_BACKLOG each), then each notification left without one, so no delete cascades.
	spend(
		db,
		budget,
		{
			ids: `SELECT CAST(d.id AS TEXT) AS id FROM (${SENDER_WINDOW}) w
				CROSS JOIN push_deliveries d INDEXED BY push_deliveries_notification ON d.notification_id = w.id LIMIT ?2`,
			each: 'DELETE FROM push_deliveries WHERE id = CAST(?1 AS INTEGER)',
		},
		id
	)
	spend(
		db,
		budget,
		{
			ids: `SELECT CAST(w.id AS TEXT) AS id FROM (${SENDER_WINDOW}) w
			WHERE NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.notification_id = w.id) LIMIT ?2`,
			each: 'DELETE FROM notifications WHERE id = CAST(?1 AS INTEGER)',
		},
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
		{
			ids: `SELECT CAST(id AS TEXT) AS id FROM notification_requests INDEXED BY notification_requests_from
				WHERE from_account_id = ?1 LIMIT ?2`,
			each: 'DELETE FROM notification_requests WHERE id = CAST(?1 AS INTEGER)',
		},
		id
	)
	spend(
		db,
		budget,
		{
			ids: `SELECT CAST(id AS TEXT) AS id FROM notification_request_jobs INDEXED BY notification_request_jobs_from
				WHERE from_account_id = ?1 LIMIT ?2`,
			each: 'DELETE FROM notification_request_jobs WHERE id = CAST(?1 AS INTEGER)',
		},
		id
	)
	// Its pins and featured hashtags, at most MAX_REMOTE_PINS and MAX_FEATURED_TAGS, the sync of them that waits
	// and its pending pinned statuses (migration 0025_remote_collections).
	spend(
		db,
		budget,
		`DELETE FROM status_pins WHERE account_id = ?1
			AND status_id IN (SELECT status_id FROM status_pins WHERE account_id = ?1 LIMIT ?2)`,
		id
	)
	spend(
		db,
		budget,
		`DELETE FROM featured_tags INDEXED BY ${FEATURED_TAGS_ID_INDEX}
			WHERE id IN (SELECT id FROM featured_tags INDEXED BY ${FEATURED_TAGS_ACCOUNT_INDEX} WHERE account_id = ? LIMIT ?)`,
		id
	)
	spend(
		db,
		budget,
		`DELETE FROM collection_pins_pending WHERE account_id = ?1
			AND uri IN (SELECT uri FROM collection_pins_pending WHERE account_id = ?1 LIMIT ?2)`,
		id
	)
	spend(
		db,
		budget,
		'DELETE FROM collection_syncs WHERE account_id IN (SELECT account_id FROM collection_syncs WHERE account_id = ? LIMIT ?)',
		id
	)
	// Its profile link verification (domain/remote-field-links.ts): one row at most.
	spend(
		db,
		budget,
		`DELETE FROM remote_field_links
			WHERE account_id IN (SELECT account_id FROM remote_field_links WHERE account_id = ? LIMIT ?)`,
		id
	)
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
		`UPDATE statuses INDEXED BY ${STATUSES_ID_INDEX} SET in_reply_to_account_id = NULL
		WHERE id IN (SELECT id FROM statuses INDEXED BY statuses_in_reply_to_account
			WHERE in_reply_to_account_id = ?1 AND account_id <> ?1 LIMIT ?2)`,
		id
	)
	spend(
		db,
		budget,
		`DELETE FROM media_attachments INDEXED BY ${MEDIA_ID_INDEX} WHERE id IN (SELECT id FROM media_attachments
			INDEXED BY media_attachments_account WHERE account_id = ? AND status_id IS NULL AND file_token IS NULL LIMIT ?)`,
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
// time), and its booster's statuses_count recounted. The originals drive, each one's boosts sought through
// statuses_reblog (RES-7).
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
			`SELECT r.id, r.uri, r.account_id AS booster, r.withdrawn
			FROM statuses o INDEXED BY ${column === 'o.id' ? STATUSES_ID_INDEX : 'statuses_account'}
				CROSS JOIN statuses r INDEXED BY statuses_reblog ON r.reblog_of_id = o.id
				CROSS JOIN local_accounts l ON l.account_id = r.account_id
			WHERE ${column} = ? AND r.reblog_of_id IS NOT NULL ORDER BY r.id = ? DESC, r.id LIMIT 1`,
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
// list against the schema. A table below another child (`parent`, whose rows it names by `column`) comes before it,
// with the existence check (`exists`, of `?1`) that joins through it. Votes (deletePollVotes) and the status's replies
// and boosts have their own steps.
export const STATUS_CHILDREN: readonly {
	table: string
	column: string
	parent?: string
	exists?: string
	remove: readonly (string | ByIds)[]
}[] = [
	{
		table: 'status_edits',
		column: 'status_id',
		remove: [
			{
				ids: 'SELECT CAST(id AS TEXT) AS id FROM status_edits INDEXED BY status_edits_status WHERE status_id = ?1 LIMIT ?2',
				each: 'DELETE FROM status_edits WHERE id = CAST(?1 AS INTEGER)',
			},
		],
	},
	// Local uploads, also those an edit dropped, are detached for the media sweep, which deletes their R2 objects
	// (gc_at the epoch: due at once; media.ts's DOOMED_AT written out, since media.ts reaches this module through
	// accounts.ts and the list is built as the module loads); remote rows only name URLs.
	{
		table: 'media_attachments',
		column: 'status_id',
		remove: [
			`UPDATE media_attachments INDEXED BY ${MEDIA_ID_INDEX}
			SET status_id = NULL, position = 0, shown = 1, gc_at = '1970-01-01T00:00:00.000Z'
			WHERE id IN (SELECT id FROM media_attachments INDEXED BY media_attachments_status
				WHERE status_id = ?1 AND file_token IS NOT NULL LIMIT ?2)`,
			`DELETE FROM media_attachments INDEXED BY ${MEDIA_ID_INDEX}
			WHERE id IN (SELECT id FROM media_attachments INDEXED BY media_attachments_status
				WHERE status_id = ? AND file_token IS NULL LIMIT ?)`,
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
	// The tracked Like ids of the status's favourites (migration 0052_favourite_likes), at most MAX_TRACKED_LIKES per
	// favourite, read from the status's first favourites; then the favourites that track none, so none cascades.
	{
		table: 'favourite_likes',
		column: 'favourite_id',
		parent: 'favourites',
		exists:
			'EXISTS (SELECT 1 FROM favourites f JOIN favourite_likes l ON l.favourite_id = f.id WHERE f.status_id = ?1)',
		remove: [
			{
				ids: `SELECT CAST(l.id AS TEXT) AS id FROM
					(SELECT id FROM favourites INDEXED BY favourites_status WHERE status_id = ?1 ORDER BY id LIMIT ?2) w
					CROSS JOIN favourite_likes l INDEXED BY favourite_likes_favourite ON l.favourite_id = w.id LIMIT ?2`,
				each: 'DELETE FROM favourite_likes WHERE id = CAST(?1 AS INTEGER)',
			},
		],
	},
	{
		table: 'favourites',
		column: 'status_id',
		remove: [
			{
				ids: `SELECT CAST(w.id AS TEXT) AS id
					FROM (SELECT id FROM favourites INDEXED BY favourites_status WHERE status_id = ?1 ORDER BY id LIMIT ?2) w
					WHERE NOT EXISTS (SELECT 1 FROM favourite_likes l WHERE l.favourite_id = w.id)`,
				each: 'DELETE FROM favourites WHERE id = CAST(?1 AS INTEGER)',
			},
		],
	},
	{
		table: 'bookmarks',
		column: 'status_id',
		remove: [
			{
				ids: 'SELECT CAST(id AS TEXT) AS id FROM bookmarks INDEXED BY bookmarks_pair WHERE status_id = ?1 LIMIT ?2',
				each: 'DELETE FROM bookmarks WHERE id = CAST(?1 AS INTEGER)',
			},
		],
	},
	{
		table: 'notifications',
		column: 'status_id',
		remove: [
			{
				ids: `SELECT CAST(id AS TEXT) AS id FROM notifications INDEXED BY notifications_status
					WHERE status_id = ?1 LIMIT ?2`,
				each: 'DELETE FROM notifications WHERE id = CAST(?1 AS INTEGER)',
			},
		],
	},
	// Pins of the status (migrations 0018_status_pins_and_conversation_mutes and 0025_remote_collections): only its
	// author pins it, so one row at most.
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
		remove: [
			`DELETE FROM filter_statuses INDEXED BY ${FILTER_STATUSES_ID_INDEX}
			WHERE id IN (SELECT id FROM filter_statuses INDEXED BY filter_statuses_status WHERE status_id = ? LIMIT ?)`,
		],
	},
	// Notification requests whose last status it is (migration 0020_notification_policies): one per recipient and
	// sender, any number of recipients; the request stays, without a last status (ON DELETE SET NULL, as Mastodon's
	// foreign key nullifies it).
	{
		table: 'notification_requests',
		column: 'last_status_id',
		remove: [
			{
				ids: `SELECT CAST(id AS TEXT) AS id FROM notification_requests INDEXED BY notification_requests_last_status
					WHERE last_status_id = ?1 LIMIT ?2`,
				each: 'UPDATE notification_requests SET last_status_id = NULL WHERE id = CAST(?1 AS INTEGER)',
			},
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
	// conversation_statuses_removed, which writes that conversation once (AccountConversation.remove_status) and, when
	// its owner streams `direct`, the owner's mark before it and the mark's journal row (migration 0032_streaming_lists),
	// so a batch takes a fourth of the rows left.
	{
		table: 'conversation_statuses',
		column: 'status_id',
		remove: [
			`DELETE FROM conversation_statuses WHERE status_id = ?1
			AND conversation_id IN (SELECT conversation_id FROM conversation_statuses WHERE status_id = ?1 LIMIT CAST(?2 / 4 AS INTEGER))`,
		],
	},
	// Quotes of the status (migration 0033_quotes): any number, of any accounts. Each is detached, an accepted one
	// becoming deleted in the same statement (the quotes CHECK refuses an accepted quote without its target), its work
	// ended; an accepted one also takes itself off this status's count (the trigger quotes_count_changed), so a batch
	// takes half the rows left. A batch removes remote statuses only, and Kopje's authorizations are of quotes of local
	// statuses, so no row here holds one (cleared all the same: the CHECK allows one only while accepted).
	{
		table: 'quotes',
		column: 'quoted_status_id',
		remove: [
			`UPDATE quotes INDEXED BY ${QUOTES_STATUS_INDEX}
			SET quoted_status_id = NULL, quoted_account_id = NULL, generation = ${NEW_GENERATION}, lease_until = NULL,
				state = CASE state WHEN 'accepted' THEN 'deleted' ELSE state END, verify_after = NULL, authorization_id = NULL
			WHERE status_id IN (SELECT status_id FROM quotes WHERE quoted_status_id = ?1 LIMIT CAST(?2 / 2 AS INTEGER))`,
		],
	},
	// The status's own quote, one row at most: deleted before the status, so it never cascades, with the count of its
	// target when it was accepted (the trigger quotes_count_deleted) and, for a quote of a local status still holding
	// Kopje's authorization (a purge: a Delete of the status retires it first, retireQuoteOf), its quote_revocations row
	// (quotes_authorization_deleted), so it takes a third of the rows left. With fewer than three rows left it deletes
	// nothing, and the next batch takes it.
	{
		table: 'quotes',
		column: 'status_id',
		remove: [
			`DELETE FROM quotes INDEXED BY ${QUOTES_STATUS_INDEX}
			WHERE status_id IN (SELECT status_id FROM quotes WHERE status_id = ?1 LIMIT CAST(?2 / 3 AS INTEGER))`,
		],
	},
]

const STATUS_CHILDREN_EXIST = STATUS_CHILDREN.map(
	(child) => child.exists ?? `EXISTS (SELECT 1 FROM ${child.table} WHERE ${child.column} = ?1)`
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
		for (const write of child.remove) {
			spend(db, budget, write, statusId)
		}
	}
	spend(
		db,
		budget,
		`UPDATE statuses INDEXED BY ${STATUSES_ID_INDEX} SET in_reply_to_id = NULL
		WHERE id IN (SELECT id FROM statuses INDEXED BY statuses_in_reply_to WHERE in_reply_to_id = ? LIMIT ?)`,
		statusId
	)
	const children = db.first(
		`SELECT 1 AS x WHERE ${STATUS_CHILDREN_EXIST}
			OR EXISTS (SELECT 1 FROM statuses INDEXED BY statuses_in_reply_to WHERE in_reply_to_id = ?1)
			OR EXISTS (SELECT 1 FROM statuses INDEXED BY statuses_reblog WHERE reblog_of_id = ?1)`,
		statusId
	)
	// The status's delete writes at most seven rows: the status, its poll, its trend_statuses, status_trend_reviews and
	// status_cards rows (cascaded, one each at most), the account's last status (moved back by the trigger of migration
	// 0021_directory when it is the account's newest), and the recount of its parent or of its original (a status is
	// never both a reply and a boost); `after` is the caller's rows after it.
	if (children !== undefined || hasPollVotes(db, { statusId }) || budget.left() < 7 + after) {
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
	{ table: 'favourite_likes', check: 'favourite_id IN (SELECT id FROM favourites WHERE account_id = ?1)' },
	{ table: 'follows', check: 'account_id = ?1' },
	{ table: 'follows', check: 'target_account_id = ?1' },
	{ table: 'blocks', check: 'account_id = ?1', filter: true },
	{ table: 'blocks', check: 'target_account_id = ?1', filter: true },
	{ table: 'mutes', check: 'target_account_id = ?1', filter: true },
	{ table: 'list_accounts', check: 'account_id = ?1' },
	{ table: 'account_pins', check: 'target_account_id = ?1' },
	{ table: 'account_notes', check: 'target_account_id = ?1' },
	{ table: 'follow_recommendation_mutes', check: 'target_account_id = ?1' },
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
	{ table: 'reports', check: 'account_id = ?1' },
	{ table: 'status_pins', check: 'account_id = ?1' },
	{ table: 'featured_tags', check: 'account_id = ?1' },
	{ table: 'collection_syncs', check: 'account_id = ?1' },
	{ table: 'remote_field_links', check: 'account_id = ?1' },
	{ table: 'collection_pins_pending', check: 'account_id = ?1' },
]

// What names a remote account without a foreign key (logical references, which no delete of the account cascades to):
// the purge clears each (purgeRelationships) through its partial index, before the account row goes, and the
// completion check (ACCOUNT_CHILDREN_EXIST) keeps the row while any remains. test/cascade-guard.test.ts checks each
// column has no foreign key and its index exists.
export const PURGED_ACCOUNT_REFERENCES: readonly { table: string; column: string; index: string }[] = [
	{ table: 'accounts', column: 'moved_to_account_id', index: MOVED_TO_INDEX },
]

const ACCOUNT_CHILDREN_EXIST = [
	...PURGED_ACCOUNT_CHILDREN.map((child) => {
		const exists = `EXISTS (SELECT 1 FROM ${child.table} WHERE ${child.check})`
		return child.filter ? `(?2 AND ${exists})` : exists
	}),
	...PURGED_ACCOUNT_REFERENCES.map(
		(reference) => `EXISTS (SELECT 1 FROM ${reference.table} INDEXED BY ${reference.index}
			WHERE ${reference.column} = ?1)`
	),
].join(' OR ')

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
		// A Delete of a local quote's stamp carrying an author proof is forwarded only once the Worker has verified it:
		// asked for before anything is written.
		if (activity.signed === true && activity.proven === undefined && holdsLocalStamp(db, actor, activity.object)) {
			return { ...ignored('need-proof'), need: { kind: 'proof', uri: actor.uri } }
		}
		return retractUnknown(db, actor, activity.object, now, activity.proven ?? null)
	}
	if (!retract(db, actor.uri, activity.object, now)) {
		return retryLater('retraction-cap')
	}
	recordDeletedObject(db, activity.object, now)
	if (status.reblog_of_id !== null) {
		// R32: the streaming delete of the boost, captured before it goes.
		streamDelete(db, status.id, now)
		removeBoost(db, actor.id, { id: status.id, original: status.reblog_of_id })
		return applied('boost-deleted')
	}
	// R32: the streaming delete is captured when the job is created, before the first batch removes its mentions; the
	// job row is the marker, so a Delete delivered again (or the later batches) captures nothing more. It writes outside
	// the batch's budget, which deleteStatusBatch starts after it.
	const created = db.first(
		`INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, ?) ON CONFLICT DO NOTHING
		RETURNING key`,
		status.id,
		actor.uri,
		now
	)
	if (created !== undefined) {
		streamDelete(db, status.id, now)
	}
	// Kopje's authorization of its quote ends now, before any batch, outside the batch's budget (one quote row, its
	// count and its revocation): the stamp is not served while the removal runs (VIS-28).
	retireQuoteOf(db, status.id, now)
	return applied('status-deleted', deleteStatusBatch(db, status.id, now))
}

// A Delete relayed by another server (federation/inbound.ts, ID-1's one exception): applied only to what can be a
// stamp, never to an actor, a status or a boost. With the actor's own proof it revokes as the actor's Delete does;
// without one it changes no state and only has the accepted quote naming the stamp verified again (Mastodon drops such
// a relay; Kopje lets the stamp's own server answer).
const relayedDelete: Handler<'RelayedDelete'> = (db, actor, activity, { now }) => {
	if (originOf(activity.object) !== originOf(actor.uri)) {
		return ignored('foreign-object')
	}
	if (
		db.first(
			'SELECT 1 AS x FROM statuses WHERE uri = ?1 UNION ALL SELECT 1 FROM accounts WHERE uri = ?1 LIMIT 1',
			activity.object
		) !== undefined
	) {
		return ignored('not-a-stamp')
	}
	if (!activity.proven) {
		return recheckStamp(db, actor, activity.object, now) ? applied('stamp-rechecked') : ignored('unknown-stamp')
	}
	return retractUnknown(db, actor, activity.object, now, activity.body ?? null)
}

// The actor's Delete of an object Kopje holds no status of: recorded as a retraction (ID-7) and, when it is the stamp
// of a quote of the actor's status, as a revocation for good whether or not the retraction could be (quote_revocations
// is bounded by the quotes stored), its first batch within PURGE_BATCH (quotes.ts revokeStamp). proven: the body as
// received, its author proof verified, forwarded for a local quote that holds the stamp.
function retractUnknown(
	db: Db,
	actor: { id: string; uri: string },
	object: string,
	now: number,
	proven: Record<string, unknown> | null
): ReceiveResult {
	const recorded = retract(db, actor.uri, object, now)
	const budget = new Budget(db, PURGE_BATCH)
	const revocation = revokeStamp(db, actor, object, () => budget.left(), now, proven)
	if (revocation !== null) {
		return applied('stamp-revoked', revocation)
	}
	return recorded ? applied('retraction-recorded') : ignored('retraction-cap')
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
	// Hiding writes the status, the account's last status, which the trigger of migration 0021_directory moves back, and
	// deletes the status's card (link-cards.ts: a direct status holds none).
	if (budget.left() >= 3) {
		db.run(
			`UPDATE statuses SET visibility = 'direct', content = '', spoiler_text = '', search_text = NULL
			WHERE id = ? AND (visibility <> 'direct' OR content <> '' OR spoiler_text <> '' OR search_text IS NOT NULL)`,
			statusId
		)
		deleteCard(db, statusId)
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

// A QuoteRequest for a local status (quotes.ts answerQuoteRequest), answered in this one transaction. The instrument,
// when neither stored nor inlined by the actor, is asked of the Worker (need) before anything is written.
const quoteRequest: Handler<'QuoteRequest'> = (db, actor, activity, input) => {
	const answer = answerQuoteRequest(db, actor, activity, {
		now: input.now,
		origin: input.origin,
		deliveredTo: deliveredTo(db, input.recipient),
		prefetched: input.prefetched?.statuses[activity.instrument],
	})
	switch (answer.kind) {
		case 'need':
			return { ...ignored('need-instrument'), need: { kind: 'status', uri: answer.uri, signer: { local: answer.as } } }
		case 'ignored':
			return ignored(answer.reason)
		case 'answered':
			return applied(answer.reason)
	}
}

// What an inbound Like or Announce of a status requires of its actor: that it may see the status by itself (canView, as
// a remote viewer). So an author who blocks the actor (VIS-13) or its domain (VIS-15) refuses both. Mastodon's Like and
// Announce handlers do not check the read rule; Kopje does.
function mayInteract(db: Db, actor: RemoteRow, statusId: string): boolean {
	return canView(db, actor.id, statusId)
}

// Mastodon's ActivityPub::Activity::Like: a favourite of a local status, once per account, unless an Undo of this Like
// arrived first (ID-7), by an actor that may interact with it (mayInteract). Its outstanding Like ids (favourite_likes
// rows and a retained favourites.uri, at most MAX_TRACKED_LIKES) and their admission: ID-7. A further Like of a
// favourited status notifies nothing (VIS-10).
const like: Handler<'Like'> = (db, actor, activity, { now, storeNow }) => {
	const status = originalByUri(db, activity.object)
	if (status?.local !== 1) {
		return ignored('unknown-object')
	}
	if (isRetracted(db, actor.uri, activity.id, now)) {
		return ignored('retracted')
	}
	if (!mayInteract(db, actor, status.id)) {
		return ignored('not-visible')
	}
	if (!withinIdentityBound(activity.id, ACTIVITY_ID_LIMIT)) {
		return ignored('id-past-bound')
	}
	if (
		db.first(
			`SELECT 1 AS x FROM favourite_likes WHERE uri = ?1
			UNION ALL SELECT 1 FROM favourites INDEXED BY favourites_like_uri WHERE uri = ?1 LIMIT 1`,
			activity.id
		) !== undefined
	) {
		return ignored('duplicate')
	}
	// Outstanding: the tracked ids and the retained one.
	const favourite = db.first<{ id: number; outstanding: number }>(
		`SELECT f.id, (SELECT count(*) FROM favourite_likes l WHERE l.favourite_id = f.id) + (f.uri IS NOT NULL)
			AS outstanding
		FROM favourites f WHERE f.account_id = ? AND f.status_id = ?`,
		actor.id,
		status.id
	)
	if (favourite !== undefined) {
		if (favourite.outstanding >= MAX_TRACKED_LIKES) {
			retireStaleLike(db, actor, favourite.id, now, storeNow)
		}
		trackLike(db, favourite.id, activity.id, storeNow)
		return applied('favourite-kept')
	}
	const inserted = db.first<{ id: number }>(
		'INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?) RETURNING id',
		actor.id,
		status.id,
		new Date(now).toISOString()
	)!
	trackLike(db, inserted.id, activity.id, storeNow)
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
	const document = input.prefetched?.actors[authorUri]
	let followers: string | null
	if (author === undefined) {
		if (document === undefined) {
			return { ...ignored('need-author'), need: { kind: 'actor', uri: authorUri } }
		}
		if (document === null || document === 'gone' || document.uri !== authorUri) {
			return ignored('unfetchable')
		}
		followers = followersOf(document.raw)
	} else {
		// A stale stored author is refetched first (Mastodon's account_from_uri), before VIS-6, which then reads the
		// refreshed followers: a refresh is not content, so one VIS-6 refuses still stands. The collection sync a refresh
		// asks for is left to the job rounds (receive propagates the sender's only).
		if (document !== undefined) {
			const refreshed = applyRefresh(db, author, document, origin, now)
			if (refreshed.kind === 'refused') {
				return ignored('unfetchable')
			}
			author = refreshed.author
		} else if (staleAccount(db, author.id, now)) {
			return { ...ignored('need-author-refresh'), need: { kind: 'actor', uri: authorUri, refresh: true } }
		}
		followers = followersUri(db, author.id)
	}
	if (authorUri !== actor.uri && !isDistributable(visibilityOf(fetched, followers))) {
		return ignored('not-announceable')
	}
	if (author === undefined && document !== undefined && document !== null && document !== 'gone') {
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
	// A boosted original arrives as a root, cached or not: a cached one's quote is promoted here (a new one's work was
	// recorded as it was stored).
	if (original.local !== 1) {
		promoteQuote(db, originalId, quoteArrival(db, original.account_id, null), now)
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
	// audience rule decides who may see the boost, its reblog notification included (notifications.ts). Each is sought
	// through the URI index (RES-7); past the cap, local accounts first, then by id.
	const addressed = db.all<{ id: string }>(
		`SELECT a.id FROM accounts a INDEXED BY ${ACCOUNTS_URI_INDEX} LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE a.uri IN (SELECT value FROM json_each(?)) AND a.id <> ?
		ORDER BY l.account_id IS NULL, a.id LIMIT ?`,
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

// received_at: the Store's clock (StoreReceiveInput).
function trackLike(db: Db, favouriteId: number, uri: string, storeNow: number): void {
	db.run('INSERT INTO favourite_likes (favourite_id, uri, received_at) VALUES (?, ?, ?)', favouriteId, uri, storeNow)
}

// Makes room at the cap: the earliest tracked id (by row id) the Store received at least LIKE_RETIRE_AFTER_MS ago, by
// its own clock, goes and is recorded as retracted, so a replay of its Like does not bring the favourite back (ID-7);
// a retained favourites.uri has no time of receipt and is never retired. The favourite keeps the new Like, so its
// count and notification stay. Without such an id, or without room for its retraction, nothing is written and the
// Like is answered 503.
function retireStaleLike(db: Db, actor: RemoteRow, favouriteId: number, now: number, storeNow: number): void {
	const stale = db.first<{ id: number; uri: string }>(
		`SELECT id, uri FROM favourite_likes WHERE favourite_id = ? AND received_at <= ? ORDER BY id LIMIT 1`,
		favouriteId,
		storeNow - LIKE_RETIRE_AFTER_MS
	)
	if (stale === undefined) {
		retryLater('like-tracking-cap')
	}
	if (!canRetract(db, actor.uri, [stale.uri], now)) {
		retryLater('retraction-cap')
	}
	db.run('DELETE FROM favourite_likes WHERE id = ?', stale.id)
	retract(db, actor.uri, stale.uri, now)
}

type TrackedLike = { id: number; favourite: string; status_id: string }

// The actor's favourite tracking the Like id `uri`: one row at most (favourite_likes_uri is unique), found by that
// index, never by the actor's favourites, which are any number.
function trackedLike(db: Db, actorId: string, uri: string): TrackedLike | undefined {
	return db.first<TrackedLike>(
		`SELECT l.id, CAST(f.id AS TEXT) AS favourite, f.status_id FROM favourite_likes l INDEXED BY favourite_likes_uri
			JOIN favourites f ON f.id = l.favourite_id
		WHERE l.uri = ? AND f.account_id = ?`,
		uri,
		actorId
	)
}

// The actor's id-less favourite of the status `uri`, local or remote: one with no tracked Like id and no retained one
// (a cutover stores none). A favourite with an id of its own, tracked or retained, goes only by that id's Undo, so an
// Undo that overtakes its Like never removes it. The status first (CROSS JOIN keeps the order), then its favourite by
// the pair.
type LegacyFavourite = { id: string; status_id: string }

function legacyFavourite(db: Db, actorId: string, uri: string): LegacyFavourite | undefined {
	return db.first<LegacyFavourite>(
		`SELECT CAST(f.id AS TEXT) AS id, f.status_id FROM statuses s CROSS JOIN favourites f ON f.status_id = s.id
		WHERE s.uri = ? AND f.account_id = ? AND f.uri IS NULL
			AND NOT EXISTS (SELECT 1 FROM favourite_likes l WHERE l.favourite_id = f.id)`,
		uri,
		actorId
	)
}

// The actor's favourite whose retained Like id (favourites.uri, kept from before migration 0052_favourite_likes) is
// `uri`, tracked ids or not: it stays outstanding until its own Undo. By favourites_like_uri (uri, account_id), one
// seek, never a range of the actor's favourites; owner-scoped, so a local favourite's own id is never matched.
function retainedLike(db: Db, actorId: string, uri: string): LegacyFavourite | undefined {
	return db.first<LegacyFavourite>(
		`SELECT CAST(f.id AS TEXT) AS id, f.status_id FROM favourites f INDEXED BY favourites_like_uri
		WHERE f.uri = ? AND f.account_id = ? LIMIT 1`,
		uri,
		actorId
	)
}

// Whether the favourite `id` still has an outstanding Like id: a tracked one, or its retained one.
function outstanding(db: Db, id: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x FROM favourite_likes WHERE favourite_id = ?1
			UNION ALL SELECT 1 FROM favourites WHERE id = ?1 AND uri IS NOT NULL LIMIT 1`,
			id
		) !== undefined
	)
}

// A favourite or boost the actor made under this id.
function interactionOf(db: Db, actor: RemoteRow, uri: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM favourite_likes l INDEXED BY favourite_likes_uri
					JOIN favourites f ON f.id = l.favourite_id WHERE l.uri = ?2 AND f.account_id = ?1)
				OR EXISTS (SELECT 1 FROM favourites INDEXED BY favourites_like_uri WHERE uri = ?2 AND account_id = ?1)
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

// Undo of a Like or an Announce, by the undone activity's id (ID-7). For a Like, in this order:
//   - the actor's favourite tracking the id, or retaining it (favourites.uri, retainedLike), typed or untyped: the id
//     goes (its row, or the retained uri cleared), and the favourite with its last outstanding one (removeFavourite);
//   - for a typed Like naming a status the actor has an id-less favourite of (legacyFavourite: no tracked or retained
//     id, a converted one): that favourite goes, as Mastodon's undo_like finds the actor's favourite of the object;
//   - for a typed Like naming anything but a local original: nothing (Mastodon's undo_like). A server sends a
//     reaction's Undo to the reactor's followers too, and these would spend the actor's retraction cap;
//   - otherwise the id is recorded as retracted, so a Like that arrives after its Undo does not apply.
// The stored matches come before that check: a converted favourite may be of a remote status. An Announce is found by
// its id. Whatever changes, the Undo's id is recorded as retracted; if it cannot be (the per-actor cap), nothing
// changes and the Undo is answered 503.
function undoInteraction(db: Db, actor: RemoteRow, ref: ActivityRef & { id: string }, now: number): ReceiveResult {
	const tracked = ref.type === 'Announce' ? undefined : trackedLike(db, actor.id, ref.id)
	const retained = tracked !== undefined || ref.type === 'Announce' ? undefined : retainedLike(db, actor.id, ref.id)
	const legacy =
		tracked === undefined && retained === undefined && ref.type === 'Like' && ref.object !== null
			? legacyFavourite(db, actor.id, ref.object)
			: undefined
	const boost =
		ref.type === 'Like'
			? undefined
			: db.first<{ id: string; original: string }>(
					`SELECT id, reblog_of_id AS original FROM statuses
					WHERE account_id = ? AND uri = ? AND reblog_of_id IS NOT NULL`,
					actor.id,
					ref.id
				)
	if (
		ref.type === 'Like' &&
		tracked === undefined &&
		retained === undefined &&
		legacy === undefined &&
		ref.object !== null &&
		originalByUri(db, ref.object)?.local !== 1
	) {
		return ignored('unrelated')
	}
	// Recorded first (the id has the actor's origin, checked by undo): at the cap nothing is written and the Undo is
	// answered 503, the transaction rolled back.
	if (!retract(db, actor.uri, ref.id, now)) {
		return retryLater('retraction-cap')
	}
	let reason = 'retraction-recorded'
	const undone = tracked === undefined ? retained : { id: tracked.favourite, status_id: tracked.status_id }
	if (tracked !== undefined) {
		db.run('DELETE FROM favourite_likes WHERE id = ?', tracked.id)
	} else if (retained !== undefined) {
		db.run('UPDATE favourites SET uri = NULL WHERE id = CAST(? AS INTEGER)', retained.id)
	}
	if (undone !== undefined) {
		reason = 'like-undone'
		if (!outstanding(db, undone.id)) {
			removeFavourite(db, actor.id, undone)
			reason = 'undone'
		}
	} else if (legacy !== undefined) {
		removeFavourite(db, actor.id, legacy)
		reason = 'undone'
	}
	if (boost !== undefined) {
		// R32: the streaming delete of the boost, captured before it goes.
		streamDelete(db, boost.id, now)
		removeBoost(db, actor.id, boost)
		reason = 'undone'
	}
	return applied(reason)
}

// Mastodon's ActivityPub::Activity::Add and Remove (remote-collections.ts): the target is the actor's own featured
// collection (a status, or a Hashtag) or featuredTags collection (a Hashtag; Mastodon sends a featured hashtag's Add to
// the featured collection, Kopje accepts either), on its own origin; anything else is ignored. A status is the actor's
// own on its origin; one not stored yet is fetched (Add#status_from_object) only for an actor with local followers.
const add: Handler<'Add'> = (db, actor, activity, input) => {
	const collection = collectionOf(db, actor.id, activity.target)
	const { object } = activity
	if ('hashtag' in object) {
		if (collection === null) {
			return ignored('not-collection')
		}
		return featureRemote(db, actor.id, object.hashtag, input.now) ? applied('featured') : ignored('not-featured')
	}
	if (collection !== 'featured') {
		return ignored('not-collection')
	}
	if (originOf(object.status) !== originOf(actor.uri)) {
		return ignored('foreign-object')
	}
	let status = statusByUri(db, object.status)
	if (status === undefined) {
		if (!hasLocalFollowers(db, actor.id)) {
			return ignored('unrelated')
		}
		const fetched = input.prefetched?.statuses[object.status]
		if (fetched === undefined) {
			// Signed by a local follower, as Mastodon's status_from_object fetches on behalf of one, so a status for the
			// author's followers is served.
			return {
				...ignored('need-object'),
				need: { kind: 'status', uri: object.status, signer: localFollower(db, actor.id) ?? 'instance' },
			}
		}
		if (fetched === null) {
			return ignored('unfetchable')
		}
		const stored = storeRemoteStatus(db, actor, fetched, {
			now: input.now,
			origin: input.origin,
			deliveredTo: null,
			fetched: true,
		})
		status = stored.statusId === undefined ? undefined : statusByUri(db, object.status)
	}
	if (status === undefined) {
		return ignored('unknown-object')
	}
	if (!pinRemote(db, actor.id, status.id, input.now)) {
		return ignored('not-pinned')
	}
	// A pinned status arrives as a root, cached or not: a cached one's quote is promoted (quotes.ts).
	promoteQuote(db, status.id, quoteArrival(db, actor.id, null), input.now)
	return applied('pinned')
}

const remove: Handler<'Remove'> = (db, actor, activity) => {
	const collection = collectionOf(db, actor.id, activity.target)
	const { object } = activity
	if ('hashtag' in object) {
		if (collection === null) {
			return ignored('not-collection')
		}
		return unfeatureRemote(db, actor.id, object.hashtag) ? applied('unfeatured') : ignored('not-featured')
	}
	if (collection !== 'featured') {
		return ignored('not-collection')
	}
	return unpinRemote(db, actor.id, object.status) ? applied('unpinned') : ignored('not-pinned')
}

// R34: receive an inbound Flag, as Mastodon's ActivityPub::Activity::Flag (reports.ts fileRemoteReports).
const flag: Handler<'Flag'> = (db, actor, activity, { now }) => {
	const filed = fileRemoteReports(db, actor, activity, now)
	return filed.filed ? applied(filed.reason) : ignored(filed.reason)
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
	RelayedDelete: relayedDelete,
	QuoteRequest: quoteRequest,
	Create: create,
	UpdateStatus: updateStatus,
	Like: like,
	Announce: announce,
	Add: add,
	Remove: remove,
	Flag: flag,
}

export const receiveActivity = writeOperation<StoreReceiveInput, ReceiveAnswer>((db, input) => {
	const before = outboundMark(db)
	const { need, ...result } = receive(db, input)
	const answer = { ...result, delivers: outboundSince(db, before) }
	if (need === undefined) {
		return answer
	}
	// The need's fetch, prepared in the transaction that decided it, signed as the need designates (DATA-7).
	const by = need.signer === undefined ? (input.recipient ?? null) : designatedSigner(need.signer)
	return { ...answer, need: { ...need, prefetch: fetchPreparation(db, by, need.uri) } }
})

// What an unavailable actor's activity may still do (R38): its Deletes, a DeleteActor, an Undo and a Reject, which only
// remove state. A Reject ending our follow of it must apply, since local follows of a suspended account are kept (R38).
// Mastodon also admits Update (process_collection_service.rb:59-61); Kopje does not.
const SUSPENDED_ADMITS: ReadonlySet<InboundActivity['type']> = new Set([
	'Delete',
	'RelayedDelete',
	'DeleteActor',
	'Undo',
	'Reject',
])

function receive(db: Db, input: StoreReceiveInput): ReceiveResult {
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
	// R38, VIS-30: the inbound gate, in every round. An unavailable actor (individually suspended) first takes a routing
	// refresh from its verified document; then only its cleanups apply, with its stored row and no upsert (SUSPENDED_
	// ADMITS), and anything else is ignored. An actor an instance domain block covers is held the same way, without the
	// refresh; one with no stored row has nothing to clean up, and nothing of it is stored.
	// The routing refresh and the upsert store the document only while the revision the Worker read before fetching it
	// holds (DocumentRevision), so a round after the first, or a document fetched before another store committed, stores
	// nothing (ID-1). A non-Update activity was verified against that document, and applies with the stored row; an
	// Update(Person) whose document was superseded is answered 503, and its retry fetches the document again.
	const held = unavailableRemote(db, actorUri)
	if (held === undefined && actorDomainBlocked(db, actorUri)) {
		return ignored('actor-suspended')
	}
	if (held !== undefined) {
		if (input.actor !== null && revisionHolds(db, actorUri, input.actorRevision)) {
			refreshRouting(db, held.id, input.actor)
		}
		if (!SUSPENDED_ADMITS.has(activity.type)) {
			return ignored('actor-suspended')
		}
	}
	const upserted =
		held === undefined && input.actor !== null && activity.type !== 'DeleteActor'
			? upsertRemoteActor(db, input.actor, origin, now, input.actorRevision)
			: undefined
	if (upserted === 'superseded' && activity.type === 'UpdateActor') {
		retryLater('actor-changed')
	}
	const actor =
		held ??
		(input.actor === null || activity.type === 'DeleteActor' || upserted === 'superseded'
			? remoteAccount(db, actorUri)
			: upserted)
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
	const result = handler(db, actor, activity, input)
	// A sync of the actor's collections was asked for, or quotes have verification work due (only the job rounds verify
	// them): the Worker asks the Queue for a round (cron runs one regardless).
	const waiting = ('syncWaiting' in actor && actor.syncWaiting) || quotesDue(db, now)
	return waiting ? { ...result, jobsPending: true } : result
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
		// A batch of the stamp revocations still being applied (quotes.ts), within PURGE_BATCH rows.
		const budget = new Budget(db, PURGE_BATCH)
		const revoking = continueRevocations(db, () => budget.left(), now)
		return {
			pending: revoking || db.first('SELECT 1 AS x FROM inbound_jobs WHERE done_at IS NULL') !== undefined,
			delivers: outboundSince(db, before),
		}
	}
)

// Whether a personal inbox path names a local account with its exact stored username.
function ownerExists(db: Db, username: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x FROM accounts a JOIN local_accounts l ON l.account_id = a.id
			WHERE a.domain IS NULL AND lower(a.username) = lower(?1) AND a.username = ?1`,
			username
		) !== undefined
	)
}

export const inboxOwnerExists = readOperation<{ username: string }, boolean>((db, { username }) =>
	ownerExists(db, username)
)

// What a fetch a Store answer decided needs, read in that answer (store.ts, the rule): its signer by DATA-7's rule
// (fetchSignerOf), wrapped (DATA-1), and the domain policy's verdict for its first request (ticketFor; null when the
// loader would refuse the target anyway). Optional: the Worker reads what is missing itself, as it would without it.
export type FetchPreparation = { signer: FetchSigner; ticket: PolicyTicket | null }

// The one producer of FetchPreparation, for the two answers that decide a fetch: the inbox gate and a receiveActivity
// need. Null for a target of this instance's own origin: the handling paths it serves never fetch one
// (federation/inbound.ts fetchNeeded and prepare), so no key leaves the Store for it; a signature key at this origin,
// which Fedify may still fetch, then costs the Worker its own signer and policy reads.
export function fetchPreparation(db: Db, by: string | FollowerSigner | null, target: string): FetchPreparation | null {
	const domain = instanceDomainOf(db)
	if (domain !== null && originOf(target) === `https://${domain}`) {
		return null
	}
	return { signer: fetchSignerOf(db, by), ticket: ticketFor(db, target) }
}

// now: judges the stored key only to decide whether a fetch follows (verification judges it again at its lookup,
// federation/inbound.ts lookupKey). fetches: the URL the activity's handling fetches first whatever the key
// (federation/inbound.ts fetchesFirst), or null.
// target: the target a Move's envelope names, whose revision is read with the actor's.
export type InboxGateInput = {
	username: string | null
	actor: string | null
	keyId: string | null
	now: number
	fetches: string | null
	target: string | null
}

export type InboxGate = {
	domain: string | null
	// null: a shared inbox.
	ownerExists: boolean | null
	// null: the envelope names no usable actor.
	domainBlocked: boolean | null
	// null: the request names no key id the Worker could read.
	key: { keyId: string; stored: GateKey | null } | null
	// The preparation of the request's first fetch, for the inbox's signer (the recipient's, DATA-7): only when a fetch
	// follows, the key's (missing or stale) or the activity's own; null otherwise, so a warm request carries no key.
	prefetch: FetchPreparation | null
	// The revisions of the actor and of the Move's target (actorRevision; null for none named), read before any of their
	// documents is fetched: the expectations their stores compare (DocumentRevision).
	revisions: { actor: DocumentRevision; target: DocumentRevision }
}

// What an inbound request is judged on before it is verified (federation/inbox.ts processInbox), in one read: the
// same lookups as instanceDomain, inboxOwnerExists, actorDomainBlocked and remoteKey, and the first fetch's preparation
// when the request gets that far (set up, an inbox of someone, an actor no block covers, a signature). Advisory:
// receiveActivity decides again in its own transaction (receive's gate, the recipient, the local-actor rule).
export const inboxGate = readOperation<InboxGateInput, InboxGate>((db, input) => {
	const { username, actor, keyId } = input
	const domain = instanceDomainOf(db)
	const owner = username === null ? null : ownerExists(db, username)
	const domainBlocked = actor === null ? null : actorDomainBlocked(db, actor)
	const stored = keyId === null ? null : remoteKeyOf(db, keyId)
	const target =
		keyId === null ? null : stored === null || !keyFresh(stored.fetchedAt, input.now) ? keyId : input.fetches
	return {
		domain,
		ownerExists: owner,
		domainBlocked,
		key: keyId === null ? null : { keyId, stored },
		prefetch:
			domain !== null && owner !== false && domainBlocked === false && target !== null
				? fetchPreparation(db, username, target)
				: null,
		revisions: {
			actor: actor === null ? null : actorRevision(db, actor),
			target: input.target === null ? null : actorRevision(db, input.target),
		},
	}
})
