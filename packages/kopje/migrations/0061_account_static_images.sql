-- Kopje Store schema 0061: account static images. Never edit after release (checksummed).
--
--   accounts.avatar_static_url   NULL (the account's static image is its image), or the still preview URL of the
--   accounts.header_static_url   upload its avatar_url or header_url names, of at most 512 bytes and no NUL, set only
--                             on a local row whose image is set: Mastodon's avatar_static and header_static.
--   accounts_static_images_insert  BEFORE INSERT and BEFORE UPDATE OF avatar_url, header_url, avatar_static_url,
--   accounts_static_images_update  header_static_url, domain on accounts: RAISE(ABORT, 'accounts: static image past
--                             its stored bound') for a value of another storage class, past 512 bytes or with a NUL,
--                             on a remote row, or without its image.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (staticImagesPastBoundSql); the statements below are the
-- output of accountStaticImagesMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the columns have no default or CHECK, so adding them reads no row, and every existing row holds NULL, within
-- the bound; no index is made (the columns are read only with their row); the triggers read no row.

ALTER TABLE accounts ADD COLUMN avatar_static_url TEXT;

ALTER TABLE accounts ADD COLUMN header_static_url TEXT;

CREATE TRIGGER accounts_static_images_insert BEFORE INSERT ON accounts
WHEN CASE WHEN NEW.avatar_static_url IS NULL THEN 0
	WHEN typeof(NEW.avatar_static_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.avatar_static_url AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.avatar_static_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain IS NOT NULL THEN 1
	WHEN NEW.avatar_url IS NULL THEN 1
	ELSE 0 END
	OR CASE WHEN NEW.header_static_url IS NULL THEN 0
	WHEN typeof(NEW.header_static_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.header_static_url AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.header_static_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain IS NOT NULL THEN 1
	WHEN NEW.header_url IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: static image past its stored bound');
END;

CREATE TRIGGER accounts_static_images_update BEFORE UPDATE OF avatar_url, header_url, avatar_static_url, header_static_url, domain ON accounts
WHEN CASE WHEN NEW.avatar_static_url IS NULL THEN 0
	WHEN typeof(NEW.avatar_static_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.avatar_static_url AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.avatar_static_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain IS NOT NULL THEN 1
	WHEN NEW.avatar_url IS NULL THEN 1
	ELSE 0 END
	OR CASE WHEN NEW.header_static_url IS NULL THEN 0
	WHEN typeof(NEW.header_static_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.header_static_url AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.header_static_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain IS NOT NULL THEN 1
	WHEN NEW.header_url IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'accounts: static image past its stored bound');
END;
