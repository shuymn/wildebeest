import { readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'

// Outbound delivery (design §4 "outbound", NET-2, VIS-3, RES-4, RES-5, RES-6, OPS-3). deliveries is the source of
// truth; the Queue only rings a doorbell, and the Worker does the POSTs.
//
//   - Targets: an outbound intent's audience becomes a list of (inbox, addressee) targets, from the stored audience
//     only (audienceTargets). A retraction (Delete, Undo, Reject) also targets every inbox that received the object or
//     may still receive it: receipts, and the deliveries and unexpanded targets of earlier activities about it.
//   - Silent recipients: a recipient the activity reaches without naming it in to/cc gets a copy of its own at its
//     personal inbox, with only itself added to to (the object's too), and no Mention. Misskey reads the audience from
//     to/cc only, not from the inbox it arrived at, so without the name the recipient would lose access. Each such
//     copy tells its recipient only that they themselves are addressed; the copy for everyone else never names them.
//   - Expansion: the targets are stored with the intent and written as deliveries rows EXPANSION_STEP at a time, oldest
//     intent first, in the transaction that records it and then in each claim (RES-6). An intent's rows are all
//     written before a later intent's, so id order stays intent order.
//   - Admission (RES-4): a lane may hold MAX_LANE_BACKLOG active rows and the Store MAX_BACKLOG. A row over either cap
//     is written as gave_up with 'backlog full': refused at once, visible to the operator, retried by them.
//   - Lanes: a lane is (sender, inbox origin) and is delivered in id order, so a Create to a server's shared inbox
//     cannot be overtaken by an Update or Delete to a personal inbox there. Only a lane's oldest active row is pending
//     or leased; the rows behind it are queued and promoted when it settles. So the due index holds lane heads only,
//     and a claim reads at most `limit` rows.
//   - Claims run inside one Store transaction, so they are serialized. Each claim issues a fresh lease token, counts
//     an attempt and leases the row for LEASE_MS. A completion settles a row only with the token of its current
//     lease, so a completion that arrives after the lease expired and the row was claimed again changes nothing.
//   - An expired lease (the Worker died, or the completion was lost after the POST) is claimed again like a due row.
//     The remote inbox may then see the activity twice; receivers deduplicate by activity id.
//   - A failure is retried after min(30 s·2^n, 12 h), n being the attempts so far; after MAX_ATTEMPTS, or on a
//     permanent failure, the row is gave_up: kept for the operator until retried or swept. An activity that a later
//     one about the same object follows is superseded, and the operator may not send it again.
//   - A delivered Create, Update or Announce of a local status records its inbox in outbound_receipts, owned by the
//     status; none is written once the status is gone or a retraction of it is pending.
//   - Claims and completions return nextDueAt, the earliest time any work is due, so the Worker can ring for it.

export const LEASE_MS = 60_000
export const MAX_ATTEMPTS = 15
export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 12 * 60 * 60 * 1000
export const CLAIM_LIMIT = 16
export const GAVE_UP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const EXPANSION_STEP = 100
export const MAX_LANE_BACKLOG = 500
export const MAX_BACKLOG = 10_000
export const BACKLOG_FULL = 'backlog full'
const SWEEP_BATCH = 500
export const RETRY_BATCH = 1000
const REPORT_LIMIT = 100
const ACTIVE = "('queued', 'pending', 'leased')"

// The wait before the next attempt, after `attempts` attempts have failed (attempts >= 1).
export function retryDelay(attempts: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 30), RETRY_MAX_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------------------------

type Activity = Record<string, unknown>

export type Target = { inbox: string; addressee: string | null }

function uris(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value]
	}
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function idOf(value: unknown): string | null {
	if (typeof value === 'string') {
		return value
	}
	if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
		return (value as { id: string }).id
	}
	return null
}

// The local object an activity is about, and whether it retracts it.
function subjectOf(activity: Activity): { object: string | null; retracts: boolean } {
	switch (activity.type) {
		case 'Create':
		case 'Update':
			return { object: idOf(activity.object), retracts: false }
		case 'Delete':
			return { object: idOf(activity.object), retracts: true }
		case 'Undo':
		case 'Reject':
			return { object: idOf(activity.object), retracts: true }
		case 'Accept':
			return { object: idOf(activity.object), retracts: false }
		default:
			return { object: typeof activity.id === 'string' ? activity.id : null, retracts: false }
	}
}

// NET-3's syntactic part, applied before a row is written: an https URL without credentials. Host checks (literal
// IPs, local names, DNS) run again at every POST (federation/delivery.ts).
export function isDeliverableInbox(value: string | null): value is string {
	if (value === null || value === '') {
		return false
	}
	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.username === '' && url.password === ''
	} catch {
		return false
	}
}

export type DeliveryAudience = { followers: boolean; accounts: string[] }

// The targets an activity goes to (NET-2), from the stored audience only:
//   - followers: the signer's accepted remote followers, by shared inbox when they have one (deduplicated);
//   - addressed accounts named in to/cc: by shared inbox, as Mastodon's StatusReachFinder;
//   - addressed accounts the activity reaches without naming them: on an addressed activity (one with to), a silent
//     recipient, by its personal inbox only, with itself as addressee (none: recorded as unreachable for the
//     operator, never sent to a shared inbox); otherwise (the object of a Like or Follow) by its personal inbox, as
//     Mastodon delivers favourites and follows;
//   - for a retraction, every inbox that received the object or may still receive it.
// Local accounts are never delivered to over HTTP: they read the Store. A neutral copy goes once to each inbox, and a
// personal copy once to each silent recipient. Personal copies are written first, so on a server that also gets the
// neutral copy, the one naming its recipient is POSTed first; Misskey keeps only the first Create it processes.
export function audienceTargets(db: Db, signerId: string, activity: Activity, audience: DeliveryAudience): Target[] {
	// Neutral copies by inbox; personal copies by recipient, kept apart so one never replaces the other.
	const neutral = new Set<string>()
	const personal = new Map<string, string>()
	const add = (inbox: string | null, addressee: string | null) => {
		if (addressee !== null) {
			// VIS-2: only the recipient's own inbox. Without one the copy is recorded as unreachable ('' inbox), never
			// sent to a shared inbox where others would see the recipient named.
			personal.set(addressee, isDeliverableInbox(inbox) ? inbox : '')
		} else if (isDeliverableInbox(inbox)) {
			neutral.add(inbox)
		}
	}
	if (audience.followers) {
		const followers = db.all<{ inbox: string | null }>(
			`SELECT DISTINCT COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) AS inbox
			FROM follows f JOIN accounts a ON a.id = f.account_id
			WHERE f.target_account_id = ? AND f.state = 'accepted' AND a.domain IS NOT NULL`,
			signerId
		)
		for (const { inbox } of followers) {
			add(inbox, null)
		}
	}
	const named = new Set([...uris(activity.to), ...uris(activity.cc)])
	const addressedActivity = Array.isArray(activity.to)
	const addressed = db.all<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null }>(
		`SELECT uri, NULLIF(inbox_url, '') AS inbox_url, NULLIF(shared_inbox_url, '') AS shared_inbox_url FROM accounts
		WHERE id IN (SELECT value FROM json_each(?)) AND domain IS NOT NULL ORDER BY id`,
		JSON.stringify(audience.accounts)
	)
	for (const account of addressed) {
		if (named.has(account.uri)) {
			add(account.shared_inbox_url ?? account.inbox_url, null)
		} else {
			add(
				addressedActivity ? account.inbox_url : (account.inbox_url ?? account.shared_inbox_url),
				addressedActivity ? account.uri : null
			)
		}
	}
	const { object, retracts } = subjectOf(activity)
	if (retracts && object !== null) {
		for (const inbox of receiversOf(db, signerId, object)) {
			add(inbox, null)
		}
	}
	const byInbox = (a: Target, b: Target) => (a.inbox < b.inbox ? -1 : a.inbox > b.inbox ? 1 : 0)
	return [
		...[...personal].map(([addressee, inbox]) => ({ inbox, addressee })).sort(byInbox),
		...[...neutral].map((inbox) => ({ inbox, addressee: null })).sort(byInbox),
	]
}

// Every inbox that received an object of this signer, or may: its receipts, the rows of earlier activities about it
// in any state (a leased one may have been POSTed already), and their targets not yet expanded.
function receiversOf(db: Db, signerId: string, object: string): string[] {
	const receipts = db.all<{ inbox: string }>(
		`SELECT r.inbox_url AS inbox FROM outbound_receipts r JOIN statuses s ON s.id = r.status_id
		WHERE s.uri = ? AND r.account_id = ?`,
		object,
		signerId
	)
	const outstanding = db.all<{ inbox: string }>(
		`SELECT d.inbox_url AS inbox FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id
		WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0`,
		signerId,
		object
	)
	const unexpanded = db.all<{ inbox: string }>(
		`SELECT json_extract(t.value, '$.inbox') AS inbox FROM outbound_activities o, json_each(o.pending_targets) t
		WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0 AND o.pending_targets IS NOT NULL`,
		signerId,
		object
	)
	return [...receipts, ...outstanding, ...unexpanded].map((r) => r.inbox)
}

// ---------------------------------------------------------------------------------------------------------------
// Recording and expansion
// ---------------------------------------------------------------------------------------------------------------

// Records the intent with its targets, and expands what the step allows. A retraction supersedes every earlier
// activity about its object and drops the object's receipts (its own targets now hold that evidence); an Update
// supersedes earlier Updates only. An Update goes as an Update only to servers that have the object (a receipt, or a
// Create or Update in flight before it in the lane); every other server gets a Create of the current version
// instead, which replaces any Create or Update of the object still waiting for it there.
export function enqueueActivity(
	db: Db,
	signerId: string,
	envelope: { activity: Activity; audience: DeliveryAudience },
	now: number
): void {
	const targets = audienceTargets(db, signerId, envelope.activity, envelope.audience)
	const { object, retracts } = subjectOf(envelope.activity)
	if (object !== null && (retracts || envelope.activity.type === 'Update')) {
		db.run(
			`UPDATE outbound_activities SET superseded = 1 WHERE account_id = ? AND object_uri = ?
				AND (? OR json_extract(body, '$.activity.type') = 'Update')`,
			signerId,
			object,
			retracts ? 1 : 0
		)
	}
	if (object !== null && retracts) {
		db.run(
			'DELETE FROM outbound_receipts WHERE account_id = ? AND status_id IN (SELECT id FROM statuses WHERE uri = ?)',
			signerId,
			object
		)
	}
	if (object !== null && envelope.activity.type === 'Update') {
		const having = serversWithObject(db, signerId, object)
		const fresh = targets.filter((t) => t.inbox !== '' && !having.has(laneOf(t.inbox)))
		if (fresh.length > 0) {
			replaceWaiting(db, signerId, object, new Set(fresh.map((t) => laneOf(t.inbox))), now)
			const creation = { ...envelope, activity: createOfCurrent(envelope.activity) }
			insertIntent(db, signerId, creation, object, false, fresh, now)
		}
		const kept = new Set(fresh)
		insertIntent(
			db,
			signerId,
			envelope,
			object,
			false,
			targets.filter((t) => !kept.has(t)),
			now
		)
	} else {
		insertIntent(db, signerId, envelope, object, retracts, targets, now)
	}
	expandPending(db, now, EXPANSION_STEP)
}

function insertIntent(
	db: Db,
	signerId: string,
	envelope: { activity: Activity; audience: DeliveryAudience },
	object: string | null,
	retracts: boolean,
	targets: Target[],
	now: number
): void {
	if (targets.length === 0) {
		return
	}
	db.run(
		`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, pending_targets, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		signerId,
		JSON.stringify(envelope),
		object,
		retracts ? 1 : 0,
		JSON.stringify(targets),
		now
	)
}

// The servers (lane origins) that have the object, or will before anything later in their lane: a receipt at any of
// their inboxes, or a leased Create or Update of it (which may have been POSTed already). A server is the unit, as one
// that holds the object from its shared inbox applies an Update sent to a personal inbox, but ignores a Create.
function serversWithObject(db: Db, signerId: string, object: string): Set<string> {
	const receipts = db.all<{ inbox_url: string }>(
		`SELECT r.inbox_url FROM outbound_receipts r JOIN statuses s ON s.id = r.status_id
		WHERE s.uri = ? AND r.account_id = ?`,
		object,
		signerId
	)
	const leased = db.all<{ lane: string }>(
		`SELECT DISTINCT d.lane FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
		WHERE o.account_id = ? AND o.object_uri = ? AND o.retracts = 0 AND d.state = 'leased'`,
		signerId,
		object
	)
	return new Set([...receipts.map((r) => laneOf(r.inbox_url)), ...leased.map((r) => r.lane)])
}

// Drops the Creates and Updates of an object still waiting for these servers (queued, pending, given up, or not
// expanded): the Create of the current version replaces them.
function replaceWaiting(db: Db, signerId: string, object: string, lanes: Set<string>, now: number): void {
	const earlier = db.all<{ id: string; pending_targets: string | null }>(
		`SELECT CAST(id AS TEXT) AS id, pending_targets FROM outbound_activities
		WHERE account_id = ? AND object_uri = ? AND retracts = 0`,
		signerId,
		object
	)
	for (const intent of earlier) {
		const removed = db.all<{ lane: string }>(
			`DELETE FROM deliveries WHERE activity_id = CAST(? AS INTEGER) AND state <> 'leased'
				AND lane IN (SELECT value FROM json_each(?)) RETURNING lane`,
			intent.id,
			JSON.stringify([...lanes])
		)
		for (const lane of new Set(removed.map((r) => r.lane))) {
			promoteLane(db, signerId, lane, now)
		}
		if (intent.pending_targets !== null) {
			const rest = (JSON.parse(intent.pending_targets) as Target[]).filter((t) => !lanes.has(laneOf(t.inbox)))
			db.run(
				'UPDATE outbound_activities SET pending_targets = ? WHERE id = CAST(? AS INTEGER)',
				rest.length === 0 ? null : JSON.stringify(rest),
				intent.id
			)
		}
		dropSettledActivity(db, intent.id)
	}
}

// The Create a destination without the object gets instead of an Update: the current Note, under the Create's id.
function createOfCurrent(update: Activity): Activity {
	const note = update.object as Activity
	return {
		'@context': update['@context'],
		id: `${String(note.id)}/activity`,
		type: 'Create',
		actor: update.actor,
		published: note.published,
		to: update.to,
		cc: update.cc,
		object: note,
	}
}

function laneOf(inbox: string): string {
	return inbox === '' ? '' : new URL(inbox).origin
}

function activeCount(db: Db, where: string, limit: number, ...params: SqlStorageValue[]): number {
	return (
		db.first<{ n: number }>(
			`SELECT count(*) AS n FROM (SELECT 1 FROM deliveries WHERE ${where} AND state IN ${ACTIVE} LIMIT ?)`,
			...params,
			limit
		)?.n ?? 0
	)
}

// Admission (RES-4): whether one more active row fits the lane and the whole backlog, `total` being the active rows
// counted once by the caller and kept up to date. Retractions are never refused: they clean up what was already
// sent, and are bounded by it.
class Admission {
	#total: number | null = null

	constructor(private readonly db: Db) {}

	admits(accountId: string, lane: string, retracts: boolean): boolean {
		this.#total ??= activeCount(this.db, '1', MAX_BACKLOG)
		const fits =
			retracts ||
			(this.#total < MAX_BACKLOG &&
				activeCount(this.db, 'account_id = ? AND lane = ?', MAX_LANE_BACKLOG, accountId, lane) < MAX_LANE_BACKLOG)
		if (fits) {
			this.#total++
		}
		return fits
	}
}

export const NO_PERSONAL_INBOX = 'no personal inbox'

// Writes up to `budget` targets of the oldest intents still expanding, oldest first. A target over a cap is written as
// gave_up 'backlog full'; a silent copy without a personal inbox as gave_up 'no personal inbox' (inbox '').
function expandPending(db: Db, now: number, budget: number): void {
	const admission = new Admission(db)
	while (budget > 0) {
		const intent = db.first<{ id: string; account_id: string; retracts: number; pending_targets: string }>(
			`SELECT CAST(id AS TEXT) AS id, account_id, retracts, pending_targets FROM outbound_activities
			WHERE pending_targets IS NOT NULL ORDER BY id LIMIT 1`
		)
		if (intent === undefined) {
			return
		}
		const targets = JSON.parse(intent.pending_targets) as Target[]
		const step = targets.slice(0, budget)
		for (const target of step) {
			const lane = laneOf(target.inbox)
			const refusal =
				target.inbox === ''
					? NO_PERSONAL_INBOX
					: admission.admits(intent.account_id, lane, intent.retracts === 1)
						? null
						: BACKLOG_FULL
			if (refusal === NO_PERSONAL_INBOX) {
				// DATA-5: no URL or identity in the log; the operator sees the row.
				console.warn({ event: 'kopje.delivery.no_personal_inbox' })
			}
			db.run(
				`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, addressee, state, next_attempt_at,
					last_error, updated_at)
				VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5,
					CASE WHEN ?6 IS NOT NULL THEN 'gave_up'
						WHEN EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?2 AND lane = ?4 AND state IN ${ACTIVE})
						THEN 'queued' ELSE 'pending' END,
					?7, ?6, ?7)`,
				intent.id,
				intent.account_id,
				target.inbox,
				lane,
				target.addressee,
				refusal,
				now
			)
		}
		const rest = targets.slice(step.length)
		db.run(
			'UPDATE outbound_activities SET pending_targets = ? WHERE id = CAST(? AS INTEGER)',
			rest.length === 0 ? null : JSON.stringify(rest),
			intent.id
		)
		budget -= step.length
	}
}

// The earliest time any work is due: now while intents are still expanding, else the earliest due or lease deadline.
// A completion leaves out the rows of its own claim, which the round that holds them reports on itself.
function nextDueAt(db: Db, now: number, ownLease: string | null = null): number | null {
	if (db.first('SELECT 1 AS yes FROM outbound_activities WHERE pending_targets IS NOT NULL LIMIT 1') !== undefined) {
		return now
	}
	return (
		db.first<{ at: number | null }>(
			`SELECT min(next_attempt_at) AS at FROM deliveries
			WHERE state IN ('pending', 'leased') AND (?1 IS NULL OR lease_token IS NOT ?1)`,
			ownLease
		)?.at ?? null
	)
}

// ---------------------------------------------------------------------------------------------------------------
// Claims and completions
// ---------------------------------------------------------------------------------------------------------------

export type ClaimedDelivery = { id: string; inbox: string; signer: string; activityId: string; body: string }

export type DeliverySigner = { actorUri: string; privkey: Uint8Array; salt: Uint8Array; pubkey: string }

export type Claim = {
	leaseToken: string
	leaseUntil: number
	deliveries: ClaimedDelivery[]
	signers: Record<string, DeliverySigner>
	nextDueAt: number | null
}

// Promotes the oldest queued row of a lane once the lane has no pending or leased row.
function promoteLane(db: Db, accountId: string, lane: string, now: number): void {
	db.run(
		`UPDATE deliveries SET state = 'pending', next_attempt_at = ?3, updated_at = ?3
		WHERE id = (SELECT id FROM deliveries WHERE account_id = ?1 AND lane = ?2 AND state = 'queued' ORDER BY id LIMIT 1)
			AND NOT EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?1 AND lane = ?2 AND state IN ('pending', 'leased'))`,
		accountId,
		lane,
		now
	)
}

function dropSettledActivity(db: Db, activityId: string): void {
	db.run(
		`DELETE FROM outbound_activities WHERE id = CAST(?1 AS INTEGER) AND pending_targets IS NULL
			AND NOT EXISTS (SELECT 1 FROM deliveries WHERE activity_id = CAST(?1 AS INTEGER))`,
		activityId
	)
}

type LaneRow = {
	id: string
	activity_id: string
	account_id: string
	lane: string
	inbox_url: string
	attempts: number
}

const LANE_ROW = `CAST(id AS TEXT) AS id, CAST(activity_id AS TEXT) AS activity_id, account_id, lane, inbox_url, attempts`

function giveUp(db: Db, row: LaneRow, now: number, status: number | null, error: string): void {
	db.run(
		`UPDATE deliveries SET state = 'gave_up', lease_token = NULL, last_status = ?, last_error = ?, updated_at = ?
		WHERE id = CAST(? AS INTEGER)`,
		status,
		error,
		now,
		row.id
	)
	promoteLane(db, row.account_id, row.lane, now)
}

// The activity as sent to one row: a personal copy adds its addressee to to, and to the object's to.
function bodyFor(activity: string, addressee: string | null): string {
	if (addressee === null) {
		return activity
	}
	const parsed = JSON.parse(activity) as Activity
	const addTo = (target: Activity) => {
		target.to = [...uris(target.to).filter((uri) => uri !== addressee), addressee]
	}
	addTo(parsed)
	if (typeof parsed.object === 'object' && parsed.object !== null && Array.isArray((parsed.object as Activity).to)) {
		addTo(parsed.object as Activity)
	}
	return JSON.stringify(parsed)
}

// Expands one step, then leases up to `limit` due lane heads (RES-6: a claim reads and returns a bounded number of
// rows). An expired lease is due again; one that has used up its attempts is given up instead of claimed.
export const claimDeliveries = writeOperation<{ now: number; leaseToken: string; limit?: number }, Claim>(
	(db, { now, leaseToken, limit }) => {
		expandPending(db, now, EXPANSION_STEP)
		const max = Math.max(1, Math.min(limit ?? CLAIM_LIMIT, CLAIM_LIMIT))
		const leaseUntil = now + LEASE_MS
		const due = db.all<LaneRow & { addressee: string | null }>(
			`SELECT ${LANE_ROW}, addressee FROM deliveries
			WHERE state IN ('pending', 'leased') AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`,
			now,
			max
		)
		const claimed: ClaimedDelivery[] = []
		for (const row of due) {
			if (row.attempts >= MAX_ATTEMPTS) {
				giveUp(db, row, now, null, 'lease expired')
				continue
			}
			db.run(
				`UPDATE deliveries SET state = 'leased', lease_token = ?, attempts = attempts + 1, next_attempt_at = ?,
					updated_at = ?, last_error = CASE WHEN state = 'leased' THEN 'lease expired' ELSE last_error END
				WHERE id = CAST(? AS INTEGER)`,
				leaseToken,
				leaseUntil,
				now,
				row.id
			)
			const body = db.first<{ activity: string }>(
				"SELECT json_extract(body, '$.activity') AS activity FROM outbound_activities WHERE id = CAST(? AS INTEGER)",
				row.activity_id
			)
			claimed.push({
				id: row.id,
				inbox: row.inbox_url,
				signer: row.account_id,
				activityId: row.activity_id,
				body: bodyFor(body?.activity ?? '{}', row.addressee),
			})
		}
		const signers: Record<string, DeliverySigner> = {}
		for (const accountId of new Set(claimed.map((c) => c.signer))) {
			const key = db.first<{ uri: string; privkey: ArrayBuffer; privkey_salt: ArrayBuffer; pubkey: string }>(
				`SELECT a.uri, l.privkey, l.privkey_salt, l.pubkey FROM local_accounts l JOIN accounts a ON a.id = l.account_id
				WHERE l.account_id = ?`,
				accountId
			)
			if (key !== undefined) {
				signers[accountId] = {
					actorUri: key.uri,
					privkey: new Uint8Array(key.privkey),
					salt: new Uint8Array(key.privkey_salt),
					pubkey: key.pubkey,
				}
			}
		}
		return { leaseToken, leaseUntil, deliveries: claimed, signers, nextDueAt: nextDueAt(db, now) }
	}
)

export type DeliveryOutcome =
	| { kind: 'delivered'; status: number }
	| { kind: 'failed'; status: number | null; error: string; permanent: boolean }

export type Completion = (
	| { status: 'delivered' }
	| { status: 'retry'; retryAt: number }
	| { status: 'gave_up' }
	// The lease is no longer this one's: the row was claimed again, settled, or deleted.
	| { status: 'stale' }
) & { nextDueAt: number | null }

const MAX_ERROR_LENGTH = 200

export const completeDelivery = writeOperation<
	{ id: string; leaseToken: string; now: number; outcome: DeliveryOutcome },
	Completion
>((db, { id, leaseToken, now, outcome }) => {
	const row = db.first<LaneRow>(
		`SELECT ${LANE_ROW} FROM deliveries WHERE id = CAST(? AS INTEGER) AND state = 'leased' AND lease_token = ?`,
		id,
		leaseToken
	)
	if (row === undefined) {
		return { status: 'stale', nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	if (outcome.kind === 'delivered') {
		// The receipt is kept only for a status that still exists and has no retraction pending (VIS-3).
		db.run(
			`INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT s.id, ?2, o.account_id, ?3 FROM outbound_activities o JOIN statuses s ON s.uri = o.object_uri
			WHERE o.id = CAST(?1 AS INTEGER) AND json_extract(o.body, '$.activity.type') IN ('Create', 'Update', 'Announce')
				AND NOT EXISTS (SELECT 1 FROM outbound_activities r
					WHERE r.account_id = o.account_id AND r.object_uri = o.object_uri AND r.retracts = 1)
			ON CONFLICT DO UPDATE SET delivered_at = excluded.delivered_at`,
			row.activity_id,
			row.inbox_url,
			now
		)
		db.run('DELETE FROM deliveries WHERE id = CAST(? AS INTEGER)', row.id)
		promoteLane(db, row.account_id, row.lane, now)
		dropSettledActivity(db, row.activity_id)
		return { status: 'delivered', nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	const error = outcome.error.slice(0, MAX_ERROR_LENGTH)
	if (outcome.permanent || row.attempts >= MAX_ATTEMPTS) {
		giveUp(db, row, now, outcome.status, error)
		return { status: 'gave_up', nextDueAt: nextDueAt(db, now, leaseToken) }
	}
	const retryAt = now + retryDelay(row.attempts)
	db.run(
		`UPDATE deliveries SET state = 'pending', lease_token = NULL, next_attempt_at = ?, last_status = ?, last_error = ?,
			updated_at = ? WHERE id = CAST(? AS INTEGER)`,
		retryAt,
		outcome.status,
		error,
		now,
		row.id
	)
	return { status: 'retry', retryAt, nextDueAt: nextDueAt(db, now, leaseToken) }
})

// ---------------------------------------------------------------------------------------------------------------
// Operator view (admin API and `kopje-admin deliveries`) and the sweep
// ---------------------------------------------------------------------------------------------------------------

export type GaveUpDelivery = {
	id: string
	account: string
	// '' for a silent copy whose recipient has no personal inbox (unreachable).
	inbox: string
	// The silent recipient a personal copy is addressed to.
	addressee: string | null
	activityType: string | null
	activityId: string | null
	attempts: number
	lastStatus: number | null
	lastError: string | null
	superseded: boolean
	updatedAt: number
}

export type DeliveriesReport = {
	backlog: {
		queued: number
		pending: number
		leased: number
		gaveUp: number
		expanding: number
		oldestDueAt: number | null
		caps: { lane: number; total: number }
	}
	gaveUp: GaveUpDelivery[]
}

// The backlog by state and the given-up rows, newest first, `before` an id for the next page.
export const deliveriesReport = readOperation<{ before?: string; limit?: number }, DeliveriesReport>(
	(db, { before, limit }) => {
		const counts = db.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM deliveries GROUP BY state')
		const count = (state: string) => counts.find((c) => c.state === state)?.n ?? 0
		const oldest = db.first<{ at: number | null }>(
			"SELECT min(next_attempt_at) AS at FROM deliveries WHERE state IN ('pending', 'leased')"
		)
		const expanding =
			db.first<{ n: number }>('SELECT count(*) AS n FROM outbound_activities WHERE pending_targets IS NOT NULL')?.n ?? 0
		const rows = db.all<{
			id: string
			username: string
			inbox_url: string
			type: string | null
			activity: string | null
			attempts: number
			last_status: number | null
			last_error: string | null
			superseded: number
			addressee: string | null
			updated_at: number
		}>(
			`SELECT CAST(d.id AS TEXT) AS id, a.username, d.inbox_url, json_extract(o.body, '$.activity.type') AS type,
				json_extract(o.body, '$.activity.id') AS activity, d.attempts, d.last_status, d.last_error, o.superseded, d.addressee,
				d.updated_at
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id LEFT JOIN accounts a ON a.id = d.account_id
			WHERE d.state = 'gave_up' AND (?1 IS NULL OR d.id < CAST(?1 AS INTEGER)) ORDER BY d.id DESC LIMIT ?2`,
			before ?? null,
			Math.max(1, Math.min(limit ?? REPORT_LIMIT, REPORT_LIMIT))
		)
		return {
			backlog: {
				queued: count('queued'),
				pending: count('pending'),
				leased: count('leased'),
				gaveUp: count('gave_up'),
				expanding,
				oldestDueAt: oldest?.at ?? null,
				caps: { lane: MAX_LANE_BACKLOG, total: MAX_BACKLOG },
			},
			gaveUp: rows.map((r) => ({
				id: r.id,
				account: r.username,
				inbox: r.inbox_url,
				addressee: r.addressee,
				activityType: r.type,
				activityId: r.activity,
				attempts: r.attempts,
				lastStatus: r.last_status,
				lastError: r.last_error,
				superseded: r.superseded === 1,
				updatedAt: r.updated_at,
			})),
		}
	}
)

export type RetryResult =
	// refused: still over an admission cap, left given up. next: the cursor for `all` when more rows remain.
	| { ok: true; retried: number; skipped: number; refused: number; more: boolean; next: string | null }
	// Named rows that may not be sent again: superseded (a later activity about the same object, an Undo, a Delete or
	// an Update, follows it; sending it again could undo what the user did since), or a silent copy without a
	// personal inbox (unreachable).
	| { ok: false; code: 'superseded' | 'unreachable'; ids: string[] }

// Puts given-up rows back in their lanes with fresh attempts, through the same admission as new work (retractions are
// never refused): the named ones, or all eligible ones, RETRY_BATCH per call from the `after` cursor.
export const retryDeliveries = writeOperation<{ ids: string[] | 'all'; now: number; after?: string }, RetryResult>(
	(db, { ids, now, after }) => {
		type Candidate = {
			id: string
			account_id: string
			lane: string
			superseded: number
			retracts: number
			inbox_url: string
		}
		const columns = 'CAST(d.id AS TEXT) AS id, d.account_id, d.lane, o.superseded, o.retracts, d.inbox_url'
		let rows: Candidate[]
		let skipped = 0
		if (ids === 'all') {
			// Eligible rows only, so ineligible ones never fill the batch.
			rows = db.all<Candidate>(
				`SELECT ${columns} FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE d.state = 'gave_up' AND o.superseded = 0 AND d.inbox_url <> '' AND d.id > CAST(?1 AS INTEGER)
				ORDER BY d.id LIMIT ?2`,
				after ?? '0',
				RETRY_BATCH + 1
			)
			skipped =
				db.first<{ n: number }>(
					`SELECT count(*) AS n FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
					WHERE d.state = 'gave_up' AND (o.superseded = 1 OR d.inbox_url = '') AND d.id > CAST(? AS INTEGER)`,
					after ?? '0'
				)?.n ?? 0
		} else {
			rows = db.all<Candidate>(
				`SELECT ${columns} FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE d.state = 'gave_up' AND d.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY d.id`,
				JSON.stringify(ids.slice(0, RETRY_BATCH))
			)
			const superseded = rows.filter((r) => r.superseded === 1).map((r) => r.id)
			if (superseded.length > 0) {
				return { ok: false, code: 'superseded', ids: superseded }
			}
			const unreachable = rows.filter((r) => r.inbox_url === '').map((r) => r.id)
			if (unreachable.length > 0) {
				return { ok: false, code: 'unreachable', ids: unreachable }
			}
		}
		const batch = rows.slice(0, RETRY_BATCH)
		const admission = new Admission(db)
		let retried = 0
		for (const row of batch) {
			if (!admission.admits(row.account_id, row.lane, row.retracts === 1)) {
				continue
			}
			db.run(
				`UPDATE deliveries SET attempts = 0, last_status = NULL, last_error = NULL, next_attempt_at = ?3, updated_at = ?3,
					state = CASE WHEN EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?1 AND lane = ?2
						AND state IN ${ACTIVE}) THEN 'queued' ELSE 'pending' END
				WHERE id = CAST(?4 AS INTEGER)`,
				row.account_id,
				row.lane,
				now,
				row.id
			)
			retried++
		}
		const more = rows.length > RETRY_BATCH
		return {
			ok: true,
			retried,
			skipped,
			refused: batch.length - retried,
			more,
			next: more ? (batch.at(-1)?.id ?? null) : null,
		}
	}
)

// RES-4: given-up rows are kept for GAVE_UP_RETENTION_MS, then deleted with their activity once it has no row left.
export const sweepDeliveries = writeOperation<{ now: number }, { swept: number }>((db, { now }) => {
	const swept = db.all<{ activity_id: string }>(
		`DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE state = 'gave_up' AND updated_at < ?
			ORDER BY updated_at LIMIT ?) RETURNING CAST(activity_id AS TEXT) AS activity_id`,
		now - GAVE_UP_RETENTION_MS,
		SWEEP_BATCH
	)
	for (const activityId of new Set(swept.map((r) => r.activity_id))) {
		dropSettledActivity(db, activityId)
	}
	return { swept: swept.length }
})
