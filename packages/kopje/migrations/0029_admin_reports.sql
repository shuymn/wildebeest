-- Kopje Store schema 0029: the admin API's reports and the moderation log. Never edit after release (checksummed).
--
-- The Mastodon admin API serves reports to the OAuth admin (src/domain/reports.ts, R37): its moderation state goes on
-- the report, as Mastodon's Report keeps it.
--
--   action_taken_at              when the report was resolved; NULL while it is unresolved. The reporter's Report
--                                entity shows action_taken as action_taken_at IS NOT NULL.
--   action_taken_by_account_id   the account that resolved it (the admin), NULL while unresolved.
--   assigned_account_id          the account it is assigned to (the admin), or NULL.
--   updated_at                   the time of its last change by the admin; NULL reads as created_at.
--
-- The two account columns name local accounts and are set to NULL if one goes (a local account is never deleted: its
-- account row restricts the delete). No column has a CHECK, so adding them is a change of the schema alone, whatever
-- the number of reports.
--
-- The admin's list of reports (GET /api/v1/admin/reports) reads one state, unresolved or resolved, newest first, of
-- every report, of one reporter's or of one reported account's. Each has an index whose range is in id (rowid) order
-- for that state: reports_state, reports_account_state and reports_target_state. The last two lead with the columns
-- of reports_account and reports_target, which they replace: the reporter's foreign key and a remote account's purge
-- are served by them as before. The partial indexes on the two new account columns serve their foreign keys.
--
-- admin_actions is the moderation log: one row per admin write, by the OAuth admin through the Mastodon admin API
-- (actor 'oauth', with its account and client) or by the Access admin through /admin (actor 'access'), written in the
-- write's transaction (src/domain/moderation-log.ts). It names its targets by id without foreign keys, so a row
-- outlives what it names. The log keeps the newest 10,000 rows: each insert deletes at most 10 of the older ones.
--
-- Cost: the indexes read the reports only, which local users write; the ALTERs and the new table read nothing.
-- Measured on the benchmark store of test-bench/migration-cost.test.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags, 10,000 reports, 20 local accounts) in workerd's local Durable
-- Object SQLite: 2,297 ms for the upgrade of this file through the kernel (its bookmark, transaction and schema
-- verification), within the 5,000 ms each migration file may take.

ALTER TABLE reports ADD COLUMN action_taken_at TEXT;
ALTER TABLE reports ADD COLUMN action_taken_by_account_id TEXT REFERENCES local_accounts (account_id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN assigned_account_id TEXT REFERENCES local_accounts (account_id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN updated_at TEXT;

CREATE INDEX reports_state ON reports ((action_taken_at IS NULL));
CREATE INDEX reports_account_state ON reports (account_id, (action_taken_at IS NULL));
CREATE INDEX reports_target_state ON reports (target_account_id, (action_taken_at IS NULL));
DROP INDEX reports_account;
DROP INDEX reports_target;
CREATE INDEX reports_action_taken_by ON reports (action_taken_by_account_id) WHERE action_taken_by_account_id IS NOT NULL;
CREATE INDEX reports_assigned ON reports (assigned_account_id) WHERE assigned_account_id IS NOT NULL;

CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY,         -- the newest row is never pruned, so an id is never given twice
  actor TEXT NOT NULL CHECK (actor IN ('oauth', 'access')),
  account_id TEXT,                -- the OAuth admin's account, NULL for the Access admin
  client_id TEXT,                 -- the OAuth client it acted through, NULL for the Access admin
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at TEXT NOT NULL
);
