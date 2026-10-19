-- Kopje Store schema 0048: stored values are fixed points of their read projections. Never edit after release
-- (checksummed).
--
-- RES-2: set every covered value x to P(x), keeping no copy, then refuse writes outside P's fixed points. Projections,
-- writers and read exceptions: src/platform/stored-bounds.ts (STORED_COLUMNS); P(P(x)) = P(x), so the API's output
-- does not change. It adds:
--
--   stored_bounds_check          a table made and dropped here, whose named CHECK fails the upgrade before anything
--                                is rewritten when an uploaded media row (file_token set) holds a URL past 2,048
--                                bytes: Kopje builds those URLs, so one past the bound is a fault, not a value to drop.
--   <table>_bounds_insert        BEFORE INSERT on statuses, accounts, media_attachments and status_edits, and
--   <table>_bounds_update        BEFORE UPDATE OF their covered columns: RAISE(ABORT, '<table>: a value past its stored
--                                bound') when P(NEW.x) IS NOT NEW.x for any covered column.
--
-- A media row without a file token stores '' for a URL past its bound (url is NOT NULL), which reads as none. A
-- JSON-bounded value is tested by raw size before json_quote, and skipped below a sixth of its bound, which it cannot
-- escape past. The statements below are the output of storedBoundsMigrationSql (test/migrations.test.ts compares them).
-- Recovery of a rewritten value: the point-in-time bookmark the kernel records before the upgrade (docs/upgrade.md).
--
-- Cost: a scan of the media attachments for the check, one rewrite scan of each of the four tables (writing only
-- rows past a bound), and four pairs of triggers, which read no row when made; the upgrade's verification then runs
-- PRAGMA foreign_key_check over the Store. Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000
-- accounts, 2,000,000 statuses, 500,000 media attachments, 100,000 earlier versions, the rows past their bounds it
-- adds for this file, and the rest of that store) in workerd's local Durable Object SQLite, timing the whole upgrade
-- through the kernel (its bookmark, this file's transaction and the verification): 7,262 ms (7,283 and 7,459 ms in
-- two more runs, at load averages of 2.5 to 4), within the 10,000 ms each migration file may take.

CREATE TABLE stored_bounds_check (
  n INTEGER CONSTRAINT tokened_media_url_within_2048_bytes CHECK (n = 0)
);

INSERT INTO stored_bounds_check
SELECT count(*) FROM media_attachments
WHERE file_token IS NOT NULL AND length(CAST(url AS BLOB)) > 2048;

DROP TABLE stored_bounds_check;

UPDATE statuses SET
  content = CASE WHEN length(CAST(content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(content) AS BLOB)) > 131072 THEN '' ELSE content END,
  spoiler_text = CASE WHEN length(CAST(spoiler_text AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(spoiler_text) AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730) ELSE spoiler_text END,
  source_text = CASE WHEN length(CAST(source_text AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(source_text) AS BLOB)) > 131072 THEN '' ELSE source_text END,
  url = CASE WHEN length(CAST(url AS BLOB)) <= 4096 THEN url END
WHERE CASE WHEN length(CAST(content AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(content) AS BLOB)) > 131072 THEN '' ELSE content END) IS NOT content END
  OR CASE WHEN length(CAST(spoiler_text AS BLOB)) <= 2730 THEN 0 ELSE (CASE WHEN length(CAST(spoiler_text AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(spoiler_text) AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730) ELSE spoiler_text END) IS NOT spoiler_text END
  OR CASE WHEN length(CAST(source_text AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(source_text AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(source_text) AS BLOB)) > 131072 THEN '' ELSE source_text END) IS NOT source_text END
  OR (CASE WHEN length(CAST(url AS BLOB)) <= 4096 THEN url END) IS NOT url;

UPDATE accounts SET
  display_name = CASE WHEN length(CAST(display_name AS BLOB)) <= 2048 THEN display_name ELSE substr(display_name, 1, 2048) END,
  note = CASE WHEN length(CAST(note AS BLOB)) > 65536 THEN ''
	WHEN length(CAST(json_quote(note) AS BLOB)) > 65536 THEN '' ELSE note END,
  url = CASE WHEN length(CAST(url AS BLOB)) <= 2048 THEN url END,
  avatar_url = CASE WHEN length(CAST(avatar_url AS BLOB)) <= 2048 THEN avatar_url END,
  header_url = CASE WHEN length(CAST(header_url AS BLOB)) <= 2048 THEN header_url END
WHERE (CASE WHEN length(CAST(display_name AS BLOB)) <= 2048 THEN display_name ELSE substr(display_name, 1, 2048) END) IS NOT display_name
  OR CASE WHEN length(CAST(note AS BLOB)) <= 10922 THEN 0 ELSE (CASE WHEN length(CAST(note AS BLOB)) > 65536 THEN ''
	WHEN length(CAST(json_quote(note) AS BLOB)) > 65536 THEN '' ELSE note END) IS NOT note END
  OR (CASE WHEN length(CAST(url AS BLOB)) <= 2048 THEN url END) IS NOT url
  OR (CASE WHEN length(CAST(avatar_url AS BLOB)) <= 2048 THEN avatar_url END) IS NOT avatar_url
  OR (CASE WHEN length(CAST(header_url AS BLOB)) <= 2048 THEN header_url END) IS NOT header_url;

UPDATE media_attachments SET
  url = coalesce(CASE WHEN length(CAST(url AS BLOB)) <= 2048 THEN url END, ''),
  preview_url = CASE WHEN length(CAST(preview_url AS BLOB)) <= 2048 THEN preview_url END,
  description = CASE WHEN length(CAST(description AS BLOB)) <= 10000 THEN description ELSE substr(description, 1, 10000) END,
  meta = CASE WHEN length(CAST(meta AS BLOB)) <= 1024 THEN meta END
WHERE (CASE WHEN length(CAST(url AS BLOB)) <= 2048 THEN url END) IS NOT url
  OR (CASE WHEN length(CAST(preview_url AS BLOB)) <= 2048 THEN preview_url END) IS NOT preview_url
  OR (CASE WHEN length(CAST(description AS BLOB)) <= 10000 THEN description ELSE substr(description, 1, 10000) END) IS NOT description
  OR (CASE WHEN length(CAST(meta AS BLOB)) <= 1024 THEN meta END) IS NOT meta;

UPDATE status_edits SET
  content = CASE WHEN length(CAST(content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(content) AS BLOB)) > 131072 THEN '' ELSE content END,
  spoiler_text = CASE WHEN length(CAST(spoiler_text AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(spoiler_text) AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730) ELSE spoiler_text END,
  poll_options = CASE WHEN length(CAST(poll_options AS BLOB)) <= 655360 THEN
		(SELECT json_group_array(CASE WHEN length(CAST(value AS BLOB)) <= 1000 THEN value ELSE substr(value, 1, 1000) END ORDER BY key) FROM json_each(poll_options)
			WHERE key < 100) END
WHERE CASE WHEN length(CAST(content AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(content) AS BLOB)) > 131072 THEN '' ELSE content END) IS NOT content END
  OR CASE WHEN length(CAST(spoiler_text AS BLOB)) <= 2730 THEN 0 ELSE (CASE WHEN length(CAST(spoiler_text AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(spoiler_text) AS BLOB)) > 16384 THEN substr(spoiler_text, 1, 2730) ELSE spoiler_text END) IS NOT spoiler_text END
  OR (CASE WHEN length(CAST(poll_options AS BLOB)) <= 655360 THEN
		(SELECT json_group_array(CASE WHEN length(CAST(value AS BLOB)) <= 1000 THEN value ELSE substr(value, 1, 1000) END ORDER BY key) FROM json_each(poll_options)
			WHERE key < 100) END) IS NOT poll_options;

CREATE TRIGGER statuses_bounds_insert BEFORE INSERT ON statuses
WHEN CASE WHEN length(CAST(NEW.content AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(NEW.content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(NEW.content) AS BLOB)) > 131072 THEN '' ELSE NEW.content END) IS NOT NEW.content END
  OR CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) <= 2730 THEN 0 ELSE (CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(NEW.spoiler_text) AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730) ELSE NEW.spoiler_text END) IS NOT NEW.spoiler_text END
  OR CASE WHEN length(CAST(NEW.source_text AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(NEW.source_text AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(NEW.source_text) AS BLOB)) > 131072 THEN '' ELSE NEW.source_text END) IS NOT NEW.source_text END
  OR (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 4096 THEN NEW.url END) IS NOT NEW.url
BEGIN
  SELECT RAISE(ABORT, 'statuses: a value past its stored bound');
END;

CREATE TRIGGER statuses_bounds_update BEFORE UPDATE OF content, spoiler_text, source_text, url ON statuses
WHEN CASE WHEN length(CAST(NEW.content AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(NEW.content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(NEW.content) AS BLOB)) > 131072 THEN '' ELSE NEW.content END) IS NOT NEW.content END
  OR CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) <= 2730 THEN 0 ELSE (CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(NEW.spoiler_text) AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730) ELSE NEW.spoiler_text END) IS NOT NEW.spoiler_text END
  OR CASE WHEN length(CAST(NEW.source_text AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(NEW.source_text AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(NEW.source_text) AS BLOB)) > 131072 THEN '' ELSE NEW.source_text END) IS NOT NEW.source_text END
  OR (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 4096 THEN NEW.url END) IS NOT NEW.url
BEGIN
  SELECT RAISE(ABORT, 'statuses: a value past its stored bound');
END;

CREATE TRIGGER accounts_bounds_insert BEFORE INSERT ON accounts
WHEN (CASE WHEN length(CAST(NEW.display_name AS BLOB)) <= 2048 THEN NEW.display_name ELSE substr(NEW.display_name, 1, 2048) END) IS NOT NEW.display_name
  OR CASE WHEN length(CAST(NEW.note AS BLOB)) <= 10922 THEN 0 ELSE (CASE WHEN length(CAST(NEW.note AS BLOB)) > 65536 THEN ''
	WHEN length(CAST(json_quote(NEW.note) AS BLOB)) > 65536 THEN '' ELSE NEW.note END) IS NOT NEW.note END
  OR (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 2048 THEN NEW.url END) IS NOT NEW.url
  OR (CASE WHEN length(CAST(NEW.avatar_url AS BLOB)) <= 2048 THEN NEW.avatar_url END) IS NOT NEW.avatar_url
  OR (CASE WHEN length(CAST(NEW.header_url AS BLOB)) <= 2048 THEN NEW.header_url END) IS NOT NEW.header_url
BEGIN
  SELECT RAISE(ABORT, 'accounts: a value past its stored bound');
END;

CREATE TRIGGER accounts_bounds_update BEFORE UPDATE OF display_name, note, url, avatar_url, header_url ON accounts
WHEN (CASE WHEN length(CAST(NEW.display_name AS BLOB)) <= 2048 THEN NEW.display_name ELSE substr(NEW.display_name, 1, 2048) END) IS NOT NEW.display_name
  OR CASE WHEN length(CAST(NEW.note AS BLOB)) <= 10922 THEN 0 ELSE (CASE WHEN length(CAST(NEW.note AS BLOB)) > 65536 THEN ''
	WHEN length(CAST(json_quote(NEW.note) AS BLOB)) > 65536 THEN '' ELSE NEW.note END) IS NOT NEW.note END
  OR (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 2048 THEN NEW.url END) IS NOT NEW.url
  OR (CASE WHEN length(CAST(NEW.avatar_url AS BLOB)) <= 2048 THEN NEW.avatar_url END) IS NOT NEW.avatar_url
  OR (CASE WHEN length(CAST(NEW.header_url AS BLOB)) <= 2048 THEN NEW.header_url END) IS NOT NEW.header_url
BEGIN
  SELECT RAISE(ABORT, 'accounts: a value past its stored bound');
END;

CREATE TRIGGER media_attachments_bounds_insert BEFORE INSERT ON media_attachments
WHEN (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 2048 THEN NEW.url END) IS NOT NEW.url
  OR (CASE WHEN length(CAST(NEW.preview_url AS BLOB)) <= 2048 THEN NEW.preview_url END) IS NOT NEW.preview_url
  OR (CASE WHEN length(CAST(NEW.description AS BLOB)) <= 10000 THEN NEW.description ELSE substr(NEW.description, 1, 10000) END) IS NOT NEW.description
  OR (CASE WHEN length(CAST(NEW.meta AS BLOB)) <= 1024 THEN NEW.meta END) IS NOT NEW.meta
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: a value past its stored bound');
END;

CREATE TRIGGER media_attachments_bounds_update BEFORE UPDATE OF url, preview_url, description, meta ON media_attachments
WHEN (CASE WHEN length(CAST(NEW.url AS BLOB)) <= 2048 THEN NEW.url END) IS NOT NEW.url
  OR (CASE WHEN length(CAST(NEW.preview_url AS BLOB)) <= 2048 THEN NEW.preview_url END) IS NOT NEW.preview_url
  OR (CASE WHEN length(CAST(NEW.description AS BLOB)) <= 10000 THEN NEW.description ELSE substr(NEW.description, 1, 10000) END) IS NOT NEW.description
  OR (CASE WHEN length(CAST(NEW.meta AS BLOB)) <= 1024 THEN NEW.meta END) IS NOT NEW.meta
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: a value past its stored bound');
END;

CREATE TRIGGER status_edits_bounds_insert BEFORE INSERT ON status_edits
WHEN CASE WHEN length(CAST(NEW.content AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(NEW.content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(NEW.content) AS BLOB)) > 131072 THEN '' ELSE NEW.content END) IS NOT NEW.content END
  OR CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) <= 2730 THEN 0 ELSE (CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(NEW.spoiler_text) AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730) ELSE NEW.spoiler_text END) IS NOT NEW.spoiler_text END
  OR (CASE WHEN length(CAST(NEW.poll_options AS BLOB)) <= 655360 THEN
		(SELECT json_group_array(CASE WHEN length(CAST(value AS BLOB)) <= 1000 THEN value ELSE substr(value, 1, 1000) END ORDER BY key) FROM json_each(NEW.poll_options)
			WHERE key < 100) END) IS NOT NEW.poll_options
BEGIN
  SELECT RAISE(ABORT, 'status_edits: a value past its stored bound');
END;

CREATE TRIGGER status_edits_bounds_update BEFORE UPDATE OF content, spoiler_text, poll_options ON status_edits
WHEN CASE WHEN length(CAST(NEW.content AS BLOB)) <= 21845 THEN 0 ELSE (CASE WHEN length(CAST(NEW.content AS BLOB)) > 131072 THEN ''
	WHEN length(CAST(json_quote(NEW.content) AS BLOB)) > 131072 THEN '' ELSE NEW.content END) IS NOT NEW.content END
  OR CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) <= 2730 THEN 0 ELSE (CASE WHEN length(CAST(NEW.spoiler_text AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730)
	WHEN length(CAST(json_quote(NEW.spoiler_text) AS BLOB)) > 16384 THEN substr(NEW.spoiler_text, 1, 2730) ELSE NEW.spoiler_text END) IS NOT NEW.spoiler_text END
  OR (CASE WHEN length(CAST(NEW.poll_options AS BLOB)) <= 655360 THEN
		(SELECT json_group_array(CASE WHEN length(CAST(value AS BLOB)) <= 1000 THEN value ELSE substr(value, 1, 1000) END ORDER BY key) FROM json_each(NEW.poll_options)
			WHERE key < 100) END) IS NOT NEW.poll_options
BEGIN
  SELECT RAISE(ABORT, 'status_edits: a value past its stored bound');
END;
