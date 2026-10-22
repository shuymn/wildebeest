-- Kopje Store schema 0066: field verification. Never edit after release (checksummed).
--
--   local_accounts.links_due_at      NULL, or the earliest time (ms) a round may claim the account's links
--                                    (src/domain/field-links.ts): a non-negative integer.
--   local_accounts.links_hold_until  NULL, or the end of the last claim's hold (ms): its lease while it is open, then
--                                    the cooldown before the next claim. A non-negative integer.
--   local_accounts.links_claim       the claim token, incremented by each claim: a non-negative integer, default 0.
--   local_accounts.links_attempts    claims since the last finish, 0 to 2 (more than 0: a claim is open), default 0.
--   local_accounts.verified_links    NULL, or the field values verified by rel=me with their times: a JSON array of 1
--                                    to 4 [value, time] pairs of texts, a value 1 to 255 bytes of printable ASCII
--                                    once each, a time in the 24-byte ISO form, within 4,096 bytes and no NUL.
--   local_accounts_verified_links_insert  BEFORE INSERT and BEFORE UPDATE OF verified_links on local_accounts:
--   local_accounts_verified_links_update  RAISE(ABORT, 'local_accounts: verified_links past its stored bound') for any
--                                    other value.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (verifiedLinksPastBoundSql); the statements below are the
-- output of fieldVerificationMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: each of the four ALTERs with a CHECK scans the local accounts (an operator-sized table) to check it;
-- verified_links has no default or CHECK, so adding it reads no row; the triggers read no row. No index is made: a round's claim walks the local accounts
-- whose links are due (RES-6), as 0058's unlock acceptance cursor does.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 20 of them local) in workerd's
-- local Durable Object SQLite, the Store's foreign key check skipped as declared: 12 ms for the upgrade of this file
-- through the kernel, within the budget.

ALTER TABLE local_accounts ADD COLUMN links_due_at INTEGER
  CONSTRAINT links_due_at_time CHECK (links_due_at IS NULL OR (typeof(links_due_at) = 'integer' AND links_due_at >= 0));

ALTER TABLE local_accounts ADD COLUMN links_hold_until INTEGER
  CONSTRAINT links_hold_until_time CHECK (links_hold_until IS NULL OR (typeof(links_hold_until) = 'integer' AND links_hold_until >= 0));

ALTER TABLE local_accounts ADD COLUMN links_claim INTEGER NOT NULL DEFAULT 0
  CONSTRAINT links_claim_count CHECK (typeof(links_claim) = 'integer' AND links_claim >= 0);

ALTER TABLE local_accounts ADD COLUMN links_attempts INTEGER NOT NULL DEFAULT 0
  CONSTRAINT links_attempts_count CHECK (typeof(links_attempts) = 'integer' AND links_attempts BETWEEN 0 AND 2);

ALTER TABLE local_accounts ADD COLUMN verified_links TEXT;

CREATE TRIGGER local_accounts_verified_links_insert BEFORE INSERT ON local_accounts
WHEN CASE WHEN NEW.verified_links IS NULL THEN 0
	WHEN typeof(NEW.verified_links) <> 'text' THEN 1
	WHEN length(CAST(NEW.verified_links AS BLOB)) > 4096 THEN 1
	WHEN instr(CAST(NEW.verified_links AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.verified_links) THEN 1
	WHEN json_type(NEW.verified_links) <> 'array' THEN 1
	WHEN json_array_length(NEW.verified_links) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.verified_links) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN NOT (length(CAST(e.value ->> '$[0]' AS BLOB)) BETWEEN 1 AND 255
		AND instr(CAST(e.value ->> '$[0]' AS BLOB), x'00') = 0 AND e.value ->> '$[0]' NOT GLOB '*[^!-~]*') THEN 1
		WHEN (CASE WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) = 24 AND substr(e.value ->> '$[1]', 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', e.value ->> '$[1]') = e.value ->> '$[1]' THEN e.value ->> '$[1]' END) IS NULL THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.verified_links) e) <> json_array_length(NEW.verified_links) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'local_accounts: verified_links past its stored bound');
END;

CREATE TRIGGER local_accounts_verified_links_update BEFORE UPDATE OF verified_links ON local_accounts
WHEN CASE WHEN NEW.verified_links IS NULL THEN 0
	WHEN typeof(NEW.verified_links) <> 'text' THEN 1
	WHEN length(CAST(NEW.verified_links AS BLOB)) > 4096 THEN 1
	WHEN instr(CAST(NEW.verified_links AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.verified_links) THEN 1
	WHEN json_type(NEW.verified_links) <> 'array' THEN 1
	WHEN json_array_length(NEW.verified_links) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.verified_links) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN NOT (length(CAST(e.value ->> '$[0]' AS BLOB)) BETWEEN 1 AND 255
		AND instr(CAST(e.value ->> '$[0]' AS BLOB), x'00') = 0 AND e.value ->> '$[0]' NOT GLOB '*[^!-~]*') THEN 1
		WHEN (CASE WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) = 24 AND substr(e.value ->> '$[1]', 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', e.value ->> '$[1]') = e.value ->> '$[1]' THEN e.value ->> '$[1]' END) IS NULL THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.verified_links) e) <> json_array_length(NEW.verified_links) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'local_accounts: verified_links past its stored bound');
END;
