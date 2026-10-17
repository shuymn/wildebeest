-- Kopje Store schema 0042: the report fence of a suspension. Never edit after release (checksummed).
--
-- A suspension resolves only the reports it froze (src/domain/reports.ts resolveSuspensionReports, R37, VIS-29). It
-- judged them by comparing two requests' clocks, so a reopen applied after the suspension, with an earlier clock, was
-- resolved anyway. The fence is now the moderation log id, which is given in commit order and never twice
-- (0029_admin_reports):
--
--   reports.last_action_id         the log id of the last admin write to the report, stamped in that write's
--                                  transaction. NULL (no admin write) counts as 0.
--   moderation_jobs.action_bound   the newest log id when the suspension committed, frozen in its transaction. A
--                                  suspension job resolves only reports whose last_action_id is at or below it; NULL
--                                  (unknown) resolves none, and leaves them to the admin.
--
-- The stored state is carried over from the log: each report logged by an admin gets its newest log id, and each
-- suspension job still running gets the id of its own suspend row (the account's, with the job's suspended_at; logged
-- in the suspension's transaction, after the bound was frozen, and no report write between). A job whose suspend row
-- was pruned (MODERATION_LOG_KEEP) keeps NULL: the reopen that followed it may have been pruned as well, so no bound
-- is safe. Report writes pruned while their suspension's row is kept are older than it, so 0 is below its bound.
--
-- Cost: two ALTERs adding a column with no default and no CHECK (a change of the schema alone), and the carry-over,
-- which reads the log once (at most MODERATION_LOG_KEEP rows and a pruning batch), writes one row per report it names,
-- and reads the log once more per running suspension job. Measured on the benchmark store of
-- test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses with their mentions and tags,
-- 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts) in workerd's local Durable Object SQLite:
-- 3,045 ms for the upgrade of this file through the kernel (its bookmark, transaction and schema verification; 3,074
-- ms in a second run), within the 5,000 ms each migration file may take. That store holds no moderation log; the
-- carry-over's reads grow with the log alone (test/migrations.test.ts, 0042), and the log is capped.

ALTER TABLE reports ADD COLUMN last_action_id INTEGER;
ALTER TABLE moderation_jobs ADD COLUMN action_bound INTEGER;

UPDATE reports SET last_action_id = logged.id
FROM (
  SELECT CAST(target_id AS INTEGER) AS report_id, max(id) AS id FROM admin_actions
  WHERE target_type = 'Report' GROUP BY target_id
) AS logged
WHERE reports.id = logged.report_id;

UPDATE moderation_jobs SET action_bound = (
  SELECT id FROM admin_actions
  WHERE action = 'suspend' AND target_type = 'Account' AND target_id = moderation_jobs.account_id
    AND json_extract(detail, '$.suspended_at') = moderation_jobs.since
  ORDER BY id DESC LIMIT 1
)
WHERE kind = 'suspension';
