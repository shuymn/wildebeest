import { availableLocalSql, isDistributable, type Visibility } from './audience'
import { isDeleted, isDeletedActor, type RemoteActorInput, upsertRemoteActor } from './inbox'
import { readOperation, writeOperation } from './operation'
import { localFollower } from './remote-collections'
import {
	followersUri,
	type RemoteQuoteInput,
	type RemoteStatusInput,
	storeRemoteStatus,
	visibilityOf,
} from './remote-statuses'
import type { Db } from '../db/sql'

// Quote posts received from remote servers (Mastodon 4.5's Quote, ActivityPub::Parser::StatusParser's quote
// properties, ActivityPub::VerifyQuoteService and the Delete of a QuoteAuthorization), stored and verified in the rows
// of migration 0027_quotes. Nothing reads them for a client yet.
//
// A quote is stored with the status that makes it (recordQuote, from storeRemoteStatus and updateRemoteStatus, so every
// path that stores a remote status records it), in the same transaction, with its verification work: verify_after
// says it is due. The inbox request that stored it consumes the work inline (federation/inbound.ts), within what is
// left of its fetch budget; whatever is left due is taken by the Worker's job rounds (federation/quotes.ts, claimQuotes),
// which cron runs too, so a Worker that dies after the commit only delays it.
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
// How long a round's claim holds a quote from other rounds.
export const QUOTE_LEASE_MS = 10 * 60 * 1000
// Unresolved quotes that one newly stored status links at most (the rest stay unresolved, by uri), as replies are.
export const MAX_LINKED_QUOTES = 100

export type QuoteState = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'deleted'

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

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

type QuoteRow = {
	status_id: string
	status_uri: string
	account_id: string
	author_uri: string
	quoted_uri: string | null
	quoted_status_id: string | null
	state: QuoteState
	legacy: number
	approval_uri: string | null
	attempts: number
	hops: number
	fetch_as: string | null
	need_author: string | null
	generation: number
}

function quoteRow(db: Db, statusId: string): QuoteRow | undefined {
	return db.first<QuoteRow>(
		`SELECT q.status_id, s.uri AS status_uri, s.account_id, a.uri AS author_uri, q.quoted_uri, q.quoted_status_id,
			q.state, q.legacy, q.approval_uri, q.attempts, q.hops, q.fetch_as, q.need_author, q.generation
		FROM quotes q JOIN statuses s ON s.id = q.status_id JOIN accounts a ON a.id = s.account_id
		WHERE q.status_id = ?`,
		statusId
	)
}

// Mastodon's ActivityPub::Activity::Create#process_quote and ProcessStatusUpdateService#update_quote!: the quote a
// stored status's Note names, written with its work. A Note that names none removes the status's quote; a Tombstone
// is a deleted quote, with no work; a quote whose target or stamp changed starts over as pending (the count trigger
// takes an accepted one off its target); an unchanged one is promoted when its status arrived as a root. A stamp of
// this instance's origin is not a remote stamp, and is dropped (StatusParser#quote_approval_uri). A quoted Note embedded
// in the status (design §5.1, Mastodon's safe_prefetched_embed) is stored first, with one hop less of work, only when it
// is the status's author's own (its attributedTo is the author, its id on the author's origin): the author vouches for
// it as for the status itself, so a private self-quote that its server serves nobody is still known.
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
	const work = !named.tombstone && arrival.hops > 0
	db.run(
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, legacy, approval_uri,
			verify_after, attempts, hops, fetch_as, generation, updated_at)
		SELECT ?1, ?2, t.id, t.account_id, CASE WHEN ?3 THEN 'deleted' ELSE 'pending' END, ?4, ?5, ?6, 0, ?7, ?8,
			(abs(random()) % 9007199254740991), ?9
		FROM (SELECT NULL) LEFT JOIN statuses t ON NOT ?3 AND t.uri = ?2 AND t.reblog_of_id IS NULL AND t.id <> ?1
		WHERE true
		ON CONFLICT (status_id) DO UPDATE SET quoted_uri = excluded.quoted_uri, quoted_status_id = excluded.quoted_status_id,
			quoted_account_id = excluded.quoted_account_id, state = excluded.state, legacy = excluded.legacy, approval_uri = excluded.approval_uri,
			verify_after = excluded.verify_after, attempts = 0, hops = excluded.hops, fetch_as = excluded.fetch_as,
			need_author = NULL, generation = excluded.generation, updated_at = excluded.updated_at`,
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

// A stored status arrived again as a root: its pending quote gets the full work budget again and is due now, with this
// arrival's fetch identity when it has one. An arrival of a status stored for verification (fewer hops) promotes
// nothing.
export function promoteQuote(db: Db, statusId: string, arrival: QuoteArrival, now: number): void {
	if (arrival.hops < QUOTE_HOPS) {
		return
	}
	db.run(
		`UPDATE quotes SET hops = ?2, attempts = 0, verify_after = ?3, fetch_as = COALESCE(?4, fetch_as), updated_at = ?5
		WHERE status_id = ?1 AND state = 'pending' AND quoted_uri IS NOT NULL`,
		statusId,
		QUOTE_HOPS,
		now,
		arrival.fetchAs,
		iso(now)
	)
}

// A newly stored status is the target of the unresolved quotes that name its uri: at most MAX_LINKED_QUOTES are linked,
// and those with a work budget left are due again.
export function linkQuotes(db: Db, status: { id: string; uri: string }, now: number): void {
	db.run(
		`UPDATE quotes SET quoted_status_id = ?1, quoted_account_id = (SELECT account_id FROM statuses WHERE id = ?1),
			need_author = NULL, generation = (abs(random()) % 9007199254740991), verify_after = CASE WHEN hops > 0 THEN ?3 ELSE verify_after END,
			attempts = CASE WHEN hops > 0 THEN 0 ELSE attempts END, updated_at = ?4
		WHERE status_id IN (SELECT status_id FROM quotes
			WHERE quoted_uri = ?2 AND quoted_status_id IS NULL AND state = 'pending' AND status_id <> ?1 LIMIT ?5)`,
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

// Whether any quote other than `except` has work due (a seek of quotes_due).
export function otherQuotesDue(db: Db, now: number, except: string | null): boolean {
	return (
		db.first(
			'SELECT 1 AS x FROM quotes WHERE verify_after <= ?1 AND status_id IS NOT ?2 ORDER BY verify_after LIMIT 1',
			now,
			except
		) !== undefined
	)
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

// The stage a quote's verification is at, each one fetch of the Worker's (a stage fits one fetch budget, redirects
// included, so a round always finishes the stage it starts): the quoted status (not stored yet), its author (the status
// fetched and kept in need_author, its author unknown), the stamp; decide: nothing left to fetch.
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
}

type Linked = { id: string; uri: string; account_id: string; author_uri: string; visibility: Visibility; local: number }

// The quote's quoted status: the one linked, or else the one stored under its uri (never a boost), which a status
// stored after more than MAX_LINKED_QUOTES quotes named it was never linked to.
function quotedOf(db: Db, row: QuoteRow): Linked | undefined {
	return db.first<Linked>(
		`SELECT t.id, t.uri, t.account_id, a.uri AS author_uri, t.visibility, a.domain IS NULL AS local
		FROM statuses t JOIN accounts a ON a.id = t.account_id
		WHERE t.id = ?1 OR (?1 IS NULL AND t.uri = ?2 AND t.reblog_of_id IS NULL AND t.id <> ?3)
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

// The quote of `statusId` when it has work to do (pending, or accepted and being checked again), with the stage it is
// at. fetch_as is rechecked here: it signs only while it is an available local account that is still a recipient of the
// quoting status (status_mentions, silent included) or an accepted follower of its author; otherwise the instance
// actor fetches.
export const quoteWork = readOperation<{ statusId: string }, QuoteWork | null>((db, { statusId }) => {
	const row = quoteRow(db, statusId)
	if (row === undefined || row.quoted_uri === null || (row.state !== 'pending' && row.state !== 'accepted')) {
		return null
	}
	const quoted = quotedOf(db, row)
	const [stage, fetch]: [QuoteStage, string | null] =
		quoted !== undefined
			? stampStage(db, row, quoted)
				? ['stamp', row.approval_uri]
				: ['decide', null]
			: row.need_author !== null && db.first('SELECT 1 AS x FROM accounts WHERE uri = ?', row.need_author) === undefined
				? ['author', row.need_author]
				: ['quoted', row.quoted_uri]
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
	// The generation the stage read (quoteWork, or the round's claim): a stale outcome is discarded.
	generation: number
	// Run inline by the inbox request: best effort, never charged; what fails is left due for a job round.
	inline: boolean
	// What the stage fetched: the quoted status, its author's document or the stamp.
	quoted?: Fetched<RemoteStatusInput>
	author?: Fetched<RemoteActorInput>
	stamp?: Fetched<StampInput>
}

// done: no work of this quote is due now (finished, or retried after a backoff); due: some quote has work due now (a
// quoted status this stored has a quote of its own to verify); next: a stage was completed and kept, and another is
// waiting, which the Worker may run at once.
export type QuoteVerified = { done: boolean; due: boolean; state: QuoteState | null; next: boolean }

// The end of one verification: the state it leaves and its work: done (none left), retry (a failure that may pass:
// the next attempt after QUOTE_BACKOFF_MS, none after the last; an attempt is charged) or again (due at once for a job
// round: an inline stage that did not finish, which charges nothing). The author address a stage recorded stays only
// while work is left. Every end draws a new generation, so no other verifier's outcome applies after it.
function finish(
	db: Db,
	row: QuoteRow,
	state: QuoteState,
	work: 'done' | 'retry' | 'again',
	now: number,
	keep: string | null = null
): QuoteVerified {
	const attempts = work === 'retry' ? row.attempts + 1 : row.attempts
	const delay = work === 'retry' ? QUOTE_BACKOFF_MS[attempts - 1] : undefined
	const verifyAfter = work === 'again' ? now : delay === undefined ? null : now + delay
	const fetched = work === 'done' || (work === 'retry' && delay === undefined) ? null : keep
	db.run(
		`UPDATE quotes SET state = ?2, verify_after = ?3, attempts = ?4, need_author = ?5, updated_at = ?6,
			generation = (abs(random()) % 9007199254740991)
		WHERE status_id = ?1`,
		row.status_id,
		state,
		verifyAfter,
		attempts,
		fetched,
		iso(now)
	)
	return { done: work !== 'again', due: otherQuotesDue(db, now, null), state, next: false }
}

// A failed fetch's outcome: gone or unusable end the work; one that may pass (a fetch budget or deadline that ran out
// included) charges an attempt in a job round, where the stage had a whole budget, and nothing inline.
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
		: finish(db, row, keep, input.inline ? 'again' : 'retry', input.now, held)
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

// The quoted-status stages: a stage fetching the author it named stores that account and ends; one fetching the quoted
// status stores it, from that fresh fetch, once its author is known, and otherwise records only the author's address
// (need_author) for the next stage. Nothing fetched is kept between stages. Returns the linked status, or a stage's end.
function storeQuoted(db: Db, row: QuoteRow, input: QuoteVerification, keep: QuoteState): Linked | QuoteVerified {
	const { now, origin } = input
	if (input.author !== undefined) {
		const document = input.author
		if (document.kind !== 'ok') {
			return failed(db, row, keep, document, input, row.need_author)
		}
		if (document.value.uri !== row.need_author || isDeletedActor(db, document.value.uri, now)) {
			return finish(db, row, keep, 'done', now)
		}
		upsertRemoteActor(db, document.value, origin, now)
		db.run('UPDATE quotes SET generation = (abs(random()) % 9007199254740991) WHERE status_id = ?', row.status_id)
		return { done: false, due: true, state: keep, next: true }
	}
	const fetched = input.quoted
	if (fetched === undefined) {
		return finish(db, row, keep, 'again', now, row.need_author)
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
	const author = db.first<{ id: string; uri: string }>(
		'SELECT id, uri FROM accounts WHERE uri = ? AND domain IS NOT NULL',
		authorUri
	)
	if (author === undefined) {
		// A second fetch of the same unknown author ends the work: the stage before stored nobody under that address.
		if (row.need_author === authorUri) {
			return finish(db, row, keep, 'done', now)
		}
		// A status that names another author each time it is fetched pays for each change.
		if (row.need_author !== null) {
			return finish(db, row, keep, input.inline ? 'again' : 'retry', now, authorUri)
		}
		db.run(
			'UPDATE quotes SET need_author = ?2, generation = (abs(random()) % 9007199254740991), updated_at = ?3 WHERE status_id = ?1',
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
	db.run(
		'UPDATE quotes SET need_author = NULL, generation = (abs(random()) % 9007199254740991) WHERE status_id = ?',
		row.status_id
	)
	storeRemoteStatus(db, author, status, {
		now,
		origin,
		deliveredTo: null,
		fetched: true,
		quoteHops: Math.max(0, row.hops - 1),
	})
	return quotedOf(db, { ...row, quoted_status_id: null }) ?? finish(db, row, keep, 'done', now)
}

// Applies what the Worker fetched for one stage of a quote's work, in one transaction. A quoted status fetched is kept
// until its author is known, then stored; a quote whose quoted status is stored (linked, or found by its uri and linked
// now) is decided. Only a pending quote is accepted, and only for a self-quote or a valid stamp; an accepted one being
// checked again is revoked only when its stamp is gone or no longer valid. A pending quote whose stamp is gone is
// rejected (Mastodon's VerifyQuoteService); one that fails a check stays pending, its work done. Every failure that may
// pass charges an attempt; a fetch budget that ran out charges none.
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
		return { done: true, due: otherQuotesDue(db, now, null), state: row?.state ?? null, next: false }
	}
	const keep = row.state
	// What a stamp that is gone or invalid leaves: a pending quote rejected (gone) or still pending, an accepted one
	// revoked.
	const lost = (gone: boolean): QuoteState => (keep === 'accepted' ? 'revoked' : gone ? 'rejected' : 'pending')
	const found = quotedOf(db, row) ?? storeQuoted(db, row, input, keep)
	if ('done' in found) {
		return found
	}
	const quoted = found
	if (row.quoted_status_id !== quoted.id) {
		db.run(
			`UPDATE quotes SET quoted_status_id = ?2, quoted_account_id = ?3, need_author = NULL, generation = (abs(random()) % 9007199254740991)
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
export const chargeQuote = writeOperation<{ statusId: string; generation: number; now: number }, void>(
	(db, { statusId, generation, now }) => {
		const row = quoteRow(db, statusId)
		if (row !== undefined && row.generation === generation && (row.state === 'pending' || row.state === 'accepted')) {
			finish(db, row, row.state, 'retry', now, row.need_author)
		}
	}
)

// A job round's claim: the quotes due first, at most `limit`, each with the generation of its work, held from other
// rounds for QUOTE_LEASE_MS (a round that dies leaves them to a later one). more: others are due too.
export const claimQuotes = writeOperation<
	{ now: number; limit: number },
	{ ids: string[]; generations: number[]; more: boolean }
>((db, { now, limit }) => {
	const rows = db.all<{ status_id: string; generation: number }>(
		'SELECT status_id, generation FROM quotes WHERE verify_after <= ? ORDER BY verify_after LIMIT ?',
		now,
		limit
	)
	const ids = rows.map((row) => row.status_id)
	db.run(
		'UPDATE quotes SET verify_after = ?1 WHERE status_id IN (SELECT value FROM json_each(?2))',
		now + QUOTE_LEASE_MS,
		JSON.stringify(ids)
	)
	return { ids, generations: rows.map((row) => row.generation), more: otherQuotesDue(db, now, null) }
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
				updated_at = ?3
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
// `left()`; the rest is continued by the inbound job rounds (continueRevocations). A repeated Delete finds the
// revocation and adds nothing. Returns null when no such quote names the stamp, else whether batches remain.
export function revokeStamp(
	db: Db,
	actor: { id: string; uri: string },
	approvalUri: string,
	left: () => number,
	now: number
): boolean | null {
	const named =
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

// A Delete of a stamp relayed by another server without the author's proof (federation/inbound.ts): nothing is revoked
// on its word, but the accepted quote of the actor's status that names the stamp (one: a valid stamp names exactly one
// quoting status, by its unique uri) is verified again, its state unchanged until then, so a stamp that is gone
// revokes it. Returns the quoting status made due, or null.
export function recheckStamp(db: Db, actor: { id: string }, approvalUri: string, now: number): string | null {
	const row = db.first<{ status_id: string }>(
		`UPDATE quotes SET verify_after = ?3, attempts = 0, hops = max(hops, 1), updated_at = ?4
		WHERE status_id IN (SELECT status_id FROM quotes
			WHERE approval_uri = ?1 AND quoted_account_id = ?2 AND state = 'accepted' LIMIT 1)
		RETURNING status_id`,
		approvalUri,
		actor.id,
		now,
		iso(now)
	)
	return row?.status_id ?? null
}

// ---------------------------------------------------------------------------------------------------------------
// A local status's delete (statuses.ts deleteStatus)
// ---------------------------------------------------------------------------------------------------------------

// Before a local status's own delete: its incoming quotes are detached (an accepted one becomes deleted in the same
// statement, so the CHECK never sees an accepted quote without its target, and no work stays due on a target that is
// gone), and its outgoing quote is deleted (the count trigger takes it off its target).
export function detachQuotes(db: Db, statusId: string, now: number): void {
	db.run(
		`UPDATE quotes SET quoted_status_id = NULL, quoted_account_id = NULL, generation = (abs(random()) % 9007199254740991),
			state = CASE state WHEN 'accepted' THEN 'deleted' ELSE state END, verify_after = NULL, updated_at = ?2
		WHERE quoted_status_id = ?1`,
		statusId,
		iso(now)
	)
	db.run('DELETE FROM quotes WHERE status_id = ?', statusId)
}
