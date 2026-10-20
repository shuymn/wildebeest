-- Kopje Store schema 0057: trends (Mastodon 4.5's TagTrend, StatusTrend, Tag#max_score and the trendable reviews of
-- tags, statuses and accounts) and the trends settings. Never edit after release (checksummed).
--
--   trend_tags             hashtags the cron scores (src/domain/trends.ts trendsRound): the decayed score (listed at 1
--                          or more) and the peak it decays from. At most 250: 200 allowed, 50 for review.
--   trend_statuses         statuses the cron scores, with their author. At most 250, 3 per author.
--   tag_trend_reviews, status_trend_reviews, account_trend_reviews   the Access admin's decisions. At most 10,000 each.
--   instance_settings      two triggers bound `trends` and `trendable_by_default` to 'true' or 'false'.
--
-- Caps refuse only a new key when full, so an update or upsert of a stored key always passes. Each name CHECK judges
-- raw bytes first, then NUL, then characters, then the ASCII a normalized hashtag holds (0-9, _, a-z).
-- Bounds: src/platform/stored-bounds.ts (MAX_TREND_TAGS, MAX_TREND_STATUSES, TREND_STATUSES_PER_AUTHOR,
-- MAX_TREND_REVIEWS, TREND_SCORE_MAX, trendTagNameCheckSql), which test/migrations.test.ts compares with the literals
-- below; stored form and refusals: docs/dump-format.md. No trigger reads the time.
--
-- Cost: five empty tables with their indexes and triggers, and two triggers; nothing is read.

CREATE TABLE trend_tags (
  name TEXT NOT NULL PRIMARY KEY,
  score REAL NOT NULL,
  max_score REAL NOT NULL,
  max_score_at TEXT NOT NULL,
  CONSTRAINT trend_tag_name CHECK (typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND 1024
    AND instr(CAST(name AS BLOB), x'00') = 0 AND length(name) <= 256
    AND name NOT GLOB ('*[' || char(1) || '-/:-^`{-' || char(127) || ']*')),
  CONSTRAINT trend_tag_scores CHECK (typeof(score) IN ('integer', 'real') AND typeof(max_score) IN ('integer', 'real')
    AND score BETWEEN 0 AND 1e15 AND max_score BETWEEN score AND 1e15),
  -- times as Kopje writes them (strftime judges them, as in 0056_announcements; it keeps an hour of 24 as given)
  CONSTRAINT trend_tag_max_score_at_iso CHECK (typeof(max_score_at) = 'text' AND length(CAST(max_score_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', max_score_at) IS max_score_at AND substr(max_score_at, 12, 2) BETWEEN '00' AND '23')
) WITHOUT ROWID;

CREATE INDEX trend_tags_listed ON trend_tags (score DESC, name) WHERE score >= 1;

CREATE TRIGGER trend_tags_cap BEFORE INSERT ON trend_tags
WHEN NOT EXISTS (SELECT 1 FROM trend_tags WHERE name = NEW.name) AND (SELECT count(*) FROM trend_tags) >= 250
BEGIN
  SELECT RAISE(ABORT, 'trend_tags: more than 250');
END;

-- No foreign key on account_id: deleting a status cascades its row, and a purge deletes statuses before the account.
CREATE TABLE trend_statuses (
  status_id TEXT NOT NULL PRIMARY KEY REFERENCES statuses (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  score REAL NOT NULL,
  CONSTRAINT trend_status_ids CHECK (typeof(status_id) = 'text' AND length(CAST(status_id AS BLOB)) = 18 AND length(status_id) = 18
    AND status_id NOT GLOB '*[^0-9]*'
    AND typeof(account_id) = 'text' AND length(CAST(account_id AS BLOB)) = 18 AND length(account_id) = 18
    AND account_id NOT GLOB '*[^0-9]*'),
  CONSTRAINT trend_status_score CHECK (typeof(score) IN ('integer', 'real') AND score BETWEEN 0.3 AND 1e15)
) WITHOUT ROWID;

CREATE INDEX trend_statuses_account ON trend_statuses (account_id, score);

CREATE TRIGGER trend_statuses_cap BEFORE INSERT ON trend_statuses
WHEN NOT EXISTS (SELECT 1 FROM trend_statuses WHERE status_id = NEW.status_id) AND (SELECT count(*) FROM trend_statuses) >= 250
BEGIN
  SELECT RAISE(ABORT, 'trend_statuses: more than 250');
END;

CREATE TRIGGER trend_statuses_per_author BEFORE INSERT ON trend_statuses
WHEN NOT EXISTS (SELECT 1 FROM trend_statuses WHERE status_id = NEW.status_id)
  AND (SELECT count(*) FROM trend_statuses WHERE account_id = NEW.account_id) >= 3
BEGIN
  SELECT RAISE(ABORT, 'trend_statuses: more than 3 for one author');
END;

CREATE TRIGGER trend_statuses_author_insert BEFORE INSERT ON trend_statuses
WHEN NEW.account_id IS NOT (SELECT account_id FROM statuses WHERE id = NEW.status_id)
BEGIN
  SELECT RAISE(ABORT, 'trend_statuses: account_id is the status''s author');
END;

CREATE TRIGGER trend_statuses_author_update BEFORE UPDATE OF status_id, account_id ON trend_statuses
WHEN NEW.status_id IS NOT OLD.status_id OR NEW.account_id IS NOT OLD.account_id
BEGIN
  SELECT RAISE(ABORT, 'trend_statuses: a row''s status and author never change');
END;

CREATE TABLE tag_trend_reviews (
  name TEXT NOT NULL PRIMARY KEY,
  trendable INTEGER NOT NULL CHECK (trendable IN (0, 1)),
  reviewed_at TEXT NOT NULL,
  CONSTRAINT tag_trend_review_name CHECK (typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND 1024
    AND instr(CAST(name AS BLOB), x'00') = 0 AND length(name) <= 256
    AND name NOT GLOB ('*[' || char(1) || '-/:-^`{-' || char(127) || ']*')),
  CONSTRAINT tag_trend_review_at_iso CHECK (typeof(reviewed_at) = 'text' AND length(CAST(reviewed_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at) IS reviewed_at AND substr(reviewed_at, 12, 2) BETWEEN '00' AND '23')
) WITHOUT ROWID;

CREATE TRIGGER tag_trend_reviews_cap BEFORE INSERT ON tag_trend_reviews
WHEN NOT EXISTS (SELECT 1 FROM tag_trend_reviews WHERE name = NEW.name) AND (SELECT count(*) FROM tag_trend_reviews) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'tag_trend_reviews: more than 10000');
END;

CREATE TABLE status_trend_reviews (
  status_id TEXT NOT NULL PRIMARY KEY REFERENCES statuses (id) ON DELETE CASCADE,
  trendable INTEGER NOT NULL CHECK (trendable IN (0, 1)),
  reviewed_at TEXT NOT NULL,
  CONSTRAINT status_trend_review_at_iso CHECK (typeof(reviewed_at) = 'text' AND length(CAST(reviewed_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at) IS reviewed_at AND substr(reviewed_at, 12, 2) BETWEEN '00' AND '23')
) WITHOUT ROWID;

CREATE TRIGGER status_trend_reviews_cap BEFORE INSERT ON status_trend_reviews
WHEN NOT EXISTS (SELECT 1 FROM status_trend_reviews WHERE status_id = NEW.status_id) AND (SELECT count(*) FROM status_trend_reviews) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'status_trend_reviews: more than 10000');
END;

CREATE TABLE account_trend_reviews (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  trendable INTEGER NOT NULL CHECK (trendable IN (0, 1)),
  reviewed_at TEXT NOT NULL,
  CONSTRAINT account_trend_review_at_iso CHECK (typeof(reviewed_at) = 'text' AND length(CAST(reviewed_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at) IS reviewed_at AND substr(reviewed_at, 12, 2) BETWEEN '00' AND '23')
) WITHOUT ROWID;

CREATE TRIGGER account_trend_reviews_cap BEFORE INSERT ON account_trend_reviews
WHEN NOT EXISTS (SELECT 1 FROM account_trend_reviews WHERE account_id = NEW.account_id) AND (SELECT count(*) FROM account_trend_reviews) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'account_trend_reviews: more than 10000');
END;

-- 0049's triggers end in ELSE 0, so they let these names through; these bound them (TREND_SETTING_BOUNDS).
CREATE TRIGGER instance_settings_trends_insert BEFORE INSERT ON instance_settings
WHEN NEW.name IN ('trends', 'trendable_by_default') AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;

CREATE TRIGGER instance_settings_trends_update BEFORE UPDATE OF name, value ON instance_settings
WHEN NEW.name IN ('trends', 'trendable_by_default') AND NEW.value IS NOT 'true' AND NEW.value IS NOT 'false'
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;
