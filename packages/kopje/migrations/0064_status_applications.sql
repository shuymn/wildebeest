-- Kopje Store schema 0064: status applications. Never edit after release (checksummed).
--
--   statuses.application_id      NULL, or the client_id of the app a local original was posted through: Mastodon's
--                             Status#application_id. No foreign key holds it, as in Mastodon: removing an app writes
--                             no status row, and an id whose app is gone reads as no app.
--   statuses_application_insert  BEFORE INSERT and BEFORE UPDATE OF application_id, reblog_of_id, account_id on
--   statuses_application_update  statuses: RAISE(ABORT, 'statuses: application_id past its stored bound') for a value
--                             of another storage class, outside 1 to 64 bytes, with a NUL or a character outside
--                             base64url, on a boost, or by a remote author.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (applicationIdPastBoundSql); the statements below are the
-- output of statusApplicationsMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the column has no default or CHECK, so adding it reads no row, and every existing row holds NULL, within the
-- bound; no index is made (nothing looks a status up by its app); the triggers read no row.
-- Measured on the benchmark store of test/bench/migration-cost.ts: BENCH ms for the upgrade of this file through the
-- kernel.

ALTER TABLE statuses ADD COLUMN application_id TEXT;

CREATE TRIGGER statuses_application_insert BEFORE INSERT ON statuses
WHEN CASE WHEN NEW.application_id IS NULL THEN 0
	WHEN typeof(NEW.application_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.application_id AS BLOB)) NOT BETWEEN 1 AND 64 THEN 1
	WHEN instr(CAST(NEW.application_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.application_id GLOB '*[^0-9A-Za-z_-]*' THEN 1
	WHEN NEW.reblog_of_id IS NOT NULL THEN 1
	WHEN (SELECT a.domain FROM accounts a WHERE a.id = NEW.account_id) IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: application_id past its stored bound');
END;

CREATE TRIGGER statuses_application_update BEFORE UPDATE OF application_id, reblog_of_id, account_id ON statuses
WHEN CASE WHEN NEW.application_id IS NULL THEN 0
	WHEN typeof(NEW.application_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.application_id AS BLOB)) NOT BETWEEN 1 AND 64 THEN 1
	WHEN instr(CAST(NEW.application_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.application_id GLOB '*[^0-9A-Za-z_-]*' THEN 1
	WHEN NEW.reblog_of_id IS NOT NULL THEN 1
	WHEN (SELECT a.domain FROM accounts a WHERE a.id = NEW.account_id) IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: application_id past its stored bound');
END;
