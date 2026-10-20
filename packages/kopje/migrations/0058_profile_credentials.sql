-- Kopje Store schema 0058: profile credentials. Never edit after release (checksummed).
--
--   accounts.indexable        NULL (a remote account not stored again since this migration), or the integer 0 or 1:
--                             Mastodon's Account#indexable, set by update_credentials and by every remote actor store.
--   accounts_indexable_insert BEFORE INSERT and BEFORE UPDATE OF indexable on accounts:
--   accounts_indexable_update RAISE(ABORT, 'accounts: indexable past its stored bound') for any other value.
--   local_accounts.accept_requests_after   the unlock acceptance cursor (src/domain/unlock-accepts.ts): NULL for no
--                             job, else the last follows.id the job has passed, a non-negative integer.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (indexablePastBoundSql); the statements below are the output
-- of profileBoundsMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: accounts.indexable has no default or CHECK, so adding it reads no row; the triggers read no row; the cursor's
-- CHECK reads the local accounts once.

ALTER TABLE accounts ADD COLUMN indexable INTEGER;

ALTER TABLE local_accounts ADD COLUMN accept_requests_after INTEGER
  CONSTRAINT accept_requests_after_cursor CHECK (accept_requests_after IS NULL
    OR (typeof(accept_requests_after) = 'integer' AND accept_requests_after >= 0));

CREATE TRIGGER accounts_indexable_insert BEFORE INSERT ON accounts
WHEN CASE WHEN NEW.indexable IS NULL THEN 0
	WHEN typeof(NEW.indexable) <> 'integer' THEN 1
	WHEN NEW.indexable NOT IN (0, 1) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: indexable past its stored bound');
END;

CREATE TRIGGER accounts_indexable_update BEFORE UPDATE OF indexable ON accounts
WHEN CASE WHEN NEW.indexable IS NULL THEN 0
	WHEN typeof(NEW.indexable) <> 'integer' THEN 1
	WHEN NEW.indexable NOT IN (0, 1) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: indexable past its stored bound');
END;
