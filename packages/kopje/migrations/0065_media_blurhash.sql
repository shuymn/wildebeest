-- Kopje Store schema 0065: media blurhash. Never edit after release (checksummed).
--
--   media_attachments.blurhash         NULL, or the BlurHash a remote attachment was sent with when Mastodon's parser
--                                      keeps it (MediaAttachment#blurhash): base83, x and y components of 1 to 5, and
--                                      4 + 2xy characters. Local uploads store none.
--   media_attachments_blurhash_insert  BEFORE INSERT and BEFORE UPDATE OF blurhash on media_attachments:
--   media_attachments_blurhash_update  RAISE(ABORT, 'media_attachments: blurhash past its stored bound') for a value of
--                                      another storage class, outside 6 to 54 bytes, with a NUL or a character outside
--                                      base83, with a size flag past 5 components, or of a length its flag does not
--                                      give.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (blurhashPastBoundSql); the statements below are the output
-- of mediaBlurhashMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the column has no default or CHECK, so adding it reads no row, and every existing row holds NULL, within the
-- bound; no index is made; the triggers read no row.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 statuses, 500,000
-- media attachments) in workerd's local Durable Object SQLite, the Store's foreign key check skipped as declared: 21 ms
-- for the upgrade of this file through the kernel, within the budget.

ALTER TABLE media_attachments ADD COLUMN blurhash TEXT;

CREATE TRIGGER media_attachments_blurhash_insert BEFORE INSERT ON media_attachments
WHEN CASE WHEN NEW.blurhash IS NULL THEN 0
	WHEN typeof(NEW.blurhash) <> 'text' THEN 1
	WHEN length(CAST(NEW.blurhash AS BLOB)) NOT BETWEEN 6 AND 54 THEN 1
	WHEN instr(CAST(NEW.blurhash AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(NEW.blurhash, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~') <> '' THEN 1
	WHEN (SELECT f % 9 >= 5 OR f / 9 >= 5
			OR length(NEW.blurhash) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~', substr(NEW.blurhash, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: blurhash past its stored bound');
END;

CREATE TRIGGER media_attachments_blurhash_update BEFORE UPDATE OF blurhash ON media_attachments
WHEN CASE WHEN NEW.blurhash IS NULL THEN 0
	WHEN typeof(NEW.blurhash) <> 'text' THEN 1
	WHEN length(CAST(NEW.blurhash AS BLOB)) NOT BETWEEN 6 AND 54 THEN 1
	WHEN instr(CAST(NEW.blurhash AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(NEW.blurhash, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~') <> '' THEN 1
	WHEN (SELECT f % 9 >= 5 OR f / 9 >= 5
			OR length(NEW.blurhash) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~', substr(NEW.blurhash, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'media_attachments: blurhash past its stored bound');
END;
