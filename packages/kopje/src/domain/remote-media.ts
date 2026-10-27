import { availableSql, hostCoveredSql, suspendedSql } from './audience'
import { hostCovered } from './instance-domain-blocks'
import { writeOperation } from './operation'
import { fixedColumns, selectSql } from '../db/columns'
import { ACCOUNTS_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'
import { REMOTE_MEDIA_CACHE_MIN_BYTES } from '../platform/config'
import { hostDomain } from '../platform/domain-name'
import { remoteMediaUrlRefusal } from '../platform/http-url'
import { FILE_TOKEN } from '../platform/media-files'
import { type RemoteCategory, type RemoteFileKind, remoteFileLimits } from '../platform/remote-media-bytes'
import {
	REMOTE_MEDIA_ACCOUNT_INDEX,
	REMOTE_MEDIA_DUE_INDEX,
	REMOTE_MEDIA_EXPIRY_INDEX,
	REMOTE_MEDIA_HOSTS,
	REMOTE_MEDIA_MAX_ATTEMPTS,
	REMOTE_MEDIA_OWNER_INDEX,
	REMOTE_MEDIA_TYPES,
	REMOTE_OBJECTS_DUE_INDEX,
	REMOTE_OBJECTS_RETRY_INDEX,
	REMOTE_OBJECTS_RESERVED_INDEX,
	REMOTE_OBJECTS_SLOT_INDEX,
	REMOTE_OBJECTS_STORED_INDEX,
	REMOTE_OBJECTS_VALIDATION_INDEX,
	REMOTE_MEDIA_DELETE_ATTEMPTS,
	SAFE_INTEGER_MAX,
	cardUrlPastSql,
	storedLinkDomain,
} from '../platform/stored-bounds'

// The cache of remote media (MEDIA-7 in docs/threat-model.md; migration 0077_remote_media): the Store's part, the only
// writer of remote_media (slots), remote_media_objects (the R2 ledger) and remote_media_usage. The Worker's part, the
// cron round that fetches and puts files and deletes doomed ones, is federation/remote-media.ts. This release caches
// remote accounts' avatars and headers (kinds avatar and header, lane 0); the other kinds have no enqueue and no
// eligibility branch yet, so a slot of one is never claimed and is retired by the validity walk.
//
// A slot (one remote file of one owner) is pending (due_at set), failed (failed_at set) or stored (token set: the
// object it shows). An object (one R2 token, remote/<token>/full and remote/<token>/still) is reserved (claimed,
// recorded before any key exists, MEDIA-2), stored, or doomed (its deletion due at due_at); it is charged
// `charge` bytes: a reservation R (the kind's file cap plus its still cap), its actual bytes once stored, and a doomed
// one keeps what it had until its deletion is confirmed. remote_media_usage holds bytes (every charge), doomed (the
// doomed charges) and pending (the slots with due_at set); every transition changes it in the same transaction, here
// only, so it is exact by construction (the audit only logs drift).
//
// Transitions:
// - enqueue (syncProfileFiles, in upsertRemoteActor's storing branch; the backfill): a slot for each acceptable URL,
//   reset (resetSlot) when its URL changed or when it failed more than a day ago, removed when the URL is gone;
// - claim (claimRemoteMedia): expiry, then a walk of due slots: each deleted (ineligible, attempts exhausted, a counter
//   past its range), deferred (the reservation not admitted) or claimed (a fresh token reserved at R);
// - admission (admitRemoteMedia) before each put, and record (recordRemoteMedia), both under the fence (FENCE): the
//   claim's token reserved for the slot, the slot's claim and generation, the slot eligible now, no recorded host
//   covered, the category the slot's;
// - maintenance (maintainRemoteMedia, one call a round): PITR settling and validation, reservation expiry, the
//   validity walk, the suspended accounts, the backfill, reclamation, the audit, and the batch of doomed objects due;
//   deletion is confirmed (confirmRemoteMediaDeleted) only after the R2 delete returned;
// - retirement (retireAccountSlots, the purge of a deleted account).
// A doom whose object may still receive a put (it was reserved: a put of the claim may be in flight, or may land late
// after its call was given up) is due LATE_PUT_MS after the Store-recorded claimed_at: a put cannot outlive its cron
// invocation (15 minutes), so it lands before the deletion. Every other doom is due at once.

// ---- Constants

// The cap less this is where lane 1 admission stops and reclamation starts: one round of lane 0 reservations.
export const LANE1_HEADROOM = 96 * 1024 * 1024
export const REMOTE_MEDIA_PENDING_LIMIT = 20_000
export const REMOTE_MEDIA_HOLD_MS = 10 * 60 * 1000
export const LATE_PUT_MS = 75 * 60 * 1000
// Retries after a transient failure, by the attempt that failed (1 to 3); the fourth failure is final.
export const RETRY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000] as const
export const DEFER_MS = 60 * 60 * 1000
export const FAILED_RESET_MS = 24 * 60 * 60 * 1000
export const EXPIRE_PENDING_MS = 7 * 24 * 60 * 60 * 1000
export const EXPIRE_BATCH = 500
export const LANE0_CLAIMS = 24
export const CLAIM_WALK = 64
export const DELETE_BATCH = 500
// The retried deletions a round may take, of DELETE_BATCH, and the halvings after which one is tried alone (250 / 2^8
// < 1: from its ninth attempt).
export const RETRY_BATCH = 250
export const DELETE_SPLITS = 8
export const DELETE_BACKOFF_MS = 5 * 60 * 1000
export const DELETE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000
export const RESERVATION_EXPIRY_BATCH = 500
export const VALIDITY_WALK = 500
export const SUSPENDED_ACCOUNTS = 200
export const SUSPENDED_SLOTS = 200
export const RECLAIM_VICTIMS = 200
export const BACKFILL_BATCH = 200
export const BACKFILL_DELAY_MS = 60 * 60 * 1000
export const AUDIT_CHUNK = 500
// PITR: a restore younger than this stops the round before any write or R2 operation; validation heads at most this
// many variants a round.
export const REMOTE_SETTLE_MS = 20 * 60 * 1000
export const VALIDATION_HEADS = 100
// The failed heads in a row after which validation handles an object as missing.
export const VALIDATION_FAILURES = 3
export const ORPHAN_SWEEP_MS = 60 * 60 * 1000
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000
// The kinds the release fetches (backfill's coverage version: a release that adds kinds bumps it).
const COVERAGE_VERSION = 1

// Reclamation's victim order: attachments, thumbnails, headers, avatars, emoji.
const RECLAIM_ORDER = ['attachment', 'thumbnail', 'header', 'avatar', 'emoji'] as const

const STATE = {
	walk: 'remote_media_walk',
	suspended: 'remote_media_suspended',
	backfill: 'remote_media_backfill',
	validated: 'remote_media_validated_at',
	validation: 'remote_media_validation',
	sweep: 'remote_media_sweep',
	audit: 'remote_media_audit',
} as const

const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const isTimeOrNull = (n: unknown): n is number | null => n === null || isTime(n)

function state(db: Db, name: string): string | undefined {
	return db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', name)?.value
}

function setState(db: Db, name: string, value: string): void {
	db.run('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, value)
}

// An array input as given over RPC (a caller may send anything), or none.
function listOf<T>(value: readonly T[]): readonly T[] {
	return Array.isArray(value) ? (value as readonly T[]) : []
}

function json<T>(db: Db, name: string): Partial<T> {
	try {
		const value: unknown = JSON.parse(state(db, name) ?? '{}')
		return typeof value === 'object' && value !== null ? value : {}
	} catch {
		return {}
	}
}

// The reservation of a kind in a category: its file cap and its still cap (platform/remote-media-bytes.ts).
export function reservationOf(kind: RemoteFileKind, category: RemoteCategory): number | null {
	const limits = remoteFileLimits(kind, category)
	return limits === null ? null : limits.maxBytes + (limits.stillMaxBytes ?? 0)
}

// ---- Usage

function addUsage(db: Db, change: { bytes?: number; doomed?: number; pending?: number }): void {
	db.run(
		`UPDATE remote_media_usage SET bytes = bytes + ?1, doomed = doomed + ?2, pending = max(pending + ?3, 0)
		WHERE id = 1`,
		change.bytes ?? 0,
		change.doomed ?? 0,
		change.pending ?? 0
	)
}

// A change of the object `token`'s charge (bytes, doomed) in the usage row. While an audit pass runs, a change of an
// object it has already counted (token at or before its cursor) is added to the pass's sums too, so a write between
// its chunks reports no drift.
function chargeObject(db: Db, token: string, change: { bytes?: number; doomed?: number; pending?: number }): void {
	addUsage(db, change)
	const saved = json<Audit>(db, STATE.audit)
	if (typeof saved.cursor === 'string' && saved.cursor !== '' && token <= saved.cursor) {
		setState(
			db,
			STATE.audit,
			JSON.stringify({
				cursor: saved.cursor,
				bytes: (saved.bytes ?? 0) + (change.bytes ?? 0),
				doomed: (saved.doomed ?? 0) + (change.doomed ?? 0),
			})
		)
	}
}

export type RemoteMediaUsage = { bytes: number; doomed: number; pending: number }

export function usage(db: Db): RemoteMediaUsage {
	return (
		db.first<RemoteMediaUsage>('SELECT bytes, doomed, pending FROM remote_media_usage WHERE id = 1') ?? {
			bytes: 0,
			doomed: 0,
			pending: 0,
		}
	)
}

// ---- Eligibility (one predicate: claim, record, the validity walk, and the presenter's owner and URL part)

// Whether the slot row `r` may be claimed, recorded or kept: its owner and URL part (slotOwnsSql), and its policy:
// the owner account available (R1: not suspended, not being deleted, no domain block covering it), and neither the
// slot's host nor any host of its object's fetch covered by a domain block (redirect provenance). Emoji, attachment
// and thumbnail slots have no branch yet: never eligible.
function slotEligibleSql(r: string): string {
	return `(${slotOwnsSql(r)} AND ${availableSql(`${r}.owner_id`)}
		AND NOT ${hostCoveredSql(`${r}.host`)}
		AND NOT EXISTS (SELECT 1 FROM remote_media_objects eo INDEXED BY ${REMOTE_OBJECTS_SLOT_INDEX}
			CROSS JOIN json_each(CASE WHEN json_valid(eo.hosts) THEN eo.hosts ELSE '[]' END) eh
			WHERE eo.slot_id = ${r}.id AND ${hostCoveredSql('eh.value')}))`
}

// The owner and URL part: an avatar or header slot of a stored remote account whose current avatar_url or header_url
// is the slot's URL, byte for byte.
function slotOwnsSql(r: string): string {
	return `(${r}.kind IN ('avatar', 'header') AND EXISTS (SELECT 1 FROM accounts eac INDEXED BY ${ACCOUNTS_ID_INDEX}
		WHERE eac.id = ${r}.owner_id AND eac.id = ${r}.account_id AND eac.domain IS NOT NULL
			AND CAST(CASE ${r}.kind WHEN 'avatar' THEN eac.avatar_url ELSE eac.header_url END AS BLOB) = CAST(${r}.url AS BLOB)))`
}

// ---- Dooms and resets

// Dooms the live object `token` (reserved or stored), unlinked from its slot, with its deletion due at once, or
// LATE_PUT_MS after its Store-recorded claim when it was reserved (a put may still land) unless `immediate` (its
// window has passed). Its charge stays counted, now as doomed. One ledger row and the usage row.
function doomObject(db: Db, token: string, now: number, immediate = false): void {
	const object = db.first<{ charge: number; state: string; claimed_at: number }>(
		"SELECT charge, state, claimed_at FROM remote_media_objects WHERE token = ?1 AND state <> 'doomed'",
		token
	)
	if (object === undefined) {
		return
	}
	const due = object.state === 'reserved' && !immediate ? Math.max(now, object.claimed_at + LATE_PUT_MS) : now
	db.run(
		"UPDATE remote_media_objects SET state = 'doomed', slot_id = NULL, due_at = ?2 WHERE token = ?1",
		token,
		Math.min(due, SAFE_INTEGER_MAX)
	)
	chargeObject(db, token, { doomed: object.charge })
}

// Dooms the live object of slot `id`, if any (at most one: remote_media_objects_slot is unique).
function doomSlotObject(db: Db, id: number, now: number): void {
	const object = db.first<{ token: string }>(
		`SELECT token FROM remote_media_objects INDEXED BY ${REMOTE_OBJECTS_SLOT_INDEX} WHERE slot_id = ?1`,
		id
	)
	if (object !== undefined) {
		doomObject(db, object.token, now)
	}
}

// Deletes slot `id` and dooms its object; the pending count follows.
function deleteSlot(db: Db, id: number, now: number): void {
	doomSlotObject(db, id, now)
	const pending = db.first<{ due: number }>(
		'DELETE FROM remote_media WHERE id = ?1 RETURNING due_at IS NOT NULL AS due',
		id
	)
	if (pending?.due === 1) {
		addUsage(db, { pending: -1 })
	}
}

// resetSlot: one atomic transition of slot `id` to pending at `now` with `url` (and its host): generation + 1, no
// attempts, no failure, no object (its object doomed), enqueued and due now. The pending count changes by the
// old-to-new pending-state delta: a slot already pending or claimed adds nothing. Applied only while it adds
// nothing or the pending count is below REMOTE_MEDIA_PENDING_LIMIT; otherwise the slot is left as it was (false).
function resetSlot(db: Db, id: number, url: string, host: string, now: number): boolean {
	const slot = db.first<{ due: number }>('SELECT due_at IS NOT NULL AS due FROM remote_media WHERE id = ?1', id)
	if (slot === undefined) {
		return false
	}
	if (slot.due !== 1 && usage(db).pending >= REMOTE_MEDIA_PENDING_LIMIT) {
		return false
	}
	doomSlotObject(db, id, now)
	db.run(
		`UPDATE remote_media SET url = ?2, host = ?3, generation = min(generation + 1, ${SAFE_INTEGER_MAX}), attempts = 0,
			failed_at = NULL, enqueued_at = ?4, due_at = ?4, token = NULL, ext = NULL, still_ext = NULL, stored_at = NULL
		WHERE id = ?1`,
		id,
		url,
		host,
		now
	)
	if (slot.due !== 1) {
		addUsage(db, { pending: 1 })
	}
	return true
}

// ---- Enqueue

// The instance's domain (instance_settings), or null before setup.
function instanceDomain(db: Db): string | null {
	const value = db.first<{ value: SqlStorageValue }>("SELECT value FROM instance_settings WHERE name = 'domain'")?.value
	return typeof value === 'string' ? value : null
}

// The URL a slot takes for `value` and its normalized host, or null: what the fetch accepts (platform/http-url.ts
// remoteMediaUrlRefusal, the own host included) and what the stored bound takes (an https card URL, judged by the
// trigger's own predicate, and a link domain), so the insert never fails on the trigger.
function slotUrl(db: Db, value: string | null, own: string): { url: string; host: string } | null {
	if (typeof value !== 'string' || remoteMediaUrlRefusal(value, own) !== null) {
		return null
	}
	const host = storedLinkDomain(hostDomain(value))
	if (host === null) {
		return null
	}
	const stored = db.first<{ past: number }>(`SELECT ${cardUrlPastSql('?1', false)} AS past`, value)
	return stored?.past === 0 ? { url: value, host } : null
}

type SlotRow = { id: number; url: string; failed_at: number | null }

// Inserts a pending profile image slot (lane 0) of `kind` for the account `owner` with `url`, due at `due`, while
// the pending count is below REMOTE_MEDIA_PENDING_LIMIT.
function insertSlot(
	db: Db,
	kind: 'avatar' | 'header',
	owner: string,
	target: { url: string; host: string },
	now: number,
	due: number
): void {
	if (usage(db).pending >= REMOTE_MEDIA_PENDING_LIMIT) {
		return
	}
	const inserted = db.run(
		`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, due_at, enqueued_at)
		VALUES (?1, ?2, ?2, ?3, ?4, 'image', 0, 0, ?5, ?6) ON CONFLICT DO NOTHING`,
		kind,
		owner,
		target.url,
		target.host,
		due,
		now
	)
	if (inserted > 0) {
		addUsage(db, { pending: 1 })
	}
}

// The profile images of the stored remote account `accountId` (upsertRemoteActor's storing branch, after the row is
// stored; the backfill), per slot (avatar, header): a URL that is gone or not acceptable removes the slot and dooms
// its object; the same URL leaves it, but for a slot that failed more than FAILED_RESET_MS ago, which is reset; a new
// URL resets it; no slot yet inserts a pending one, due at `due` (now for an update, later for the backfill). Never for
// a local account (ID-3), nor for a host a domain block covers. At most 2 slots and 2 objects written, and the usage
// row.
export function syncProfileFiles(
	db: Db,
	accountId: string,
	urls: { avatar: string | null; header: string | null },
	now: number,
	due = now
): void {
	const own = instanceDomain(db)
	if (own === null || !isTime(now)) {
		return
	}
	const remote = db.first('SELECT 1 AS x FROM accounts WHERE id = ?1 AND domain IS NOT NULL', accountId)
	if (remote === undefined) {
		return
	}
	for (const kind of ['avatar', 'header'] as const) {
		const slot = db.first<SlotRow>(
			`SELECT id, url, failed_at FROM remote_media INDEXED BY ${REMOTE_MEDIA_OWNER_INDEX}
			WHERE owner_id = ?1 AND kind = ?2`,
			accountId,
			kind
		)
		const target = slotUrl(db, urls[kind], own)
		if (target === null || hostCovered(db, target.host)) {
			if (slot !== undefined) {
				deleteSlot(db, slot.id, now)
			}
			continue
		}
		if (slot === undefined) {
			insertSlot(db, kind, accountId, target, now, due)
		} else if (slot.url !== target.url || (slot.failed_at !== null && slot.failed_at < now - FAILED_RESET_MS)) {
			resetSlot(db, slot.id, target.url, target.host, now)
		}
	}
}

// Retires the slots of the remote account `accountId` (its purge, inbox.ts purgeBatch): each slot deleted and its
// object doomed, three rows changed at most a slot (the slot, the object, the usage row), while `budget` has room for
// one. 'more' when a slot remains, so the purge resumes it in a later batch before anything else.
export function retireAccountSlots(
	db: Db,
	accountId: string,
	budget: { left(): number },
	now: number
): 'done' | 'more' {
	for (;;) {
		const slot = db.first<{ id: number }>(
			`SELECT id FROM remote_media INDEXED BY ${REMOTE_MEDIA_ACCOUNT_INDEX} WHERE account_id = ?1 LIMIT 1`,
			accountId
		)
		if (slot === undefined) {
			return 'done'
		}
		if (budget.left() < 3) {
			return 'more'
		}
		deleteSlot(db, slot.id, now)
	}
}

// ---- Claim

export type RemoteMediaClaim = {
	slot: number
	claim: number
	generation: number
	token: string
	kind: RemoteFileKind
	category: RemoteCategory
	url: string
}

export type RemoteMediaClaims = {
	// The instance's domain, for the round's User-Agent; null: nothing was done.
	domain: string | null
	claims: RemoteMediaClaim[]
	expired: number
	dropped: number
	deferred: number
}

type Walked = {
	id: number
	kind: string
	category: string
	url: string
	claim: number
	generation: number
	attempts: number
	eligible: number
}

// See the module's head. `tokens`: the Worker's fresh tokens, one per claim it may start (at most LANE0_CLAIMS are
// used); `cap`: REMOTE_MEDIA_CACHE_BYTES. First at most EXPIRE_BATCH slots pending more than EXPIRE_PENDING_MS are
// deleted (never one under an open hold), then at most CLAIM_WALK due slots of lane 0 are walked by (lane, due_at, id),
// each deleted (ineligible, attempts exhausted, a counter at its end), deferred by DEFER_MS when its reservation is
// not admitted (bytes + R past the cap; no attempt charged), or claimed: its earlier object doomed, the token reserved
// at R (bytes + R), and the slot's claim and attempts counted, due again after REMOTE_MEDIA_HOLD_MS.
export const claimRemoteMedia = writeOperation<
	{ now: number; tokens: readonly string[]; cap: number },
	RemoteMediaClaims
>((db, { now, tokens, cap }) => {
	const out: RemoteMediaClaims = { domain: null, claims: [], expired: 0, dropped: 0, deferred: 0 }
	const domain = instanceDomain(db)
	if (domain === null || !isTime(now) || now > SAFE_INTEGER_MAX - LATE_PUT_MS || !isTime(cap)) {
		return out
	}
	out.domain = domain
	const expired = db.all<{ id: number }>(
		`SELECT id FROM remote_media INDEXED BY ${REMOTE_MEDIA_EXPIRY_INDEX}
		WHERE due_at IS NOT NULL AND enqueued_at < ?1 ORDER BY enqueued_at LIMIT ${EXPIRE_BATCH}`,
		now - EXPIRE_PENDING_MS
	)
	for (const { id } of expired) {
		const held = db.first('SELECT 1 AS x FROM remote_media WHERE id = ?1 AND attempts > 0 AND due_at > ?2', id, now)
		if (held === undefined) {
			deleteSlot(db, id, now)
			out.expired++
		}
	}
	const given = listOf(tokens)
		.filter((token): token is string => typeof token === 'string' && FILE_TOKEN.test(token))
		.slice(0, LANE0_CLAIMS)
	// Caching off (0, or a cap the configuration refuses): nothing is claimed, nothing deferred.
	if (given.length === 0 || cap < REMOTE_MEDIA_CACHE_MIN_BYTES) {
		return out
	}
	const walk = db.all<Walked>(
		`SELECT r.id, r.kind, r.category, r.url, r.claim, r.generation, r.attempts, ${slotEligibleSql('r')} AS eligible
		FROM (SELECT id FROM remote_media INDEXED BY ${REMOTE_MEDIA_DUE_INDEX} WHERE lane = 0 AND due_at <= ?1
			ORDER BY lane, due_at, id LIMIT ${CLAIM_WALK}) w
		CROSS JOIN remote_media r ON r.id = w.id
		ORDER BY r.due_at, r.id`,
		now
	)
	let bytes = usage(db).bytes
	for (const row of walk) {
		const kind = row.kind as RemoteFileKind
		const category = row.category as RemoteCategory
		const reservation = reservationOf(kind, category)
		if (
			row.eligible !== 1 ||
			reservation === null ||
			row.attempts >= REMOTE_MEDIA_MAX_ATTEMPTS ||
			row.claim + 1 > SAFE_INTEGER_MAX
		) {
			deleteSlot(db, row.id, now)
			out.dropped++
			continue
		}
		if (bytes + reservation > cap) {
			db.run('UPDATE remote_media SET due_at = ?2 WHERE id = ?1', row.id, now + DEFER_MS)
			out.deferred++
			continue
		}
		const token = given[out.claims.length]
		if (token === undefined) {
			break
		}
		// A token the ledger already holds is never reused; the slot stays due.
		if (db.first('SELECT 1 AS x FROM remote_media_objects WHERE token = ?1', token) !== undefined) {
			break
		}
		doomSlotObject(db, row.id, now)
		db.run(
			`INSERT INTO remote_media_objects (token, slot_id, state, charge, kind, claimed_at)
			VALUES (?1, ?2, 'reserved', ?3, ?4, ?5)`,
			token,
			row.id,
			reservation,
			kind,
			now
		)
		chargeObject(db, token, { bytes: reservation })
		bytes += reservation
		db.run(
			'UPDATE remote_media SET claim = claim + 1, attempts = attempts + 1, due_at = ?2 WHERE id = ?1',
			row.id,
			now + REMOTE_MEDIA_HOLD_MS
		)
		out.claims.push({
			slot: row.id,
			claim: row.claim + 1,
			generation: row.generation,
			token,
			kind,
			category,
			url: row.url,
		})
		if (out.claims.length >= given.length) {
			break
		}
	}
	return out
})

// ---- The fence, admission and record

export type RemoteMediaFence = { slot: number; claim: number; generation: number; token: string }

// The claim `fence` names is still open and the slot eligible: the token reserved for the slot, the slot's claim and
// generation, slotEligibleSql.
const FENCE = `SELECT 1 AS x FROM remote_media r
	CROSS JOIN remote_media_objects o ON o.token = ?4 AND o.slot_id = r.id AND o.state = 'reserved'
	WHERE r.id = ?1 AND r.claim = ?2 AND r.generation = ?3 AND r.due_at IS NOT NULL AND ${slotEligibleSql('r')}`

function fenced(db: Db, fence: RemoteMediaFence): boolean {
	const { slot, claim, generation, token } = fence
	return (
		isTime(slot) &&
		isTime(claim) &&
		isTime(generation) &&
		typeof token === 'string' &&
		db.first(FENCE, slot, claim, generation, token) !== undefined
	)
}

// Whether a normalized host list (the recorded hops) is within its bound and covered by no domain block.
function hostsAdmitted(db: Db, hosts: unknown): hosts is string[] {
	return (
		Array.isArray(hosts) &&
		hosts.length >= 1 &&
		hosts.length <= REMOTE_MEDIA_HOSTS &&
		hosts.every((host) => typeof host === 'string' && storedLinkDomain(host) === host && !hostCovered(db, host))
	)
}

// Admission before each put (the full file, then the still): a write, so the Store refuses it in any maintenance, a
// dump or an import; under the fence, and the hosts of the fetch not covered.
export const admitRemoteMedia = writeOperation<RemoteMediaFence & { hosts: readonly string[] }, { held: boolean }>(
	(db, input) => ({ held: fenced(db, input) && hostsAdmitted(db, input.hosts) })
)

export type RemoteMediaOutcome =
	| {
			kind: 'stored'
			contentType: string
			stillType: string | null
			bytes: number
			hosts: readonly string[]
			category: RemoteCategory
	  }
	// The full file was put but the still was not (failed, timed out or not admitted): never published.
	| { kind: 'partial' }
	| { kind: 'failed'; permanent: boolean }
	| { kind: 'unattempted' }

const EXTENSIONS: Readonly<Record<string, string>> = REMOTE_MEDIA_TYPES

// Moves the slot `id` after a failed attempt `attempts` (1 to REMOTE_MEDIA_MAX_ATTEMPTS): permanent or the last
// attempt fails it for good (due_at NULL, failed_at set), otherwise it is due again after RETRY_DELAYS_MS.
function failSlot(db: Db, id: number, attempts: number, permanent: boolean, now: number): void {
	const delay = RETRY_DELAYS_MS[attempts - 1]
	if (permanent || delay === undefined || attempts >= REMOTE_MEDIA_MAX_ATTEMPTS) {
		db.run('UPDATE remote_media SET due_at = NULL, failed_at = ?2 WHERE id = ?1', id, now)
		addUsage(db, { pending: -1 })
		return
	}
	db.run('UPDATE remote_media SET due_at = ?2 WHERE id = ?1', id, now + delay)
}

// The outcome of one claim. Out of the fence (another claim, a reset, an ineligible slot, a covered host, another
// category, or any value out of its range), the token is doomed and nothing else changes. Inside it:
// - stored: the object becomes stored at its actual bytes (at most its reservation), usage moves by actual − R, and
//   the slot points at it;
// - partial: the object is doomed (its still put may still land: LATE_PUT_MS after its claim) and the slot takes a
//   transient failure;
// - failed: the object is doomed and the slot fails (permanent) or is retried;
// - unattempted: the object is doomed and the attempt given back; the slot stays due.
export const recordRemoteMedia = writeOperation<
	RemoteMediaFence & { outcome: RemoteMediaOutcome; now: number },
	{ held: boolean }
>((db, input) => {
	const { slot, token, now } = input
	const outcome: RemoteMediaOutcome =
		typeof input.outcome === 'object' && input.outcome !== null ? input.outcome : { kind: 'failed', permanent: true }
	if (!isTime(now) || typeof token !== 'string') {
		return { held: false }
	}
	const row = db.first<{ attempts: number; category: string }>(
		'SELECT attempts, category FROM remote_media WHERE id = ?1',
		slot
	)
	const stored =
		outcome.kind === 'stored' &&
		row !== undefined &&
		outcome.category === row.category &&
		typeof outcome.contentType === 'string' &&
		EXTENSIONS[outcome.contentType] !== undefined &&
		(outcome.stillType === null ||
			(typeof outcome.stillType === 'string' && EXTENSIONS[outcome.stillType] !== undefined)) &&
		isTime(outcome.bytes) &&
		hostsAdmitted(db, outcome.hosts)
	if (row === undefined || !fenced(db, input) || (outcome.kind === 'stored' && !stored)) {
		doomObject(db, token, now)
		return { held: false }
	}
	if (outcome.kind === 'stored') {
		const object = db.first<{ charge: number }>('SELECT charge FROM remote_media_objects WHERE token = ?1', token)!
		const actual = Math.min(outcome.bytes, object.charge)
		db.run(
			`UPDATE remote_media_objects SET state = 'stored', charge = ?2, content_type = ?3, still_type = ?4, hosts = ?5,
				stored_at = ?6 WHERE token = ?1`,
			token,
			actual,
			outcome.contentType,
			outcome.stillType,
			JSON.stringify(outcome.hosts),
			now
		)
		chargeObject(db, token, { bytes: actual - object.charge, pending: -1 })
		db.run(
			`UPDATE remote_media SET token = ?2, ext = ?3, still_ext = ?4, stored_at = ?5, due_at = NULL, failed_at = NULL,
				attempts = 0 WHERE id = ?1`,
			slot,
			token,
			EXTENSIONS[outcome.contentType] ?? null,
			outcome.stillType === null ? null : (EXTENSIONS[outcome.stillType] ?? null),
			now
		)
		return { held: true }
	}
	doomObject(db, token, now)
	if (outcome.kind === 'unattempted') {
		db.run('UPDATE remote_media SET attempts = max(attempts - 1, 0), due_at = ?2 WHERE id = ?1', slot, now)
	} else {
		failSlot(db, slot, row.attempts, outcome.kind === 'failed' && outcome.permanent === true, now)
	}
	return { held: true }
})

// ---- Maintenance

export type RemoteMediaDeletion = { token: string; keys: string[] }

export type RemoteMediaMaintenance = {
	status: 'settling' | 'ready' | 'unset'
	// Doomed objects due, their keys (at most DELETE_BATCH, two keys each).
	// The doomed objects due, in at most two groups the Worker deletes with one R2 call each (dueDeletions).
	deletions: RemoteMediaDeletion[][]
	// PITR validation: the stored objects whose variants to head, at most VALIDATION_HEADS keys.
	validation: RemoteMediaDeletion[]
	// The orphan sweep's list cursor when a sweep is due ('' from the start), else null.
	sweep: string | null
	counts: { expired: number; walked: number; retired: number; reclaimed: number; backfilled: number; restored: number }
	// Drift the audit found at the end of a pass (the counters minus the ledger's sums), or null.
	drift: RemoteMediaUsage | null
	usage: RemoteMediaUsage
}

function keysOf(token: string): string[] {
	return [`remote/${token}/full`, `remote/${token}/still`]
}

// The doomed objects whose deletion is due at `now`, by due_at, at most DELETE_BATCH.
// The doomed objects due, in two groups from two seeks: the retried ones (a delete failed) from the oldest
// RETRY_BATCH due, those of the fewest failed attempts n, at most RETRY_BATCH / 2^(n-1) (one from the ninth), so a
// delete that keeps failing is tried again in ever smaller groups until it is alone; and the ones never tried, the
// oldest due up to what the retried leave of DELETE_BATCH (at least DELETE_BATCH - RETRY_BATCH). Neither hides the
// other however many of it are due.
function dueDeletions(db: Db, now: number): RemoteMediaDeletion[][] {
	const retried = db.all<{ token: string; attempts: number }>(
		`SELECT token, delete_attempts AS attempts FROM remote_media_objects INDEXED BY ${REMOTE_OBJECTS_RETRY_INDEX}
		WHERE state = 'doomed' AND delete_attempts > 0 AND due_at <= ?1 ORDER BY due_at LIMIT ${RETRY_BATCH}`,
		now
	)
	const fewest = Math.min(...retried.map((row) => row.attempts))
	const retry = retried
		.filter((row) => row.attempts === fewest)
		.slice(0, Math.max(1, RETRY_BATCH >> Math.min(fewest - 1, DELETE_SPLITS)))
	const fresh = db.all<{ token: string }>(
		`SELECT token FROM remote_media_objects INDEXED BY ${REMOTE_OBJECTS_DUE_INDEX}
		WHERE state = 'doomed' AND delete_attempts = 0 AND due_at <= ?1 ORDER BY due_at LIMIT ?2`,
		now,
		DELETE_BATCH - retry.length
	)
	return [fresh, retry]
		.filter((group) => group.length > 0)
		.map((group) => group.map(({ token }) => ({ token, keys: keysOf(token) })))
}

// The validity walk: at most VALIDITY_WALK slots from the cursor by id (wrapping), each that fails slotEligibleSql
// deleted and its object doomed. Returns the slots retired.
function validityWalk(db: Db, now: number): number {
	const cursor = Number(state(db, STATE.walk) ?? '0')
	const from = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
	const rows = db.all<{ id: number; eligible: number }>(
		`SELECT r.id, ${slotEligibleSql('r')} AS eligible
		FROM (SELECT id FROM remote_media WHERE id > ?1 ORDER BY id LIMIT ${VALIDITY_WALK}) w
		CROSS JOIN remote_media r ON r.id = w.id`,
		from
	)
	let retired = 0
	for (const row of rows) {
		if (row.eligible !== 1) {
			deleteSlot(db, row.id, now)
			retired++
		}
	}
	setState(db, STATE.walk, rows.length < VALIDITY_WALK ? '0' : String(rows.at(-1)?.id ?? 0))
	return retired
}

// The suspended accounts (accounts_suspended, from a cursor by id, at most SUSPENDED_ACCOUNTS): their slots, at most
// SUSPENDED_SLOTS in all, deleted and their objects doomed. An unsuspended account's images return with its next
// refresh.
function suspendedWalk(db: Db, now: number): number {
	const stored = state(db, STATE.suspended) ?? ''
	const cursor = /^\d{18}$/.test(stored) ? stored : ''
	const accounts = db.all<{ id: string }>(
		`SELECT a.id FROM accounts a INDEXED BY accounts_suspended WHERE ${suspendedSql('a')} AND a.id > ?1
		ORDER BY a.id LIMIT ${SUSPENDED_ACCOUNTS}`,
		cursor
	)
	let retired = 0
	let last = cursor
	let whole = true
	for (const { id } of accounts) {
		const slots = db.all<{ id: number }>(
			`SELECT id FROM remote_media INDEXED BY ${REMOTE_MEDIA_ACCOUNT_INDEX} WHERE account_id = ?1 LIMIT ?2`,
			id,
			SUSPENDED_SLOTS - retired + 1
		)
		// An account whose slots do not fit what is left waits for the next round, the cursor before it.
		if (retired + slots.length > SUSPENDED_SLOTS) {
			whole = false
			break
		}
		for (const slot of slots) {
			deleteSlot(db, slot.id, now)
			retired++
		}
		last = id
	}
	setState(db, STATE.suspended, whole && accounts.length < SUSPENDED_ACCOUNTS ? '' : last)
	return retired
}

// Reservation expiry: at most RESERVATION_EXPIRY_BATCH reserved objects claimed before `cutoff` doomed, due at once.
// Normally the cutoff is LATE_PUT_MS ago (a record lost to an RPC failure or the Worker's death: their window has
// passed); after a restore it is the restore (validationBatch: the settle period outlasts any put of theirs).
function expireReservations(db: Db, now: number, cutoff = now - LATE_PUT_MS): number {
	const rows = db.all<{ token: string }>(
		`SELECT token FROM remote_media_objects INDEXED BY ${REMOTE_OBJECTS_RESERVED_INDEX}
		WHERE state = 'reserved' AND claimed_at < ?1 ORDER BY claimed_at LIMIT ${RESERVATION_EXPIRY_BATCH}`,
		cutoff
	)
	for (const { token } of rows) {
		doomObject(db, token, now, true)
	}
	return rows.length
}

// The demand of the next claim: the reservations of the lane 0 slots due at `now` it would walk, at most LANE0_CLAIMS.
function demand(db: Db, now: number): number {
	const rows = db.all<{ kind: string; category: string }>(
		`SELECT r.kind, r.category FROM (SELECT id FROM remote_media INDEXED BY ${REMOTE_MEDIA_DUE_INDEX}
			WHERE lane = 0 AND due_at <= ?1 ORDER BY lane, due_at, id LIMIT ${LANE0_CLAIMS}) w
		CROSS JOIN remote_media r ON r.id = w.id`,
		now
	)
	return rows.reduce(
		(sum, row) => sum + (reservationOf(row.kind as RemoteFileKind, row.category as RemoteCategory) ?? 0),
		0
	)
}

// Reclamation: when the bytes charged and the next claim's demand pass the cap less LANE1_HEADROOM, stored objects
// are doomed (due at once) and their slots deleted, oldest first in RECLAIM_ORDER, at most RECLAIM_VICTIMS, until the
// bytes not yet doomed and the demand fit 0.9 × the cap (or the threshold, when that is lower). Their bytes stay
// counted until their deletion is confirmed.
function reclaim(db: Db, cap: number, now: number): number {
	const need = demand(db, now)
	const counted = usage(db)
	if (counted.bytes + need <= cap - LANE1_HEADROOM) {
		return 0
	}
	let projected = counted.bytes - counted.doomed
	let victims = 0
	// 0.9 × the cap, or the threshold itself for a cap so small that 0.9 of it is past the threshold (below 960 MiB; the
	// configuration keeps the cap at least REMOTE_MEDIA_CACHE_MIN_BYTES, so the threshold is positive).
	const target = Math.min(0.9 * cap, cap - LANE1_HEADROOM)
	for (const kind of RECLAIM_ORDER) {
		while (victims < RECLAIM_VICTIMS && projected + need > target) {
			const rows = db.all<{ token: string; slot_id: number | null; charge: number }>(
				`SELECT token, slot_id, charge FROM remote_media_objects INDEXED BY ${REMOTE_OBJECTS_STORED_INDEX}
				WHERE kind = ?1 AND state = 'stored' ORDER BY stored_at LIMIT ?2`,
				kind,
				Math.min(50, RECLAIM_VICTIMS - victims)
			)
			if (rows.length === 0) {
				break
			}
			for (const row of rows) {
				if (projected + need <= target) {
					break
				}
				if (row.slot_id !== null) {
					deleteSlot(db, row.slot_id, now)
				} else {
					doomObject(db, row.token, now)
				}
				projected -= row.charge
				victims++
			}
		}
	}
	return victims
}

type Backfill = { v: number; cursor: string; done: boolean }

// Backfill phase 1: the remote accounts newest first from the cursor (at most BACKFILL_BATCH raw candidates by id),
// each available one's avatar and header enqueued (syncProfileFiles) due BACKFILL_DELAY_MS later, so fresh content goes
// first. The cursor moves past fully processed accounts only, and stops at the pending limit. A coverage version other
// than COVERAGE_VERSION starts again from the top.
function backfill(db: Db, now: number): number {
	const saved = json<Backfill>(db, STATE.backfill)
	const fresh = saved.v !== COVERAGE_VERSION
	if (!fresh && saved.done === true) {
		return 0
	}
	// Ids are 18-digit text; the start of the walk is past all of them.
	const cursor =
		!fresh && typeof saved.cursor === 'string' && /^\d{18}$/.test(saved.cursor) ? saved.cursor : '9'.repeat(19)
	const rows = db.all<{ id: string; avatar_url: string | null; header_url: string | null; available: number }>(
		`SELECT a.id, a.avatar_url, a.header_url, ${availableSql('a.id')} AS available
		FROM (SELECT id FROM accounts INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE id < ?1
			ORDER BY id DESC LIMIT ${BACKFILL_BATCH}) w
		CROSS JOIN accounts a ON a.id = w.id
		WHERE a.domain IS NOT NULL
		ORDER BY a.id DESC`,
		cursor
	)
	const raw = db.first<{ n: number; last: string | null }>(
		`SELECT count(*) AS n, min(id) AS last FROM (SELECT id FROM accounts INDEXED BY ${ACCOUNTS_ID_INDEX}
			WHERE id < ?1 ORDER BY id DESC LIMIT ${BACKFILL_BATCH})`,
		cursor
	) ?? { n: 0, last: null }
	let done = 0
	let last = cursor
	for (const row of rows) {
		if (usage(db).pending >= REMOTE_MEDIA_PENDING_LIMIT - 2) {
			// Stopped at the pending limit: the cursor stays past the last account fully processed.
			setState(db, STATE.backfill, JSON.stringify({ v: COVERAGE_VERSION, cursor: last, done: false }))
			return done
		}
		if (row.available === 1) {
			syncProfileFiles(db, row.id, { avatar: row.avatar_url, header: row.header_url }, now, now + BACKFILL_DELAY_MS)
		}
		last = row.id
		done++
	}
	setState(
		db,
		STATE.backfill,
		JSON.stringify({ v: COVERAGE_VERSION, cursor: raw.last ?? last, done: raw.n < BACKFILL_BATCH })
	)
	return done
}

type Audit = { cursor: string; bytes: number; doomed: number }

// The audit: AUDIT_CHUNK ledger rows a round from a cursor by token, summing the charges; at the end of a pass, the
// counters minus the sums. A change between chunks to an object already counted is added to the pass's sums
// (chargeObject), so the pass is exact; a drift is only logged, and nothing overwrites the counters.
function audit(db: Db): RemoteMediaUsage | null {
	const saved = json<Audit>(db, STATE.audit)
	const cursor = typeof saved.cursor === 'string' && FILE_TOKEN.test(saved.cursor) ? saved.cursor : ''
	const chunk = db.first<{ n: number; bytes: number | null; doomed: number | null; last: string | null }>(
		`SELECT count(*) AS n, sum(charge) AS bytes, sum(CASE state WHEN 'doomed' THEN charge ELSE 0 END) AS doomed,
			max(token) AS last
		FROM (SELECT token, charge, state FROM remote_media_objects WHERE token > ?1 ORDER BY token LIMIT ${AUDIT_CHUNK})`,
		cursor
	) ?? { n: 0, bytes: 0, doomed: 0, last: null }
	const bytes = (cursor === '' ? 0 : (saved.bytes ?? 0)) + (chunk.bytes ?? 0)
	const doomed = (cursor === '' ? 0 : (saved.doomed ?? 0)) + (chunk.doomed ?? 0)
	if (chunk.n < AUDIT_CHUNK) {
		setState(db, STATE.audit, JSON.stringify({ cursor: '', bytes: 0, doomed: 0 }))
		const counted = usage(db)
		const pending =
			db.first<{ n: number }>(
				`SELECT count(*) AS n FROM remote_media INDEXED BY ${REMOTE_MEDIA_EXPIRY_INDEX} WHERE due_at IS NOT NULL`
			)?.n ?? 0
		const drift = { bytes: counted.bytes - bytes, doomed: counted.doomed - doomed, pending: counted.pending - pending }
		return drift.bytes === 0 && drift.doomed === 0 && drift.pending === 0 ? null : drift
	}
	setState(db, STATE.audit, JSON.stringify({ cursor: chunk.last ?? '', bytes, doomed }))
	return null
}

// PITR validation after a settled restore newer than the last validation: the restored reservations (claimed before
// the restore) doomed, due at once (the settle period outlasts any put of theirs), then the stored objects from a
// cursor by token whose variants are headed, at most VALIDATION_HEADS keys (an object with a still counts two).
// The validation walk's progress: the restore it validates and the last token recorded (JSON in kopje_state).
function validationCursor(db: Db): {
	restore: number | null
	cursor: string
	failedToken: string | null
	failures: number
} {
	const stored = json<{ restore?: unknown; cursor?: unknown; failedToken?: unknown; failures?: unknown }>(
		db,
		STATE.validation
	)
	return {
		restore: isTime(stored.restore) ? stored.restore : null,
		cursor: typeof stored.cursor === 'string' && FILE_TOKEN.test(stored.cursor) ? stored.cursor : '',
		failedToken:
			typeof stored.failedToken === 'string' && FILE_TOKEN.test(stored.failedToken) ? stored.failedToken : null,
		failures: isTime(stored.failures) ? stored.failures : 0,
	}
}

function validationBatch(db: Db, now: number, restoredAt: number): { batch: RemoteMediaDeletion[]; restored: number } {
	const restored = expireReservations(db, now, restoredAt)
	// The walk's cursor belongs to the restore it validates: one of another restore (a bookmark taken mid-validation
	// rewinds it) starts the walk again from the first token.
	const progress = validationCursor(db)
	const cursor = progress.restore === restoredAt ? progress.cursor : ''
	if (progress.restore !== restoredAt) {
		setState(db, STATE.validation, JSON.stringify({ restore: restoredAt, cursor }))
	}
	const rows = db.all<{ token: string; still: number }>(
		`SELECT token, still_type IS NOT NULL AS still FROM remote_media_objects INDEXED BY ${REMOTE_OBJECTS_VALIDATION_INDEX}
		WHERE state = 'stored' AND token > ?1 ORDER BY token LIMIT ${VALIDATION_HEADS}`,
		cursor
	)
	const batch: RemoteMediaDeletion[] = []
	let heads = 0
	for (const row of rows) {
		const keys = row.still === 1 ? keysOf(row.token) : [`remote/${row.token}/full`]
		if (heads + keys.length > VALIDATION_HEADS) {
			break
		}
		heads += keys.length
		batch.push({ token: row.token, keys })
	}
	return { batch, restored }
}

// One round's maintenance (federation/remote-media.ts), in order: a restore younger than REMOTE_SETTLE_MS stops it
// before any write ('settling'); a settled restore newer than the last validation starts validation (the batch to
// head); then reservation expiry, the validity walk, the suspended accounts, the backfill, reclamation and the audit;
// then the doomed objects due and whether an orphan sweep is due. `restoredAt`: the restore marker the Store read;
// `cap`: REMOTE_MEDIA_CACHE_BYTES.
export const maintainRemoteMedia = writeOperation<
	{ now: number; restoredAt: number | null; cap: number },
	RemoteMediaMaintenance
>((db, { now, restoredAt, cap }) => {
	const counts = { expired: 0, walked: 0, retired: 0, reclaimed: 0, backfilled: 0, restored: 0 }
	const empty = (status: RemoteMediaMaintenance['status']): RemoteMediaMaintenance => ({
		status,
		deletions: [],
		validation: [],
		sweep: null,
		counts,
		drift: null,
		usage: usage(db),
	})
	if (!isTime(now) || !isTimeOrNull(restoredAt) || !isTime(cap) || instanceDomain(db) === null) {
		return empty('unset')
	}
	if (restoredAt !== null && now - restoredAt < REMOTE_SETTLE_MS) {
		return empty('settling')
	}
	let validation: RemoteMediaDeletion[] = []
	const validated = Number(state(db, STATE.validated) ?? '-1')
	if (restoredAt !== null && restoredAt > validated) {
		const started = validationBatch(db, now, restoredAt)
		validation = started.batch
		counts.restored = started.restored
		if (validation.length === 0) {
			setState(db, STATE.validated, String(restoredAt))
			setState(db, STATE.validation, JSON.stringify({ restore: restoredAt, cursor: '' }))
		}
	}
	counts.expired = expireReservations(db, now)
	counts.retired = validityWalk(db, now) + suspendedWalk(db, now)
	counts.backfilled = backfill(db, now)
	// Caching off reclaims nothing: what is cached stays, and its slots are kept for when caching is on again.
	counts.reclaimed = cap < REMOTE_MEDIA_CACHE_MIN_BYTES ? 0 : reclaim(db, cap, now)
	const drift = audit(db)
	// The orphan sweep is attempted at most once an hour: its attempt time is recorded here, as it is handed out, so a
	// sweep that fails costs one round an hour; its page cursor moves only after the page's delete (sweepCheckpoint).
	const sweep = json<{ at: number; cursor: string }>(db, STATE.sweep)
	const sweepCursor = typeof sweep.cursor === 'string' ? sweep.cursor : ''
	const sweepDue = !isTime(sweep.at) || now - sweep.at >= ORPHAN_SWEEP_MS
	if (sweepDue) {
		setState(db, STATE.sweep, JSON.stringify({ at: now, cursor: sweepCursor }))
	}
	return {
		status: 'ready',
		deletions: dueDeletions(db, now),
		validation,
		sweep: sweepDue ? sweepCursor : null,
		counts,
		drift,
		usage: usage(db),
	}
})

// The round's R2 deletes, one result an object: its group's delete returned within its deadline (deleted) or not:
// deleted, the ledger row goes and its charge is subtracted; otherwise it stays doomed and charged, due again after
// DELETE_BACKOFF_MS × 2^n (at most DELETE_BACKOFF_MAX_MS). A group the round did not try is not reported.
export const confirmRemoteMediaDeleted = writeOperation<
	{ results: readonly { token: string; deleted: boolean }[]; now: number },
	{ confirmed: number }
>((db, { results, now }) => {
	let confirmed = 0
	for (const result of listOf(results).slice(0, 2 * DELETE_BATCH)) {
		const token = result?.token
		const deleted = result?.deleted === true
		if (typeof token !== 'string') {
			continue
		}
		const row = db.first<{ charge: number; delete_attempts: number }>(
			"SELECT charge, delete_attempts FROM remote_media_objects WHERE token = ?1 AND state = 'doomed'",
			token
		)
		if (row === undefined) {
			continue
		}
		if (deleted) {
			db.run('DELETE FROM remote_media_objects WHERE token = ?1', token)
			chargeObject(db, token, { bytes: -row.charge, doomed: -row.charge })
			confirmed++
		} else if (isTime(now)) {
			const attempts = Math.min(row.delete_attempts + 1, REMOTE_MEDIA_DELETE_ATTEMPTS)
			const wait = Math.min(DELETE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 30), DELETE_BACKOFF_MAX_MS)
			db.run(
				'UPDATE remote_media_objects SET delete_attempts = ?2, due_at = ?3 WHERE token = ?1',
				token,
				attempts,
				now + wait
			)
		}
	}
	return { confirmed }
})

// PITR validation's heads, in token order: each object one of whose variants is missing is doomed (its surviving
// variants go with it) and its slot reset to pending; the walk's cursor moves past the last one. A head that failed
// (`failed`, the last result) is tried again from that object, and an object whose heads fail VALIDATION_FAILURES times
// in a row is handled as missing, so it never holds the walk back: the cache is disposable, and the file is fetched
// again. The pass ends when the maintenance finds no object past the cursor (remote_media_validated_at).
export const recordRemoteMediaValidation = writeOperation<
	{ results: readonly { token: string; missing: boolean; failed?: boolean }[]; now: number },
	{ reset: number }
>((db, { results, now }) => {
	let reset = 0
	const progress = validationCursor(db)
	let last = progress.cursor
	let failures = { token: progress.failedToken, count: progress.failures }
	const missing = (token: string) => {
		const slot = db.first<{ id: number; url: string; host: string }>(
			`SELECT r.id, r.url, r.host FROM remote_media_objects o CROSS JOIN remote_media r ON r.id = o.slot_id
			WHERE o.token = ?1 AND o.state = 'stored'`,
			token
		)
		doomObject(db, token, now)
		if (slot !== undefined && !resetSlot(db, slot.id, slot.url, slot.host, now)) {
			db.run(
				'UPDATE remote_media SET token = NULL, ext = NULL, still_ext = NULL, stored_at = NULL, failed_at = ?2 WHERE id = ?1',
				slot.id,
				now
			)
		}
		reset++
	}
	for (const result of listOf(results).slice(0, VALIDATION_HEADS)) {
		const token = result?.token
		if (typeof token !== 'string' || !FILE_TOKEN.test(token) || token <= last) {
			continue
		}
		if (result.failed === true) {
			const count = failures.token === token ? failures.count + 1 : 1
			if (count < VALIDATION_FAILURES) {
				failures = { token, count }
				break
			}
			missing(token)
		} else if (result.missing === true) {
			missing(token)
		}
		last = token
		failures = { token: null, count: 0 }
	}
	if (progress.restore !== null) {
		setState(
			db,
			STATE.validation,
			JSON.stringify({ restore: progress.restore, cursor: last, failedToken: failures.token, failures: failures.count })
		)
	}
	return { reset }
})

// The orphan sweep's page (one R2 list of remote/, at most 1,000 keys, at most once an hour): the keys uploaded more
// than ORPHAN_GRACE_MS ago whose token the ledger does not hold, to delete. Safe because the ledger records every token
// before its put (MEDIA-2). The page is checkpointed (the sweep's time and the list's next cursor) only once nothing of
// it is left to delete: here when it has no orphan, otherwise by remoteMediaSwept after the Worker's delete returned,
// so a page whose delete failed or did not run is listed again.
export const remoteMediaOrphans = writeOperation<
	{ keys: readonly { key: string; uploaded: number }[]; cursor: string | null; now: number },
	{ orphans: string[] }
>((db, { keys, cursor, now }) => {
	const orphans: string[] = []
	for (const entry of listOf(keys).slice(0, 1000)) {
		const match =
			typeof entry?.key === 'string' ? /^remote\/([A-Za-z0-9_-]{32,64})\/(full|still)$/.exec(entry.key) : null
		if (match === null || !isTime(entry.uploaded) || entry.uploaded > now - ORPHAN_GRACE_MS) {
			continue
		}
		const token = match[1] ?? ''
		if (db.first('SELECT 1 AS x FROM remote_media_objects WHERE token = ?1', token) === undefined) {
			orphans.push(entry.key)
		}
	}
	if (orphans.length === 0) {
		sweepCheckpoint(db, cursor)
	}
	return { orphans }
})

// The sweep's page whose orphans the Worker deleted: its checkpoint (remoteMediaOrphans).
export const remoteMediaSwept = writeOperation<{ cursor: string | null; now: number }, { swept: boolean }>(
	(db, { cursor }) => {
		sweepCheckpoint(db, cursor)
		return { swept: true }
	}
)

// The page's checkpoint: the list's next cursor, the attempt time kept.
function sweepCheckpoint(db: Db, cursor: string | null): void {
	const sweep = json<{ at: number }>(db, STATE.sweep)
	setState(
		db,
		STATE.sweep,
		JSON.stringify({
			at: isTime(sweep.at) ? sweep.at : 0,
			cursor: typeof cursor === 'string' && cursor.length <= 1024 ? cursor : '',
		})
	)
}

// ---- Presentation

// The cached avatar and header of each presented account, packed as `token:ext:still_ext` (at most CACHED_IMAGE_BYTES
// each, every part bounded by the trigger), by account id.
export type CachedImages = ReadonlyMap<string, { avatar?: string; header?: string }>

// The most bytes one packed object reads: a token, two extensions and the separators.
export const CACHED_IMAGE_BYTES = 64 + 1 + 4 + 1 + 4
// The kinds a presentation chunk resolves, each at most one stored slot an account.
export const CACHED_IMAGE_KINDS = ['avatar', 'header'] as const
// cachedImagesOf's result columns and the heap of one row (an 18-digit owner id, a kind, a packed object): the status
// row bound (status-rows.ts) counts CACHED_IMAGE_KINDS of them for each remote author and moved-to account.
export const CACHED_IMAGE_COLUMNS = fixedColumns(
	{
		owner: 'cm.owner_id',
		kind: 'cm.kind',
		packed: "cm.token || ':' || cm.ext || ':' || COALESCE(cm.still_ext, '')",
	},
	{ owner: 18, kind: 6, packed: CACHED_IMAGE_BYTES }
)

// The per-chunk resolver of cached profile images (cached emoji can take its shape): the stored avatar and header slots
// of `ids` (a presentation chunk, at most ANSWER_CHUNK accounts and their moved-to targets), read outside the row heap
// in one statement of one seek of remote_media_owner per id and kind, each kept only while slotOwnsSql holds (the slot
// is the account's current URL, byte for byte: a stale URL shows nothing cached). A local account (ID-3) owns no slot.
// The policy part of eligibility is the account's availability, which the presenter reads with the row. At most
// ids × CACHED_IMAGE_KINDS × CACHED_IMAGE_BYTES bytes.
// cachedImagesOf's one statement: ?1 the ids, ?2 the kinds, both JSON arrays.
function cachedImagesSql(): string {
	return `SELECT ${selectSql(CACHED_IMAGE_COLUMNS.columns)}
		FROM json_each(?1) c CROSS JOIN (SELECT value AS kind FROM json_each(?2)) k
		CROSS JOIN remote_media cm INDEXED BY ${REMOTE_MEDIA_OWNER_INDEX} ON cm.owner_id = c.value AND cm.kind = k.kind
		WHERE cm.token IS NOT NULL AND ${slotOwnsSql('cm')}`
}

export function cachedImagesOf(db: Db, ids: readonly string[]): CachedImages {
	const unique = [...new Set(ids)]
	if (unique.length === 0) {
		return new Map()
	}
	const rows = db.all<{ owner: string; kind: string; packed: string }>(
		cachedImagesSql(),
		JSON.stringify(unique),
		JSON.stringify(CACHED_IMAGE_KINDS)
	)
	const out = new Map<string, { avatar?: string; header?: string }>()
	for (const row of rows) {
		const entry = out.get(row.owner) ?? {}
		if (row.kind === 'avatar' || row.kind === 'header') {
			entry[row.kind] = row.packed
		}
		out.set(row.owner, entry)
	}
	return out
}

const REMOTE_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(REMOTE_MEDIA_TYPES))

// The local URLs of a packed cached object (cachedImagesOf) on `origin`, or null for anything else: the full file and
// the still (the full file when there is none). The one decision of cached against remote: a presenter shows the
// cached copy exactly when this gives URLs.
export function cachedImageUrls(packed: string | null, origin: string): { image: string; still: string } | null {
	if (typeof packed !== 'string' || packed.length > CACHED_IMAGE_BYTES) {
		return null
	}
	const [token = '', ext = '', still = ''] = packed.split(':')
	if (
		!FILE_TOKEN.test(token) ||
		!REMOTE_MEDIA_EXTENSIONS.has(ext) ||
		(still !== '' && !REMOTE_MEDIA_EXTENSIONS.has(still))
	) {
		return null
	}
	const image = `${origin}/media/r/${token}/full.${ext}`
	return { image, still: still === '' ? image : `${origin}/media/r/${token}/still.${still}` }
}
