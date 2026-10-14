-- Kopje Store schema 0001: mute expiry. Applied by the Store DO after 0000; never edit after release (checksummed).
--
-- POST /api/v1/accounts/:id/mute takes a duration (Mastodon's Mute#expires_at). A mute applies while expires_at is
-- NULL (indefinite) or later than the time a read or write is judged at, so an expired mute stops applying at once,
-- whether or not it has been removed yet. The partial index lets a sweep remove expired mutes in bounded batches.

ALTER TABLE mutes ADD COLUMN expires_at TEXT;                 -- ISO 8601 UTC, like created_at; NULL: indefinite

CREATE INDEX mutes_expires ON mutes (expires_at) WHERE expires_at IS NOT NULL;
