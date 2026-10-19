-- Kopje Store schema 0054: remote reports. Never edit after release (checksummed).
--
-- An inbound Flag files a report by a remote account (src/domain/reports.ts fileRemoteReports, R34, ID-6, ID-7), so
-- reports is rebuilt with:
--
--   account_id                   the reporter, any account (accounts.id): a remote report's is the Flag's actor.
--   UNIQUE (uri, target_account_id)  one report per Flag id and reported account (a Flag may name several accounts;
--                                its redelivery writes nothing). A local report's uri is its own Flag id, as before.
--   id AUTOINCREMENT             a report id is never given twice. The counter starts above every retained reference
--                                to a report id: the reports, the moderation log's Report targets (those that spell a
--                                signed 64-bit integer, leading zeros allowed; no other names a report) and both job
--                                tables' report_bound. Dumps restore it by name (sqlite_sequence).
--   report_uri_within_4096_json_bytes        uri within ACTIVITY_ID_LIMIT (4,096 JSON-escaped UTF-8 bytes,
--                                withinIdentityBound; 682 raw bytes cannot escape past it).
--   report_comment_within_20000_bytes        comment within 20,000 UTF-8 bytes and, up to its first NUL (SQLite's
--                                length), 5,000 code points (RES-2; the writers bound the code points with NULs too).
--   report_status_ids_within_100_ids_and_2101_bytes  status_ids a JSON array of at most MAX_REPORT_STATUSES ids,
--                                within 2,101 UTF-8 bytes: 100 status ids (18-digit snowflakes, 0000_initial) of 20
--                                bytes quoted, 99 commas and the brackets, as JSON.stringify writes them.
--   reports_pair_state           a reported account's reports by reporter and state: the admin's list filtered by
--                                both (listAdminReports) and a local suspension's walk of its reporters.
--
-- Rebuilding a parent table would delete its children (0000_initial): notifications.report_id cascades from reports
-- (0040) and push_deliveries from notifications, and DROP TABLE deletes its rows first. So the file first fails, before
-- any write, unless every notification naming a report is an admin.report and no local account holds a type in the
-- tag range; then detaches each report notification (report_id NULL, its type 'admin.report#<report id>', which keeps
-- notifications_natural unique), copies the reports with their ids, drops and renames (no child names the new table,
-- so no reference is rewritten), and relinks the notifications. Nothing is lost: every row and id is kept, and a
-- failing statement rolls the whole file back with its kopje_migrations row (src/platform/store-kernel.ts).
--
-- Cost: the guard reads the report notifications (notifications_report) and one empty range per local account; the
-- detach and the relink write each report notification once; the copy, the drop and the six indexes read the reports;
-- the counter scans the moderation log (at most MODERATION_LOG_KEEP rows) and both job tables, which no index covers.
-- Nothing reads the other notifications (test/migrations.test.ts, 0054). Measured on the benchmark store of
-- test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 notifications, 10,000 reports each with its admin.report
-- and 1,000 pushes of them, 10,000 moderation log rows, 180 local and 11,001 remote moderation jobs, and the rest of
-- that store) in workerd's local Durable Object SQLite, timing the whole upgrade through the kernel: 8,959 and 8,607 ms
-- at load averages of 3.8 to 4.8, within the 20,000 ms an upgrade may take.

CREATE TABLE reports_0054_check (
  n INTEGER CONSTRAINT report_notifications_are_admin_reports CHECK (n = 0)
);

INSERT INTO reports_0054_check
SELECT count(*) FROM notifications INDEXED BY notifications_report
WHERE report_id IS NOT NULL AND type <> 'admin.report';

INSERT INTO reports_0054_check
SELECT count(*) FROM notifications
WHERE account_id IN (SELECT account_id FROM local_accounts) AND type >= 'admin.report#' AND type < 'admin.report$';

DROP TABLE reports_0054_check;

UPDATE notifications SET type = 'admin.report#' || report_id, report_id = NULL WHERE report_id IS NOT NULL;

CREATE TABLE reports_0054 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status_ids TEXT NOT NULL DEFAULT '[]' CONSTRAINT report_status_ids_within_100_ids_and_2101_bytes
    CHECK (length(CAST(status_ids AS BLOB)) <= 2101 AND json_valid(status_ids) AND json_type(status_ids) = 'array'
      AND json_array_length(status_ids) <= 100),
  comment TEXT NOT NULL DEFAULT '' CONSTRAINT report_comment_within_20000_bytes
    CHECK (length(CAST(comment AS BLOB)) <= 20000 AND length(comment) <= 5000),
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('other', 'spam', 'legal', 'violation')),
  rule_ids TEXT CHECK (rule_ids IS NULL OR (json_valid(rule_ids) AND json_type(rule_ids) = 'array')),
  forwarded INTEGER NOT NULL DEFAULT 0 CHECK (forwarded IN (0, 1)),
  uri TEXT NOT NULL CONSTRAINT report_uri_within_4096_json_bytes
    CHECK (length(CAST(uri AS BLOB)) <= 682 OR length(CAST(json_quote(uri) AS BLOB)) <= 4098),
  created_at TEXT NOT NULL,
  action_taken_at TEXT,
  action_taken_by_account_id TEXT REFERENCES local_accounts (account_id) ON DELETE SET NULL,
  assigned_account_id TEXT REFERENCES local_accounts (account_id) ON DELETE SET NULL,
  updated_at TEXT,
  last_action_id INTEGER,
  UNIQUE (uri, target_account_id)
);

INSERT INTO reports_0054 (id, account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri,
  created_at, action_taken_at, action_taken_by_account_id, assigned_account_id, updated_at, last_action_id)
SELECT id, account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri,
  created_at, action_taken_at, action_taken_by_account_id, assigned_account_id, updated_at, last_action_id
FROM reports ORDER BY id;

DROP TABLE reports;

ALTER TABLE reports_0054 RENAME TO reports;

DELETE FROM sqlite_sequence WHERE name = 'reports';

INSERT INTO sqlite_sequence (name, seq)
SELECT 'reports', max(n) FROM (
  SELECT max(id) AS n FROM reports
  UNION ALL SELECT max(CAST(target_id AS INTEGER)) FROM admin_actions
    WHERE target_type = 'Report' AND target_id <> '' AND target_id NOT GLOB '*[^0-9]*'
      AND (length(ltrim(target_id, '0')) < 19
        OR (length(ltrim(target_id, '0')) = 19 AND ltrim(target_id, '0') <= '9223372036854775807'))
  UNION ALL SELECT max(report_bound) FROM moderation_jobs
  UNION ALL SELECT max(report_bound) FROM remote_moderation_jobs
) HAVING max(n) IS NOT NULL;

CREATE INDEX reports_state ON reports ((action_taken_at IS NULL));
CREATE INDEX reports_account_state ON reports (account_id, (action_taken_at IS NULL));
CREATE INDEX reports_target_state ON reports (target_account_id, (action_taken_at IS NULL));
CREATE INDEX reports_pair_state ON reports (target_account_id, account_id, (action_taken_at IS NULL));
CREATE INDEX reports_action_taken_by ON reports (action_taken_by_account_id) WHERE action_taken_by_account_id IS NOT NULL;
CREATE INDEX reports_assigned ON reports (assigned_account_id) WHERE assigned_account_id IS NOT NULL;

UPDATE notifications SET report_id = CAST(substr(type, 14) AS INTEGER), type = 'admin.report'
WHERE account_id IN (SELECT account_id FROM local_accounts) AND type > 'admin.report#' AND type < 'admin.report$';
