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
}

function quoteRow(db: Db, statusId: string): QuoteRow | undefined {
	return db.first<QuoteRow>(
		`SELECT q.status_id, s.uri AS status_uri, s.account_id, a.uri AS author_uri, q.quoted_uri, q.quoted_status_id,
			q.state, q.legacy, q.approval_uri, q.attempts, q.hops, q.fetch_as
		FROM quotes q JOIN statuses s ON s.id = q.status_id JOIN accounts a ON a.id = s.account_id
		WHERE q.status_id = ?`,
		statusId
	)
}

// Mastodon's ActivityPub::Activity::Create#process_quote and ProcessStatusUpdateService#update_quote!: the quote a
// stored status's Note names, written with its work. A Note that names none removes the status's quote; a Tombstone
// is a deleted quote, with no work; a quote whose target or stamp changed starts over as pending (the count trigger
// takes an accepted one off its target); an unchanged one is promoted when its status arrived as a root. A stamp of
// this instance's origin is not a remote stamp, and is dropped (StatusParser#quote_approval_uri).
export function recordQuote(
	db: Db,
	status: { id: string; uri: string },
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
			verify_after, attempts, hops, fetch_as, updated_at)
		SELECT ?1, ?2, t.id, t.account_id, CASE WHEN ?3 THEN 'deleted' ELSE 'pending' END, ?4, ?5, ?6, 0, ?7, ?8, ?9
		FROM (SELECT NULL) LEFT JOIN statuses t ON NOT ?3 AND t.uri = ?2 AND t.reblog_of_id IS NULL AND t.id <> ?1
		WHERE true
		ON CONFLICT (status_id) DO UPDATE SET quoted_uri = excluded.quoted_uri, quoted_status_id = excluded.quoted_status_id,
			quoted_account_id = excluded.quoted_account_id, state = excluded.state, legacy = excluded.legacy, approval_uri = excluded.approval_uri,
			verify_after = excluded.verify_after, attempts = 0, hops = excluded.hops, fetch_as = excluded.fetch_as,
			updated_at = excluded.updated_at`,
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
	status: { id: string; uri: string },
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
			verify_after = CASE WHEN hops > 0 THEN ?3 ELSE verify_after END,
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
// for; transient: may pass later (a retry); budget: the request's fetch budget ran out (due again at once).
export type Fetched<T> =
	{ kind: 'ok'; value: T } | { kind: 'gone' } | { kind: 'unusable' } | { kind: 'transient' } | { kind: 'budget' }

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

export type QuoteWork = {
	statusId: string
	statusUri: string
	authorUri: string
	quotedUri: string
	approvalUri: string | null
	// The stored quoted status, or null when it is not stored yet.
	quoted: { uri: string; authorUri: string; local: boolean } | null
	// The stamp was revoked for good (quote_revocations).
	revoked: boolean
	// The username of the local account whose key fetches for this work (fetch_as, rechecked), or null for the instance
	// actor.
	signer: string | null
}

// The quote of `statusId` when it has work to do (pending, or accepted and being checked again), with the stored state
// it is judged on. fetch_as is rechecked here: it signs only while it is an available local account that is still a
// recipient of the quoting status (status_mentions, silent included) or an accepted follower of its author; otherwise
// the instance actor fetches.
export const quoteWork = readOperation<{ statusId: string }, QuoteWork | null>((db, { statusId }) => {
	const row = quoteRow(db, statusId)
	if (row === undefined || row.quoted_uri === null || (row.state !== 'pending' && row.state !== 'accepted')) {
		return null
	}
	const quoted =
		row.quoted_status_id === null
			? undefined
			: db.first<{ uri: string; author_uri: string; local: number }>(
					`SELECT s.uri, a.uri AS author_uri, a.domain IS NULL AS local FROM statuses s JOIN accounts a ON a.id = s.account_id
					WHERE s.id = ?`,
					row.quoted_status_id
				)
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
		statusUri: row.status_uri,
		authorUri: row.author_uri,
		quotedUri: row.quoted_uri,
		approvalUri: row.approval_uri,
		quoted: quoted === undefined ? null : { uri: quoted.uri, authorUri: quoted.author_uri, local: quoted.local === 1 },
		revoked: row.approval_uri !== null && revoked(db, row.approval_uri),
		signer: signer?.username ?? null,
	}
})

function revoked(db: Db, approvalUri: string): boolean {
	return db.first('SELECT 1 AS x FROM quote_revocations WHERE authorization = ?', approvalUri) !== undefined
}

export type QuoteVerification = {
	statusId: string
	now: number
	origin: string
	// The work as quoteWork read it: a row whose target or stamp changed since takes nothing from this result (the new
	// one has its own work).
	quotedUri: string
	approvalUri: string | null
	// The quoted status, fetched by its id when it was not stored; its author's document when the Store asked for it.
	quoted?: Fetched<RemoteStatusInput>
	author?: RemoteActorInput | null
	stamp?: Fetched<StampInput>
}

// done: no work of this quote is due now (finished, or retried after a backoff); due: some quote has work due now (a
// quoted status this stored has a quote of its own to verify); need: the quoted status's author, which the Store does
// not have.
export type QuoteVerified = { done: boolean; due: boolean; state: QuoteState | null; need?: string }

type Linked = { id: string; uri: string; account_id: string; author_uri: string; visibility: Visibility; local: number }

function linkedQuoted(db: Db, statusId: string): Linked | undefined {
	return db.first<Linked>(
		`SELECT t.id, t.uri, t.account_id, a.uri AS author_uri, t.visibility, a.domain IS NULL AS local
		FROM quotes q JOIN statuses t ON t.id = q.quoted_status_id JOIN accounts a ON a.id = t.account_id
		WHERE q.status_id = ?`,
		statusId
	)
}

// The end of one verification: the state it leaves and its work: done (none left), retry (a failure that may pass:
// the next attempt after QUOTE_BACKOFF_MS, none after the last) or again (due at once: the fetch budget ran out).
function finish(
	db: Db,
	row: QuoteRow,
	state: QuoteState,
	work: 'done' | 'retry' | 'again',
	now: number
): QuoteVerified {
	const attempts = work === 'retry' ? row.attempts + 1 : row.attempts
	const delay = work === 'retry' ? QUOTE_BACKOFF_MS[attempts - 1] : undefined
	const verifyAfter = work === 'again' ? now : delay === undefined ? null : now + delay
	db.run(
		'UPDATE quotes SET state = ?2, verify_after = ?3, attempts = ?4, updated_at = ?5 WHERE status_id = ?1',
		row.status_id,
		state,
		verifyAfter,
		attempts,
		iso(now)
	)
	return { done: work !== 'again', due: otherQuotesDue(db, now, null), state }
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

// Applies what the Worker fetched for one quote's work, in one transaction: stores the quoted status if it was fetched
// (with one hop less of work for its own quote), then decides the quote. Only a pending quote is accepted, and only
// for a self-quote or a valid stamp; an accepted one being checked again is revoked only when its stamp is gone or no
// longer valid. A pending quote whose stamp is gone is rejected (Mastodon's VerifyQuoteService); one that fails a check
// stays pending, its work done.
export const completeQuote = writeOperation<QuoteVerification, QuoteVerified>((db, input) => {
	const { now, origin } = input
	const row = quoteRow(db, input.statusId)
	if (
		row === undefined ||
		(row.state !== 'pending' && row.state !== 'accepted') ||
		row.quoted_uri !== input.quotedUri ||
		row.approval_uri !== input.approvalUri
	) {
		return { done: true, due: otherQuotesDue(db, now, null), state: row?.state ?? null }
	}
	const keep = row.state
	// What a stamp that is gone or invalid leaves: a pending quote rejected (gone) or still pending, an accepted one
	// revoked.
	const lost = (gone: boolean): QuoteState => (keep === 'accepted' ? 'revoked' : gone ? 'rejected' : 'pending')
	let quoted = linkedQuoted(db, row.status_id)
	if (quoted === undefined) {
		const fetched = input.quoted
		if (fetched === undefined || fetched.kind === 'gone' || fetched.kind === 'unusable') {
			return finish(db, row, keep, 'done', now)
		}
		if (fetched.kind !== 'ok') {
			return finish(db, row, keep, fetched.kind === 'budget' ? 'again' : 'retry', now)
		}
		const status = fetched.value
		const authorUri = status.attributedTo
		if (
			status.uri !== row.quoted_uri ||
			authorUri === null ||
			originOf(authorUri) !== originOf(status.uri) ||
			originOf(authorUri) === origin ||
			isDeletedActor(db, authorUri, now)
		) {
			return finish(db, row, keep, 'done', now)
		}
		let author = db.first<{ id: string; uri: string }>(
			'SELECT id, uri FROM accounts WHERE uri = ? AND domain IS NOT NULL',
			authorUri
		)
		if (author === undefined && input.author === undefined) {
			return { done: false, due: true, state: keep, need: authorUri }
		}
		if (author === undefined && (input.author === null || input.author?.uri !== authorUri)) {
			return finish(db, row, keep, 'done', now)
		}
		const followers =
			author === undefined ? followersOfDocument(input.author?.raw ?? null) : followersUri(db, author.id)
		// Only a public or unlisted status, or the quoting author's own, is ever accepted: nothing else is stored for it.
		if (authorUri !== row.author_uri && !isDistributable(visibilityOf(status, followers))) {
			return finish(db, row, keep, 'done', now)
		}
		author ??=
			input.author === null || input.author === undefined ? undefined : upsertRemoteActor(db, input.author, origin, now)
		if (author === undefined) {
			return finish(db, row, keep, 'done', now)
		}
		storeRemoteStatus(db, author, status, {
			now,
			origin,
			deliveredTo: null,
			fetched: true,
			quoteHops: Math.max(0, row.hops - 1),
		})
		quoted = linkedQuoted(db, row.status_id)
		if (quoted === undefined) {
			return finish(db, row, keep, 'done', now)
		}
	}
	// VerifyQuoteService: a boost is never quoted (linking takes originals only), and nothing hidden from the quote's
	// public is accepted unless it is the quoting author's own.
	if (quoted.account_id === row.account_id) {
		return finish(db, row, 'accepted', 'done', now)
	}
	if (!isDistributable(quoted.visibility) || quoted.local === 1 || row.approval_uri === null) {
		return finish(db, row, keep, 'done', now)
	}
	if (revoked(db, row.approval_uri) || isDeleted(db, quoted.author_uri, row.approval_uri, now)) {
		return finish(db, row, lost(false), 'done', now)
	}
	const stamp = input.stamp
	if (stamp === undefined || stamp.kind === 'budget') {
		return finish(db, row, keep, 'again', now)
	}
	if (stamp.kind === 'transient') {
		return finish(db, row, keep, 'retry', now)
	}
	if (stamp.kind === 'gone') {
		return finish(db, row, lost(true), 'done', now)
	}
	if (stamp.kind === 'unusable') {
		return finish(db, row, keep, 'done', now)
	}
	return finish(db, row, stampValid(stamp.value, row, quoted) ? 'accepted' : lost(false), 'done', now)
})

function followersOfDocument(raw: string | null): string | null {
	if (raw === null) {
		return null
	}
	try {
		const followers = (JSON.parse(raw) as { followers?: unknown }).followers
		return typeof followers === 'string' ? followers : null
	} catch {
		return null
	}
}

// A job round's claim: the quotes due first, at most `limit`, held from other rounds for QUOTE_LEASE_MS (a round that
// dies leaves them to a later one). more: others are due too.
export const claimQuotes = writeOperation<{ now: number; limit: number }, { ids: string[]; more: boolean }>(
	(db, { now, limit }) => {
		const ids = db
			.all<{ status_id: string }>(
				'SELECT status_id FROM quotes WHERE verify_after <= ? ORDER BY verify_after LIMIT ?',
				now,
				limit
			)
			.map((row) => row.status_id)
		db.run(
			'UPDATE quotes SET verify_after = ?1 WHERE status_id IN (SELECT value FROM json_each(?2))',
			now + QUOTE_LEASE_MS,
			JSON.stringify(ids)
		)
		return { ids, more: otherQuotesDue(db, now, null) }
	}
)

// ---------------------------------------------------------------------------------------------------------------
// Revocation: the Delete of a stamp
// ---------------------------------------------------------------------------------------------------------------

// The quotes a revocation still has to process, oldest first: the stamp and the actor whose Delete recorded it.
function pendingRevocation(db: Db): { authorization: string; actor_uri: string | null } | undefined {
	return db.first<{ authorization: string; actor_uri: string | null }>(
		'SELECT authorization, actor_uri FROM quote_revocations WHERE pending = 1 ORDER BY revoked_at LIMIT 1'
	)
}

// One batch of a revocation (Mastodon's Delete#revoke_quote, Quote#reject!): the quotes still pending or accepted that
// name the stamp and quote a status by the actor (a seek of quotes_approval, whatever other quotes name the stamp)
// become rejected or revoked, at most `left() / 2` (each row and the count trigger it fires). The predicate is the
// cursor: a processed row leaves it. Clears the revocation's pending mark once none is left. Returns whether rows
// remain.
function revocationBatch(db: Db, approvalUri: string, actorUri: string | null, left: () => number, now: number) {
	const actorId =
		actorUri === null ? undefined : db.first<{ id: string }>('SELECT id FROM accounts WHERE uri = ?', actorUri)?.id
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
		db.run('UPDATE quote_revocations SET pending = 0 WHERE authorization = ? AND pending = 1', approvalUri)
		return false
	}
	return true
}

// A Delete of `approvalUri` by `actor` (its retraction recorded by the caller): when a stored quote of one of the
// actor's statuses names that stamp, the revocation is recorded once, for good, and its first batch runs within
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
		`UPDATE quotes SET quoted_status_id = NULL, quoted_account_id = NULL,
			state = CASE state WHEN 'accepted' THEN 'deleted' ELSE state END, verify_after = NULL, updated_at = ?2
		WHERE quoted_status_id = ?1`,
		statusId,
		iso(now)
	)
	db.run('DELETE FROM quotes WHERE status_id = ?', statusId)
}
