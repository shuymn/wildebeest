import { individuallySuspendedSql } from './audience'
import type { Admin } from './auth'
import { severRemoteFollow } from './blocks'
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
// REPORT_ROUND reports or SEVER_ROUND follows. Before a follow ends, the push deliveries of
// its follow notification, which the notification's delete would cascade to, are deleted within the room the round has
// left above SEVER_ROWS; a follow whose deliveries do not fit waits for the next round, which starts with them.

// Follows a severing round reads at most.
export const SEVER_ROUND = 100
// Rows one follow's end writes at most, its push deliveries deleted first, with the job's own update: the follow and
// its list and pin triggers (none for a remote follower), its notifications, the two counts, the retraction, the
// Reject's intent and chunk, and the earlier activities about the follow it supersedes with their deliveries.
export const SEVER_ROWS = 40

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

// One round of the follows phase (above). Returns whether an activity was recorded.
function severRound(db: Db, job: RemoteJob, now: number): boolean {
	const start = totalChanges(db)
	const room = () => MODERATION_ROUND_ROWS - SEVER_ROWS - (totalChanges(db) - start)
	const follows = db.all<{ target: string; id: number }>(
		`SELECT f.target_account_id AS target, f.id FROM follows f INDEXED BY follows_pair
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
			const left = room()
			if (left > 0) {
				db.run(
					`DELETE FROM push_deliveries WHERE id IN (SELECT d.id FROM notifications n
						JOIN push_deliveries d INDEXED BY push_deliveries_notification ON d.notification_id = n.id
						WHERE n.account_id = ?1 AND n.type IN ('follow', 'follow_request') AND n.from_account_id = ?2
						LIMIT ?3)`,
					follow.target,
					job.subject,
					left
				)
			}
			const waiting = db.first(
				`SELECT 1 AS x FROM notifications n JOIN push_deliveries d ON d.notification_id = n.id
				WHERE n.account_id = ?1 AND n.type IN ('follow', 'follow_request') AND n.from_account_id = ?2 LIMIT 1`,
				follow.target,
				job.subject
			)
			if (waiting !== undefined || left <= 0) {
				stopped = true
				break
			}
			recorded = severRemoteFollow(db, job.subject, follow.target, now) || recorded
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
