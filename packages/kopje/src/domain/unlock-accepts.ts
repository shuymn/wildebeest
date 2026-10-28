import type { Db } from "../db/sql";
import { errorFields } from "../platform/error-message";
import { answerPendingFollow } from "./accounts";
import { availableJoinedSql, availableSql, blocksSql, domainBlocksSql } from "./audience";
import { isolated } from "./job-attempts";
import { writeOperation } from "./operation";

// Unlocking an account accepts its pending follow requests (Mastodon's
// UpdateAccountService#authorize_all_follow_requests, app/services/update_account_service.rb:5-11, 22-28, which queues
// AuthorizeFollowWorker for each). Kopje runs it as a cursor job: local_accounts.accept_requests_after (migration
// 0058) holds the last follows.id the job has passed, NULL for no job.
//
// - The 1 -> 0 transition of `locked` starts the job at 0 when a request is pending (unlockChanged, in the update's
//   transaction); relocking clears it (Kopje stops accepting, docs/mastodon-deviations.md), and so does a suspension,
//   in its transaction (suspension.ts suspendLocal), so an unsuspension does not resume it.
// - Each step is its own write transaction (Store.runUnlockAccepts runs UNLOCK_ACCEPTS_PER_ROUND of them per round): it
//   reads the job and the next pending request past the cursor, advances the cursor past it, and authorizes it through
//   answerPendingFollow, the operation POST /api/v1/follow_requests/:id/authorize runs, with that operation's cost,
//   delivery admission, counter recount and push cascade, in its own savepoint (isolated): an authorization that
//   throws is rolled back alone and logged (kopje.jobs.step.failed), and its request stays pending, which the account
//   can still authorize by hand, while the cursor's advance commits. Every step that reads makes progress: it advances
//   or clears the cursor.
// - An unavailable requester (R1) or one the account blocks, or whose domain it blocks (R21, blockedSql's terms), is
//   passed over and stays pending.
// - The cursor is compared and advanced in SQL (ids read as text and bound back with CAST), never through a JS number.
// - A locked or suspended account, or no pending request past the cursor, ends the job.

// Requests one round accepts or passes over at most, each in its own transaction.
export const UNLOCK_ACCEPTS_PER_ROUND = 20;

// In the transaction of a credentials update, after `locked` is applied: relocking clears the job, and unlocking with a
// pending request starts it. True when a job is (still) running for the account.
export function unlockChanged(db: Db, accountId: string, wasLocked: boolean, locked: boolean | undefined): boolean {
  if (locked === true) {
    db.run("UPDATE local_accounts SET accept_requests_after = NULL WHERE account_id = ?", accountId);
    return false;
  }
  if (locked === false && wasLocked) {
    db.run(
      `UPDATE local_accounts SET accept_requests_after = 0 WHERE account_id = ?1
				AND EXISTS (SELECT 1 FROM follows WHERE target_account_id = ?1 AND state = 'pending')`,
      accountId,
    );
  }
  return (
    db.first(
      "SELECT 1 AS running FROM local_accounts WHERE account_id = ? AND accept_requests_after IS NOT NULL",
      accountId,
    ) !== undefined
  );
}

// The first job, by account id: a scan of the local accounts.
const NEXT_JOB = `SELECT l.account_id, a.locked, ${availableJoinedSql("a", "l")} AS available
	FROM local_accounts l JOIN accounts a ON a.id = l.account_id
	WHERE l.accept_requests_after IS NOT NULL ORDER BY l.account_id LIMIT 1`;

// The next pending request of the job of ?1 past its cursor: one seek of follows_target (target_account_id, state,
// rowid), then key probes of availability and blocks (test/unlock-accepts.test.ts shows the plan).
export const NEXT_REQUEST = `SELECT CAST(f.id AS TEXT) AS id, f.account_id AS requester,
		(${availableSql("f.account_id")} AND NOT ${blocksSql("?1", "f.account_id")}
			AND NOT ${domainBlocksSql("?1", "f.account_id")}) AS acceptable
	FROM follows f INDEXED BY follows_target
	WHERE f.target_account_id = ?1 AND f.state = 'pending'
		AND f.id > (SELECT accept_requests_after FROM local_accounts WHERE account_id = ?1)
	ORDER BY f.id LIMIT 1`;

export type UnlockStep = { done: boolean; delivers: boolean };

// One step of the first job. done: there is no job left to step.
export const unlockAcceptStep = writeOperation<{ now: number }, UnlockStep>((db, { now }) => {
  const job = db.first<{ account_id: string; locked: number; available: number }>(NEXT_JOB);
  if (job === undefined) {
    return { done: true, delivers: false };
  }
  const end = () => {
    db.run("UPDATE local_accounts SET accept_requests_after = NULL WHERE account_id = ?", job.account_id);
    return { done: db.first(NEXT_JOB) === undefined, delivers: false };
  };
  if (job.locked === 1 || job.available === 0) {
    return end();
  }
  const request = db.first<{ id: string; requester: string; acceptable: number }>(NEXT_REQUEST, job.account_id);
  if (request === undefined) {
    return end();
  }
  db.run(
    "UPDATE local_accounts SET accept_requests_after = CAST(?2 AS INTEGER) WHERE account_id = ?1",
    job.account_id,
    request.id,
  );
  if (request.acceptable === 0) {
    return { done: false, delivers: false };
  }
  const remote = db.first("SELECT 1 AS remote FROM accounts WHERE id = ? AND domain IS NOT NULL", request.requester);
  // The cursor's advance above commits whatever the authorization does: one that throws is rolled back alone and
  // passed over, its request left pending for the account to answer (RES-5).
  const answered = isolated(db, () => answerPendingFollow(db, job.account_id, request.requester, "authorize", now));
  if (!answered.ok) {
    console.error({ event: "kopje.jobs.step.failed", family: "unlock_accepts", ...errorFields(answered.error) });
    return { done: false, delivers: false };
  }
  return { done: false, delivers: answered.value === "ok" && remote !== undefined };
});
