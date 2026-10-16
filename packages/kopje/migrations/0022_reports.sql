-- Kopje Store schema 0022: reports. Never edit after release (checksummed).
--
-- reports holds the reports a local account made of an account (Mastodon's Report, POST /api/v1/reports,
-- src/domain/reports.ts): the reporter, the reported account, the reported statuses, the comment, the category, the
-- instance rules it names and whether it was forwarded to the reported account's server. id is its API id. uri is the
-- id of the Flag that forwards it, unique to the report whether or not it was sent.
--
-- status_ids is a JSON array of status ids, as Mastodon's reports.status_ids is an array without a foreign key: a
-- reported status that is deleted later stays named in the report, as Mastodon keeps it (Report#statuses reads them
-- with_discarded). rule_ids is a JSON array of the ids GET /api/v1/instance/rules answers, or NULL when it names none.
--
-- A report goes with its reporter, and with the reported account: a remote account's purge deletes the reports of it
-- in its batches (purgeRelationships in src/domain/inbox.ts, PURGED_ACCOUNT_CHILDREN), as Mastodon's
-- DeleteAccountService destroys an account's targeted_reports. The index by reported account serves the purge.
--
-- The file only creates an empty table: its work does not grow with the Store.

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(status_ids) AND json_type(status_ids) = 'array'),
  comment TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('other', 'spam', 'legal', 'violation')),
  rule_ids TEXT CHECK (rule_ids IS NULL OR (json_valid(rule_ids) AND json_type(rule_ids) = 'array')),
  forwarded INTEGER NOT NULL DEFAULT 0 CHECK (forwarded IN (0, 1)),
  uri TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX reports_account ON reports (account_id);
CREATE INDEX reports_target ON reports (target_account_id);
