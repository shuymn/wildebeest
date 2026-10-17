-- Kopje Store schema 0042: the report fence of a suspension. Never edit after release (checksummed).
--
-- A suspension resolves only the reports it froze (src/domain/reports.ts resolveSuspensionReports, R37, VIS-29). The
-- fence is the moderation log id, given in commit order and never twice (0029_admin_reports), so no request's clock
-- can make a later reopen look older:
--
--   reports.last_action_id         the log id of the last admin write to the report, stamped in that write's
--                                  transaction. NULL (no admin write) counts as 0.
--   moderation_jobs.action_bound   the newest log id when the suspension committed, frozen in its transaction. A
--                                  suspension job resolves only reports whose last_action_id is at or below it; NULL
--                                  (unknown) resolves none, and leaves them to the admin.
--
-- The stored state is carried over from the log: each report logged by an admin gets its newest log id, and each
-- suspension job that will still resolve reports (its account's current epoch, in its report phase) gets the id of its
-- own suspend row: the account's newest, if it carries the job's suspended_at (logged in the suspension's transaction,
-- after the bound was frozen, and no report write between). Every other job keeps NULL. A job whose suspend row was
-- pruned (MODERATION_LOG_KEEP) keeps NULL too: the reopen that followed it may have been pruned as well, so no bound
-- is safe. Report writes pruned while their suspension's row is kept are older than it, so 0 is below its bound.
--
-- Cost: two ALTERs adding a column with no default and no CHECK (a change of the schema alone), and the carry-over,
-- which reads the log twice (at most MODERATION_LOG_KEEP rows and a pruning batch each), writes one row per report it
-- names, and seeks each suspended account's current job through moderation_jobs' unique key, so obsolete jobs cost
-- nothing (test/migrations.test.ts, 0042). Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000
-- accounts, 3,000,000 follows, 2,000,000 statuses with their mentions and tags, 2,000,000 notifications, 200,000
-- quotes, 10,000 reports, 20 local accounts) in workerd's local Durable Object SQLite: 3,059 ms for the upgrade of this
-- file through the kernel (its bookmark, transaction and schema verification; 3,117 and 3,112 ms in two more runs at
-- load average 7 to 9, and one outlier of 6,055 ms), within the per-file budget (test/bench/migration-cost.ts). That
-- store holds no moderation log, so this is mostly the schema verification an isolated upgrade pays.

ALTER TABLE reports ADD COLUMN last_action_id INTEGER;
ALTER TABLE moderation_jobs ADD COLUMN action_bound INTEGER;

UPDATE reports SET last_action_id = logged.id
FROM (
  SELECT CAST(target_id AS INTEGER) AS report_id, max(id) AS id FROM admin_actions
  WHERE target_type = 'Report' GROUP BY target_id
) AS logged
WHERE reports.id = logged.report_id;

UPDATE moderation_jobs SET action_bound = suspended.id
FROM (
  SELECT target_id AS account_id, max(id) AS id, json_extract(detail, '$.suspended_at') AS at FROM admin_actions
  WHERE action = 'suspend' AND target_type = 'Account' GROUP BY target_id
) AS suspended
JOIN local_accounts ON local_accounts.account_id = suspended.account_id
WHERE moderation_jobs.account_id = suspended.account_id AND moderation_jobs.kind = 'suspension'
  AND moderation_jobs.generation = local_accounts.credential_epoch AND moderation_jobs.phase = 'reports'
  AND moderation_jobs.since = suspended.at;
