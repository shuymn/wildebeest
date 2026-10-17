import { individuallySuspendedSql } from './audience'
import type { Admin } from './auth'
import { severRemoteFollow } from './blocks'
import { EXPANSION_STEP, stageRetraction, supersedeEarlier } from './deliveries'
import { logAction } from './moderation-log'
import { actionBound, reportBound, resolveSuspensionReports } from './reports'
import { MODERATION_ROUND_ROWS, REPORT_ROUND } from './suspension'
import type { Db } from '../db/sql'

// The instance suspension of a remote account (R38, VIS-30; Mastodon's Admin::AccountAction with type suspend and
// SuspendAccountService#reject_remote_follows!, UnsuspendAccountService for the unsuspension), migration
// 0045_remote_suspension. The OAuth admin suspends and unsuspends through the Mastodon admin API (admin-accounts.ts).
//
// A suspension commits in one bounded transaction: the account's suspended_at and suspension_source 'account', which
// make it unavailable (R1, availableSql) from the commit on, and the reset of its job, which freezes its bounds (the
// newest follow, report and moderation log row) and moves its cursor to the start. The reset is the job's generation:
// a suspension again resets the same row, and every round first requires that the account is still individually
// suspended, so an unsuspension ends the job at its next round. Rounds are Store-only and stage nothing:
//
//   - reports: resolves the account's reports the suspension froze (reports.ts resolveSuspensionReports, VIS-29).
//   - follows: ends the account's follows of local accounts up to the follow bound, in target order (follows_pair).
//     An accepted follow ends with a withdrawing Reject, a request is deleted without one (blocks.ts
//     severRemoteFollow); row existence decides, so an Undo or purge that removed the follow first sends nothing more.
//     Local accounts' follows of the account are kept, and an unsuspension restores nothing that was severed.
//
// Every round writes at most MODERATION_ROUND_ROWS rows (suspension.ts, counted with total_changes) and reads at most
// REPORT_ROUND reports or SEVER_ROUND follows. Ending a follow has two parts:
//   - preparatory steps (prepared), each bounded by the round's room above SEVER_ROWS: every write of variable size
//     that ending the follow would cascade to. These are its follow notification's push deliveries (the notification's
//     delete cascades to them) and, for an accepted follow whose Reject names its Follow by id, the earlier activities
//     about that Follow, which the Reject supersedes (an update, and a delete when settled, each; a Misskey pair id
//     names every generation of a follow, so they grow with its history). They are worked down across rounds.
//   - the final step (blocks.ts severRemoteFollow), taken only once both are done, which then writes at most SEVER_ROWS
//     rows: a constant. The Reject of a follow named by its Follow's id is recorded there as a staged retraction
//     (deliveries.ts beginRetraction, one row): its receivers, every inbox an earlier activity about that id reached
//     or may reach, grow with the id's history (a Misskey pair id, a shared inbox that changed).
//   - staging (phase 'reject', deliveries.ts stageRetraction): the staged Reject's targets, written a chunk at a time
//     in inbox order within the rows the round has left, across rounds, before the next follow. Chunks written may
//     be expanded before the rest; each expanded row is queued behind the earlier rows of its lane, the earlier
//     activities' included. Staging runs to its end even after an unsuspension, since the follow is gone.
// The arithmetic: a preparatory step writes at most room() rows, and the final step is taken only while room() >= 0,
// so a round writes at most MODERATION_ROUND_ROWS - SEVER_ROWS + SEVER_ROWS rows. Progress: a round starts with room()
// = MODERATION_ROUND_ROWS - SEVER_ROWS (260) > 0, so its first follow either has a preparatory row written (a push
// delivery deleted, or an activity superseded) or is ended; the job's cursor moves past each follow ended. A staging
// round passes stageRetraction at least MODERATION_ROUND_ROWS - 2 rows, so it writes a chunk or completes, within
// that and the job's save (stageRetraction writes at most its maxRows rows and one delete).

// Follows a severing round reads at most.
export const SEVER_ROUND = 100
// Rows the final step of ending a follow writes at most, its preparatory steps done, with the job's own update: up to
// 40 for the follow (its list and pin triggers delete nothing for a remote follower, which has neither), its follow and
// follow_request notifications (one each at most, notifications_natural; no push delivery left), the two counts, the
// retraction, the Reject's intent and chunk, the earlier activities left to supersede (none), and the job's update; and
// 3 × EXPANSION_STEP for the expansion that recording the Reject runs (deliveries.ts enqueueActivity), which may expand
// any activity's pending targets: up to EXPANSION_STEP deliveries, each from a chunk of its own at worst, whose cursor
// update and delete are two more rows.
export const SEVER_ROWS = 40 + 3 * EXPANSION_STEP

type RemoteJob = {
	id: number
	kind: 'account' | 'domain'
	subject: string
	mode: 'account' | 'domain'
	actor_account_id: string | null
	follow_bound: number
	report_bound: number | null
	action_bound: number | null
	phase: string
	cursor: string
}

const iso = (ms: number) => new Date(ms).toISOString()

// Suspends the remote account `accountId` in one bounded transaction (above), also when it is suspended already
// (Mastodon's suspend! runs again), which resets its job. `by` is the admin who suspends: its suspend row in the
// moderation log is the job's action bound (VIS-29), and the resolved reports name it; without one (null), nothing is
// logged and the bound is the newest log row. Returns the suspension's time, or null for an account that is not remote.
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
	db.run(
		`INSERT INTO remote_moderation_jobs (kind, subject, mode, actor_account_id, follow_bound, report_bound,
			action_bound, phase, cursor)
		VALUES ('account', ?1, 'account', ?2, (SELECT coalesce(max(id), 0) FROM follows), ?3, ?4, 'reports', '')
		ON CONFLICT (kind, subject) DO UPDATE SET mode = excluded.mode, actor_account_id = excluded.actor_account_id,
			follow_bound = excluded.follow_bound, report_bound = excluded.report_bound,
			action_bound = excluded.action_bound, phase = excluded.phase, cursor = excluded.cursor`,
		accountId,
		by?.accountId ?? null,
		reportBound(db),
		fence
	)
	return at
}

// Lifts the individual suspension of a remote account: clears suspended_at and its source, which ends its job at the
// next round. What was severed stays severed. Returns false for an account that is not individually suspended.
export function unsuspendRemote(db: Db, accountId: string): boolean {
	return (
		db.first(
			`UPDATE accounts SET suspended_at = NULL, suspension_source = NULL
			WHERE id = ? AND domain IS NOT NULL AND ${individuallySuspendedSql('accounts')} RETURNING id`,
			accountId
		) !== undefined
	)
}

// ---- Rounds

function totalChanges(db: Db): number {
	return db.first<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0
}

// Whether the condition the job's mode requires still holds: in mode 'account', the account is individually
// suspended. A job of another kind or mode is not served by this version, and ends.
function holds(db: Db, job: RemoteJob): boolean {
	return (
		job.kind === 'account' &&
		job.mode === 'account' &&
		db.first(`SELECT 1 AS x FROM accounts a WHERE a.id = ? AND ${individuallySuspendedSql('a')}`, job.subject) !==
			undefined
	)
}

function save(db: Db, job: RemoteJob, phase: string, cursor: string): void {
	db.run('UPDATE remote_moderation_jobs SET phase = ?, cursor = ? WHERE id = ?', phase, cursor, job.id)
}

function finish(db: Db, job: RemoteJob): void {
	db.run('DELETE FROM remote_moderation_jobs WHERE id = ?', job.id)
}

type Severed = { target: string; id: number; state: string; uri: string | null }

// The preparatory steps of ending `follow` (above), within `room()` rows: its follow notification's push deliveries,
// then, for an accepted follow whose Reject names its Follow by id, the earlier activities about that Follow the Reject
// would supersede (deliveries.ts supersedeEarlier, two rows each at most). Returns whether all are done, so that its
// end costs at most SEVER_ROWS; false when room ran out first, after writing at least one row whenever room() was
// positive.
function prepared(db: Db, job: RemoteJob, follow: Severed, room: () => number): boolean {
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
		job.subject,
		left
	)
	const waiting = db.first(
		`SELECT 1 AS x FROM notifications n JOIN push_deliveries d ON d.notification_id = n.id
		WHERE n.account_id = ?1 AND n.type IN ('follow', 'follow_request') AND n.from_account_id = ?2 LIMIT 1`,
		follow.target,
		job.subject
	)
	if (waiting !== undefined) {
		return false
	}
	if (follow.state !== 'accepted' || follow.uri === null) {
		return true
	}
	left = Math.floor(room() / 2)
	return left > 0 && !supersedeEarlier(db, follow.target, follow.uri, left)
}

// One round of the follows phase (above). Returns whether an activity was recorded.
function severRound(db: Db, job: RemoteJob, now: number): boolean {
	const start = totalChanges(db)
	const room = () => MODERATION_ROUND_ROWS - SEVER_ROWS - (totalChanges(db) - start)
	const follows = db.all<Severed>(
		`SELECT f.target_account_id AS target, f.id, f.state, f.uri FROM follows f INDEXED BY follows_pair
		WHERE f.account_id = ?1 AND f.target_account_id > ?2 ORDER BY f.target_account_id LIMIT ?3`,
		job.subject,
		job.cursor,
		SEVER_ROUND
	)
	let cursor = job.cursor
	let stopped = false
	let recorded = false
	for (const follow of follows) {
		if (follow.id <= job.follow_bound) {
			// The final step only once nothing of variable size is left, with its constant cost still in the budget.
			if (!prepared(db, job, follow, room) || room() < 0) {
				stopped = true
				break
			}
			const ended = severRemoteFollow(db, job.subject, follow.target, now)
			recorded = ended.recorded || recorded
			if (ended.staged !== null) {
				// The staged Reject's receivers, within what the round has left (one row kept for the job's save).
				const used = totalChanges(db) - start
				if (!stageRetraction(db, ended.staged.signer, ended.staged.object, MODERATION_ROUND_ROWS - used - 2)) {
					save(db, job, 'reject', JSON.stringify({ after: follow.target, ...ended.staged }))
					return true
				}
			}
		}
		cursor = follow.target
	}
	if (!stopped && follows.length < SEVER_ROUND) {
		finish(db, job)
	} else {
		save(db, job, 'follows', cursor)
	}
	return recorded
}

const JOB_COLUMNS = `id, kind, subject, mode, actor_account_id, follow_bound, report_bound, action_bound, phase, cursor`

// One round of the remote job after id `after`, else of the oldest, so a call's jobs take turns. Null when there is
// no job; else the job's id and whether the round recorded an activity to deliver.
export function remoteModerationRound(db: Db, now: number, after = 0): { id: number; delivers: boolean } | null {
	const job =
		db.first<RemoteJob>(`SELECT ${JOB_COLUMNS} FROM remote_moderation_jobs WHERE id > ? ORDER BY id LIMIT 1`, after) ??
		db.first<RemoteJob>(`SELECT ${JOB_COLUMNS} FROM remote_moderation_jobs ORDER BY id LIMIT 1`)
	if (job === undefined) {
		return null
	}
	// A staged Reject is staged to the end whether or not the account is still suspended: its follow is gone already.
	if (job.phase === 'reject') {
		const staging = JSON.parse(job.cursor) as { after: string; signer: string; object: string }
		if (stageRetraction(db, staging.signer, staging.object, MODERATION_ROUND_ROWS - 2)) {
			save(db, job, 'follows', staging.after)
		}
		return { id: job.id, delivers: true }
	}
	if (!holds(db, job)) {
		finish(db, job)
		return { id: job.id, delivers: false }
	}
	if (job.phase === 'reports') {
		const round = resolveSuspensionReports(
			db,
			job.subject,
			job.report_bound ?? 0,
			job.action_bound,
			job.actor_account_id,
			Number(job.cursor === '' ? 0 : job.cursor),
			REPORT_ROUND,
			iso(now)
		)
		if (round.read < REPORT_ROUND) {
			save(db, job, 'follows', '')
		} else {
			save(db, job, 'reports', String(round.last ?? 0))
		}
		return { id: job.id, delivers: false }
	}
	return { id: job.id, delivers: severRound(db, job, now) }
}
