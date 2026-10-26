-- Kopje Store schema 0077: field link checks. Never edit after release (checksummed).
--
--   local_accounts.unverified_links          NULL, or the field values a link check checked and did not verify since
--                                            the last save (src/domain/field-links.ts), left out of the next claims
--                                            until a save clears the column: a JSON array of 1 to 4 distinct texts,
--                                            each 1 to 255 bytes of printable ASCII once decoded, within 4,096 bytes
--                                            and no NUL. Every row the upgrade carries holds NULL.
--   local_accounts_unverified_links_insert   BEFORE INSERT and BEFORE UPDATE OF unverified_links on local_accounts:
--   local_accounts_unverified_links_update   RAISE(ABORT, 'local_accounts: unverified_links past its stored bound')
--                                            for any other value.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (unverifiedLinksPastBoundSql); the statements below are
-- the output of fieldLinkChecksMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the column has no default or CHECK, so adding it reads and rewrites no row; no index is made (the column is
-- read only with its row, by account id); the triggers read no row.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 20 of them local) in workerd's
-- local Durable Object SQLite, the Store's foreign key check skipped as declared: COST_MS ms for the upgrade of this
-- file through the kernel, within the budget, at a load average of about LOAD.

ALTER TABLE local_accounts ADD COLUMN unverified_links TEXT;

CREATE TRIGGER local_accounts_unverified_links_insert BEFORE INSERT ON local_accounts
WHEN CASE WHEN NEW.unverified_links IS NULL THEN 0
	WHEN typeof(NEW.unverified_links) <> 'text' THEN 1
	WHEN length(CAST(NEW.unverified_links AS BLOB)) > 4096 THEN 1
	WHEN instr(CAST(NEW.unverified_links AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.unverified_links) THEN 1
	WHEN json_type(NEW.unverified_links) <> 'array' THEN 1
	WHEN json_array_length(NEW.unverified_links) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.unverified_links) e WHERE e.type <> 'text' OR NOT (length(CAST(e.value AS BLOB)) BETWEEN 1 AND 255
		AND instr(CAST(e.value AS BLOB), x'00') = 0 AND e.value NOT GLOB '*[^!-~]*')) THEN 1
	WHEN (SELECT count(DISTINCT e.value) FROM json_each(NEW.unverified_links) e) <> json_array_length(NEW.unverified_links) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'local_accounts: unverified_links past its stored bound');
END;

CREATE TRIGGER local_accounts_unverified_links_update BEFORE UPDATE OF unverified_links ON local_accounts
WHEN CASE WHEN NEW.unverified_links IS NULL THEN 0
	WHEN typeof(NEW.unverified_links) <> 'text' THEN 1
	WHEN length(CAST(NEW.unverified_links AS BLOB)) > 4096 THEN 1
	WHEN instr(CAST(NEW.unverified_links AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.unverified_links) THEN 1
	WHEN json_type(NEW.unverified_links) <> 'array' THEN 1
	WHEN json_array_length(NEW.unverified_links) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.unverified_links) e WHERE e.type <> 'text' OR NOT (length(CAST(e.value AS BLOB)) BETWEEN 1 AND 255
		AND instr(CAST(e.value AS BLOB), x'00') = 0 AND e.value NOT GLOB '*[^!-~]*')) THEN 1
	WHEN (SELECT count(DISTINCT e.value) FROM json_each(NEW.unverified_links) e) <> json_array_length(NEW.unverified_links) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'local_accounts: unverified_links past its stored bound');
END;
