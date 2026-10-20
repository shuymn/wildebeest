-- Kopje Store schema 0055: local custom emoji. Never edit after release (checksummed).
--
-- An emoji is a kept local upload (media_attachments, the same id) with a shortcode. Its image, shortcode and time
-- never change: replacing one disables it and adds a row (MEDIA-5: its image is never deleted, disabled or not).
-- Bounds: src/platform/emoji-image.ts and stored-bounds.ts (LOCAL_EMOJI_SHORTCODE, EMOJI_CATEGORY_*,
-- MAX_ENABLED_EMOJIS), which test/migrations.test.ts compares with the literals below; writers:
-- src/domain/custom-emojis.ts; stored form and refusals: docs/dump-format.md. It adds:
--
--   custom_emojis                 the emoji; id is the media row's (no cascade: deleting an emoji's image fails)
--   custom_emojis_enabled         the enabled emoji by shortcode, one each (the list, the snapshot probe, the cap)
--   custom_emojis_image_insert    the image is a kept, complete, unattached local upload served as PNG or WebP whose
--                                 RECORDED size (meta.original, the served image's as completeMedia and recordRebuild
--                                 write it) is within EMOJI_EDGE_LIMIT; its actual bytes and edges are checked where
--                                 they are known, at upload and by the media rebuild
--   custom_emojis_enabled_insert, custom_emojis_enabled_update
--                                 at most MAX_ENABLED_EMOJIS enabled
--   custom_emojis_immutable       an emoji's id, shortcode and time never change
--
-- Cost: one empty table, one index and four triggers; no row is read.

CREATE TABLE custom_emojis (
  id TEXT NOT NULL PRIMARY KEY REFERENCES media_attachments (id),
  shortcode TEXT NOT NULL,
  category TEXT,
  visible_in_picker INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CONSTRAINT custom_emoji_id_is_a_snowflake CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 18
    AND length(id) = 18 AND id NOT GLOB '*[^0-9]*'),
  -- bytes, then NUL and non-ASCII (length() stops at a NUL), then the grammar
  CONSTRAINT custom_emoji_shortcode_2_to_128_ascii CHECK (typeof(shortcode) = 'text'
    AND length(CAST(shortcode AS BLOB)) BETWEEN 2 AND 128
    AND length(shortcode) = length(CAST(shortcode AS BLOB))
    AND shortcode NOT GLOB '*[^A-Za-z0-9_]*'),
  -- stored bytes only: SQLite cannot judge UTF-8 well-formedness, so presentation judges the decoded value again
  CONSTRAINT custom_emoji_category_within_256_bytes CHECK (category IS NULL OR (typeof(category) = 'text'
    AND length(CAST(category AS BLOB)) BETWEEN 1 AND 256
    AND instr(CAST(category AS BLOB), x'00') = 0
    AND length(category) <= 64
    AND category NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  CONSTRAINT custom_emoji_flags CHECK (visible_in_picker IN (0, 1) AND disabled IN (0, 1)),
  -- a time as Kopje writes one (workerd refuses a long GLOB pattern, so strftime judges it: it rewrites anything else)
  CONSTRAINT custom_emoji_created_at_iso CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
);

CREATE UNIQUE INDEX custom_emojis_enabled ON custom_emojis (shortcode) WHERE disabled = 0;

CREATE TRIGGER custom_emojis_image_insert BEFORE INSERT ON custom_emojis
WHEN NOT EXISTS (SELECT 1 FROM media_attachments m JOIN accounts a ON a.id = m.account_id
  WHERE m.id = NEW.id AND a.domain IS NULL AND m.type = 'image' AND m.file_token IS NOT NULL AND m.processed = 1
    AND m.url <> '' AND m.status_id IS NULL AND m.scheduled_status_id IS NULL AND m.gc_at IS NULL
    AND m.content_type IN ('image/png', 'image/webp')
    -- json_type raises on text that is not JSON, so it is reached only through json_valid
    AND CASE WHEN json_valid(m.meta) THEN json_type(m.meta, '$.original.width') = 'integer'
      AND json_type(m.meta, '$.original.height') = 'integer'
      AND json_extract(m.meta, '$.original.width') BETWEEN 1 AND 1024
      AND json_extract(m.meta, '$.original.height') BETWEEN 1 AND 1024 ELSE 0 END)
BEGIN
  SELECT RAISE(ABORT, 'custom_emojis: the image is not a kept local upload within the emoji limits');
END;

CREATE TRIGGER custom_emojis_enabled_insert BEFORE INSERT ON custom_emojis
WHEN NEW.disabled = 0 AND (SELECT count(*) FROM custom_emojis WHERE disabled = 0) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'custom_emojis: more than 1000 enabled');
END;

CREATE TRIGGER custom_emojis_enabled_update BEFORE UPDATE OF disabled ON custom_emojis
WHEN NEW.disabled = 0 AND OLD.disabled = 1 AND (SELECT count(*) FROM custom_emojis WHERE disabled = 0) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'custom_emojis: more than 1000 enabled');
END;

CREATE TRIGGER custom_emojis_immutable BEFORE UPDATE OF id, shortcode, created_at ON custom_emojis
WHEN NEW.id IS NOT OLD.id OR NEW.shortcode IS NOT OLD.shortcode OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'custom_emojis: an emoji''s id, shortcode and time never change');
END;
