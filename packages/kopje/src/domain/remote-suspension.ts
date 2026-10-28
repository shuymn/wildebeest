import { followUri } from './activities'
import {
	domainCoveredSql,
	domainMarkedSql,
	individuallySuspendedSql,
	SUSPEND_BLOCKS_SQL,
	suspendedSql,
} from './audience'
import type { Admin } from './auth'
import { severFollow } from './blocks'
import { supersedeEarlier } from './deliveries'
import { EXPANSION_STEP } from './delivery-bounds'
import { FRESH_ATTEMPTS_SQL, JOB_BOOKKEEPING_ROWS, nextJob, REMOTE_MODERATION_JOBS, runJobItem } from './job-attempts'
import { logAction } from './moderation-log'
import { actionBound, reportBound, resolveSuspensionReports } from './reports'
import { RowBudget } from './row-budget'
import { MODERATION_ROUND_ROWS, REPORT_ROUND } from './suspension'
import { ACCOUNTS_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'

// The instance suspension of remote accounts (R38, VIS-30), migration 0045_remote_suspension: of one account
// (Mastodon's Admin::AccountAction with type suspend and SuspendAccountService#reject_remote_follows!,
// UnsuspendAccountService for the unsuspension), and of the accounts an instance domain block covers
// (BlockDomainService with DeleteAccountService's severing; the blocks are instance-domain-blocks.ts's). The OAuth
// admin suspends and unsuspends an account through the Mastodon admin API (admin-accounts.ts).
//
// Each decision commits in one bounded transaction that resets its job's row: the reset is the job's generation, and
// each round first requires the condition the job's kind and mode name, read live, so a later decision ends or
// redirects the job at its next round. Rounds are Store-only and stage nothing.
//
// The account job (kind 'account', one row per account):
//   - mode 'account', set by a suspension: the account's suspended_at with suspension_source 'account' make it
//     unavailable (R1, availableSql) from the commit on; each round requires that it is still individually suspended.
//       - reports: resolves the account's reports the suspension froze (reports.ts resolveSuspensionReports, VIS-29).
//       - follows: ends the account's follows of local accounts up to the follow bound (severing, below). Local
//         accounts' follows of it are kept, and an unsuspension restores nothing that was severed.
//   - mode 'domain', set by the conversion: an unsuspension of an account a suspend block still covers keeps it
//     suspended, as a domain mark (suspension_source 'domain'), and redirects the job with a fresh follow bound; each
//     round requires the mark and live coverage. It severs both ways (out, then in), as the domain job severs a covered
//     account. Suspending the account again sets mode 'account' back, which keeps local follows of it.
//
// The domain job (kind 'domain', one row in all, subject ''): every transition of a block into or out of suspend for
// some host resets it, with a fresh follow bound (instance-domain-blocks.ts resetDomainJob). It reconciles the domain
// marks (suspension_source 'domain', which only the admin's lists read: availability reads coverage live) with the
// blocks as they stand, in two walks:
//   - clear: the suspended accounts by id (accounts_suspended, which holds every mark, whatever the account's domain is
//     now), CLEAR_ROUND a round; a mark no block covers any more is cleared.
//   - mark (only while a suspend block exists): every account by id, MARK_WINDOW a round (the predicate per remote
//     account, MARK_ACCOUNTS covered ones at most); a covered account not individually suspended is marked if it is
//     not yet, and severed both ways up to the follow bound, marked or not, so a follow made while an earlier block was
//     lifted is severed too. An individually suspended account is skipped: its local follows are kept.
// No account is stored or moves into a covered domain (inbox.ts upsertRemoteActor), so the walk after the last reset
// finds every covered account; marks and severing then agree with the blocks whatever the order of transitions and
// rounds. A permitted refresh of a marked account clears its stale mark (upsertRemoteActor).
//
// Severing an account (sever): out, its follows of local accounts (follows_pair, by target), then in, local
// accounts' follows of it (follows_target, by state and id), each up to the follow bound. A remote follower's accepted
// follow ends with a withdrawing Reject to its current inbox alone (its shared inbox when known, else its personal
// one), as Mastodon sends it; its request is deleted without one; a local follower's follow or request ends with its
// Undo (blocks.ts severFollow). Row existence decides, so an Undo, a purge, a user's domain block cleanup or another
// job that removed the follow first sends nothing more. Every round reads at most SEVER_ROUND follows and writes at
// most MODERATION_ROUND_ROWS rows (suspension.ts, counted with total_changes). Ending a follow has two parts:
//   - preparatory steps (prepared), each bounded by the round's room above SEVER_ROWS: every write of variable size
//     that ending the follow would cascade to. These are its follow notification's push deliveries (the notification's
//     delete cascades to them) and, for an activity that names the follow by id (the Reject of an accepted follow, the
//     Undo of a local one), the earlier activities about that follow it supersedes (an update, and a delete when
//     settled, each; a Misskey pair id names every generation of a follow, so they grow with its history). They are
//     worked down across rounds, so no Accept left waiting is sent after the Reject.
//   - the final step (blocks.ts severFollow), taken only once both are done, which then writes at most SEVER_ROWS rows:
//     a constant.
// The arithmetic: room() keeps SEVER_ROWS and the round's retry state's row (job-attempts.ts JOB_BOOKKEEPING_ROWS); a
// preparatory step or a mark writes at most room() rows, and the final step is taken only while room() >= 0, so a
// round writes at most MODERATION_ROUND_ROWS - SEVER_ROWS - JOB_BOOKKEEPING_ROWS + SEVER_ROWS rows, and its retry
// state's row one more. Progress: a round starts with room() = MODERATION_ROUND_ROWS - SEVER_ROWS - 1 (258) > 0, so its
// first covered account is marked, or its first follow has a preparatory row written or is ended; otherwise the cursor
// moves past what it read.

// Follows a severing round reads at most.
export const SEVER_ROUND = 100
// Rows the final step of ending a follow writes at most, its preparatory steps done, with the job's own update: 40
// for the follow and its bookkeeping, which write 9 at most: the follow, its follow and follow_request notifications
// (one each at most, notifications_natural; no push delivery left), the two counts, the retraction, the activity's
// intent and its one chunk (one target: the remote account's current inbox; no earlier receivers), the earlier
// activities left to supersede (none), and the job's update; 1 for the follow delete's triggers, which for a local
// follower remove its pin of the account (account_pins_follow_ended) and, its list memberships of the account already
// deleted in preparatory steps, no list row (list_members_follow_ended); and 3 × EXPANSION_STEP for the expansion
// that recording the activity runs (deliveries.ts enqueueActivity), which may expand any activity's pending targets:
// up to EXPANSION_STEP deliveries, each from a chunk of its own at worst, whose cursor update and delete are two more
// rows.
export const SEVER_ROWS = 40 + 1 + 3 * EXPANSION_STEP
// Suspended accounts a clearing round reads at most: each clear is one row, so a round writes CLEAR_ROUND + 1.
export const CLEAR_ROUND = 500
// Accounts a marking round walks at most, by id (the predicate is evaluated for each remote one among them), and
// covered accounts it reconciles at most. MARK_WINDOW is set by measurement on the benchmark store (docs/visibility.md,
// "Instance domain blocks").
export const MARK_WINDOW = 2_000
export const MARK_ACCOUNTS = 100

type RemoteJob = {
	// Read as TEXT (DATA-6).
	id: string
	kind: 'account' | 'domain'
	subject: string
	mode: 'account' | 'domain'
	actor_account_id: string | null
	// The newest follow at the job's reset, read as TEXT (DATA-6).
	follow_bound: string
	report_bound: string | null
	action_bound: number | null
	phase: string
	cursor: string
}

const iso = (ms: number) => new Date(ms).toISOString()

const NEWEST_FOLLOW = '(SELECT coalesce(max(id), 0) FROM follows)'

// Resets the account job of `accountId` in the caller's transaction (its generation): the mode, the phase it starts in
// and its metadata, a fresh follow bound (the newest follow, read in the same statement), the cursor at the start, and
// the retry state fresh, so a job that failed or parked under the earlier decision runs the new one (RES-5).
function resetAccountJob(
	db: Db,
	accountId: string,
	job: {
		mode: 'account' | 'domain'
		phase: string
		actor: string | null
		reportBound: string | null
		actionBound: number | null
	}
): void {
	db.run(
		`INSERT INTO remote_moderation_jobs (kind, subject, mode, actor_account_id, follow_bound, report_bound,
			action_bound, phase, cursor)
		VALUES ('account', ?1, ?2, ?3, ${NEWEST_FOLLOW}, ?4, ?5, ?6, '')
		ON CONFLICT (kind, subject) DO UPDATE SET mode = excluded.mode, actor_account_id = excluded.actor_account_id,
			follow_bound = excluded.follow_bound, report_bound = excluded.report_bound,
			action_bound = excluded.action_bound, phase = excluded.phase, cursor = excluded.cursor, ${FRESH_ATTEMPTS_SQL}`,
		accountId,
		job.mode,
		job.actor,
		job.reportBound,
		job.actionBound,
		job.phase
	)
}

// Suspends the remote account `accountId` in one bounded transaction (above), also when it is suspended already
// (Mastodon's suspend! runs again) or held by a domain mark, which resets its job to mode 'account'. `by` is the admin
// who suspends: its suspend row in the moderation log is the job's action bound (VIS-29), and the resolved reports name
// it; without one (null), nothing is logged and the bound is the newest log row. Returns the suspension's time, or null
// for an account that is not remote.
export function suspendRemote(db: Db, accountId: string, by: Admin | null, now: number): string | null {
	const at = iso(now)
	const found = db.first(
		"UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = ? AND domain IS NOT NULL RETURNING id",
		at,
		accountId
	)
	if (found === undefined) {
		return null
	}
	const fence =
		by === null
			? actionBound(db)
			: logAction(db, by, 'suspend', { type: 'Account', id: accountId }, { suspended_at: at }, by.now)
	resetAccountJob(db, accountId, {
		mode: 'account',
		phase: 'reports',
		actor: by?.accountId ?? null,
		reportBound: reportBound(db),
		actionBound: fence,
	})
	return at
}

// Lifts the individual suspension of a remote account. When no suspend block covers it, clears suspended_at and its
// source ('lifted'), which ends its job at the next round; what was severed stays severed. When one still does, the
// account stays suspended as a domain mark ('converted'), and its job is reset to mode 'domain' with a
// fresh follow bound, so it severs both ways. Null for an account that is not individually suspended (a domain mark
// alone is lifted by lowering the block).
export function unsuspendRemote(db: Db, accountId: string): 'lifted' | 'converted' | null {
	const found = db.first<{ covered: number }>(
		`SELECT ${domainCoveredSql('a')} AS covered FROM accounts a
		WHERE a.id = ? AND a.domain IS NOT NULL AND ${individuallySuspendedSql('a')}`,
		accountId
	)
	if (found === undefined) {
		return null
	}
	if (found.covered === 0) {
		db.run('UPDATE accounts SET suspended_at = NULL, suspension_source = NULL WHERE id = ?', accountId)
		return 'lifted'
	}
	db.run("UPDATE accounts SET suspension_source = 'domain' WHERE id = ?", accountId)
	resetAccountJob(db, accountId, { mode: 'domain', phase: 'out', actor: null, reportBound: null, actionBound: null })
	return 'converted'
}

// Whether the domain job runs: the domain marks may lag the blocks (R38), so the admin's lists that read them answer
// 503 meanwhile (admin-accounts.ts).
export function domainJobRunning(db: Db): boolean {
	return db.first("SELECT 1 AS x FROM remote_moderation_jobs WHERE kind = 'domain' AND subject = ''") !== undefined
}

// ---- Rounds

// The remote account `a` the domain job severs: covered by a suspend block, and not individually suspended.
function severableSql(a: string): string {
	return `(${a}.domain IS NOT NULL AND NOT ${individuallySuspendedSql(a)} AND ${domainCoveredSql(a)})`
}

// Whether the job's condition (above, by kind and mode) still holds, read live before each round.
function holds(db: Db, job: RemoteJob): boolean {
	if (job.kind === 'domain') {
		return true
	}
	const condition =
		job.mode === 'account' ? individuallySuspendedSql('a') : `${domainMarkedSql('a')} AND ${domainCoveredSql('a')}`
	return db.first(`SELECT 1 AS x FROM accounts a WHERE a.id = ? AND ${condition}`, job.subject) !== undefined
}

function save(db: Db, job: RemoteJob, phase: string, cursor: string): void {
	db.run('UPDATE remote_moderation_jobs SET phase = ?, cursor = ? WHERE id = CAST(? AS INTEGER)', phase, cursor, job.id)
}

function finish(db: Db, job: RemoteJob): void {
	db.run('DELETE FROM remote_moderation_jobs WHERE id = CAST(? AS INTEGER)', job.id)
}

// A round's budgets: rows written (room, above) and follows read.
type Budget = { room: () => number; reads: number }

function budget(db: Db): Budget {
	const rows = new RowBudget(db, MODERATION_ROUND_ROWS)
	// Unclamped: a step past the room reads it as negative.
	return { room: () => MODERATION_ROUND_ROWS - SEVER_ROWS - JOB_BOOKKEEPING_ROWS - rows.spent(), reads: SEVER_ROUND }
}

// A follow to sever: its id read as TEXT (DATA-6), and whether it is at most the job's follow bound (compared in SQL).
type Severed = { follower: string; target: string; id: string; bounded: number; state: string; uri: string | null }

// The preparatory steps of ending `follow` (above), within `room()` rows: its follow notification's push deliveries,
// the followed account's memberships in the follower's lists (which the follow delete's trigger would remove at once:
// a converted instance keeps legacy lists, of any number, so they are not bounded by lists.ts MAX_LISTS; read as the
// trigger reads them, through the follower's lists), then the earlier activities that the activity ending it would
// supersede (deliveries.ts supersedeEarlier, three rows each at most: its update, its delete and the end of its
// staging, which only an imported retraction still staging has, outbound_activities_staging_ended): for a remote
// follower's accepted follow with an id, its Reject's, signed by the local target; for a local follower, its Undo's,
// signed by the follower. Returns whether all are done, so that its end costs at most SEVER_ROWS; false when room ran
// out first, after writing at least one row whenever room() was positive.
function prepared(db: Db, follow: Severed, room: () => number): boolean {
	let left = room()
	if (left <= 0) {
		return false
	}
	db.run(
		`DELETE FROM push_deliveries WHERE id IN (SELECT d.id FROM notifications n
			JOIN push_deliveries d INDEXED BY push_deliveries_notification ON d.notification_id = n.id
			WHERE n.account_id = ?1 AND n.type IN ('follow', 'follow_request') AND n.from_account_id = ?2
			LIMIT ?3)`,
		follow.target,
		follow.follower,
		left
	)
	const waiting = db.first(
		`SELECT 1 AS x FROM notifications n JOIN push_deliveries d ON d.notification_id = n.id
		WHERE n.account_id = ?1 AND n.type IN ('follow', 'follow_request') AND n.from_account_id = ?2 LIMIT 1`,
		follow.target,
		follow.follower
	)
	if (waiting !== undefined) {
		return false
	}
	left = room()
	if (left <= 0) {
		return false
	}
	const members = `SELECT l.id FROM lists l INDEXED BY lists_account
		WHERE l.account_id = ?1 AND EXISTS (SELECT 1 FROM list_accounts m WHERE m.list_id = l.id AND m.account_id = ?2)`
	db.run(
		`DELETE FROM list_accounts WHERE account_id = ?2 AND list_id IN (${members} LIMIT ?3)`,
		follow.follower,
		follow.target,
		left
	)
	if (db.first(`${members} LIMIT 1`, follow.follower, follow.target) !== undefined) {
		return false
	}
	const local = db.first<{ uri: string }>('SELECT uri FROM accounts WHERE id = ? AND domain IS NULL', follow.follower)
	const [signer, object] =
		local !== undefined
			? [follow.follower, follow.uri ?? followUri(local.uri, String(follow.id))]
			: [follow.target, follow.state === 'accepted' ? follow.uri : null]
	if (object === null) {
		return true
	}
	left = Math.floor(room() / 3)
	return left > 0 && !supersedeEarlier(db, signer, object, left)
}

// Where severing an account stands: the direction ('out', its follows of local accounts; 'in', local accounts' follows
// of it) and the cursor in it (the last target id out; the last state and id in, as 'state id').
type Side = { dir: 'out' | 'in'; cursor: string }

// The columns of a follow to sever, its bound the parameter ?4 (out) or ?5 (in), decimal TEXT.
const SEVERED_OUT = `f.account_id AS follower, f.target_account_id AS target, CAST(f.id AS TEXT) AS id,
	f.id <= CAST(?4 AS INTEGER) AS bounded, f.state, f.uri`
const SEVERED_IN = `f.account_id AS follower, f.target_account_id AS target, CAST(f.id AS TEXT) AS id,
	f.id <= CAST(?5 AS INTEGER) AS bounded, f.state, f.uri`

function readSide(
	db: Db,
	account: string,
	side: Side,
	bound: string,
	limit: number
): { rows: Severed[]; next: (f: Severed) => string } {
	if (side.dir === 'out') {
		return {
			rows: db.all<Severed>(
				`SELECT ${SEVERED_OUT} FROM follows f INDEXED BY follows_pair
				WHERE f.account_id = ?1 AND f.target_account_id > ?2 ORDER BY f.target_account_id LIMIT ?3`,
				account,
				side.cursor,
				limit,
				bound
			),
			next: (f) => f.target,
		}
	}
	// The cursor's id is decimal TEXT, bound back with CAST.
	const [state = '', id = '0'] = side.cursor.split(' ')
	return {
		rows: db.all<Severed>(
			`SELECT ${SEVERED_IN} FROM follows f INDEXED BY follows_target
			WHERE f.target_account_id = ?1 AND (f.state, f.id) > (?2, CAST(?3 AS INTEGER)) ORDER BY f.state, f.id LIMIT ?4`,
			account,
			state,
			id,
			limit,
			bound
		),
		next: (f) => `${f.state} ${f.id}`,
	}
}

// Severs `account`'s follows from `side` up to `bound` (above), out only or both ways, within the round's budget.
// Returns the side where it stopped, or null when done, and whether an activity was recorded.
function sever(
	db: Db,
	account: string,
	bound: string,
	side: Side,
	both: boolean,
	spent: Budget,
	now: number
): { side: Side | null; recorded: boolean } {
	let recorded = false
	let at = side
	for (;;) {
		if (spent.reads <= 0) {
			return { side: at, recorded }
		}
		const { rows, next } = readSide(db, account, at, bound, spent.reads)
		spent.reads -= rows.length
		for (const follow of rows) {
			if (follow.bounded === 1) {
				if (!prepared(db, follow, spent.room) || spent.room() < 0) {
					return { side: at, recorded }
				}
				recorded = severFollow(db, follow.follower, follow.target, now) || recorded
			}
			at = { dir: at.dir, cursor: next(follow) }
		}
		if (spent.reads <= 0 && rows.length > 0) {
			// Read up to the budget: there may be more on this side.
			return { side: at, recorded }
		}
		if (at.dir === 'in' || !both) {
			return { side: null, recorded }
		}
		at = { dir: 'in', cursor: '' }
	}
}

// One round of an account job's severing (mode 'account': out only; mode 'domain': both ways).
function accountSeverRound(db: Db, job: RemoteJob, now: number): boolean {
	const dir = job.phase === 'in' ? 'in' : 'out'
	const done = sever(
		db,
		job.subject,
		job.follow_bound,
		{ dir, cursor: job.cursor },
		job.mode === 'domain',
		budget(db),
		now
	)
	if (done.side === null) {
		finish(db, job)
	} else {
		save(db, job, done.side.dir === 'in' ? 'in' : job.mode === 'domain' ? 'out' : 'follows', done.side.cursor)
	}
	return done.recorded
}

function clearRound(db: Db, job: RemoteJob): void {
	const rows = db.all<{ id: string; stale: number }>(
		`SELECT a.id, (a.suspension_source = 'domain' AND NOT ${domainCoveredSql('a')}) AS stale
		FROM accounts a INDEXED BY accounts_suspended
		WHERE ${suspendedSql('a')} AND a.id > ?1 ORDER BY a.id LIMIT ?2`,
		job.cursor,
		CLEAR_ROUND
	)
	const stale = rows.filter((row) => row.stale === 1).map((row) => row.id)
	if (stale.length > 0) {
		// Each account sought by id (RES-7).
		db.run(
			`UPDATE accounts INDEXED BY ${ACCOUNTS_ID_INDEX} SET suspended_at = NULL, suspension_source = NULL
			WHERE id IN (SELECT value FROM json_each(?)) AND suspension_source = 'domain'`,
			JSON.stringify(stale)
		)
	}
	if (rows.length === CLEAR_ROUND) {
		save(db, job, 'clear', rows.at(-1)!.id)
	} else if (db.first(`SELECT ${SUSPEND_BLOCKS_SQL} AS x`)?.x === 1) {
		save(db, job, 'mark', JSON.stringify({ after: '' }))
	} else {
		finish(db, job)
	}
}

// The domain job's position in its marking walk: every account up to `after` is reconciled; `severing` is the
// account after it whose severing stopped at `side`.
type MarkCursor = { after: string; severing?: string; side?: Side }

// Returns whether this round recorded an activity.
function markRound(db: Db, job: RemoteJob, now: number): boolean {
	const at = JSON.parse(job.cursor) as MarkCursor
	const spent = budget(db)
	let recorded = false
	const stop = (cursor: MarkCursor) => {
		save(db, job, 'mark', JSON.stringify(cursor))
		return recorded
	}
	// Covered accounts this round may still reconcile: MARK_ACCOUNTS, the one it resumes included.
	let accounts = MARK_ACCOUNTS
	if (at.severing !== undefined) {
		accounts--
		const still = db.first(`SELECT 1 AS x FROM accounts a WHERE a.id = ? AND ${severableSql('a')}`, at.severing)
		if (still !== undefined) {
			const done = sever(db, at.severing, job.follow_bound, at.side!, true, spent, now)
			recorded = done.recorded
			if (done.side !== null) {
				return stop({ ...at, side: done.side })
			}
		}
		at.after = at.severing
	}
	// The window's last account, or none when fewer than MARK_WINDOW accounts are left (the walk's last window).
	const end = db.first<{ id: string }>(
		'SELECT id FROM accounts WHERE id > ? ORDER BY id LIMIT 1 OFFSET ?',
		at.after,
		MARK_WINDOW - 1
	)?.id
	const covered = db.all<{ id: string; marked: number }>(
		`SELECT a.id, ${suspendedSql('a')} AS marked FROM accounts a
		WHERE a.id > ?1 AND a.id <= coalesce(?2, char(58)) AND ${severableSql('a')} ORDER BY a.id LIMIT ?3`,
		at.after,
		end ?? null,
		accounts
	)
	let after = at.after
	for (const account of covered) {
		if (spent.room() < 1) {
			return stop({ after })
		}
		if (account.marked === 0) {
			db.run(
				`UPDATE accounts SET suspended_at = ?, suspension_source = 'domain' WHERE id = ? AND NOT ${suspendedSql('accounts')}`,
				iso(now),
				account.id
			)
		}
		const done = sever(db, account.id, job.follow_bound, { dir: 'out', cursor: '' }, true, spent, now)
		recorded = done.recorded || recorded
		if (done.side !== null) {
			return stop({ after, severing: account.id, side: done.side })
		}
		after = account.id
	}
	if (covered.length === accounts) {
		return stop({ after })
	}
	if (end === undefined) {
		finish(db, job)
		return recorded
	}
	return stop({ after: end })
}

const JOB_COLUMNS = `CAST(id AS TEXT) AS id, kind, subject, mode, actor_account_id,
	CAST(follow_bound AS TEXT) AS follow_bound, CAST(report_bound AS TEXT) AS report_bound, action_bound, phase, cursor`

// One round of the next remote job (nextJob: the first due retry, else the first fresh job after id `after`, else the
// oldest), of both kinds, in its own savepoint (runJobItem, as suspension.ts moderationRound). Null when no job may
// run; else the job's id (as TEXT), whether it was a fresh one and whether the round recorded an activity to deliver.
export function remoteModerationRound(
	db: Db,
	now: number,
	after = '0'
): { id: string; fresh: boolean; delivers: boolean } | null {
	const job = nextJob<RemoteJob>(db, REMOTE_MODERATION_JOBS, now, { columns: JOB_COLUMNS, after })
	if (job === undefined) {
		return null
	}
	const ran = runJobItem(db, REMOTE_MODERATION_JOBS, [job.id], job.attempts, now, () => remoteRound(db, job, now))
	return { id: job.id, fresh: job.attempts === 0, delivers: ran.ok && ran.value }
}

// One round of `job`. Returns whether it recorded an activity to deliver.
function remoteRound(db: Db, job: RemoteJob, now: number): boolean {
	if (!holds(db, job)) {
		finish(db, job)
		return false
	}
	if (job.kind === 'domain') {
		if (job.phase === 'clear') {
			clearRound(db, job)
			return false
		}
		return markRound(db, job, now)
	}
	if (job.phase === 'reports') {
		const round = resolveSuspensionReports(
			db,
			job.subject,
			job.report_bound ?? '0',
			job.action_bound,
			job.actor_account_id,
			job.cursor === '' ? '0' : job.cursor,
			REPORT_ROUND,
			iso(now)
		)
		if (round.read < REPORT_ROUND) {
			save(db, job, 'follows', '')
		} else {
			save(db, job, 'reports', round.last ?? '0')
		}
		return false
	}
	return accountSeverRound(db, job, now)
}
