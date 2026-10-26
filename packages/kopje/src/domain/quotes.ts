import {
	type QuoteRequestRef,
	quoteAnswerActivity,
	quoteRequestUri,
	recordOutbound,
	stampUri,
	statusFacts,
	statusReach,
	updateActivity,
} from './activities'
import {
	audienceSql,
	availableLocalSql,
	DISTRIBUTABLE_SQL,
	isDistributable,
	mayQuoteSql,
	MENTION_STATUS_COLUMNS,
	mentionStatusSql,
	type Visibility,
} from './audience'
import { NEW_GENERATION } from './ids'
import {
	actorRevision,
	applyRefresh,
	type DocumentRevision,
	isDeleted,
	isDeletedActor,
	remoteAccount,
	type RemoteActorInput,
	type RemoteRow,
	RETRACTION_TTL_MS,
	RetryLater,
	staleAccount,
	SWEEP_BATCH,
	upsertRemoteActor,
} from './inbox'
import { notify } from './notifications'
import { readOperation, writeOperation } from './operation'
import { localFollower } from './remote-collections'
import {
	followersUri,
	type RemoteQuoteInput,
	type RemoteStatusInput,
	statusByUri,
	storeRemoteStatus,
	visibilityOf,
} from './remote-statuses'
import { iso } from './statuses'
import { QUOTES_STATUS_INDEX, STATUSES_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'

// Quote posts received from remote servers (Mastodon 4.5's Quote, ActivityPub::Parser::StatusParser's quote
// properties, ActivityPub::VerifyQuoteService and the Delete of a QuoteAuthorization), stored and verified in the rows
// of migration 0033_quotes. Clients read them only through the policy module (audience.ts quoteReads, R35) and the
// quotes list's window (acceptedQuoteWindow).
//
// A quote is stored with the status that makes it (recordQuote, from storeRemoteStatus and updateRemoteStatus, so every
// path that stores a remote status records it), in the same transaction, with its verification work: verify_after
// says it is due. Only the Worker's job rounds verify it (federation/quotes.ts, claimQuotes): the inbox request that
// made work due asks the Queue for a round, and cron runs one too, so a Worker that dies after the commit only delays
// it. A round leases what it claims, so the generation, the lease and the recheck flag (the rule at the column,
// migration 0033_quotes) are the only concurrency to reason about.
//
// Verification (verifyQuote's checks in completeQuote) follows FEP-044f and Mastodon: a quote is accepted only when it
// quotes its own author's status (a self-quote), or when the quoted author's stamp (QuoteAuthorization) fetched from
// its id names exactly this quote, was never revoked (quote_revocations) and was not retracted by its author. A local
// quoted status is never accepted here: only Kopje's own decision accepts one (not built yet). A status stored as a
// quoted target during verification gets one hop less of work, so one traversal stops two levels below the status
// that arrived; a status that arrives again as a root promotes its quote back to the full budget (promoteQuote).

// The work budget of a quote whose status arrived as a root (delivered, boosted, searched, fetched as a pin).
export const QUOTE_HOPS = 2
// Quotes one job round verifies at most, oldest due first, within one request's fetch budget.
export const QUOTE_ROUND = 10
// The delays before each retry of a verification that failed in a way that may pass (Mastodon retries five times).
// After the last one the work is given up, and the quote stays pending until its status arrives again.
export const QUOTE_BACKOFF_MS = [1, 5, 30, 120, 720].map((minutes) => minutes * 60 * 1000)
// The stages one quote's verification runs at most in a round: the quoted status, its author, the status again, the
// stamp, and the decision (federation/quotes.ts verifyQuote).
export const QUOTE_STAGES = 5
// How long a round's claim holds a quote from other rounds: longer than a live round can run, so its lease never
// expires under it. A stage's fetches all end by its fetch budget's deadline (REQUEST_DEADLINE_MS, 15 s: the loader
// bounds each load, redirects, signing and body included, by what is left of it), and a round runs at most
// QUOTE_ROUND quotes of QUOTE_STAGES stages one after another: 10 × 5 × 15 s = 12.5 minutes of fetching at worst.
// Twice that covers the Store RPCs between stages and the JSON-LD processing; federation/quotes.ts checks it as it
// loads.
export const QUOTE_LEASE_MS = 25 * 60 * 1000
// Unresolved quotes that one newly stored status links at most (the rest stay unresolved, by uri), as replies are.
export const MAX_LINKED_QUOTES = 100

export type QuoteState = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'deleted'

// Whether a round holds a quote's work: its claim's lease, which lasts only while verify_after still equals it.
// Null-safe (IS), so NOT of it holds for work with no due time.
const LEASED = '(lease_until IS NOT NULL AND verify_after IS lease_until AND lease_until > ?3)'

// How a status came: hops is its work's budget (QUOTE_HOPS for a root), fetchAs the local account whose key may fetch
// for it (the owner of the personal inbox it was delivered to, else a local follower of its author), or null.
export type QuoteArrival = { hops: number; fetchAs: string | null }

export function quoteArrival(db: Db, authorId: string, deliveredTo: string | null, hops = QUOTE_HOPS): QuoteArrival {
	return { hops, fetchAs: deliveredTo ?? localFollower(db, authorId)?.follower ?? null }
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

type QuoteRow = {
	status_id: string
	status_uri: string
	account_id: string
	author_uri: string
	quoted_uri: string | null
	quoted_status_id: string | null
	state: QuoteState
	approval_uri: string | null
	attempts: number
	hops: number
	fetch_as: string | null
	need_author: string | null
	generation: number
	recheck: number
}

function quoteRow(db: Db, statusId: string): QuoteRow | undefined {
	return db.first<QuoteRow>(
		`SELECT q.status_id, s.uri AS status_uri, s.account_id, a.uri AS author_uri, q.quoted_uri, q.quoted_status_id,
			q.state, q.approval_uri, q.attempts, q.hops, q.fetch_as, q.need_author, q.generation, q.recheck
		FROM quotes q JOIN statuses s ON s.id = q.status_id JOIN accounts a ON a.id = s.account_id
		WHERE q.status_id = ?`,
		statusId
	)
}

// Mastodon's ActivityPub::Activity::Create#process_quote and ProcessStatusUpdateService#update_quote!: the quote a
// stored status's Note names, written with its work. A Note that names none removes the status's quote; a Tombstone is
// a deleted quote, with no work; a quote whose target or stamp changed starts over as pending (the count trigger takes
// an accepted one off its target); an unchanged one is promoted when its status arrived as a root. A stamp of this
// instance's origin is not a remote stamp, and is dropped (StatusParser#quote_approval_uri). A quoted Note embedded in
// the status (design §5.1, Mastodon's safe_prefetched_embed) is stored first, with one hop less of work, only when it
// is the status's author's own (its attributedTo is the author, its id on the author's origin): the author vouches for
// it as for the status itself, so a private self-quote that its server serves nobody is still known. A withdrawn status
// (its Delete recorded, its removal under way) is never linked as the quoted status.
export function recordQuote(
	db: Db,
	status: { id: string; uri: string; author: { id: string; uri: string } },
	quote: RemoteQuoteInput | null | undefined,
	arrival: QuoteArrival,
	ctx: { now: number; origin: string }
): void {
	const named = quote === undefined || quote === null || (!quote.tombstone && quote.uri === status.uri) ? null : quote
	const existing = db.first<{
		quoted_uri: string | null
		approval_uri: string | null
		state: QuoteState
		legacy: number
	}>('SELECT quoted_uri, approval_uri, state, legacy FROM quotes WHERE status_id = ?', status.id)
	if (named === null) {
		if (existing !== undefined) {
			db.run('DELETE FROM quotes WHERE status_id = ?', status.id)
		}
		return
	}
	// The embedded quoted Note is taken first, whether or not the quote changed: an Update may embed what an earlier
	// version only named.
	const embedded = named.tombstone ? null : (named.embedded ?? null)
	if (
		embedded !== null &&
		arrival.hops > 0 &&
		embedded.uri === named.uri &&
		embedded.attributedTo === status.author.uri &&
		originOf(embedded.uri) === originOf(status.author.uri) &&
		db.first('SELECT 1 AS x FROM statuses WHERE uri = ?', embedded.uri) === undefined
	) {
		storeRemoteStatus(db, status.author, embedded, {
			now: ctx.now,
			origin: ctx.origin,
			deliveredTo: null,
			fetched: true,
			quoteHops: arrival.hops - 1,
		})
	}
	const approval =
		named.tombstone || named.approvalUri === null || originOf(named.approvalUri) === ctx.origin
			? null
			: named.approvalUri
	const legacy = named.legacy ? 1 : 0
	if (
		existing !== undefined &&
		existing.quoted_uri === named.uri &&
		existing.approval_uri === approval &&
		existing.legacy === legacy &&
		(existing.state === 'deleted') === named.tombstone
	) {
		promoteQuote(db, status.id, arrival, ctx.now)
		return
	}
	// A quote of a local status is decided by Kopje's answer to its QuoteRequest alone (answerQuoteRequest), never by a
	// verification round: it gets no work (design, Concurrency: Defaults 7).
	const work = !named.tombstone && arrival.hops > 0 && originOf(named.uri) !== ctx.origin
	db.run(
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, legacy, approval_uri,
			verify_after, attempts, hops, fetch_as, generation, updated_at)
		SELECT ?1, ?2, t.id, t.account_id, CASE WHEN ?3 THEN 'deleted' ELSE 'pending' END, ?4, ?5, ?6, 0, ?7, ?8,
			${NEW_GENERATION}, ?9
		FROM (SELECT NULL) LEFT JOIN statuses t ON NOT ?3 AND t.uri = ?2 AND t.reblog_of_id IS NULL
			AND t.withdrawn = 0 AND t.id <> ?1
		WHERE true
		ON CONFLICT (status_id) DO UPDATE SET quoted_uri = excluded.quoted_uri, quoted_status_id = excluded.quoted_status_id,
			quoted_account_id = excluded.quoted_account_id, state = excluded.state, legacy = excluded.legacy, approval_uri = excluded.approval_uri,
			verify_after = excluded.verify_after, attempts = 0, hops = excluded.hops, fetch_as = excluded.fetch_as,
			need_author = NULL, generation = excluded.generation, recheck = 0, lease_until = NULL,
			authorization_id = NULL, activity_uri = NULL, updated_at = excluded.updated_at`,
		status.id,
		named.uri,
		named.tombstone ? 1 : 0,
		legacy,
		approval,
		work ? ctx.now : null,
		named.tombstone ? 0 : Math.max(0, Math.min(arrival.hops, QUOTE_HOPS)),
		named.tombstone ? null : arrival.fetchAs,
		iso(ctx.now)
	)
}

// ProcessStatusUpdateService#handle_implicit_update!: an Update that names no newer version never changes which status
// is quoted, but a changed stamp of the same quote is recorded (and verified again); anything else only promotes the
// quote, the status having arrived again as a root.
export function refreshQuote(
	db: Db,
	status: { id: string; uri: string; author: { id: string; uri: string } },
	quote: RemoteQuoteInput | null | undefined,
	arrival: QuoteArrival,
	ctx: { now: number; origin: string }
): void {
	const stored = db.first<{ quoted_uri: string | null }>('SELECT quoted_uri FROM quotes WHERE status_id = ?', status.id)
	if (stored !== undefined && quote?.tombstone === false && quote.uri === stored.quoted_uri) {
		recordQuote(db, status, quote, arrival, ctx)
	} else {
		promoteQuote(db, status.id, arrival, ctx.now)
	}
}

// A root re-arrival renews a pending quote's full budget and due time, using its fetch identity when present.
// Verification arrivals (fewer hops) promote nothing, nor do quotes of local statuses (no work: recordQuote) or local
// quoting statuses (no round decides them: test/quote-authoring.test.ts concurrency row 17).
export function promoteQuote(db: Db, statusId: string, arrival: QuoteArrival, now: number): void {
	if (arrival.hops < QUOTE_HOPS) {
		return
	}
	db.run(
		`UPDATE quotes SET hops = ?2, attempts = 0, verify_after = ?3, fetch_as = COALESCE(?4, fetch_as), updated_at = ?5,
			generation = ${NEW_GENERATION}
		WHERE status_id = ?1 AND state = 'pending' AND quoted_uri IS NOT NULL AND local = 0
			AND NOT EXISTS (SELECT 1 FROM local_accounts l WHERE l.account_id = quotes.quoted_account_id)`,
		statusId,
		QUOTE_HOPS,
		now,
		arrival.fetchAs,
		iso(now)
	)
}

// A newly stored status is the target of the unresolved quotes that name its uri: at most MAX_LINKED_QUOTES are linked,
// and those with a work budget left are due again. One a round holds is left alone: its round links it in its own stage
// (completeQuote finds the target by its uri), and if the round dies, the next claim after the lease does.
export function linkQuotes(db: Db, status: { id: string; uri: string }, now: number): void {
	db.run(
		`UPDATE quotes SET quoted_status_id = ?1, quoted_account_id = (SELECT account_id FROM statuses WHERE id = ?1),
			need_author = NULL, generation = ${NEW_GENERATION}, verify_after = CASE WHEN hops > 0 THEN ?3 ELSE verify_after END,
			attempts = CASE WHEN hops > 0 THEN 0 ELSE attempts END, updated_at = ?4
		WHERE status_id IN (SELECT status_id FROM quotes
			WHERE quoted_uri = ?2 AND quoted_status_id IS NULL AND state = 'pending' AND status_id <> ?1 AND NOT ${LEASED}
			LIMIT ?5)`,
		status.id,
		status.uri,
		now,
		iso(now),
		MAX_LINKED_QUOTES
	)
}

// Whether the quote of `statusId` has verification work due at `now`.
export function quoteDue(db: Db, statusId: string, now: number): boolean {
	return db.first('SELECT 1 AS x FROM quotes WHERE status_id = ? AND verify_after <= ?', statusId, now) !== undefined
}

// Whether any quote has verification work due (a seek of quotes_due).
export function quotesDue(db: Db, now: number): boolean {
	return db.first('SELECT 1 AS x FROM quotes WHERE verify_after <= ? ORDER BY verify_after LIMIT 1', now) !== undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Verification: what the Worker needs to fetch (quoteWork), and what it fetched (completeQuote)
// ---------------------------------------------------------------------------------------------------------------

// What the Worker fetched: a document, or why it has none. gone: 404 or 410; unusable: refused, or not what was asked
// for; transient: may pass later (a fetch budget or deadline that ran out included).
export type Fetched<T> = { kind: 'ok'; value: T } | { kind: 'gone' } | { kind: 'unusable' } | { kind: 'transient' }

// A stamp as the Worker read it, ids only (an inlined object counts by its id, and is never trusted beyond it).
export type StampInput = {
	// The document has the ActivityStreams context.
	context: boolean
	types: string[]
	id: string | null
	attributedTo: string | null
	interactingObject: string | null
	interactionTarget: string | null
}

// The stage a quote's verification is at, each one fetch of the Worker's within a fetch budget of its own (redirects
// included): the quoted status (not stored yet), its author (the address a fetch of the status recorded in need_author,
// the author unknown or stale: staleAccount), the stamp; decide: nothing left to fetch.
export type QuoteStage = 'quoted' | 'author' | 'stamp' | 'decide'

export type QuoteWork = {
	statusId: string
	quotedUri: string
	approvalUri: string | null
	stage: QuoteStage
	// The document the stage fetches: the quoted status, its author or the stamp.
	fetch: string | null
	// The username of the local account whose key fetches for this work (fetch_as, rechecked), or null for the instance
	// actor.
	signer: string | null
	// The work's generation: the stage's outcome applies only while it is unchanged.
	generation: number
	// The author stage's: the author's revision read before its fetch (inbox.ts DocumentRevision), which a refetched
	// document is stored under (applyRefresh); null for the other stages.
	authorRevision: DocumentRevision
}

type Linked = { id: string; uri: string; account_id: string; author_uri: string; visibility: Visibility; local: number }

// The quote's quoted status: the one linked, or else the one stored under its uri (never a boost), which a status
// stored after more than MAX_LINKED_QUOTES quotes named it was never linked to; never a withdrawn one (its removal
// has begun).
function quotedOf(db: Db, row: QuoteRow): Linked | undefined {
	return db.first<Linked>(
		`SELECT t.id, t.uri, t.account_id, a.uri AS author_uri, t.visibility, a.domain IS NULL AS local
		FROM statuses t JOIN accounts a ON a.id = t.account_id
		WHERE (t.id = ?1 OR (?1 IS NULL AND t.uri = ?2 AND t.reblog_of_id IS NULL AND t.id <> ?3)) AND t.withdrawn = 0
		LIMIT 1`,
		row.quoted_status_id,
		row.quoted_uri,
		row.status_id
	)
}

function revoked(db: Db, approvalUri: string, authorUri: string): boolean {
	return (
		db.first(
			'SELECT 1 AS x FROM quote_revocations WHERE authorization = ? AND actor_uri = ?',
			approvalUri,
			authorUri
		) !== undefined
	)
}

// The stage of a quote whose quoted status is known: the stamp, unless nothing a stamp says can decide it (a
// self-quote, a local or non-public target, no stamp, a stamp its author revoked).
function stampStage(db: Db, row: QuoteRow, quoted: Linked): boolean {
	return (
		quoted.account_id !== row.account_id &&
		quoted.local !== 1 &&
		isDistributable(quoted.visibility) &&
		row.approval_uri !== null &&
		!revoked(db, row.approval_uri, quoted.author_uri)
	)
}

// Whether the author a quoted status names is fetched before the status is stored: one with no row, or a stored remote
// one that is stale (staleAccount, Mastodon's account_from_uri).
function authorDue(db: Db, uri: string, now: number): boolean {
	const account = db.first<{ id: string }>('SELECT id FROM accounts WHERE uri = ?', uri)
	return account === undefined || staleAccount(db, account.id, now)
}

// The stage a quote's work is at now, and the document it fetches. Derived from the row and from what the Store has
// (the quoted status, its author and that author's age), so it can move without the row changing: an outcome is
// checked against it too.
function stageOf(
	db: Db,
	row: QuoteRow,
	now: number,
	quoted = quotedOf(db, row)
): { stage: QuoteStage; fetch: string | null } {
	if (quoted !== undefined) {
		return stampStage(db, row, quoted) ? { stage: 'stamp', fetch: row.approval_uri } : { stage: 'decide', fetch: null }
	}
	return row.need_author !== null && authorDue(db, row.need_author, now)
		? { stage: 'author', fetch: row.need_author }
		: { stage: 'quoted', fetch: row.quoted_uri }
}

// Whether an outcome computed for `expected` still belongs to the work: the same generation, and the same stage and
// fetch address (a stage another path moved on, as an author some other request stored, takes no outcome).
function current(
	db: Db,
	row: QuoteRow,
	expected: { generation: number; stage: QuoteStage; fetch: string | null; now: number },
	quoted = quotedOf(db, row)
) {
	if (row.generation !== expected.generation) {
		return false
	}
	const at = stageOf(db, row, expected.now, quoted)
	return at.stage === expected.stage && at.fetch === expected.fetch
}

// An outcome for a stage the work has left: discarded, and the current stage left due (a renewal: a new generation).
function moved(db: Db, row: QuoteRow, now: number): QuoteVerified {
	db.run(`UPDATE quotes SET verify_after = ?2, generation = ${NEW_GENERATION} WHERE status_id = ?1`, row.status_id, now)
	return { done: false, due: true, state: row.state, next: true }
}

// The quote of `statusId` when it has work to do (pending, or accepted and being checked again), with the stage it is
// at. fetch_as is rechecked here: it signs only while it is an available local account that is still a recipient of the
// quoting status (status_mentions, silent included) or an accepted follower of its author; otherwise the instance
// actor fetches.
export const quoteWork = readOperation<{ statusId: string; now: number }, QuoteWork | null>((db, { statusId, now }) => {
	const row = quoteRow(db, statusId)
	if (row === undefined || row.quoted_uri === null || (row.state !== 'pending' && row.state !== 'accepted')) {
		return null
	}
	const { stage, fetch } = stageOf(db, row, now)
	const signer =
		row.fetch_as === null
			? undefined
			: db.first<{ username: string }>(
					`SELECT a.username FROM local_accounts l JOIN accounts a ON a.id = l.account_id
					WHERE l.account_id = ?1 AND ${availableLocalSql('l')}
						AND (EXISTS (SELECT 1 FROM status_mentions m WHERE m.status_id = ?2 AND m.account_id = ?1)
							OR EXISTS (SELECT 1 FROM follows f WHERE f.account_id = ?1 AND f.target_account_id = ?3 AND f.state = 'accepted'))`,
					row.fetch_as,
					row.status_id,
					row.account_id
				)
	return {
		statusId: row.status_id,
		quotedUri: row.quoted_uri,
		approvalUri: row.approval_uri,
		stage,
		fetch,
		signer: signer?.username ?? null,
		generation: row.generation,
		authorRevision: stage === 'author' && fetch !== null ? actorRevision(db, fetch) : null,
	}
})

export type QuoteVerification = {
	statusId: string
	now: number
	origin: string
	// The work as quoteWork read it: a row whose target or stamp changed since takes nothing from this result (the new
	// one has its own work).
	quotedUri: string
	approvalUri: string | null
	// The generation the stage read (quoteWork, or the round's claim), and the stage and fetch address it ran: an outcome
	// for anything else is discarded.
	generation: number
	stage: QuoteStage
	fetch: string | null
	// What the stage fetched: the quoted status, its author's document or the stamp.
	quoted?: Fetched<RemoteStatusInput>
	author?: Fetched<RemoteActorInput>
	// The work's authorRevision, with author: absent, a refetched document stores nothing over the stored row.
	authorRevision?: DocumentRevision
	stamp?: Fetched<StampInput>
}

// done: no work of this quote is due now (finished, or retried after a backoff); due: some quote has work due now (a
// quoted status this stored has a quote of its own to verify); next: a stage was completed and kept, and another is
// waiting, which the Worker may run at once.
export type QuoteVerified = { done: boolean; due: boolean; state: QuoteState | null; next: boolean }

// The end of one verification: the state it leaves and its work: done (none left) or retry (a failure that may pass:
// the next attempt after QUOTE_BACKOFF_MS, none after the last; an attempt is charged). A stamp found valid while a
// relayed Delete asked for a recheck is checked once more, at once. The author address a stage recorded stays only
// while work is left.
function finish(
	db: Db,
	row: QuoteRow,
	state: QuoteState,
	work: 'done' | 'retry',
	now: number,
	keep: string | null = null
): QuoteVerified {
	const attempts = work === 'retry' ? row.attempts + 1 : row.attempts
	const delay = work === 'retry' ? QUOTE_BACKOFF_MS[attempts - 1] : undefined
	const again = row.recheck === 1 && work === 'done' && state === 'accepted'
	const verifyAfter = again ? now : delay === undefined ? null : now + delay
	const fetched = work === 'done' || (work === 'retry' && delay === undefined) ? null : keep
	db.run(
		`UPDATE quotes SET state = ?2, verify_after = ?3, attempts = ?4, need_author = ?5, updated_at = ?6,
			generation = ${NEW_GENERATION}, recheck = 0, lease_until = NULL
		WHERE status_id = ?1`,
		row.status_id,
		state,
		verifyAfter,
		attempts,
		fetched,
		iso(now)
	)
	return { done: !again, due: quotesDue(db, now), state, next: false }
}

// A failed fetch's outcome: gone or unusable end the work; one that may pass (a fetch budget or deadline that ran out
// included) charges an attempt: the stage had a whole budget of its own. A stale stored author's refetch is not one of
// these (refreshQuoted).
function failed(
	db: Db,
	row: QuoteRow,
	keep: QuoteState,
	fetched: Fetched<unknown>,
	input: QuoteVerification,
	held: string | null
) {
	return fetched.kind !== 'transient'
		? finish(db, row, keep, 'done', input.now)
		: finish(db, row, keep, 'retry', input.now, held)
}

// The stamp's checks (VerifyQuoteService#accept_quote! and FEP-044f "Verifying a quote"): a QuoteAuthorization with
// the ActivityStreams context, whose id is exactly the stamp the Note named, attributed to the quoted author on the
// stamp's own origin (ID-2), and naming exactly this quote of exactly that status.
function stampValid(stamp: StampInput, row: QuoteRow, quoted: Linked): boolean {
	return (
		stamp.context &&
		stamp.types.includes('QuoteAuthorization') &&
		stamp.id !== null &&
		stamp.id === row.approval_uri &&
		stamp.attributedTo !== null &&
		originOf(stamp.id) === originOf(stamp.attributedTo) &&
		stamp.attributedTo === quoted.author_uri &&
		stamp.interactingObject === row.status_uri &&
		stamp.interactionTarget === quoted.uri
	)
}

// The author stage of a stale stored author (applyRefresh): a document stored, or any failure other than 404 or 410
// stamped, moves on to the quoted stage, which stores the status under that row; no attempt is charged for the
// fallback. Gone ends the work as for an unknown author (no stamp: the next fetch of a status by them tries again). A
// row refreshed or stamped meanwhile is a stage the work left (current() sees it first).
function refreshQuoted(
	db: Db,
	row: QuoteRow,
	input: QuoteVerification,
	keep: QuoteState,
	stored: RemoteRow
): QuoteVerified {
	const { now, origin } = input
	const fetched = input.author!
	if (isDeletedActor(db, stored.uri, now)) {
		return finish(db, row, keep, 'done', now)
	}
	const document = fetched.kind === 'ok' ? fetched.value : fetched.kind === 'gone' ? 'gone' : null
	const refreshed = applyRefresh(db, stored, document, origin, now, input.authorRevision ?? null)
	if (refreshed.kind === 'current') {
		return moved(db, row, now)
	}
	if (refreshed.kind === 'refused' || refreshed.frozen) {
		return finish(db, row, keep, 'done', now)
	}
	db.run(`UPDATE quotes SET generation = ${NEW_GENERATION} WHERE status_id = ?`, row.status_id)
	return { done: false, due: true, state: keep, next: true }
}

// The quoted-status stages: a stage fetching the author it named stores that account (or refetches a stale stored one:
// refreshQuoted) and ends; one fetching the quoted status stores it, from that fresh fetch, once its author is known
// and not stale (staleAccount), and otherwise records only the author's address (need_author) for the next stage.
// Nothing fetched is kept between stages. Returns the linked status, or a stage's end.
function storeQuoted(db: Db, row: QuoteRow, input: QuoteVerification, keep: QuoteState): Linked | QuoteVerified {
	const { now, origin } = input
	const stored = row.need_author === null ? undefined : remoteAccount(db, row.need_author)
	if (input.author !== undefined && stored !== undefined) {
		return refreshQuoted(db, row, input, keep, stored)
	}
	if (input.author !== undefined) {
		const document = input.author
		if (document.kind !== 'ok') {
			return failed(db, row, keep, document, input, row.need_author)
		}
		if (document.value.uri !== row.need_author || isDeletedActor(db, document.value.uri, now)) {
			return finish(db, row, keep, 'done', now)
		}
		// An upsert that stores nothing (an unavailable author's row is frozen, R38) ends the work: the next stage could
		// store nothing of that author either.
		const stored = upsertRemoteActor(db, document.value, origin, now)
		if (stored === undefined || stored.frozen) {
			return finish(db, row, keep, 'done', now)
		}
		db.run(`UPDATE quotes SET generation = ${NEW_GENERATION} WHERE status_id = ?`, row.status_id)
		return { done: false, due: true, state: keep, next: true }
	}
	const fetched = input.quoted
	if (fetched === undefined) {
		return finish(db, row, keep, 'retry', now, row.need_author)
	}
	if (fetched.kind !== 'ok') {
		return failed(db, row, keep, fetched, input, row.need_author)
	}
	const status = fetched.value
	const authorUri = status.attributedTo
	if (
		status.uri !== row.quoted_uri ||
		authorUri === null ||
		authorUri.length > 2048 ||
		originOf(authorUri) !== originOf(status.uri) ||
		originOf(authorUri) === origin ||
		isDeletedActor(db, authorUri, now)
	) {
		return finish(db, row, keep, 'done', now)
	}
	const author = remoteAccount(db, authorUri)
	// A stale author is refetched by the author stage first, as an unknown one is fetched (the stage before refreshed or
	// stamped it, so the same author is never stale here again).
	if (author === undefined || (row.need_author !== authorUri && staleAccount(db, author.id, now))) {
		// A second fetch of the same unknown author ends the work: the stage before stored nobody under that address.
		if (row.need_author === authorUri) {
			return finish(db, row, keep, 'done', now)
		}
		// A status that names another author each time it is fetched pays for each change.
		if (row.need_author !== null) {
			return finish(db, row, keep, 'retry', now, authorUri)
		}
		db.run(
			`UPDATE quotes SET need_author = ?2, generation = ${NEW_GENERATION}, updated_at = ?3 WHERE status_id = ?1`,
			row.status_id,
			authorUri,
			iso(now)
		)
		return { done: false, due: true, state: keep, next: true }
	}
	// Only a public or unlisted status, or the quoting author's own, is ever accepted: nothing else is stored for it.
	if (authorUri !== row.author_uri && !isDistributable(visibilityOf(status, followersUri(db, author.id)))) {
		return finish(db, row, keep, 'done', now)
	}
	storeRemoteStatus(db, author, status, {
		now,
		origin,
		deliveredTo: null,
		fetched: true,
		quoteHops: Math.max(0, row.hops - 1),
	})
	return quotedOf(db, { ...row, quoted_status_id: null }) ?? finish(db, row, keep, 'done', now)
}

// Applies what the Worker fetched for one stage of a quote's work, in one transaction. A quoted status fetched is
// stored once its author is known (else only the author's address is recorded); a quote whose quoted status is stored
// (linked, or found by its uri and linked now) is decided. Only a pending quote is accepted, and only for a self-quote
// or a valid stamp; an accepted one being checked again is revoked only when its stamp is gone or no longer valid. A
// pending quote whose stamp is gone is rejected (Mastodon's VerifyQuoteService); one that fails a check stays pending,
// its work done. Every failure that may pass charges an attempt, a fetch budget or deadline that ran out included,
// except a stale stored author's refetch, which falls back to the stored account uncharged (refreshQuoted).
export const completeQuote = writeOperation<QuoteVerification, QuoteVerified>((db, input) => {
	const { now } = input
	const row = quoteRow(db, input.statusId)
	if (
		row === undefined ||
		(row.state !== 'pending' && row.state !== 'accepted') ||
		row.generation !== input.generation ||
		row.quoted_uri !== input.quotedUri ||
		row.approval_uri !== input.approvalUri
	) {
		return { done: true, due: quotesDue(db, now), state: row?.state ?? null, next: false }
	}
	// A quoted status whose removal has begun (withdrawn: its Delete is recorded) is gone: nothing is fetched or
	// decided for it, the work ends with the state it has, and its removal detaches the quote (inbox.ts STATUS_CHILDREN).
	if (
		db.first(
			'SELECT 1 AS x FROM statuses WHERE (id = ?1 OR (?1 IS NULL AND uri = ?2)) AND withdrawn = 1 LIMIT 1',
			row.quoted_status_id,
			row.quoted_uri
		) !== undefined
	) {
		return finish(db, row, row.state, 'done', now)
	}
	const target = quotedOf(db, row)
	if (!current(db, row, input, target)) {
		return moved(db, row, now)
	}
	const keep = row.state
	// What a stamp that is gone or invalid leaves: a pending quote rejected (gone) or still pending, an accepted one
	// revoked.
	const lost = (gone: boolean): QuoteState => (keep === 'accepted' ? 'revoked' : gone ? 'rejected' : 'pending')
	const found = target ?? storeQuoted(db, row, input, keep)
	if ('done' in found) {
		return found
	}
	const quoted = found
	if (row.quoted_status_id !== quoted.id) {
		db.run(
			`UPDATE quotes SET quoted_status_id = ?2, quoted_account_id = ?3, need_author = NULL, generation = ${NEW_GENERATION}
			WHERE status_id = ?1`,
			row.status_id,
			quoted.id,
			quoted.account_id
		)
	}
	// VerifyQuoteService: a boost is never quoted (linking takes originals only), and nothing hidden from the quote's
	// public is accepted unless it is the quoting author's own.
	if (quoted.account_id === row.account_id) {
		return finish(db, row, 'accepted', 'done', now)
	}
	if (!isDistributable(quoted.visibility) || quoted.local === 1 || row.approval_uri === null) {
		return finish(db, row, keep, 'done', now)
	}
	// Revoked by the quoted author (only theirs counts: anyone may Delete the same URI) or retracted by them.
	if (revoked(db, row.approval_uri, quoted.author_uri) || isDeleted(db, quoted.author_uri, row.approval_uri, now)) {
		return finish(db, row, lost(false), 'done', now)
	}
	const stamp = input.stamp
	if (stamp === undefined) {
		// The quoted status was stored by this stage: the stamp is the next.
		return { done: false, due: true, state: keep, next: true }
	}
	if (stamp.kind === 'gone') {
		return finish(db, row, lost(true), 'done', now)
	}
	if (stamp.kind !== 'ok') {
		return failed(db, row, keep, stamp, input, null)
	}
	return finish(db, row, stampValid(stamp.value, row, quoted) ? 'accepted' : lost(false), 'done', now)
})

// A job round's stage that failed in the Store itself (a document it could not store, as one past the row size
// limit): charged as a failure that may pass, so it is given up after the last retry, and never stops the other quotes
// of a round. Only the work of the generation the stage read is charged: a quote replaced since is a new work.
export const chargeQuote = writeOperation<
	{ statusId: string; generation: number; stage: QuoteStage; fetch: string | null; now: number },
	void
>((db, input) => {
	const row = quoteRow(db, input.statusId)
	if (
		row === undefined ||
		row.generation !== input.generation ||
		(row.state !== 'pending' && row.state !== 'accepted')
	) {
		return
	}
	if (current(db, row, input)) {
		finish(db, row, row.state, 'retry', input.now, row.need_author)
	} else {
		moved(db, row, input.now)
	}
})

// A job round's claim: the quotes due first, at most `limit`, each with the new generation the claim drew, held from
// other rounds for QUOTE_LEASE_MS (a round that dies leaves them to a later one). more: others are due too.
export const claimQuotes = writeOperation<
	{ now: number; limit: number },
	{ ids: string[]; generations: number[]; more: boolean }
>((db, { now, limit }) => {
	const ids = db
		.all<{ status_id: string }>(
			'SELECT status_id FROM quotes WHERE verify_after <= ? ORDER BY verify_after LIMIT ?',
			now,
			limit
		)
		.map((row) => row.status_id)
	if (ids.length === 0) {
		return { ids, generations: [], more: false }
	}
	// The claim draws a new generation: a round whose lease expired, and whose work another round claimed, has its late
	// outcome discarded.
	const claimed = new Map(
		db
			.all<{ status_id: string; generation: number }>(
				`UPDATE quotes SET verify_after = ?1, lease_until = ?1, generation = ${NEW_GENERATION}
				WHERE status_id IN (SELECT value FROM json_each(?2)) RETURNING status_id, generation`,
				now + QUOTE_LEASE_MS,
				JSON.stringify(ids)
			)
			.map((row) => [row.status_id, row.generation])
	)
	return { ids, generations: ids.map((id) => claimed.get(id)!), more: quotesDue(db, now) }
})

// ---------------------------------------------------------------------------------------------------------------
// Revocation: the Delete of a stamp
// ---------------------------------------------------------------------------------------------------------------

// The quotes a revocation still has to process, oldest first: the stamp and the actor whose Delete recorded it.
function pendingRevocation(db: Db): { authorization: string; actor_uri: string } | undefined {
	return db.first<{ authorization: string; actor_uri: string }>(
		'SELECT authorization, actor_uri FROM quote_revocations WHERE pending = 1 ORDER BY revoked_at LIMIT 1'
	)
}

// One batch of a revocation (Mastodon's Delete#revoke_quote, Quote#reject!): the quotes still pending or accepted that
// name the stamp and quote a status by the actor (a seek of quotes_approval, whatever other quotes name the stamp)
// become rejected or revoked, at most `left() / 2` (each row and the count trigger it fires). The predicate is the
// cursor: a processed row leaves it. Clears the revocation's pending mark once none is left. Returns whether rows
// remain.
function revocationBatch(db: Db, approvalUri: string, actorUri: string, left: () => number, now: number) {
	const actorId = db.first<{ id: string }>('SELECT id FROM accounts WHERE uri = ?', actorUri)?.id
	const room = Math.floor(left() / 2)
	if (actorId !== undefined && room > 0) {
		db.run(
			`UPDATE quotes SET state = CASE state WHEN 'accepted' THEN 'revoked' ELSE 'rejected' END, verify_after = NULL,
				updated_at = ?3, generation = ${NEW_GENERATION}
			WHERE status_id IN (SELECT status_id FROM quotes
				WHERE approval_uri = ?1 AND quoted_account_id = ?2 AND state IN ('pending', 'accepted') LIMIT ?4)`,
			approvalUri,
			actorId,
			iso(now),
			room
		)
	}
	const remaining =
		actorId !== undefined &&
		db.first(
			`SELECT 1 AS x FROM quotes
			WHERE approval_uri = ?1 AND quoted_account_id = ?2 AND state IN ('pending', 'accepted') LIMIT 1`,
			approvalUri,
			actorId
		) !== undefined
	if (!remaining && left() > 0) {
		db.run(
			'UPDATE quote_revocations SET pending = 0 WHERE authorization = ? AND actor_uri = ? AND pending = 1',
			approvalUri,
			actorUri
		)
		return false
	}
	return true
}

// A Delete of `approvalUri` by `actor` (its retraction recorded by the caller): when a stored quote of one of the
// actor's statuses names that stamp, the revocation is recorded once, for good and for that actor alone (another
// actor's Delete of the same URI revokes nothing of this one's), and its first batch runs within
// `left()`; the rest is continued by the inbound job rounds (continueRevocations), which meet received quotes only. A
// repeated Delete finds the revocation and adds nothing. The local quote holding the stamp is handled first, in this
// transaction and outside the batch budget, whether or not the revocation was recorded before: revoked, and, for a
// proven Delete (`forward`, the body as received), forwarded once (revokeLocalStamp).
// Returns null when no quote names the stamp, else whether batches remain.
export function revokeStamp(
	db: Db,
	actor: { id: string; uri: string },
	approvalUri: string,
	left: () => number,
	now: number,
	forward: Record<string, unknown> | null = null
): boolean | null {
	const local = revokeLocalStamp(db, actor, approvalUri, forward, now)
	const named =
		local ||
		db.first(
			'SELECT 1 AS x FROM quotes WHERE approval_uri = ? AND quoted_account_id = ? LIMIT 1',
			approvalUri,
			actor.id
		) !== undefined
	if (!named) {
		return null
	}
	const recorded = db.run(
		`INSERT INTO quote_revocations (authorization, actor_uri, revoked_at, pending) VALUES (?, ?, ?, 1)
		ON CONFLICT DO NOTHING`,
		approvalUri,
		actor.uri,
		now
	)
	if (recorded === 0) {
		return pendingRevocation(db) !== undefined
	}
	return revocationBatch(db, approvalUri, actor.uri, left, now)
}

// Batches of the revocations still pending, oldest first, within `left()`. Returns whether any remains.
export function continueRevocations(db: Db, left: () => number, now: number): boolean {
	for (let revocation = pendingRevocation(db); revocation !== undefined; revocation = pendingRevocation(db)) {
		if (revocationBatch(db, revocation.authorization, revocation.actor_uri, left, now)) {
			return true
		}
	}
	return false
}

// Leased pending quotes one relayed Delete marks at most: a bound on its writes, as only quotes whose fetch is in
// flight match (at most a round's claim each).
export const MAX_RECHECKED = 100

// A Delete of a stamp relayed by another server without the author's proof (federation/inbound.ts): nothing is revoked
// on its word, but the quotes of the actor's statuses that name the stamp and could still be accepted by it are checked
// again, their state unchanged until then, so a stamp that is gone revokes or rejects them. Replays coalesce:
//   - the accepted quote that a stamp accepted (one at most: a valid stamp names exactly one quoting status; a
//     self-quote, accepted without one, may name the stamp too and is passed over, and so is a local quote, which only
//     its quoted author's answers decide: VIS-28, quote-authoring concurrency row 17) is renewed when idle (due now,
//     attempts reset, a new generation), left as it is when due or backing off (its next fetch is fresh anyway), and
//     marked when a round has leased it;
//   - a pending quote is marked only when a round has leased it (its first stamp fetch is in flight), matched by the
//     stamp alone, since a round may not have linked its target yet (the target found by its uri); marking one of
//     another author's costs at most one more check. Otherwise its next fetch is fresh anyway.
// A marked quote keeps its generation, so the fetch in flight still applies, and is checked once more if that fetch
// finds the stamp valid. A round's 404 thus always applies, and a Delete that races a fetch is never lost. Returns
// whether such a quote exists.
export function recheckStamp(db: Db, actor: { id: string }, approvalUri: string, now: number): boolean {
	const accepted = db.first<{ status_id: string; verify_after: number | null; leased: number }>(
		`SELECT q.status_id, q.verify_after, ${LEASED} AS leased FROM quotes q JOIN statuses s ON s.id = q.status_id
		WHERE q.approval_uri = ?1 AND q.quoted_account_id = ?2 AND q.state = 'accepted' AND s.account_id <> ?2
			AND q.local = 0 LIMIT 1`,
		approvalUri,
		actor.id,
		now
	)
	if (accepted?.leased === 1) {
		db.run('UPDATE quotes SET recheck = 1 WHERE status_id = ?', accepted.status_id)
	} else if (accepted !== undefined && accepted.verify_after === null) {
		db.run(
			`UPDATE quotes SET verify_after = ?2, attempts = 0, hops = max(hops, 1), updated_at = ?3,
				generation = ${NEW_GENERATION}
			WHERE status_id = ?1`,
			accepted.status_id,
			now,
			iso(now)
		)
	}
	const marked = db.run(
		`UPDATE quotes SET recheck = 1 WHERE status_id IN (SELECT status_id FROM quotes INDEXED BY quotes_leased
			WHERE approval_uri = ?1 AND state = 'pending' AND ${LEASED} LIMIT ?4)`,
		approvalUri,
		actor.id,
		now,
		MAX_RECHECKED
	)
	return accepted !== undefined || marked > 0
}

// ---------------------------------------------------------------------------------------------------------------
// The quotes list (statuses.ts statusQuotes, R35)
// ---------------------------------------------------------------------------------------------------------------

// The window of the quotes list of `quotedId`: the quoting statuses of at most `limit` of its accepted quotes strictly
// between `max` and `min` (null: no bound), newest first, or oldest first when `ascending`. One seek of quotes_accepted
// (migration 0036_quotes_list) from the cursor; the caller applies the read rule to these ids only. With `audience`
// (the viewer's account id, null for anonymous), only quoting statuses whose visibility and audience let that viewer
// see them are candidates (audienceSql, docs/visibility.md "Read bounds"), so none supplies a cursor; the walk passes
// the others. Without it (the quoted author, who sees every quote, R35), it reads at most `limit` entries.
export function acceptedQuoteWindow(
	db: Db,
	quotedId: string,
	range: { readonly max: string | null; readonly min: string | null; readonly ascending: boolean },
	limit: number,
	audience?: string | null
): string[] {
	return db
		.all<{ status_id: string }>(
			`SELECT q.status_id FROM quotes q INDEXED BY quotes_accepted
			${audience === undefined ? '' : `CROSS JOIN statuses s ON s.id = q.status_id`}
			WHERE q.quoted_status_id = ?1 AND q.state = 'accepted' AND q.status_id < ?2 AND q.status_id > ?3
				${audience === undefined ? '' : `AND ${audienceSql('s', '?5')}`}
			ORDER BY q.status_id ${range.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			quotedId,
			range.max ?? ':',
			range.min ?? '',
			limit,
			...(audience === undefined ? [] : [audience])
		)
		.map((row) => row.status_id)
}

// ---------------------------------------------------------------------------------------------------------------
// Being quoted: QuoteRequests for local statuses, Kopje's stamps and their revocation (design §5.4, §5.5, VIS-28)
// ---------------------------------------------------------------------------------------------------------------

// Answered QuoteRequests one actor may have recorded at once (quote_requests, kept RETRACTION_TTL_MS). A request past
// it is refused with a retry (503), never by evicting a live row, as canRetract caps retractions; it also bounds the
// Rejects one revoke sends (every request answered for the quote is the actor's).
export const MAX_QUOTE_REQUESTS_PER_ACTOR = 100

// A fresh authorization id: 128 random bits, hex. Never reused: the unique index refuses a repeat, and a retired id
// stays in quote_revocations for good.
function freshAuthorization(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Quote#ensure_quoted_access: the quoted author `quotedAuthorId` becomes a silent recipient of the quoting status, so
// they may always see the quote of their status; an existing mention of them stays as it is.
export function ensureQuotedAccess(db: Db, quotingId: string, quotedAuthorId: string): void {
	db.run(
		`INSERT INTO status_mentions (status_id, account_id, silent, ${MENTION_STATUS_COLUMNS})
		VALUES (?1, ?2, 1, ${mentionStatusSql('?1')}) ON CONFLICT DO NOTHING`,
		quotingId,
		quotedAuthorId
	)
}

export type QuoteRequestInput = {
	id: string
	// The quoted status, and the quoting status (the instrument) by id, with the Note when the request inlined it.
	object: string
	instrument: string
	embedded: RemoteStatusInput | null
}

export type QuoteRequestOutcome =
	// as: the username of the quoted author, whose key signs the instrument's fetch (Mastodon fetches it on_behalf_of
	// them), so a Note addressed to them alone is served.
	{ kind: 'need'; uri: string; as: string } | { kind: 'ignored'; reason: string } | { kind: 'answered'; reason: string }

type QuotedTarget = {
	id: string
	uri: string
	account_id: string
	author_uri: string
	username: string
	allowed: number
}

// Mastodon's ActivityPub::Activity::QuoteRequest for a local status. Invariant: the answer is decided and written in
// this one transaction, the inbox's final Store round, and an earlier round returns `need` (the instrument, the only
// fetch) before any write (design, Concurrency: Defaults 1). R36 (mayQuoteSql) decides, read in that round; the stored
// quote row, never the fetched document, says what the instrument quotes; only a transition into accepted draws an
// authorization (VIS-28). Bounds: one answer per request id (ID-7), at most MAX_QUOTE_REQUESTS_PER_ACTOR live ones per
// actor (RetryLater past it), one fetch. What is answered and what is ignored: docs/visibility.md (R36) and
// docs/threat-model.md (VIS-28); a withdrawn status (its Delete recorded) is an unknown object.
export function answerQuoteRequest(
	db: Db,
	actor: { id: string; uri: string },
	request: QuoteRequestInput,
	ctx: { now: number; origin: string; deliveredTo: string | null; prefetched: RemoteStatusInput | null | undefined }
): QuoteRequestOutcome {
	const { now } = ctx
	if (db.first('SELECT 1 AS x FROM quote_requests WHERE activity_uri = ?', request.id) !== undefined) {
		return { kind: 'ignored', reason: 'duplicate' }
	}
	const quoted = db.first<QuotedTarget>(
		`SELECT t.id, t.uri, t.account_id, a.uri AS author_uri, a.username, ${mayQuoteSql('t', '?2')} AS allowed
		FROM statuses t JOIN accounts a ON a.id = t.account_id JOIN local_accounts l ON l.account_id = a.id
		WHERE t.uri = ?1 AND t.reblog_of_id IS NULL AND t.withdrawn = 0 AND t.visibility IN ${DISTRIBUTABLE_SQL}
			AND ${availableLocalSql('l')}`,
		request.object,
		actor.id
	)
	if (quoted === undefined) {
		return { kind: 'ignored', reason: 'unknown-object' }
	}
	const live =
		db.first<{ n: number }>(
			`SELECT count(*) AS n FROM (SELECT 1 FROM quote_requests WHERE actor_uri = ? AND answered_at > ? LIMIT ?)`,
			actor.uri,
			now - RETRACTION_TTL_MS,
			MAX_QUOTE_REQUESTS_PER_ACTOR
		)?.n ?? 0
	if (live >= MAX_QUOTE_REQUESTS_PER_ACTOR) {
		throw new RetryLater('quote-request-cap')
	}
	const ref: QuoteRequestRef = {
		id: request.id,
		actorUri: actor.uri,
		actorId: actor.id,
		quotedUri: quoted.uri,
		instrumentUri: request.instrument,
	}
	if (quoted.allowed !== 1) {
		recordAnswer(db, ref, quoted.id, now)
		recordOutbound(db, quoted.account_id, quoteAnswerActivity('Reject', quoted.author_uri, ref), now)
		return { kind: 'answered', reason: 'quote-rejected' }
	}
	let quoting = statusByUri(db, request.instrument)
	if (quoting === undefined) {
		const embedded = request.embedded
		const document =
			embedded !== null &&
			embedded.uri === request.instrument &&
			embedded.attributedTo === actor.uri &&
			originOf(embedded.uri) === originOf(actor.uri)
				? embedded
				: ctx.prefetched
		if (document === undefined) {
			return { kind: 'need', uri: request.instrument, as: quoted.username }
		}
		if (document === null) {
			return { kind: 'ignored', reason: 'unfetchable' }
		}
		const stored = storeRemoteStatus(db, actor, document, {
			now,
			origin: ctx.origin,
			deliveredTo: ctx.deliveredTo,
			fetched: true,
		})
		quoting = statusByUri(db, request.instrument)
		if (quoting === undefined) {
			return { kind: 'ignored', reason: stored.reason }
		}
	}
	const row = db.first<{ state: QuoteState; authorization_id: string | null }>(
		`SELECT q.state, q.authorization_id FROM quotes q JOIN statuses s ON s.id = q.status_id
		WHERE q.status_id = ?1 AND q.quoted_status_id = ?2 AND s.account_id = ?3 AND s.reblog_of_id IS NULL
			AND NOT EXISTS (SELECT 1 FROM inbound_jobs j WHERE j.kind = 'delete' AND j.key = ?1 AND j.done_at IS NULL)`,
		quoting.id,
		quoted.id,
		actor.id
	)
	if (row === undefined) {
		return { kind: 'ignored', reason: 'not-a-quote' }
	}
	recordAnswer(db, ref, quoted.id, now)
	if (row.state === 'accepted' && row.authorization_id !== null) {
		const stamp = stampUri(quoted.author_uri, row.authorization_id)
		recordOutbound(db, quoted.account_id, quoteAnswerActivity('Accept', quoted.author_uri, ref, stamp), now)
		return { kind: 'answered', reason: 'quote-accepted-again' }
	}
	const authorization = freshAuthorization()
	db.run(
		`UPDATE quotes SET state = 'accepted', authorization_id = ?3, activity_uri = ?4, verify_after = NULL,
			lease_until = NULL, recheck = 0, need_author = NULL, generation = ${NEW_GENERATION}, updated_at = ?5
		WHERE status_id = ?1 AND quoted_status_id = ?2`,
		quoting.id,
		quoted.id,
		authorization,
		request.id,
		iso(now)
	)
	ensureQuotedAccess(db, quoting.id, quoted.account_id)
	recordOutbound(
		db,
		quoted.account_id,
		quoteAnswerActivity('Accept', quoted.author_uri, ref, stampUri(quoted.author_uri, authorization)),
		now
	)
	notify(db, { recipientId: quoted.account_id, type: 'quote', fromId: actor.id, statusId: quoting.id, now })
	return { kind: 'answered', reason: 'quote-accepted' }
}

function recordAnswer(db: Db, request: QuoteRequestRef, quotedId: string, now: number): void {
	db.run(
		`INSERT INTO quote_requests (activity_uri, actor_uri, instrument_uri, quoted_status_id, answered_at)
		VALUES (?, ?, ?, ?, ?)`,
		request.id,
		request.actorUri,
		request.instrumentUri,
		quotedId,
		now
	)
}

// The sweep's part (inbox.ts sweep): answered requests older than RETRACTION_TTL_MS, at most SWEEP_BATCH, oldest first.
export function sweepQuoteRequests(db: Db, now: number): void {
	db.run(
		`DELETE FROM quote_requests WHERE activity_uri IN
			(SELECT activity_uri FROM quote_requests WHERE answered_at <= ? ORDER BY answered_at LIMIT ?)`,
		now - RETRACTION_TTL_MS,
		SWEEP_BATCH
	)
}

// The first transaction of a Delete of a remote quoting status (inbox.ts deleteObject), before any batch: its quote, if
// accepted, is retired at once, whether or not it holds an authorization of Kopje's (an imported one may hold none), so
// it leaves its target's quotes list and count (quotes_accepted, the trigger quotes_count_changed) and its stamp is
// never served (the trigger quotes_authorization_retired records it) while the status's removal runs in batches. At
// most three rows: a status has one quote. With `pending` (a local status's hide, statuses.ts deleteStatus), a pending
// quote ends too, revoked: no Accept of its QuoteRequest applies once its status is withdrawn (acceptOurQuote).
export function retireQuoteOf(db: Db, statusId: string, now: number, pending = false): void {
	db.run(
		`UPDATE quotes SET state = 'revoked', authorization_id = NULL, verify_after = NULL, lease_until = NULL,
			need_author = NULL, generation = ${NEW_GENERATION}, updated_at = ?2
		WHERE status_id = ?1 AND (state = 'accepted' OR (?3 AND state = 'pending'))`,
		statusId,
		iso(now),
		pending ? 1 : 0
	)
}

export type QuoteAuthorization = {
	id: string
	attributedTo: string
	interactingObject: string
	interactionTarget: string
}

// GET /ap/users/:username/quote_authorizations/:authorization_id (federation/routes.ts), one read: the stamp only while
// it is the current authorization of an accepted quote, never retired, of a local original of the available account
// `username` (the quoted author: the path binds it) that is public or unlisted, and while the quoting status is
// there: a Delete of it retires the authorization in its first transaction (retireQuoteOf), and a purge of its author
// (whose batches delete the quote last) hides it here at once. Ids only (FEP-044f: the quote post is never embedded).
// The id is 128 random bits, never sequential, so stamps cannot be enumerated.
export const quoteAuthorization = readOperation<
	{ username: string; authorizationId: string },
	QuoteAuthorization | null
>((db, { username, authorizationId }) => {
	const row = db.first<{ author_uri: string; interacting: string; target: string }>(
		`SELECT a.uri AS author_uri, s.uri AS interacting, t.uri AS target
		FROM quotes q JOIN statuses s ON s.id = q.status_id JOIN statuses t ON t.id = q.quoted_status_id
			JOIN accounts a ON a.id = t.account_id JOIN local_accounts l ON l.account_id = a.id
		WHERE q.authorization_id = ?1 AND q.state = 'accepted' AND a.domain IS NULL AND a.username = ?2
			AND ${availableLocalSql('l')} AND t.reblog_of_id IS NULL AND t.visibility IN ${DISTRIBUTABLE_SQL}
			AND NOT EXISTS (SELECT 1 FROM quote_revocations r WHERE r.authorization = ?1)
			AND NOT EXISTS (SELECT 1 FROM accounts qa JOIN inbound_jobs j ON j.kind = 'purge' AND j.key = qa.uri
				WHERE qa.id = s.account_id)`,
		authorizationId,
		username
	)
	return row === undefined
		? null
		: {
				id: stampUri(row.author_uri, authorizationId),
				attributedTo: row.author_uri,
				interactingObject: row.interacting,
				interactionTarget: row.target,
			}
})

export type RevocableQuote = {
	state: QuoteState
	authorizationId: string | null
	quotingUri: string
	quotingAuthorId: string
	quotingAuthorUri: string
}

export function revocableQuote(db: Db, quotedId: string, quotingId: string): RevocableQuote | undefined {
	const row = db.first<{
		state: QuoteState
		authorization_id: string | null
		quoting_uri: string
		quoting_author_id: string
		quoting_author_uri: string
	}>(
		`SELECT q.state, q.authorization_id, s.uri AS quoting_uri, s.account_id AS quoting_author_id,
			a.uri AS quoting_author_uri
		FROM quotes q JOIN statuses s ON s.id = q.status_id JOIN accounts a ON a.id = s.account_id
		WHERE q.status_id = ? AND q.quoted_status_id = ?`,
		quotingId,
		quotedId
	)
	return row === undefined
		? undefined
		: {
				state: row.state,
				authorizationId: row.authorization_id,
				quotingUri: row.quoting_uri,
				quotingAuthorId: row.quoting_author_id,
				quotingAuthorUri: row.quoting_author_uri,
			}
}

// The revoke itself (Quote#reject!): accepted becomes revoked and pending rejected, only while the quote still holds
// the authorization the caller prepared its signed Delete for (`expected`, null for none), so of two concurrent
// revokes exactly one changes it. Clearing the authorization retires it (the trigger). Returns the new state, or null
// when it changed nothing.
export function revokeQuoteRow(
	db: Db,
	quotingId: string,
	quotedId: string,
	expected: string | null,
	now: number
): QuoteState | null {
	return (
		db.first<{ state: QuoteState }>(
			`UPDATE quotes SET state = CASE state WHEN 'accepted' THEN 'revoked' ELSE 'rejected' END,
				authorization_id = NULL, verify_after = NULL, lease_until = NULL, generation = ${NEW_GENERATION},
				updated_at = ?4
			WHERE status_id = ?1 AND quoted_status_id = ?2 AND state IN ('accepted', 'pending')
				AND authorization_id IS ?3
			RETURNING state`,
			quotingId,
			quotedId,
			expected,
			iso(now)
		)?.state ?? null
	)
}

// The requests the quoting author `authorUri` had answered for its quote `quotingUri` of `quotedId` (quote_requests),
// oldest first: the Rejects a revoke sends. A request may name anyone's status as its instrument (a refused one is
// recorded before the instrument is read), so only the quoting author's own count: another actor's never draws a
// Reject about this quote, nor counts against its bound, MAX_QUOTE_REQUESTS_PER_ACTOR. Only live rows count, as for
// the cap (answered within RETRACTION_TTL_MS), so expired rows the sweep has yet to remove never crowd out the current
// request (one seek of quote_requests_instrument).
export function answeredRequests(
	db: Db,
	quotingUri: string,
	quotedId: string,
	authorUri: string,
	now: number
): string[] {
	return db
		.all<{ activity_uri: string }>(
			`SELECT activity_uri FROM quote_requests
			WHERE instrument_uri = ? AND quoted_status_id = ? AND actor_uri = ? AND answered_at > ?
			ORDER BY answered_at, activity_uri LIMIT ?`,
			quotingUri,
			quotedId,
			authorUri,
			now - RETRACTION_TTL_MS,
			MAX_QUOTE_REQUESTS_PER_ACTOR
		)
		.map((row) => row.activity_uri)
}

// ---------------------------------------------------------------------------------------------------------------
// Authoring: quotes by local users (design §5.6, VIS-28; rows: test/quote-authoring.test.ts concurrency table)
// ---------------------------------------------------------------------------------------------------------------
//
// A local quoting row (local = 1) is decided only by the post that writes it, the quoted author's answer (an Accept or
// Reject of our QuoteRequest, each one compare-and-set), the quoted author's stamp Delete (in its first transaction),
// and the removal paths (a detach, the quoting status's delete). It never has verification work (hops 0, no due time),
// so no job round claims it (row 17), and every write here draws a new generation and clears the work. Its stamp
// (approval_uri) is kept after it leaves accepted, until the quoted author's proven Delete of it is forwarded
// (quotes_local_stamp, migration 0039_quotes_local): one local quote per stamp and quoted author, so that forward is
// one envelope, recorded once.

// The quoted status of a post, as preparePost (statuses.ts) found it through R36.
export type QuotedForPost = {
	id: string
	uri: string
	account_id: string
	local: number
}

// PostStatusService#attach_quote! in the post's transaction: a quote of a local status is accepted at once (R36 was
// its decision), with a fresh authorization when its author is not the poster's; a quote of a remote status is pending
// until its author answers the QuoteRequest named activity_uri (activities.ts quoteRequestUri). Returns the state.
export function recordLocalQuote(
	db: Db,
	quoting: { id: string; uri: string; authorId: string },
	quoted: QuotedForPost,
	now: number
): QuoteState {
	const state: QuoteState = quoted.local === 1 ? 'accepted' : 'pending'
	db.run(
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, legacy, local,
			authorization_id, activity_uri, hops, generation, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, ?7, 0, ${NEW_GENERATION}, ?8)`,
		quoting.id,
		quoted.uri,
		quoted.id,
		quoted.account_id,
		state,
		quoted.local === 1 && quoted.account_id !== quoting.authorId ? freshAuthorization() : null,
		quoted.local === 1 ? null : quoteRequestUri(quoting.uri),
		iso(now)
	)
	return state
}

// Note quote fields (activities.ts noteOf): quotedUri is null for a deleted or withdrawn target (Tombstone); only
// accepted quotes of a target still there carry a stamp, Kopje's for another local author's status or approval_uri for
// a remote status. The quote is sought by its status, the target by its id (RES-7).
export type NoteQuote = { quotedUri: string | null; stamp: string | null }

export function noteQuote(db: Db, statusId: string): NoteQuote | null {
	const row = db.first<{
		quoted_uri: string | null
		present: number
		state: QuoteState
		authorization_id: string | null
		approval_uri: string | null
		author_uri: string | null
	}>(
		`SELECT q.quoted_uri, t.id IS NOT NULL AS present, q.state, q.authorization_id, q.approval_uri,
			a.uri AS author_uri
		FROM quotes q INDEXED BY ${QUOTES_STATUS_INDEX} LEFT JOIN accounts a ON a.id = q.quoted_account_id
			LEFT JOIN statuses t INDEXED BY ${STATUSES_ID_INDEX} ON t.id = q.quoted_status_id AND t.withdrawn = 0
		WHERE q.status_id = ? AND q.local = 1`,
		statusId
	)
	if (row === undefined) {
		return null
	}
	// A withdrawn quoted status (its removal under way) is gone already: a Tombstone, with no stamp.
	const stamp =
		row.state !== 'accepted' || row.present !== 1
			? null
			: row.authorization_id !== null && row.author_uri !== null
				? stampUri(row.author_uri, row.authorization_id)
				: row.approval_uri
	return { quotedUri: row.present === 1 ? row.quoted_uri : null, stamp }
}

// A local status's quote, for an edit of it (statuses.ts): the status it quotes while it is there (its RE: line), or
// null once it is gone; undefined when it quotes nothing.
export function localQuoteOf(db: Db, statusId: string): { quotedStatusId: string | null } | undefined {
	const row = db.first<{ quoted_status_id: string | null }>(
		'SELECT quoted_status_id FROM quotes WHERE status_id = ? AND local = 1',
		statusId
	)
	return row === undefined ? undefined : { quotedStatusId: row.quoted_status_id }
}

// The answer an Accept or Reject names: our request by its id (the quoting status's uri with #quote-request), or an
// inlined QuoteRequest whose instrument is our quoting status and whose object is the actor's status (Mastodon's
// quote_from_request_json). Only a local quoting row of a quote of the actor's status matches, of a quoting status not
// withdrawn: once its Delete is recorded, no answer applies (statuses.ts deleteStatus ends its quote as well).
export type QuoteAnswerRef = {
	id: string | null
	type: string | null
	object: string | null
	instrument: string | null
}

type AnsweredQuote = { status_id: string; author_id: string }

function answeredQuote(db: Db, actor: { id: string }, ref: QuoteAnswerRef): AnsweredQuote | undefined {
	const byId =
		ref.id === null || !ref.id.endsWith('#quote-request')
			? undefined
			: db.first<AnsweredQuote>(
					`SELECT q.status_id, s.account_id AS author_id FROM statuses s JOIN quotes q ON q.status_id = s.id
					WHERE s.uri = ?1 AND s.withdrawn = 0 AND q.local = 1 AND q.activity_uri = ?2 AND q.quoted_account_id = ?3`,
					ref.id.slice(0, -'#quote-request'.length),
					ref.id,
					actor.id
				)
	if (byId !== undefined || ref.type !== 'QuoteRequest' || ref.instrument === null || ref.object === null) {
		return byId
	}
	return db.first<AnsweredQuote>(
		`SELECT q.status_id, s.account_id AS author_id FROM statuses s JOIN quotes q ON q.status_id = s.id
			JOIN statuses t ON t.id = q.quoted_status_id
		WHERE s.uri = ?1 AND s.withdrawn = 0 AND q.local = 1 AND t.uri = ?2 AND t.account_id = ?3`,
		ref.instrument,
		ref.object,
		actor.id
	)
}

// Mastodon's StatusUpdateDistributionWorker after Accept: snapshot the Note without history or an edited_at change,
// so receivers treat it as implicit and recheck the stamp or its absence. Use a random id, never a clock; supersede
// waiting Updates (deliveries.ts).
function recordStampUpdate(db: Db, statusId: string, authorId: string, now: number): void {
	const facts = statusFacts(db, statusId)
	if (facts !== null) {
		recordOutbound(db, authorId, updateActivity(facts, `quote-${crypto.randomUUID()}`), now)
	}
}

// Mastodon's Accept#accept_quote! for our QuoteRequest, one compare-and-set (row 7): only from the quoted author (the
// row's quoted_account_id, cleared by a detach, row 15), with a result on the actor's origin that the actor never
// revoked nor retracted (rows 8, the same checks as verification), on a pending quote, and only when no other local
// quote holds that stamp of the actor (quotes_local_stamp, row 9: the update is ignored on the unique index). Then the
// quoting status's Update carries the stamp. Returns whether it applied.
export function acceptOurQuote(
	db: Db,
	actor: { id: string; uri: string },
	ref: QuoteAnswerRef,
	result: string | null,
	now: number
): boolean {
	const quote = answeredQuote(db, actor, ref)
	if (
		quote === undefined ||
		result === null ||
		originOf(result) === null ||
		!/^https?:$/.test(new URL(result).protocol) ||
		originOf(result) !== originOf(actor.uri) ||
		revoked(db, result, actor.uri) ||
		isDeleted(db, actor.uri, result, now)
	) {
		return false
	}
	const changed = db.run(
		`UPDATE OR IGNORE quotes SET state = 'accepted', approval_uri = ?3, verify_after = NULL, lease_until = NULL,
			recheck = 0, need_author = NULL, generation = ${NEW_GENERATION}, updated_at = ?4
		WHERE status_id = ?1 AND local = 1 AND state = 'pending' AND quoted_account_id = ?2`,
		quote.status_id,
		actor.id,
		result,
		iso(now)
	)
	if (changed === 0) {
		return false
	}
	recordStampUpdate(db, quote.status_id, quote.author_id, now)
	return true
}

// Mastodon's Quote#reject!: compare-and-set pending to rejected or accepted to revoked; the latter sends an Update
// without the stamp, superseding waiting Updates that carry it. Only the author's stamp Delete writes
// quote_revocations, so it still runs revocation batches for received quotes. Keep the stamp until that Delete is
// forwarded: uniqueness prevents reuse before forwarding (row 9), and the Delete's record afterwards (row 8).
// Returns whether it applied.
export function rejectOurQuote(db: Db, actor: { id: string }, ref: QuoteAnswerRef, now: number): boolean {
	const quote = answeredQuote(db, actor, ref)
	if (quote === undefined) {
		return false
	}
	const row = db.first<{ state: QuoteState }>(
		`UPDATE quotes SET state = CASE state WHEN 'accepted' THEN 'revoked' ELSE 'rejected' END, verify_after = NULL,
			lease_until = NULL, recheck = 0, generation = ${NEW_GENERATION}, updated_at = ?3
		WHERE status_id = ?1 AND local = 1 AND state IN ('pending', 'accepted') AND quoted_account_id = ?2
		RETURNING state`,
		quote.status_id,
		actor.id,
		iso(now)
	)
	if (row === undefined) {
		return false
	}
	if (row.state === 'revoked') {
		recordStampUpdate(db, quote.status_id, quote.author_id, now)
	}
	return true
}

// Whether a local quote holds the actor's stamp `approvalUri` (one seek of quotes_local_stamp): a Delete of it is then
// forwarded when proven, so the inbox asks the Worker to verify a proof the Delete carries (inbox.ts deleteObject).
export function holdsLocalStamp(db: Db, actor: { id: string }, approvalUri: string): boolean {
	return (
		db.first(
			`SELECT 1 AS x FROM quotes INDEXED BY quotes_local_stamp
			WHERE approval_uri = ? AND quoted_account_id = ? AND local = 1`,
			approvalUri,
			actor.id
		) !== undefined
	)
}

// The first transaction of the actor's Delete of the stamp `approvalUri` (row 10), for the one local quote that holds
// it (a seek of quotes_local_stamp, whatever the received quotes naming it): an accepted quote becomes revoked and its
// status's Update without the stamp is recorded; and when the Delete is proven (its author's proof verified: `forward`
// is the body as received), that body is recorded unchanged as one immutable envelope signed by the quoting author,
// reaching every inbox that received the quoting status or would receive it now (reachOf, its owner's receipts and
// audience), and the row lets go of the stamp, so a replay forwards nothing more. A retraction: no suspension or
// admission refuses it. Returns whether a local quote held the stamp.
function revokeLocalStamp(
	db: Db,
	actor: { id: string },
	approvalUri: string,
	forward: Record<string, unknown> | null,
	now: number
): boolean {
	const row = db.first<{ status_id: string; state: QuoteState; author_id: string }>(
		`SELECT q.status_id, q.state, s.account_id AS author_id FROM quotes q INDEXED BY quotes_local_stamp
			JOIN statuses s ON s.id = q.status_id
		WHERE q.approval_uri = ?1 AND q.quoted_account_id = ?2 AND q.local = 1`,
		approvalUri,
		actor.id
	)
	if (row === undefined) {
		return false
	}
	if (row.state === 'accepted') {
		db.run(
			`UPDATE quotes SET state = 'revoked', verify_after = NULL, lease_until = NULL, recheck = 0,
				generation = ${NEW_GENERATION}, updated_at = ?2
			WHERE status_id = ?1`,
			row.status_id,
			iso(now)
		)
		recordStampUpdate(db, row.status_id, row.author_id, now)
	}
	if (forward !== null) {
		const reach = statusReach(db, row.status_id)
		recordOutbound(
			db,
			row.author_id,
			{
				activity: forward,
				audience: { followers: false, accounts: [] },
				immutable: true,
				reachOf: reach === null ? [] : [reach],
			},
			now
		)
		db.run(
			`UPDATE quotes SET approval_uri = NULL, generation = ${NEW_GENERATION}, updated_at = ?2 WHERE status_id = ?1`,
			row.status_id,
			iso(now)
		)
	}
	return true
}

// Local accounts an edit of a status notifies with quoted_update at most (row 16): the authors of its newest accepted
// local quotes.
export const MAX_QUOTED_UPDATES = 100

// The quoting statuses and their local authors that an edit of `quotedId` notifies (Mastodon's
// FanOutOnWriteService#notify_about_update!): the accepted local quotes at this commit, newest first, at most
// MAX_QUOTED_UPDATES, from one seek of quotes_local_accepted (migration 0039_quotes_local) whatever the received
// quotes of the status.
export function quotedUpdates(db: Db, quotedId: string): { status_id: string; account_id: string }[] {
	return db.all<{ status_id: string; account_id: string }>(
		`SELECT q.status_id, s.account_id FROM quotes q INDEXED BY quotes_local_accepted JOIN statuses s ON s.id = q.status_id
		WHERE q.quoted_status_id = ? AND q.local = 1 AND q.state = 'accepted'
		ORDER BY q.status_id DESC LIMIT ?`,
		quotedId,
		MAX_QUOTED_UPDATES
	)
}
