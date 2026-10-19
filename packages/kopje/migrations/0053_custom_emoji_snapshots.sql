-- Kopje Store schema 0053: remote custom emoji snapshots. Never edit after release (checksummed).
--
-- RES-2: each status, earlier version and account may hold the custom emoji its object tagged, as a bounded snapshot.
-- Bounds, the predicate and its JS twin (emojisValid): src/platform/stored-bounds.ts (EMOJI_COLUMNS); the writer and
-- presenter: src/domain/custom-emojis.ts; the stored form: docs/dump-format.md. It adds:
--
--   statuses.emojis, status_edits.emojis, accounts.emojis   NULL, or a JSON array of 1 to 64 [shortcode, url] pairs:
--                            a shortcode of 1 to 128 of A-Z a-z 0-9 _ + -, once each; a url http(s), of at most 512
--                            bytes of '!' to '~' but '"' and '\'; the presented entries within 12,288 bytes (6,144 for
--                            an account), and the stored text within the same bytes, with no NUL anywhere.
--   <table>_emojis_insert    BEFORE INSERT and BEFORE UPDATE OF emojis on the three tables:
--   <table>_emojis_update    RAISE(ABORT, '<table>: emojis past their stored bound') for any other value.
--
-- The columns have no default or CHECK, so adding them reads no row; existing rows read NULL (no emoji). The
-- statements below are the output of emojiBoundsMigrationSql (test/migrations.test.ts compares them).
--
-- Cost: three schema-only column additions and six triggers, which read no row. Measured under concurrent load on
-- the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 statuses, 100,000 earlier
-- versions and the rest of that store) in workerd's local Durable Object SQLite, timing the whole upgrade through the
-- kernel (its verification included): this file alone 6,537 and 6,465 ms (load averages 4 to 12). The release range
-- 0049_instance_bounds to this file, in one upgrade: 8,447 to 32,791 ms over seven runs at load averages of 3.5 to 10,
-- four past the 20,000 ms an upgrade may take; 0049 to 0052 alone measured 8,544 to 25,714 ms the same way. The
-- serial release-range run is pending.

ALTER TABLE statuses ADD COLUMN emojis TEXT;

ALTER TABLE status_edits ADD COLUMN emojis TEXT;

ALTER TABLE accounts ADD COLUMN emojis TEXT;

CREATE TRIGGER statuses_emojis_insert BEFORE INSERT ON statuses
WHEN CASE WHEN NEW.emojis IS NULL THEN 0
	WHEN typeof(NEW.emojis) <> 'text' THEN 1
	WHEN instr(CAST(NEW.emojis AS BLOB), X'00') > 0 THEN 1
	WHEN length(CAST(NEW.emojis AS BLOB)) > 12288 THEN 1
	WHEN NOT json_valid(NEW.emojis) THEN 1
	WHEN json_type(NEW.emojis) <> 'array' THEN 1
	WHEN json_array_length(NEW.emojis) NOT BETWEEN 1 AND 64 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.emojis) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) NOT BETWEEN 1 AND 128 THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) <> length(e.value ->> '$[0]') THEN 1
		WHEN e.value ->> '$[0]' GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) > 512 THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) <> length(e.value ->> '$[1]') THEN 1
		WHEN NOT (e.value ->> '$[1]' GLOB 'https://?*' OR e.value ->> '$[1]' GLOB 'http://?*') THEN 1
		WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' OR e.value ->> '$[1]' GLOB '*["\]*' THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.emojis) e) <> json_array_length(NEW.emojis) THEN 1
	WHEN 1 + (SELECT sum(67 + length(e.value ->> '$[0]') + 2 * length(e.value ->> '$[1]')) FROM json_each(NEW.emojis) e)
		> 12288 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: emojis past their stored bound');
END;

CREATE TRIGGER statuses_emojis_update BEFORE UPDATE OF emojis ON statuses
WHEN CASE WHEN NEW.emojis IS NULL THEN 0
	WHEN typeof(NEW.emojis) <> 'text' THEN 1
	WHEN instr(CAST(NEW.emojis AS BLOB), X'00') > 0 THEN 1
	WHEN length(CAST(NEW.emojis AS BLOB)) > 12288 THEN 1
	WHEN NOT json_valid(NEW.emojis) THEN 1
	WHEN json_type(NEW.emojis) <> 'array' THEN 1
	WHEN json_array_length(NEW.emojis) NOT BETWEEN 1 AND 64 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.emojis) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) NOT BETWEEN 1 AND 128 THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) <> length(e.value ->> '$[0]') THEN 1
		WHEN e.value ->> '$[0]' GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) > 512 THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) <> length(e.value ->> '$[1]') THEN 1
		WHEN NOT (e.value ->> '$[1]' GLOB 'https://?*' OR e.value ->> '$[1]' GLOB 'http://?*') THEN 1
		WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' OR e.value ->> '$[1]' GLOB '*["\]*' THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.emojis) e) <> json_array_length(NEW.emojis) THEN 1
	WHEN 1 + (SELECT sum(67 + length(e.value ->> '$[0]') + 2 * length(e.value ->> '$[1]')) FROM json_each(NEW.emojis) e)
		> 12288 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: emojis past their stored bound');
END;

CREATE TRIGGER status_edits_emojis_insert BEFORE INSERT ON status_edits
WHEN CASE WHEN NEW.emojis IS NULL THEN 0
	WHEN typeof(NEW.emojis) <> 'text' THEN 1
	WHEN instr(CAST(NEW.emojis AS BLOB), X'00') > 0 THEN 1
	WHEN length(CAST(NEW.emojis AS BLOB)) > 12288 THEN 1
	WHEN NOT json_valid(NEW.emojis) THEN 1
	WHEN json_type(NEW.emojis) <> 'array' THEN 1
	WHEN json_array_length(NEW.emojis) NOT BETWEEN 1 AND 64 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.emojis) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) NOT BETWEEN 1 AND 128 THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) <> length(e.value ->> '$[0]') THEN 1
		WHEN e.value ->> '$[0]' GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) > 512 THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) <> length(e.value ->> '$[1]') THEN 1
		WHEN NOT (e.value ->> '$[1]' GLOB 'https://?*' OR e.value ->> '$[1]' GLOB 'http://?*') THEN 1
		WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' OR e.value ->> '$[1]' GLOB '*["\]*' THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.emojis) e) <> json_array_length(NEW.emojis) THEN 1
	WHEN 1 + (SELECT sum(67 + length(e.value ->> '$[0]') + 2 * length(e.value ->> '$[1]')) FROM json_each(NEW.emojis) e)
		> 12288 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_edits: emojis past their stored bound');
END;

CREATE TRIGGER status_edits_emojis_update BEFORE UPDATE OF emojis ON status_edits
WHEN CASE WHEN NEW.emojis IS NULL THEN 0
	WHEN typeof(NEW.emojis) <> 'text' THEN 1
	WHEN instr(CAST(NEW.emojis AS BLOB), X'00') > 0 THEN 1
	WHEN length(CAST(NEW.emojis AS BLOB)) > 12288 THEN 1
	WHEN NOT json_valid(NEW.emojis) THEN 1
	WHEN json_type(NEW.emojis) <> 'array' THEN 1
	WHEN json_array_length(NEW.emojis) NOT BETWEEN 1 AND 64 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.emojis) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) NOT BETWEEN 1 AND 128 THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) <> length(e.value ->> '$[0]') THEN 1
		WHEN e.value ->> '$[0]' GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) > 512 THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) <> length(e.value ->> '$[1]') THEN 1
		WHEN NOT (e.value ->> '$[1]' GLOB 'https://?*' OR e.value ->> '$[1]' GLOB 'http://?*') THEN 1
		WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' OR e.value ->> '$[1]' GLOB '*["\]*' THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.emojis) e) <> json_array_length(NEW.emojis) THEN 1
	WHEN 1 + (SELECT sum(67 + length(e.value ->> '$[0]') + 2 * length(e.value ->> '$[1]')) FROM json_each(NEW.emojis) e)
		> 12288 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_edits: emojis past their stored bound');
END;

CREATE TRIGGER accounts_emojis_insert BEFORE INSERT ON accounts
WHEN CASE WHEN NEW.emojis IS NULL THEN 0
	WHEN typeof(NEW.emojis) <> 'text' THEN 1
	WHEN instr(CAST(NEW.emojis AS BLOB), X'00') > 0 THEN 1
	WHEN length(CAST(NEW.emojis AS BLOB)) > 6144 THEN 1
	WHEN NOT json_valid(NEW.emojis) THEN 1
	WHEN json_type(NEW.emojis) <> 'array' THEN 1
	WHEN json_array_length(NEW.emojis) NOT BETWEEN 1 AND 64 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.emojis) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) NOT BETWEEN 1 AND 128 THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) <> length(e.value ->> '$[0]') THEN 1
		WHEN e.value ->> '$[0]' GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) > 512 THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) <> length(e.value ->> '$[1]') THEN 1
		WHEN NOT (e.value ->> '$[1]' GLOB 'https://?*' OR e.value ->> '$[1]' GLOB 'http://?*') THEN 1
		WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' OR e.value ->> '$[1]' GLOB '*["\]*' THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.emojis) e) <> json_array_length(NEW.emojis) THEN 1
	WHEN 1 + (SELECT sum(67 + length(e.value ->> '$[0]') + 2 * length(e.value ->> '$[1]')) FROM json_each(NEW.emojis) e)
		> 6144 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: emojis past their stored bound');
END;

CREATE TRIGGER accounts_emojis_update BEFORE UPDATE OF emojis ON accounts
WHEN CASE WHEN NEW.emojis IS NULL THEN 0
	WHEN typeof(NEW.emojis) <> 'text' THEN 1
	WHEN instr(CAST(NEW.emojis AS BLOB), X'00') > 0 THEN 1
	WHEN length(CAST(NEW.emojis AS BLOB)) > 6144 THEN 1
	WHEN NOT json_valid(NEW.emojis) THEN 1
	WHEN json_type(NEW.emojis) <> 'array' THEN 1
	WHEN json_array_length(NEW.emojis) NOT BETWEEN 1 AND 64 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.emojis) e WHERE CASE WHEN e.type <> 'array' THEN 1
		WHEN json_array_length(e.value) <> 2 THEN 1
		WHEN json_type(e.value, '$[0]') <> 'text' OR json_type(e.value, '$[1]') <> 'text' THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) NOT BETWEEN 1 AND 128 THEN 1
		WHEN length(CAST(e.value ->> '$[0]' AS BLOB)) <> length(e.value ->> '$[0]') THEN 1
		WHEN e.value ->> '$[0]' GLOB '*[^A-Za-z0-9_+-]*' THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) > 512 THEN 1
		WHEN length(CAST(e.value ->> '$[1]' AS BLOB)) <> length(e.value ->> '$[1]') THEN 1
		WHEN NOT (e.value ->> '$[1]' GLOB 'https://?*' OR e.value ->> '$[1]' GLOB 'http://?*') THEN 1
		WHEN e.value ->> '$[1]' GLOB '*[^!-~]*' OR e.value ->> '$[1]' GLOB '*["\]*' THEN 1
		ELSE 0 END) THEN 1
	WHEN (SELECT count(DISTINCT e.value ->> '$[0]') FROM json_each(NEW.emojis) e) <> json_array_length(NEW.emojis) THEN 1
	WHEN 1 + (SELECT sum(67 + length(e.value ->> '$[0]') + 2 * length(e.value ->> '$[1]')) FROM json_each(NEW.emojis) e)
		> 6144 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: emojis past their stored bound');
END;
