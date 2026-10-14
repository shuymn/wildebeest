-- Kopje Store schema 0001: blocks and mutes. Applied by the Store DO after 0000; never edit after release (checksummed).

-- Mute expiry. POST /api/v1/accounts/:id/mute takes a duration (Mastodon's Mute#expires_at). A mute applies while
-- expires_at is NULL (indefinite) or later than the time a read or write is judged at, so an expired mute stops
-- applying at once, whether or not it has been removed yet. The partial index lets a sweep remove expired mutes in
-- bounded batches.

ALTER TABLE mutes ADD COLUMN expires_at TEXT;                 -- ISO 8601 UTC, like created_at; NULL: indefinite

CREATE INDEX mutes_expires ON mutes (expires_at) WHERE expires_at IS NOT NULL;

-- The work a user's domain block leaves (Mastodon's AfterBlockDomainFromAccountService): the user's follows to and
-- from accounts of the domain end, in bounded batches that scan follows by id up to bound (the newest follow when
-- the domain was blocked; later follows across the block are refused). cursor is the last follows.id scanned. The row
-- goes with its domain block, so an unblock stops what remains, and is deleted when the scan reaches bound.
CREATE TABLE domain_block_cleanups (
  domain_block_id INTEGER NOT NULL PRIMARY KEY REFERENCES domain_blocks (id) ON DELETE CASCADE,
  bound INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL                     -- epoch ms, like the other queue-like tables
);

-- The next cleanup to run, oldest first, without scanning or sorting the pending ones.
CREATE INDEX domain_block_cleanups_next ON domain_block_cleanups (created_at, domain_block_id);
