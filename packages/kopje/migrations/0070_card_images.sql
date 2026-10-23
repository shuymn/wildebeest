-- Kopje Store schema 0070: card images (Mastodon 4.5's PreviewCard image, image_description and blurhash). Never
-- edit after release (checksummed).
--
--   status_cards                  three columns: image_url (the card's image source, '' for none: an https card URL),
--                                 image_id (the card_images row it shows, NULL for none; no foreign key) and
--                                 image_description (the image's alt text, a card text of 256 JSON-escaped bytes),
--                                 defaulted so every existing row has no image; no row is rewritten.
--   status_cards_image            the rows by image_id where it is set: the image GC's reference check.
--   status_cards_bounds_insert    dropped and recreated over every column, the new ones included: BEFORE INSERT and
--   status_cards_bounds_update    BEFORE UPDATE of every column, RAISE(ABORT, 'status_cards: a value past its stored
--                                 bound') for a value past its bound (0069's cases, then an image_url that is
--                                 neither '' nor a card URL, an image_id that is not an 18-digit snowflake, an
--                                 image_description past its bound), or an image_id without an image_url. No trigger
--                                 writes.
--   card_images                   one row per image source URL (src/domain/card-images.ts): pending (due_at set: the
--                                 URL to fetch, its claim and attempts) or stored (stored_at set: the token of its
--                                 served file, files/<token>/full in the media bucket, its size and blurhash).
--   card_images_due               the pending rows by (due_at, id): the round's walk.
--   card_images_expiry            the pending rows by enqueued_at: the claim's expiry.
--   card_images_stored            the stored rows by (source_url, stored_at): a record's reuse of a fresh image.
--   card_images_pending           the pending rows by source_url: a record's reuse of a pending one.
--   card_images_stored_id         the stored rows by id: the image GC's cursor walk.
--   card_images_token             UNIQUE over the stored tokens.
--   card_images_bounds_insert     BEFORE INSERT and BEFORE UPDATE of every column on card_images: RAISE(ABORT,
--   card_images_bounds_update     'card_images: a value past its stored bound') for an id that is not a snowflake, a
--                                 source_url that is not an https card URL, a counter or time that is not an integer
--                                 from 0 to 2^53 - 1 (attempts 0 to 2), a token that is not 32 to 64 base64url bytes,
--                                 a width or height outside 1 to 65,535, a blurhash past its bound, or a row that is
--                                 neither pending without a token, size or blurhash nor stored with a token and size.
--                                 No trigger writes.
--
-- Bounds and the predicates: src/platform/stored-bounds.ts (CARD_IMAGE_DESCRIPTION_JSON_BYTES, CARD_IMAGE_EDGE_MAX,
-- statusCardPastBoundSql, cardImagePastBoundSql); the statements below are the output of cardImagesMigrationSql
-- (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the columns are added to the schema only, the triggers read no row, the new table is empty, and the index of
-- the image link reads status_cards once.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000
-- statuses with their mentions and tags, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts,
-- 200,000 attached cards with 0069's columns and 10,000 pending ones) in workerd's local Durable Object SQLite, with
-- the whole Store's foreign keys verified (the file creates a table, so it is not declared foreignKeys: 'unchanged'):
-- 6,520 ms for the upgrade of this file through the kernel, within the budget, at a load average of 4 to 5.

ALTER TABLE status_cards ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE status_cards ADD COLUMN image_id TEXT;
ALTER TABLE status_cards ADD COLUMN image_description TEXT NOT NULL DEFAULT '';

CREATE INDEX status_cards_image ON status_cards (image_id) WHERE image_id IS NOT NULL;

DROP TRIGGER status_cards_bounds_insert;
DROP TRIGGER status_cards_bounds_update;

CREATE TRIGGER status_cards_bounds_insert BEFORE INSERT ON status_cards
WHEN CASE WHEN typeof(NEW.status_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.status_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.status_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.fetched_at IS NOT NULL AND (typeof(NEW.fetched_at) <> 'integer' OR NEW.fetched_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN typeof(NEW.title) <> 'text' THEN 1
	WHEN length(CAST(NEW.title AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.title AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.title) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.description) <> 'text' THEN 1
	WHEN length(CAST(NEW.description AS BLOB)) > 1022 THEN 1
	WHEN instr(CAST(NEW.description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.description) AS BLOB)) > 1024 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.author_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.author_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.provider_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.provider_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.author_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.author_url = '' THEN 0
	WHEN NOT (NEW.author_url GLOB 'https://?*' OR NEW.author_url GLOB 'http://?*') THEN 1
	WHEN NEW.author_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.author_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.provider_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.provider_url = '' THEN 0
	WHEN NOT (NEW.provider_url GLOB 'https://?*' OR NEW.provider_url GLOB 'http://?*') THEN 1
	WHEN NEW.provider_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.provider_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.published_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL THEN 1
	WHEN typeof(NEW.card_type) <> 'integer' OR NEW.card_type NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 0 AND 65535 THEN 1
	WHEN typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 0 AND 65535 THEN 1
	WHEN CASE WHEN typeof(NEW.embed_src) <> 'text' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.embed_src AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.embed_src = '' THEN 0
	WHEN NOT (NEW.embed_src GLOB 'http://?*' OR NEW.embed_src GLOB 'https://?*') THEN 1
	WHEN NEW.embed_src GLOB '*[^!-~]*' THEN 1
	WHEN NEW.embed_src GLOB '*["<>\^`{|}]*' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) + 4 * (length(NEW.embed_src) - length(replace(NEW.embed_src, '&', '')))
		> 512 THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.iframe_width IS NOT NULL AND (typeof(NEW.iframe_width) <> 'integer' OR NEW.iframe_width NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.iframe_height IS NOT NULL AND (typeof(NEW.iframe_height) <> 'integer' OR NEW.iframe_height NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.image_url IS NOT '' AND CASE WHEN typeof(NEW.image_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.image_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.image_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.image_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.image_id IS NOT NULL AND CASE WHEN typeof(NEW.image_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.image_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.image_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_description AS BLOB)) > 254 THEN 1
	WHEN instr(CAST(NEW.image_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.image_description) AS BLOB)) > 256 THEN 1
	ELSE 0 END THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	WHEN NEW.image_url IS '' AND NEW.image_id IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;

CREATE TRIGGER status_cards_bounds_update BEFORE UPDATE OF status_id, url, due_at, enqueued_at, claim, attempts, generation, title, description, author_name, author_url, provider_name, provider_url, language, published_at, fetched_at, card_type, width, height, embed_src, iframe_width, iframe_height, image_url, image_id, image_description ON status_cards
WHEN CASE WHEN typeof(NEW.status_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.status_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.status_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.status_id GLOB '*[^0-9]*' THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.fetched_at IS NOT NULL AND (typeof(NEW.fetched_at) <> 'integer' OR NEW.fetched_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN CASE WHEN typeof(NEW.title) <> 'text' THEN 1
	WHEN length(CAST(NEW.title AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.title AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.title) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.description) <> 'text' THEN 1
	WHEN length(CAST(NEW.description AS BLOB)) > 1022 THEN 1
	WHEN instr(CAST(NEW.description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.description) AS BLOB)) > 1024 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.author_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.author_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_name) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_name AS BLOB)) > 510 THEN 1
	WHEN instr(CAST(NEW.provider_name AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.provider_name) AS BLOB)) > 512 THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.author_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.author_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.author_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.author_url = '' THEN 0
	WHEN NOT (NEW.author_url GLOB 'https://?*' OR NEW.author_url GLOB 'http://?*') THEN 1
	WHEN NEW.author_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.author_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.provider_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.provider_url AS BLOB)) > 1024 THEN 1
	WHEN instr(CAST(NEW.provider_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.provider_url = '' THEN 0
	WHEN NOT (NEW.provider_url GLOB 'https://?*' OR NEW.provider_url GLOB 'http://?*') THEN 1
	WHEN NEW.provider_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.provider_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.published_at IS NOT NULL AND (CASE WHEN length(CAST(NEW.published_at AS BLOB)) = 24 AND substr(NEW.published_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.published_at) = NEW.published_at THEN NEW.published_at END) IS NULL THEN 1
	WHEN typeof(NEW.card_type) <> 'integer' OR NEW.card_type NOT BETWEEN 0 AND 2 THEN 1
	WHEN typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 0 AND 65535 THEN 1
	WHEN typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 0 AND 65535 THEN 1
	WHEN CASE WHEN typeof(NEW.embed_src) <> 'text' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) > 512 THEN 1
	WHEN instr(CAST(NEW.embed_src AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.embed_src = '' THEN 0
	WHEN NOT (NEW.embed_src GLOB 'http://?*' OR NEW.embed_src GLOB 'https://?*') THEN 1
	WHEN NEW.embed_src GLOB '*[^!-~]*' THEN 1
	WHEN NEW.embed_src GLOB '*["<>\^`{|}]*' THEN 1
	WHEN length(CAST(NEW.embed_src AS BLOB)) + 4 * (length(NEW.embed_src) - length(replace(NEW.embed_src, '&', '')))
		> 512 THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.iframe_width IS NOT NULL AND (typeof(NEW.iframe_width) <> 'integer' OR NEW.iframe_width NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.iframe_height IS NOT NULL AND (typeof(NEW.iframe_height) <> 'integer' OR NEW.iframe_height NOT BETWEEN 0 AND 65535) THEN 1
	WHEN NEW.image_url IS NOT '' AND CASE WHEN typeof(NEW.image_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.image_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.image_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.image_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.image_id IS NOT NULL AND CASE WHEN typeof(NEW.image_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.image_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.image_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.image_description) <> 'text' THEN 1
	WHEN length(CAST(NEW.image_description AS BLOB)) > 254 THEN 1
	WHEN instr(CAST(NEW.image_description AS BLOB), x'00') > 0 THEN 1
	WHEN length(CAST(json_quote(NEW.image_description) AS BLOB)) > 256 THEN 1
	ELSE 0 END THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	WHEN NEW.image_url IS '' AND NEW.image_id IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;

CREATE TABLE card_images (
  id TEXT NOT NULL PRIMARY KEY,
  source_url TEXT NOT NULL,
  due_at INTEGER,
  enqueued_at INTEGER NOT NULL,
  claim INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  width INTEGER,
  height INTEGER,
  blurhash TEXT,
  stored_at INTEGER
) WITHOUT ROWID;

CREATE INDEX card_images_due ON card_images (due_at, id) WHERE due_at IS NOT NULL;
CREATE INDEX card_images_expiry ON card_images (enqueued_at) WHERE due_at IS NOT NULL;
CREATE INDEX card_images_stored ON card_images (source_url, stored_at) WHERE stored_at IS NOT NULL;
CREATE INDEX card_images_pending ON card_images (source_url) WHERE due_at IS NOT NULL;
CREATE INDEX card_images_stored_id ON card_images (id) WHERE stored_at IS NOT NULL;
CREATE UNIQUE INDEX card_images_token ON card_images (token) WHERE token IS NOT NULL;

CREATE TRIGGER card_images_bounds_insert BEFORE INSERT ON card_images
WHEN CASE WHEN CASE WHEN typeof(NEW.id) <> 'text' THEN 1
	WHEN length(CAST(NEW.id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.source_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.source_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.source_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.source_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.source_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.source_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.width IS NOT NULL AND (typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 1 AND 65535) THEN 1
	WHEN NEW.height IS NOT NULL AND (typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 1 AND 65535) THEN 1
	WHEN CASE WHEN NEW.blurhash IS NULL THEN 0
	WHEN typeof(NEW.blurhash) <> 'text' THEN 1
	WHEN length(CAST(NEW.blurhash AS BLOB)) NOT BETWEEN 6 AND 54 THEN 1
	WHEN instr(CAST(NEW.blurhash AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(NEW.blurhash, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~') <> '' THEN 1
	WHEN (SELECT f % 9 >= 5 OR f / 9 >= 5
			OR length(NEW.blurhash) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~', substr(NEW.blurhash, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN (NEW.due_at IS NULL) = (NEW.stored_at IS NULL) THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (NEW.token IS NULL OR NEW.width IS NULL OR NEW.height IS NULL) THEN 1
	WHEN NEW.stored_at IS NULL AND (NEW.token IS NOT NULL OR NEW.width IS NOT NULL OR NEW.height IS NOT NULL
		OR NEW.blurhash IS NOT NULL) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'card_images: a value past its stored bound');
END;

CREATE TRIGGER card_images_bounds_update BEFORE UPDATE OF id, source_url, due_at, enqueued_at, claim, attempts, token, width, height, blurhash, stored_at ON card_images
WHEN CASE WHEN CASE WHEN typeof(NEW.id) <> 'text' THEN 1
	WHEN length(CAST(NEW.id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.source_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.source_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.source_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.source_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.source_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.source_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 2 THEN 1
	WHEN CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.width IS NOT NULL AND (typeof(NEW.width) <> 'integer' OR NEW.width NOT BETWEEN 1 AND 65535) THEN 1
	WHEN NEW.height IS NOT NULL AND (typeof(NEW.height) <> 'integer' OR NEW.height NOT BETWEEN 1 AND 65535) THEN 1
	WHEN CASE WHEN NEW.blurhash IS NULL THEN 0
	WHEN typeof(NEW.blurhash) <> 'text' THEN 1
	WHEN length(CAST(NEW.blurhash AS BLOB)) NOT BETWEEN 6 AND 54 THEN 1
	WHEN instr(CAST(NEW.blurhash AS BLOB), x'00') > 0 THEN 1
	WHEN rtrim(NEW.blurhash, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~') <> '' THEN 1
	WHEN (SELECT f % 9 >= 5 OR f / 9 >= 5
			OR length(NEW.blurhash) <> 4 + 2 * (f % 9 + 1) * (f / 9 + 1)
		FROM (SELECT instr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~', substr(NEW.blurhash, 1, 1)) - 1 AS f)) THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN (NEW.due_at IS NULL) = (NEW.stored_at IS NULL) THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (NEW.token IS NULL OR NEW.width IS NULL OR NEW.height IS NULL) THEN 1
	WHEN NEW.stored_at IS NULL AND (NEW.token IS NOT NULL OR NEW.width IS NOT NULL OR NEW.height IS NOT NULL
		OR NEW.blurhash IS NOT NULL) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'card_images: a value past its stored bound');
END;
