-- Kopje Store schema 0072: instance activity (Mastodon 4.5's ActivityTracker for GET /api/v1/instance/activity).
-- Never edit after release (checksummed).
--
--   activity_counts               per kind ('statuses': local public and unlisted statuses and boosts created;
--                                 'registrations': local accounts set up) and UTC day YYYY-MM-DD, the day's count, an
--                                 integer from 1 to 1e12 (src/domain/instance-activity.ts).
--   activity_logins               per UTC day, the local accounts with a login that day (an authenticated request,
--                                 or the setup), as 18-digit ids. No foreign key: a day's rows expire with retention.
--   instance_settings_activity_insert   BEFORE INSERT and BEFORE UPDATE OF name, value on instance_settings:
--   instance_settings_activity_update   RAISE(ABORT, 'instance_settings: a value past its stored bound') for an
--                                 activity_api_enabled that is not 'true' or 'false'.
--   instance_settings             an existing activity_api_enabled row that is neither is deleted first, so it reads
--                                 as absent (on); none is rewritten.
--
-- Bounds: src/platform/stored-bounds.ts (ACTIVITY_SETTING_BOUNDS, ACTIVITY_VALUE_MAX); the statements below are the
-- output of activityMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md. No CHECK
-- or trigger reads the time.
--
-- Cost: the tables are new and empty, the DELETE seeks one instance_settings row by its key, and the triggers read no
-- row. Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags and 200,000 boosts, 2,000,000 notifications, 20 local accounts) in
-- workerd's local Durable Object SQLite, with the whole Store's foreign keys verified (the file creates tables, so it
-- is not declared foreignKeys: 'unchanged'): 5,889 ms for the upgrade of this file through the kernel, within the
-- budget, at a load average of about 2.

CREATE TABLE activity_counts (
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (kind, day),
  CONSTRAINT activity_counts_kind CHECK (kind IN ('statuses', 'registrations')),
  CONSTRAINT activity_counts_day CHECK (typeof(day) = 'text'
    AND length(CAST(day AS BLOB)) = 10 AND instr(CAST(day AS BLOB), x'00') = 0
    AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(day) IS day),
  CONSTRAINT activity_counts_value CHECK (typeof(value) = 'integer' AND value BETWEEN 1 AND 1000000000000)
) WITHOUT ROWID;

CREATE TABLE activity_logins (
  day TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (day, account_id),
  CONSTRAINT activity_logins_day CHECK (typeof(day) = 'text'
    AND length(CAST(day AS BLOB)) = 10 AND instr(CAST(day AS BLOB), x'00') = 0
    AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(day) IS day),
  CONSTRAINT activity_logins_account_id CHECK (typeof(account_id) = 'text'
    AND length(CAST(account_id AS BLOB)) = 18 AND instr(CAST(account_id AS BLOB), x'00') = 0
    AND account_id NOT GLOB '*[^0-9]*')
) WITHOUT ROWID;

DELETE FROM instance_settings
WHERE name = 'activity_api_enabled' AND value IS NOT 'true' AND value IS NOT 'false';

-- 0049's triggers end in ELSE 0, and 0057's and 0059's name other settings; these bound activity_api_enabled.

CREATE TRIGGER instance_settings_activity_insert BEFORE INSERT ON instance_settings
WHEN NEW.name = 'activity_api_enabled' AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;

CREATE TRIGGER instance_settings_activity_update BEFORE UPDATE OF name, value ON instance_settings
WHEN NEW.name = 'activity_api_enabled' AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;
