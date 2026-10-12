import { readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'

// Outbound delivery (design §4 "outbound", NET-2, RES-5, RES-6, OPS-3). deliveries is the source of truth; the Queue
// only rings a doorbell, and the Worker does the POSTs.
//
//   - Expansion: an outbound intent becomes one deliveries row per target inbox, in the transaction of the change that
//     made it (recordOutbound in activities.ts). Inboxes come from the stored audience only.
//   - Lanes: a lane is (sender, inbox) and is delivered in id order. Only its oldest row is pending or leased; the
//     rows behind it are queued, and promoted when the head settles. So the due index holds lane heads only, and a
//     claim reads at most `limit` rows.
//   - Claims run inside one Store transaction, so they are serialized. Each claim issues a fresh lease token, counts
//     an attempt and leases the row for LEASE_MS. A completion settles a row only with the token of its current
//     lease, so a completion that arrives after the lease expired and the row was claimed again changes nothing.
//   - An expired lease (the Worker died, or the completion was lost after the POST) is claimed again like a due row.
//     The remote inbox may then see the activity twice; receivers deduplicate by activity id.
//   - A failure is retried after min(30 s·2^n, 12 h), n being the attempts so far; after MAX_ATTEMPTS, or on a
//     permanent failure, the row is gave_up: kept for the operator (admin API) until retried or swept.
//   - A delivered row is deleted, and its inbox is recorded in outbound_receipts for the object, so that a later
//     Delete or Undo reaches every inbox that received it. The outbound row goes with its last delivery.

export const LEASE_MS = 60_000
export const MAX_ATTEMPTS = 15
export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 12 * 60 * 60 * 1000
export const CLAIM_LIMIT = 16
export const GAVE_UP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SWEEP_BATCH = 500
const RETRY_BATCH = 1000
const REPORT_LIMIT = 100

// The wait before the next attempt, after `attempts` attempts have failed (attempts >= 1).
export function retryDelay(attempts: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 30), RETRY_MAX_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------------------------------------------

type Activity = Record<string, unknown>

function uris(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value]
	}
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function objectId(value: unknown): string | null {
	if (typeof value === 'string') {
		return value
	}
	if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
		return (value as { id: string }).id
	}
	return null
}

// The local object whose receivers are recorded when this activity is delivered.
function receiptObject(activity: Activity): string | null {
	switch (activity.type) {
		case 'Create':
		case 'Update':
			return objectId(activity.object)
		case 'Announce':
			return typeof activity.id === 'string' ? activity.id : null
		default:
			return null
	}
}

// The local object this activity retracts, whose receivers it must also reach.
function retractedObject(activity: Activity): string | null {
	if (activity.type === 'Delete') {
		return objectId(activity.object)
	}
	if (activity.type === 'Undo') {
		const inner = activity.object as { type?: unknown } | null
		return typeof inner === 'object' && inner !== null && inner.type === 'Announce' ? objectId(inner) : null
	}
	return null
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

// The inboxes an activity goes to (NET-2), from the stored audience only:
//   - followers: the signer's accepted remote followers, by shared inbox when they have one (deduplicated);
//   - addressed accounts: a remote account named in to/cc by its shared inbox, as Mastodon's StatusReachFinder; one
//     the activity reaches without naming it (a silent recipient, the object of a Like or Follow) by its personal
//     inbox, as only that tells the receiver it is addressed (Mastodon delivers favourites and follows there too);
//   - for a Delete or an Undo of an Announce, every inbox that received the object (outbound_receipts).
// Local accounts are never delivered to over HTTP: they read the Store.
export function audienceInboxes(db: Db, signerId: string, activity: Activity, audience: DeliveryAudience): string[] {
	const inboxes = new Set<string>()
	if (audience.followers) {
		const followers = db.all<{ inbox: string | null }>(
			`SELECT DISTINCT COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) AS inbox
			FROM follows f JOIN accounts a ON a.id = f.account_id
			WHERE f.target_account_id = ? AND f.state = 'accepted' AND a.domain IS NOT NULL`,
			signerId
		)
		for (const { inbox } of followers) {
			if (isDeliverableInbox(inbox)) {
				inboxes.add(inbox)
			}
		}
	}
	const named = new Set([...uris(activity.to), ...uris(activity.cc)])
	const addressed = db.all<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null }>(
		`SELECT uri, inbox_url, shared_inbox_url FROM accounts
		WHERE id IN (SELECT value FROM json_each(?)) AND domain IS NOT NULL`,
		JSON.stringify(audience.accounts)
	)
	for (const account of addressed) {
		const shared = account.shared_inbox_url === '' ? null : account.shared_inbox_url
		const inbox = named.has(account.uri) ? (shared ?? account.inbox_url) : (account.inbox_url ?? shared)
		if (isDeliverableInbox(inbox)) {
			inboxes.add(inbox)
		}
	}
	const retracted = retractedObject(activity)
	if (retracted !== null) {
		const receivers = db.all<{ inbox_url: string }>(
			'SELECT inbox_url FROM outbound_receipts WHERE object_uri = ? AND account_id = ?',
			retracted,
			signerId
		)
		for (const { inbox_url } of receivers) {
			if (isDeliverableInbox(inbox_url)) {
				inboxes.add(inbox_url)
			}
		}
	}
	return [...inboxes].sort()
}

// Writes the intent and its deliveries, or nothing if no inbox needs it. Receipts of a retracted object are folded
// into the retraction's deliveries and dropped: the retraction's own rows now hold that evidence.
export function enqueueActivity(
	db: Db,
	signerId: string,
	envelope: { activity: Activity; audience: DeliveryAudience },
	now: number
): void {
	const inboxes = audienceInboxes(db, signerId, envelope.activity, envelope.audience)
	const retracted = retractedObject(envelope.activity)
	if (retracted !== null) {
		db.run('DELETE FROM outbound_receipts WHERE object_uri = ? AND account_id = ?', retracted, signerId)
	}
	if (inboxes.length === 0) {
		return
	}
	const row = db.first<{ id: string }>(
		'INSERT INTO outbound_activities (account_id, body, created_at) VALUES (?, ?, ?) RETURNING CAST(id AS TEXT) AS id',
		signerId,
		JSON.stringify(envelope),
		now
	)
	if (row === undefined) {
		throw new Error('outbound activity was not recorded')
	}
	for (const inbox of inboxes) {
		db.run(
			`INSERT INTO deliveries (activity_id, account_id, inbox_url, state, next_attempt_at, updated_at)
			VALUES (CAST(?1 AS INTEGER), ?2, ?3,
				CASE WHEN EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?2 AND inbox_url = ?3
					AND state IN ('queued', 'pending', 'leased')) THEN 'queued' ELSE 'pending' END, ?4, ?4)`,
			row.id,
			signerId,
			inbox,
			now
		)
	}
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
}

// Promotes the oldest queued row of a lane once the lane has no pending or leased row.
function promoteLane(db: Db, accountId: string, inbox: string, now: number): void {
	db.run(
		`UPDATE deliveries SET state = 'pending', next_attempt_at = ?3, updated_at = ?3
		WHERE id = (SELECT id FROM deliveries WHERE account_id = ?1 AND inbox_url = ?2 AND state = 'queued' ORDER BY id LIMIT 1)
			AND NOT EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?1 AND inbox_url = ?2 AND state IN ('pending', 'leased'))`,
		accountId,
		inbox,
		now
	)
}

function dropSettledActivity(db: Db, activityId: string): void {
	db.run(
		`DELETE FROM outbound_activities WHERE id = CAST(?1 AS INTEGER)
			AND NOT EXISTS (SELECT 1 FROM deliveries WHERE activity_id = CAST(?1 AS INTEGER))`,
		activityId
	)
}

type LaneRow = { id: string; activity_id: string; account_id: string; inbox_url: string; attempts: number }

function giveUp(db: Db, row: LaneRow, now: number, status: number | null, error: string): void {
	db.run(
		`UPDATE deliveries SET state = 'gave_up', lease_token = NULL, last_status = ?, last_error = ?, updated_at = ?
		WHERE id = CAST(? AS INTEGER)`,
		status,
		error,
		now,
		row.id
	)
	promoteLane(db, row.account_id, row.inbox_url, now)
}

// Leases up to `limit` due lane heads (RES-6: a claim reads and returns a bounded number of rows). An expired lease
// is due again; one that has used up its attempts is given up instead of claimed.
export const claimDeliveries = writeOperation<{ now: number; leaseToken: string; limit?: number }, Claim>(
	(db, { now, leaseToken, limit }) => {
		const max = Math.max(1, Math.min(limit ?? CLAIM_LIMIT, CLAIM_LIMIT))
		const leaseUntil = now + LEASE_MS
		const due = db.all<LaneRow & { state: string }>(
			`SELECT CAST(id AS TEXT) AS id, CAST(activity_id AS TEXT) AS activity_id, account_id, inbox_url, attempts, state
			FROM deliveries WHERE state IN ('pending', 'leased') AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`,
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
				body: body?.activity ?? '{}',
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
		return { leaseToken, leaseUntil, deliveries: claimed, signers }
	}
)

export type DeliveryOutcome =
	| { kind: 'delivered'; status: number }
	| { kind: 'failed'; status: number | null; error: string; permanent: boolean }

export type Completion =
	| { status: 'delivered' }
	| { status: 'retry'; retryAt: number }
	| { status: 'gave_up' }
	// The lease is no longer this one's: the row was claimed again, settled, or deleted.
	| { status: 'stale' }

const MAX_ERROR_LENGTH = 200

export const completeDelivery = writeOperation<
	{ id: string; leaseToken: string; now: number; outcome: DeliveryOutcome },
	Completion
>((db, { id, leaseToken, now, outcome }) => {
	const row = db.first<LaneRow>(
		`SELECT CAST(id AS TEXT) AS id, CAST(activity_id AS TEXT) AS activity_id, account_id, inbox_url, attempts
		FROM deliveries WHERE id = CAST(? AS INTEGER) AND state = 'leased' AND lease_token = ?`,
		id,
		leaseToken
	)
	if (row === undefined) {
		return { status: 'stale' }
	}
	if (outcome.kind === 'delivered') {
		const body = db.first<{ body: string }>(
			'SELECT body FROM outbound_activities WHERE id = CAST(? AS INTEGER)',
			row.activity_id
		)
		const activity = body === undefined ? null : (JSON.parse(body.body) as { activity: Activity }).activity
		const object = activity === null ? null : receiptObject(activity)
		if (object !== null) {
			db.run(
				`INSERT INTO outbound_receipts (object_uri, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, ?)
				ON CONFLICT DO UPDATE SET delivered_at = excluded.delivered_at`,
				object,
				row.inbox_url,
				row.account_id,
				now
			)
		}
		db.run('DELETE FROM deliveries WHERE id = CAST(? AS INTEGER)', row.id)
		promoteLane(db, row.account_id, row.inbox_url, now)
		dropSettledActivity(db, row.activity_id)
		return { status: 'delivered' }
	}
	const error = outcome.error.slice(0, MAX_ERROR_LENGTH)
	if (outcome.permanent || row.attempts >= MAX_ATTEMPTS) {
		giveUp(db, row, now, outcome.status, error)
		return { status: 'gave_up' }
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
	return { status: 'retry', retryAt }
})

// ---------------------------------------------------------------------------------------------------------------
// Operator view (admin API and `kopje-admin deliveries`) and the sweep
// ---------------------------------------------------------------------------------------------------------------

export type GaveUpDelivery = {
	id: string
	account: string
	inbox: string
	activityType: string | null
	activityId: string | null
	attempts: number
	lastStatus: number | null
	lastError: string | null
	updatedAt: number
}

export type DeliveriesReport = {
	backlog: { queued: number; pending: number; leased: number; gaveUp: number; oldestDueAt: number | null }
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
		const rows = db.all<{
			id: string
			username: string
			inbox_url: string
			type: string | null
			activity: string | null
			attempts: number
			last_status: number | null
			last_error: string | null
			updated_at: number
		}>(
			`SELECT CAST(d.id AS TEXT) AS id, a.username, d.inbox_url, json_extract(o.body, '$.activity.type') AS type,
				json_extract(o.body, '$.activity.id') AS activity, d.attempts, d.last_status, d.last_error, d.updated_at
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
				oldestDueAt: oldest?.at ?? null,
			},
			gaveUp: rows.map((r) => ({
				id: r.id,
				account: r.username,
				inbox: r.inbox_url,
				activityType: r.type,
				activityId: r.activity,
				attempts: r.attempts,
				lastStatus: r.last_status,
				lastError: r.last_error,
				updatedAt: r.updated_at,
			})),
		}
	}
)

// Puts given-up rows back in their lanes with fresh attempts: the named ones, or all (at most RETRY_BATCH per call).
export const retryDeliveries = writeOperation<
	{ ids: string[] | 'all'; now: number },
	{ retried: number; more: boolean }
>((db, { ids, now }) => {
	const rows = db.all<{ id: string; account_id: string; inbox_url: string }>(
		`SELECT CAST(id AS TEXT) AS id, account_id, inbox_url FROM deliveries
			WHERE state = 'gave_up' AND (?1 IS NULL OR id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1)))
			ORDER BY id LIMIT ?2`,
		ids === 'all' ? null : JSON.stringify(ids.slice(0, RETRY_BATCH)),
		RETRY_BATCH + 1
	)
	const batch = rows.slice(0, RETRY_BATCH)
	for (const row of batch) {
		db.run(
			`UPDATE deliveries SET attempts = 0, last_status = NULL, last_error = NULL, next_attempt_at = ?3, updated_at = ?3,
					state = CASE WHEN EXISTS (SELECT 1 FROM deliveries WHERE account_id = ?1 AND inbox_url = ?2
						AND state IN ('queued', 'pending', 'leased')) THEN 'queued' ELSE 'pending' END
				WHERE id = CAST(?4 AS INTEGER)`,
			row.account_id,
			row.inbox_url,
			now,
			row.id
		)
	}
	return { retried: batch.length, more: rows.length > RETRY_BATCH }
})

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
