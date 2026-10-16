-- Kopje Store schema 0025: what Kopje learns of a remote account's collections. Never edit after release
-- (checksummed).
--
-- Mastodon learns a remote account's pinned statuses (its featured collection) and featured hashtags (its featuredTags
-- collection) into the same StatusPin and FeaturedTag rows a local account's are, and whether it hides its network
-- (Account#hide_collections) into the same column (ActivityPub::ProcessAccountService, ActivityPub::Activity::Add and
-- Remove). Kopje does the same (src/domain/remote-collections.ts):
--
-- - status_pins and featured_tags name any account from now on: their account_id references accounts (id) where it
--   referenced local_accounts (account_id), so the reads of a profile's pins and featured hashtags serve a remote
--   account as they serve a local one. Each table is created anew under a temporary name, its rows copied, the old
--   table dropped (its index with it) and the new one renamed; the columns, checks and indexes are as before. No
--   foreign key, trigger or view names either table, so nothing else changes. A remote account's rows go in its purge,
--   in batches (purgeRelationships in src/domain/inbox.ts); the cascade from accounts is only a backstop.
-- - accounts.hide_collections is a remote account's hide_collections as Kopje last learned it (1 or 0), NULL until it
--   has learned it and for every local account, whose setting stays in local_accounts.hide_collections. It has no CHECK:
--   adding a column with one makes SQLite check every stored account against it, a scan of all remote accounts; its
--   only writer (applyCollectionSync) writes 0 or 1.
-- - collection_syncs holds the remote accounts whose collections are to be read again (Mastodon's
--   SynchronizeFeaturedCollectionWorker and SynchronizeFeaturedTagsCollectionWorker), one row each, written when the
--   account's document is stored. A sync has two phases (src/domain/remote-collections.ts): a round reads the
--   collections and applies them, leaving the pinned statuses Kopje does not store in collection_pins_pending (at most
--   MAX_REMOTE_PINS per account, with the pin time the collection's order gives each); later rounds fetch those. The
--   row goes once the last request is read through and nothing is pending, or after MAX_SYNC_ATTEMPTS rounds without
--   progress (attempts). due_at is when a round may take it: the time it was asked for, then, once a round takes it,
--   the end of that round's lease, so that a round that died leaves it to a later one. A round seeks the earliest
--   due_at at or before its time through collection_syncs_due, so syncs held by rounds are never read past.
--   generation counts the requests and read_through is the last one read: a request while a round holds the sync (an
--   Update of the actor naming other collections) leaves it to be read again. Both tables go with their account
--   (purgeRelationships, and the cascade as a backstop).
--
-- Cost: the copies read and write each pin and featured hashtag once. Until now only local accounts have them, at
-- most five pins (StatusPinValidator) and ten featured hashtags (FeaturedTag::LIMIT) each, so the work grows with the
-- number of local accounts and with nothing remote. The new column has no default and no CHECK, so SQLite neither
-- rewrites nor reads the accounts; the new table is created empty.

CREATE TABLE status_pins_0025 (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, status_id)
) WITHOUT ROWID;

INSERT INTO status_pins_0025 (account_id, status_id, created_at) SELECT account_id, status_id, created_at FROM status_pins;

DROP TABLE status_pins;

ALTER TABLE status_pins_0025 RENAME TO status_pins;

CREATE INDEX status_pins_status ON status_pins (status_id);

CREATE TABLE featured_tags_0025 (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  statuses_count INTEGER NOT NULL DEFAULT 0 CHECK (statuses_count >= 0),
  last_status_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, name)
);

INSERT INTO featured_tags_0025 (id, account_id, name, display_name, statuses_count, last_status_at, created_at)
SELECT id, account_id, name, display_name, statuses_count, last_status_at, created_at FROM featured_tags;

DROP TABLE featured_tags;

ALTER TABLE featured_tags_0025 RENAME TO featured_tags;

ALTER TABLE accounts ADD COLUMN hide_collections INTEGER;

CREATE TABLE collection_syncs (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  read_through INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX collection_syncs_due ON collection_syncs (due_at);

-- Pinned statuses a read listed that Kopje did not store yet, at most MAX_REMOTE_PINS per account, each with the pin
-- time the collection's order gives it.
CREATE TABLE collection_pins_pending (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (account_id, uri)
) WITHOUT ROWID;
