-- Kopje Store schema 0068: verification of remote accounts' profile links (Mastodon 4.5's Account::Field#verified_at
-- for a remote account). Never edit after release (checksummed).
--
--   remote_field_links         one row per remote account with a field link to verify
--                              (src/domain/remote-field-links.ts): its link back, the links of its first shown fields
--                              with what the round found, the generation that fences a claim across a change, and the
--                              round's scheduling (due_at and armed_at set while a check is pending, the claim token,
--                              attempts, the hold and the last negative check). It goes with its account (ON DELETE
--                              CASCADE); its primary key serves that foreign key.
--   remote_field_links_due     the armed rows by (due_at, account_id): the round's walk.
--   remote_field_links_expiry  the armed rows by armed_at: their expiry after a day.
--   remote_field_links_bounds_insert  BEFORE INSERT and BEFORE UPDATE of every column on remote_field_links:
--   remote_field_links_bounds_update  RAISE(ABORT, 'remote_field_links: a value past its stored bound') for a value
--                              past its bound, judged in order: the storage classes, the raw bytes, a raw NUL,
--                              json_valid and the canonical form of links, its shape and types, each decoded element
--                              (an href of 1 to 1,016 bytes of printable ASCII, https://, none of "<>\^`{|}; a 24-byte
--                              ISO time), then the invariants and the counters. No trigger writes.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (REMOTE_FIELD_LINKS_BYTES, 4,213 bytes;
-- REMOTE_VERIFIED_SHOWN, 4 entries; remoteFieldLinkRowPastBoundSql); the statements below are the output of
-- remoteFieldLinksMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md. No row is
-- backfilled: an account is armed at its next store.
--
-- Cost: an empty table with its indexes and triggers, which read no row.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000
-- statuses with their mentions and tags, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts)
-- in workerd's local Durable Object SQLite, with the whole Store's foreign keys verified (the file creates a table, so
-- it is not declared foreignKeys: 'unchanged'): 6,608 ms for the upgrade of this file through the kernel, within
-- the budget.

CREATE TABLE remote_field_links (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  link_back TEXT NOT NULL,
  links TEXT NOT NULL,
  generation INTEGER NOT NULL,
  claim INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,
  armed_at INTEGER,
  hold_until INTEGER,
  checked_at INTEGER,
  CONSTRAINT remote_field_links_armed CHECK ((due_at IS NULL) = (armed_at IS NULL))
) WITHOUT ROWID;

CREATE INDEX remote_field_links_due ON remote_field_links (due_at, account_id) WHERE due_at IS NOT NULL;

CREATE INDEX remote_field_links_expiry ON remote_field_links (armed_at) WHERE due_at IS NOT NULL;

CREATE TRIGGER remote_field_links_bounds_insert BEFORE INSERT ON remote_field_links
WHEN CASE WHEN typeof(NEW.account_id) <> 'text' OR typeof(NEW.link_back) <> 'text'
		OR typeof(NEW.links) <> 'text' THEN 1
	WHEN length(CAST(NEW.account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.account_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.link_back) <> 'text' THEN 1
	WHEN length(CAST(NEW.link_back AS BLOB)) NOT BETWEEN 1 AND 2048 THEN 1
	WHEN instr(CAST(NEW.link_back AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.link_back GLOB '*[^!-~]*' THEN 1
	WHEN NOT (NEW.link_back GLOB 'https://?*' OR NEW.link_back GLOB 'http://?*') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.links) <> 'text' THEN 1
	WHEN length(CAST(NEW.links AS BLOB)) > 4213 THEN 1
	WHEN instr(CAST(NEW.links AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.links) THEN 1
	WHEN CAST(json(NEW.links) AS BLOB) <> CAST(NEW.links AS BLOB) OR instr(NEW.links, '\') > 0 THEN 1
	WHEN json_type(NEW.links) <> 'array' THEN 1
	WHEN json_array_length(NEW.links) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.links) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 4 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'integer' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN json_type(e.value, '$[2]') NOT IN ('null', 'text') OR json_type(e.value, '$[3]') <> 'integer' THEN 1
		ELSE 0 END) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.links) e WHERE CASE WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) NOT BETWEEN 1 AND 1016 THEN 1
	WHEN instr(CAST(e.value ->> '$[1]' AS BLOB), x'00') > 0 THEN 1
	WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' THEN 1
	WHEN e.value ->> '$[1]' GLOB '*["<>\^`{|}]*' THEN 1
	WHEN e.value ->> '$[1]' NOT GLOB 'https://?*' THEN 1
		WHEN json_type(e.value, '$[2]') = 'text' AND (CASE WHEN length(CAST(e.value ->> '$[2]' AS BLOB)) = 24 AND substr(e.value ->> '$[2]', 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', e.value ->> '$[2]') = e.value ->> '$[2]' THEN e.value ->> '$[2]' END) IS NULL THEN 1
		ELSE 0 END) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.links) e WHERE CASE WHEN e.value ->> '$[0]' NOT BETWEEN 0 AND 15 THEN 1
		WHEN e.value ->> '$[3]' NOT IN (0, 1) THEN 1
		WHEN json_type(e.value, '$[2]') = 'text' AND e.value ->> '$[3]' <> 1 THEN 1
		WHEN e.key > 0 AND e.value ->> '$[0]' <= (NEW.links ->> ('$[' || (e.key - 1) || '][0]')) THEN 1
		ELSE 0 END) THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.armed_at IS NOT NULL AND (typeof(NEW.armed_at) <> 'integer' OR NEW.armed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.hold_until IS NOT NULL AND (typeof(NEW.hold_until) <> 'integer' OR NEW.hold_until NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.checked_at IS NOT NULL AND (typeof(NEW.checked_at) <> 'integer' OR NEW.checked_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_field_links: a value past its stored bound');
END;

CREATE TRIGGER remote_field_links_bounds_update BEFORE UPDATE OF account_id, link_back, links, generation, claim, attempts, due_at, armed_at, hold_until, checked_at ON remote_field_links
WHEN CASE WHEN typeof(NEW.account_id) <> 'text' OR typeof(NEW.link_back) <> 'text'
		OR typeof(NEW.links) <> 'text' THEN 1
	WHEN length(CAST(NEW.account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.account_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.link_back) <> 'text' THEN 1
	WHEN length(CAST(NEW.link_back AS BLOB)) NOT BETWEEN 1 AND 2048 THEN 1
	WHEN instr(CAST(NEW.link_back AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.link_back GLOB '*[^!-~]*' THEN 1
	WHEN NOT (NEW.link_back GLOB 'https://?*' OR NEW.link_back GLOB 'http://?*') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.links) <> 'text' THEN 1
	WHEN length(CAST(NEW.links AS BLOB)) > 4213 THEN 1
	WHEN instr(CAST(NEW.links AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.links) THEN 1
	WHEN CAST(json(NEW.links) AS BLOB) <> CAST(NEW.links AS BLOB) OR instr(NEW.links, '\') > 0 THEN 1
	WHEN json_type(NEW.links) <> 'array' THEN 1
	WHEN json_array_length(NEW.links) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.links) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 4 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'integer' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN json_type(e.value, '$[2]') NOT IN ('null', 'text') OR json_type(e.value, '$[3]') <> 'integer' THEN 1
		ELSE 0 END) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.links) e WHERE CASE WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) NOT BETWEEN 1 AND 1016 THEN 1
	WHEN instr(CAST(e.value ->> '$[1]' AS BLOB), x'00') > 0 THEN 1
	WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' THEN 1
	WHEN e.value ->> '$[1]' GLOB '*["<>\^`{|}]*' THEN 1
	WHEN e.value ->> '$[1]' NOT GLOB 'https://?*' THEN 1
		WHEN json_type(e.value, '$[2]') = 'text' AND (CASE WHEN length(CAST(e.value ->> '$[2]' AS BLOB)) = 24 AND substr(e.value ->> '$[2]', 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', e.value ->> '$[2]') = e.value ->> '$[2]' THEN e.value ->> '$[2]' END) IS NULL THEN 1
		ELSE 0 END) THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.links) e WHERE CASE WHEN e.value ->> '$[0]' NOT BETWEEN 0 AND 15 THEN 1
		WHEN e.value ->> '$[3]' NOT IN (0, 1) THEN 1
		WHEN json_type(e.value, '$[2]') = 'text' AND e.value ->> '$[3]' <> 1 THEN 1
		WHEN e.key > 0 AND e.value ->> '$[0]' <= (NEW.links ->> ('$[' || (e.key - 1) || '][0]')) THEN 1
		ELSE 0 END) THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.armed_at IS NOT NULL AND (typeof(NEW.armed_at) <> 'integer' OR NEW.armed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.hold_until IS NOT NULL AND (typeof(NEW.hold_until) <> 'integer' OR NEW.hold_until NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.checked_at IS NOT NULL AND (typeof(NEW.checked_at) <> 'integer' OR NEW.checked_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_field_links: a value past its stored bound');
END;
