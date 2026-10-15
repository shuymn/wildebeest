-- Kopje Store schema 0016: followed and featured hashtags. Never edit after release (checksummed).
--
-- Kopje has no table of tags: a hashtag is its normalized name, the name status_tags holds (NFKC, lowercase).
--
-- tag_follows holds the hashtags a local account follows (Mastodon's TagFollow). Home shows the public statuses with
-- them (src/domain/timelines.ts), reading the account's names through the unique (account_id, name) index;
-- GET /api/v1/followed_tags pages them by id, newest first, through tag_follows_account.
--
-- featured_tags holds the hashtags a local account features on its profile (Mastodon's FeaturedTag): the normalized
-- name, the name as the account wrote it (display_name), and statuses_count and last_status_at, the number of the
-- account's public and unlisted statuses with the hashtag and the publication time of the newest. The Store keeps the
-- two up to date as the account's statuses are written, edited and deleted (src/domain/featured-tags.ts), as
-- Mastodon's FeaturedTag#increment and #decrement do, so a read never counts.
--
-- Both belong to the local account and go with it (ON DELETE CASCADE), as its lists and filters do; no remote account
-- has rows here.
--
-- local_accounts.featured_announced is 1 once the account's actor has been sent with its featured and featuredTags
-- collections (an Update of the actor), which other servers need before they accept the Add or Remove of a featured
-- hashtag: an actor they stored before those collections were published names none. 0 for every account at first.
--
-- The file creates empty tables and adds a column with a constant default: its work does not grow with the Store.

CREATE TABLE tag_follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, name)
);

CREATE INDEX tag_follows_account ON tag_follows (account_id, id);

CREATE TABLE featured_tags (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  statuses_count INTEGER NOT NULL DEFAULT 0 CHECK (statuses_count >= 0),
  last_status_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, name)
);

ALTER TABLE local_accounts ADD COLUMN featured_announced INTEGER NOT NULL DEFAULT 0 CHECK (featured_announced IN (0, 1));
