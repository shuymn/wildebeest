-- Kopje Store schema 0062: account warnings (Mastodon's AccountWarning, the strike of an admin account action). Never
-- edit after release (checksummed).
--
--   account_warnings          the warnings an admin action of type none gave a local account that Mastodon would
--                             notify of (src/domain/account-warnings.ts): the action, the text as sent, a copy of the
--                             named report's status_ids. It goes with its local account (ON DELETE CASCADE).
--   account_warnings_target   serves that foreign key.
--   account_warnings_status_ids_insert  BEFORE INSERT and BEFORE UPDATE OF status_ids on account_warnings:
--   account_warnings_status_ids_update  RAISE(ABORT, 'account_warnings: status_ids past its stored bound') for
--                             status_ids that are not NULL or a JSON array of at most 100 18-digit ids as TEXT.
--   notifications.account_warning_id   the warning a moderation_warning notification is about, NULL for every other
--                             type. It goes with its warning (ON DELETE CASCADE).
--   notifications_account_warning      one notification per warning (LocalNotificationWorker keys a notification by
--                             its activity, the warning); it also serves the foreign key, whose `account_warning_id = ?`
--                             implies its predicate. 0063 adds the warning to the natural key.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (WARNING_TEXT_BYTES, warningStatusIdsCheckSql,
-- warningStatusIdsPastBoundSql); the statements below are the output of accountWarningsMigrationSql
-- (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: an empty table with its index and triggers, which read no row; the ALTER is a change of the schema alone; the
-- partial index reads each notification once and holds none.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000
-- statuses with their mentions and tags, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts)
-- in workerd's local Durable Object SQLite, with the whole Store's foreign keys verified:
-- 5,969 ms for the upgrade of this file through the kernel (6,077 ms in a second run), within the budget.

CREATE TABLE account_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  action TEXT NOT NULL CONSTRAINT account_warning_action CHECK (action = 'none'),
  text TEXT NOT NULL DEFAULT '' CONSTRAINT account_warning_text_within_10000_bytes
    CHECK (typeof(text) = 'text' AND length(CAST(text AS BLOB)) <= 10000
      AND instr(CAST(text AS BLOB), x'00') = 0),
  status_ids TEXT
    CONSTRAINT account_warning_status_ids_within_100_ids_and_2101_bytes
    CHECK (status_ids IS NULL OR (typeof(status_ids) = 'text'
      AND length(CAST(status_ids AS BLOB)) <= 2101 AND instr(CAST(status_ids AS BLOB), x'00') = 0
      AND json_valid(status_ids) AND json_type(status_ids) = 'array'
      AND json_array_length(status_ids) <= 100)),
  created_at TEXT NOT NULL CONSTRAINT account_warning_created_at_iso
    CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE INDEX account_warnings_target ON account_warnings (target_account_id);

CREATE TRIGGER account_warnings_status_ids_insert BEFORE INSERT ON account_warnings
WHEN CASE WHEN NEW.status_ids IS NULL THEN 0
	WHEN typeof(NEW.status_ids) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_ids AS BLOB)) > 2101 THEN 1
	WHEN instr(CAST(NEW.status_ids AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.status_ids) THEN 1
	WHEN json_type(NEW.status_ids) <> 'array' THEN 1
	WHEN json_array_length(NEW.status_ids) > 100 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.status_ids) e WHERE e.type <> 'text'
		OR length(CAST(e.value AS BLOB)) <> 18 OR e.value GLOB '*[^0-9]*') THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'account_warnings: status_ids past its stored bound');
END;

CREATE TRIGGER account_warnings_status_ids_update BEFORE UPDATE OF status_ids ON account_warnings
WHEN CASE WHEN NEW.status_ids IS NULL THEN 0
	WHEN typeof(NEW.status_ids) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_ids AS BLOB)) > 2101 THEN 1
	WHEN instr(CAST(NEW.status_ids AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.status_ids) THEN 1
	WHEN json_type(NEW.status_ids) <> 'array' THEN 1
	WHEN json_array_length(NEW.status_ids) > 100 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.status_ids) e WHERE e.type <> 'text'
		OR length(CAST(e.value AS BLOB)) <> 18 OR e.value GLOB '*[^0-9]*') THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'account_warnings: status_ids past its stored bound');
END;

ALTER TABLE notifications ADD COLUMN account_warning_id INTEGER REFERENCES account_warnings (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX notifications_account_warning ON notifications (account_warning_id)
  WHERE account_warning_id IS NOT NULL;
