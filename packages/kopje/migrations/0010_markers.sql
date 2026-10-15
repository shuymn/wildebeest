-- Kopje Store schema 0010: timeline markers. Never edit after release (checksummed).
--
-- Where a local user stopped reading home and notifications (Mastodon's Marker): one row per account and timeline,
-- written by POST /api/v1/markers and read by GET /api/v1/markers (domain/markers.ts). last_read_id is kept as the
-- client sent it. version counts the updates that changed it, as Mastodon's lock_version does. The rows belong to the
-- local account and go with it (ON DELETE CASCADE), as its lists and bookmarks do. A new table: it is quick.

CREATE TABLE markers (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  timeline TEXT NOT NULL CHECK (timeline IN ('home', 'notifications')),
  last_read_id TEXT NOT NULL CHECK (length(last_read_id) BETWEEN 1 AND 255),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, timeline)
) WITHOUT ROWID;
