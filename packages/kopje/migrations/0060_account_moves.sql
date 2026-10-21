-- Kopje Store schema 0060: account moves. Never edit after release (checksummed).
--
--   accounts.moved_to_account_id   NULL, or the 18-digit id of another account: Mastodon's Account#moved_to_account_id,
--                             set on a remote row from its actor document's movedTo and by a verified Move. No foreign
--                             key holds it; a remote account's purge clears the references to it before the row goes.
--   accounts_moved_to         the partial index of the rows that hold one, which that purge seeks them through.
--   accounts_moved_to_insert  BEFORE INSERT and BEFORE UPDATE OF moved_to_account_id, domain on accounts:
--   accounts_moved_to_update  RAISE(ABORT, 'accounts: moved_to_account_id past its stored bound') for any other value,
--                             the row's own id, or a local row.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (movedToPastBoundSql); the statements below are the output
-- of accountMovesMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the column has no default or CHECK, so adding it reads no row; the index reads every accounts row once, and
-- holds none of them (every row is NULL); the triggers read no row.

ALTER TABLE accounts ADD COLUMN moved_to_account_id TEXT;

CREATE INDEX accounts_moved_to ON accounts (moved_to_account_id) WHERE moved_to_account_id IS NOT NULL;

CREATE TRIGGER accounts_moved_to_insert BEFORE INSERT ON accounts
WHEN CASE WHEN NEW.moved_to_account_id IS NULL THEN 0
	WHEN typeof(NEW.moved_to_account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.moved_to_account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.moved_to_account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.moved_to_account_id GLOB '*[^0-9]*' THEN 1
	WHEN NEW.moved_to_account_id = NEW.id THEN 1
	WHEN NEW.domain IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: moved_to_account_id past its stored bound');
END;

CREATE TRIGGER accounts_moved_to_update BEFORE UPDATE OF moved_to_account_id, domain ON accounts
WHEN CASE WHEN NEW.moved_to_account_id IS NULL THEN 0
	WHEN typeof(NEW.moved_to_account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.moved_to_account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.moved_to_account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.moved_to_account_id GLOB '*[^0-9]*' THEN 1
	WHEN NEW.moved_to_account_id = NEW.id THEN 1
	WHEN NEW.domain IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: moved_to_account_id past its stored bound');
END;
