-- Kopje Store schema 0069: oEmbed and twitter:player cards (Mastodon 4.5's PreviewCard type, width, height and html,
-- and its oEmbed endpoint cache). Never edit after release (checksummed).
--
--   status_cards                  six columns: card_type (0 link, 1 photo, 2 video), width and height (0 to 65,535),
--                                 embed_src (a video iframe's decoded src, '' for none) and iframe_width and
--                                 iframe_height (NULL when the iframe omits them), defaulted so every existing row is a
--                                 link of 0 by 0 without an embed; no row is rewritten.
--   status_cards_bounds_insert    dropped and recreated over every column, the new ones included: BEFORE INSERT and
--   status_cards_bounds_update    BEFORE UPDATE of every column, RAISE(ABORT, 'status_cards: a value past its stored
--                                 bound') for a value past its bound (0067's cases, then the new columns: an
--                                 embed_src of http(s) printable ASCII without "<>\^`{|}, within 512 bytes raw and
--                                 escaped once, & as &amp;), or a video without an embed_src, or an iframe dimension
--                                 without one. No trigger writes.
--   card_oembed_endpoints         one row per host whose page declared an oEmbed endpoint (src/domain/link-cards.ts):
--                                 the endpoint's template ({url} after an =) and when it expires (24 hours after it is
--                                 written). No foreign key.
--   card_oembed_endpoints_expiry  the rows by (expires_at, domain): the claim's ordered expiry from both ends.
--   card_oembed_endpoints_bounds_insert  BEFORE INSERT and BEFORE UPDATE of every column on card_oembed_endpoints:
--   card_oembed_endpoints_bounds_update  RAISE(ABORT, 'card_oembed_endpoints: a value past its stored bound') for a
--                                 host that is not 1 to 253 bytes of a-z, 0-9, '.' and '-', a template that is not
--                                 https printable ASCII of 1 to 2,048 bytes without "<>\^`| holding {url} after an =
--                                 and no other brace, or a time that is not an integer from 0 to 2^53 - 1. No trigger
--                                 writes.
--
-- Bounds and the predicates: src/platform/stored-bounds.ts (CARD_EMBED_SRC_BYTES, CARD_DIMENSION_MAX,
-- OEMBED_TEMPLATE_BYTES, statusCardPastBoundSql, oembedEndpointPastBoundSql); the statements below are the output of
-- cardEmbedsMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the columns are added to the schema only, the triggers read no row, and the new table is empty.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000
-- statuses with their mentions and tags, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local accounts,
-- 200,000 attached and 10,000 pending status cards) in workerd's local Durable Object SQLite, with the whole Store's
-- foreign keys verified (the file creates a table, so it is not declared foreignKeys: 'unchanged'): 9,775 ms for the
-- upgrade of this file through the kernel, within the budget.

ALTER TABLE status_cards ADD COLUMN card_type INTEGER NOT NULL DEFAULT 0;
ALTER TABLE status_cards ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE status_cards ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
ALTER TABLE status_cards ADD COLUMN embed_src TEXT NOT NULL DEFAULT '';
ALTER TABLE status_cards ADD COLUMN iframe_width INTEGER;
ALTER TABLE status_cards ADD COLUMN iframe_height INTEGER;

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
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;

CREATE TRIGGER status_cards_bounds_update BEFORE UPDATE OF status_id, url, due_at, enqueued_at, claim, attempts, generation, title, description, author_name, author_url, provider_name, provider_url, language, published_at, fetched_at, card_type, width, height, embed_src, iframe_width, iframe_height ON status_cards
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
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;

CREATE TABLE card_oembed_endpoints (
  domain TEXT NOT NULL PRIMARY KEY,
  template TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX card_oembed_endpoints_expiry ON card_oembed_endpoints (expires_at, domain);

CREATE TRIGGER card_oembed_endpoints_bounds_insert BEFORE INSERT ON card_oembed_endpoints
WHEN CASE WHEN CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 1 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.template) <> 'text' THEN 1
	WHEN length(CAST(NEW.template AS BLOB)) NOT BETWEEN 1 AND 2048 THEN 1
	WHEN instr(CAST(NEW.template AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.template NOT GLOB 'https://?*' THEN 1
	WHEN NEW.template GLOB '*[^!-~]*' THEN 1
	WHEN NEW.template GLOB '*["<>\^`|]*' THEN 1
	WHEN instr(NEW.template, '={url}') = 0 THEN 1
	WHEN replace(NEW.template, '={url}', '') GLOB '*[{}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.expires_at) <> 'integer' OR NEW.expires_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'card_oembed_endpoints: a value past its stored bound');
END;

CREATE TRIGGER card_oembed_endpoints_bounds_update BEFORE UPDATE OF domain, template, expires_at ON card_oembed_endpoints
WHEN CASE WHEN CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 1 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.template) <> 'text' THEN 1
	WHEN length(CAST(NEW.template AS BLOB)) NOT BETWEEN 1 AND 2048 THEN 1
	WHEN instr(CAST(NEW.template AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.template NOT GLOB 'https://?*' THEN 1
	WHEN NEW.template GLOB '*[^!-~]*' THEN 1
	WHEN NEW.template GLOB '*["<>\^`|]*' THEN 1
	WHEN instr(NEW.template, '={url}') = 0 THEN 1
	WHEN replace(NEW.template, '={url}', '') GLOB '*[{}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.expires_at) <> 'integer' OR NEW.expires_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'card_oembed_endpoints: a value past its stored bound');
END;
