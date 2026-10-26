-- Kopje Store schema 0073: actor document revisions. Never edit after release (checksummed).
--
--   accounts.document_revision          an integer from 0 to 2^53 - 1, issued anew by the Store with every store of a
--                                       remote actor's document (src/domain/inbox.ts upsertRemoteActor): the value a
--                                       writer reads before it fetches the document and compares in the transaction
--                                       that stores it (ID-1). Every row the upgrade carries holds 0; local rows keep 0.
--   accounts_document_revision_insert   BEFORE INSERT and BEFORE UPDATE OF document_revision on accounts:
--   accounts_document_revision_update   RAISE(ABORT, 'accounts: document_revision past its stored bound') for a value
--                                       that is not an integer, or outside 0 to 2^53 - 1.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (documentRevisionPastBoundSql); the statements below are
-- the output of documentRevisionMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the column has a constant default and no CHECK, so adding it reads and rewrites no row; no index is made (the
-- column is read only with its row, by uri); the triggers read no row.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags and 200,000 boosts, 2,000,000 notifications, 20 local accounts) in
-- workerd's local Durable Object SQLite, the Store's foreign key check skipped as declared: 26 ms for the upgrade
-- of this file through the kernel, within the budget, at a load average of about 3.5.

ALTER TABLE accounts ADD COLUMN document_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER accounts_document_revision_insert BEFORE INSERT ON accounts
WHEN CASE WHEN typeof(NEW.document_revision) <> 'integer' THEN 1
	WHEN NEW.document_revision NOT BETWEEN 0 AND 9007199254740991 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: document_revision past its stored bound');
END;

CREATE TRIGGER accounts_document_revision_update BEFORE UPDATE OF document_revision ON accounts
WHEN CASE WHEN typeof(NEW.document_revision) <> 'integer' THEN 1
	WHEN NEW.document_revision NOT BETWEEN 0 AND 9007199254740991 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: document_revision past its stored bound');
END;
