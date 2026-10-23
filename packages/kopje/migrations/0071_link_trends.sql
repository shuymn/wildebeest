-- Kopje Store schema 0071: link trends (Mastodon 4.5's PreviewCardTrend, PreviewCard#link_type and the trendable
-- reviews of preview cards and their providers). Never edit after release (checksummed).
--
--   status_cards                  three columns: link_type (0 unknown, 1 article: JSON-LD NewsArticle or og:type
--                                 article), final_url (the fetched page's URL after redirects, '' for none: the card's
--                                 trend identity) and public (1 only on an attached row with a final URL whose status
--                                 is public), defaulted so every existing row is unknown, without a final URL and not
--                                 public; no row is rewritten.
--   status_cards_bounds_insert    dropped and recreated over every column, the new ones included: 0070's cases, then a
--   status_cards_bounds_update    link_type that is not 0 or 1, a final_url that is neither '' nor a card URL, a public
--                                 that is not 0 or 1, and public = 1 on a pending row, without a final URL or under a
--                                 status that is not public (one key seek of statuses). No trigger writes.
--   status_cards_public_link      the public attached rows by (final_url, status_id): every read of a link's copies.
--   statuses_public_boosts        the public boosts by (reblog_of_id, id): every read of an original's boosts.
--   trend_links                   links the cron scores (src/domain/trends.ts trendsRound), by final URL, with their
--                                 domain, language, the decayed score (listed at 1 or more) and its peak. At most 250:
--                                 200 allowed, 50 for review.
--   trend_links_listed            the listed rows by score.
--   link_trend_reviews            the Access admin's decisions on a link (by URL) and on a publisher (by domain, which
--   link_provider_reviews         covers its subdomains). At most 10,000 each.
--
-- Caps refuse only a new key when full, so an update or upsert of a stored key always passes. Bounds and the
-- predicates: src/platform/stored-bounds.ts (LINK_TYPES, MAX_TREND_LINKS, LINK_DOMAIN_BYTES, statusCardPastBoundSql,
-- trendLinkPastBoundSql, linkReviewPastBoundSql); the statements below are the output of linkTrendsMigrationSql
-- (test/migrations.test.ts compares them); stored form and the membership invariant: docs/dump-format.md. No trigger
-- reads the time.
--
-- Cost: the columns are added to the schema only, the triggers read no row, the new tables are empty, and the two
-- indexes read status_cards and statuses once each.

ALTER TABLE status_cards ADD COLUMN link_type INTEGER NOT NULL DEFAULT 0;
ALTER TABLE status_cards ADD COLUMN final_url TEXT NOT NULL DEFAULT '';
ALTER TABLE status_cards ADD COLUMN public INTEGER NOT NULL DEFAULT 0;

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
	WHEN typeof(NEW.link_type) <> 'integer' OR NEW.link_type NOT BETWEEN 0 AND 1 THEN 1
	WHEN NEW.final_url IS NOT '' AND CASE WHEN typeof(NEW.final_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.final_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.final_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.final_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.final_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.final_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.public) <> 'integer' OR NEW.public NOT BETWEEN 0 AND 1 THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	WHEN NEW.image_url IS '' AND NEW.image_id IS NOT NULL THEN 1
	WHEN NEW.public = 1 AND (NEW.fetched_at IS NULL OR NEW.final_url = ''
		OR (SELECT ps.visibility FROM main.statuses ps WHERE ps.id = NEW.status_id) IS NOT 'public') THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;

CREATE TRIGGER status_cards_bounds_update BEFORE UPDATE OF status_id, url, due_at, enqueued_at, claim, attempts, generation, title, description, author_name, author_url, provider_name, provider_url, language, published_at, fetched_at, card_type, width, height, embed_src, iframe_width, iframe_height, image_url, image_id, image_description, link_type, final_url, public ON status_cards
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
	WHEN typeof(NEW.link_type) <> 'integer' OR NEW.link_type NOT BETWEEN 0 AND 1 THEN 1
	WHEN NEW.final_url IS NOT '' AND CASE WHEN typeof(NEW.final_url) <> 'text' THEN 1
	WHEN length(CAST(NEW.final_url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.final_url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.final_url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.final_url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.final_url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.public) <> 'integer' OR NEW.public NOT BETWEEN 0 AND 1 THEN 1
	WHEN (NEW.card_type = 2) <> (NEW.embed_src <> '') THEN 1
	WHEN NEW.embed_src = '' AND (NEW.iframe_width IS NOT NULL OR NEW.iframe_height IS NOT NULL) THEN 1
	WHEN NEW.image_url IS '' AND NEW.image_id IS NOT NULL THEN 1
	WHEN NEW.public = 1 AND (NEW.fetched_at IS NULL OR NEW.final_url = ''
		OR (SELECT ps.visibility FROM main.statuses ps WHERE ps.id = NEW.status_id) IS NOT 'public') THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'status_cards: a value past its stored bound');
END;

CREATE INDEX status_cards_public_link ON status_cards (final_url, status_id)
  WHERE public = 1 AND fetched_at IS NOT NULL AND final_url <> '';
CREATE INDEX statuses_public_boosts ON statuses (reblog_of_id, id)
  WHERE reblog_of_id IS NOT NULL AND visibility = 'public';

CREATE TABLE trend_links (
  url TEXT NOT NULL PRIMARY KEY,
  domain TEXT NOT NULL,
  language TEXT,
  score REAL NOT NULL,
  max_score REAL NOT NULL,
  max_score_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX trend_links_listed ON trend_links (score DESC, url) WHERE score >= 1;

CREATE TRIGGER trend_links_bounds_insert BEFORE INSERT ON trend_links
WHEN CASE WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.score) NOT IN ('integer', 'real') OR NEW.score NOT BETWEEN 0 AND 1000000000000000 THEN 1
	WHEN typeof(NEW.max_score) NOT IN ('integer', 'real')
		OR NEW.max_score NOT BETWEEN NEW.score AND 1000000000000000 THEN 1
	WHEN (CASE WHEN length(CAST(NEW.max_score_at AS BLOB)) = 24 AND substr(NEW.max_score_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.max_score_at) = NEW.max_score_at THEN NEW.max_score_at END) IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'trend_links: a value past its stored bound');
END;

CREATE TRIGGER trend_links_bounds_update BEFORE UPDATE OF url, domain, language, score, max_score, max_score_at ON trend_links
WHEN CASE WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.language IS NULL THEN 0
	WHEN typeof(NEW.language) <> 'text' THEN 1
	WHEN length(CAST(NEW.language AS BLOB)) NOT BETWEEN 2 AND 7 THEN 1
	WHEN instr(CAST(NEW.language AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.language GLOB '*[^A-Za-z-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.score) NOT IN ('integer', 'real') OR NEW.score NOT BETWEEN 0 AND 1000000000000000 THEN 1
	WHEN typeof(NEW.max_score) NOT IN ('integer', 'real')
		OR NEW.max_score NOT BETWEEN NEW.score AND 1000000000000000 THEN 1
	WHEN (CASE WHEN length(CAST(NEW.max_score_at AS BLOB)) = 24 AND substr(NEW.max_score_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.max_score_at) = NEW.max_score_at THEN NEW.max_score_at END) IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'trend_links: a value past its stored bound');
END;

CREATE TRIGGER trend_links_cap BEFORE INSERT ON trend_links
WHEN NOT EXISTS (SELECT 1 FROM trend_links WHERE url = NEW.url) AND (SELECT count(*) FROM trend_links) >= 250
BEGIN
  SELECT RAISE(ABORT, 'trend_links: more than 250');
END;

CREATE TABLE link_trend_reviews (
  url TEXT NOT NULL PRIMARY KEY,
  trendable INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER link_trend_reviews_bounds_insert BEFORE INSERT ON link_trend_reviews
WHEN CASE WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.trendable) <> 'integer' OR NEW.trendable NOT BETWEEN 0 AND 1 THEN 1
	WHEN (CASE WHEN length(CAST(NEW.reviewed_at AS BLOB)) = 24 AND substr(NEW.reviewed_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.reviewed_at) = NEW.reviewed_at THEN NEW.reviewed_at END) IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'link_trend_reviews: a value past its stored bound');
END;

CREATE TRIGGER link_trend_reviews_bounds_update BEFORE UPDATE OF url, trendable, reviewed_at ON link_trend_reviews
WHEN CASE WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.trendable) <> 'integer' OR NEW.trendable NOT BETWEEN 0 AND 1 THEN 1
	WHEN (CASE WHEN length(CAST(NEW.reviewed_at AS BLOB)) = 24 AND substr(NEW.reviewed_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.reviewed_at) = NEW.reviewed_at THEN NEW.reviewed_at END) IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'link_trend_reviews: a value past its stored bound');
END;

CREATE TRIGGER link_trend_reviews_cap BEFORE INSERT ON link_trend_reviews
WHEN NOT EXISTS (SELECT 1 FROM link_trend_reviews WHERE url = NEW.url) AND (SELECT count(*) FROM link_trend_reviews) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'link_trend_reviews: more than 10000');
END;

CREATE TABLE link_provider_reviews (
  domain TEXT NOT NULL PRIMARY KEY,
  trendable INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER link_provider_reviews_bounds_insert BEFORE INSERT ON link_provider_reviews
WHEN CASE WHEN CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.trendable) <> 'integer' OR NEW.trendable NOT BETWEEN 0 AND 1 THEN 1
	WHEN (CASE WHEN length(CAST(NEW.reviewed_at AS BLOB)) = 24 AND substr(NEW.reviewed_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.reviewed_at) = NEW.reviewed_at THEN NEW.reviewed_at END) IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'link_provider_reviews: a value past its stored bound');
END;

CREATE TRIGGER link_provider_reviews_bounds_update BEFORE UPDATE OF domain, trendable, reviewed_at ON link_provider_reviews
WHEN CASE WHEN CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.trendable) <> 'integer' OR NEW.trendable NOT BETWEEN 0 AND 1 THEN 1
	WHEN (CASE WHEN length(CAST(NEW.reviewed_at AS BLOB)) = 24 AND substr(NEW.reviewed_at, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.reviewed_at) = NEW.reviewed_at THEN NEW.reviewed_at END) IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'link_provider_reviews: a value past its stored bound');
END;

CREATE TRIGGER link_provider_reviews_cap BEFORE INSERT ON link_provider_reviews
WHEN NOT EXISTS (SELECT 1 FROM link_provider_reviews WHERE domain = NEW.domain) AND (SELECT count(*) FROM link_provider_reviews) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'link_provider_reviews: more than 10000');
END;
