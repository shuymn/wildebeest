-- Kopje Store schema 0056: announcements (Mastodon 4.5's Announcement, AnnouncementReaction and AnnouncementMute)
-- and their streaming events. Never edit after release (checksummed).
--
--   announcements            the Access admin's announcements (src/domain/announcements.ts): the text as written,
--                            rendered when presented; the event's range; publication. At most 1,000, at most 16
--                            of them published or scheduled ("live").
--   announcement_reactions   one row per (announcement, name, local account); at most 8 names per announcement.
--   announcement_dismissals  the local accounts that dismissed (read) an announcement.
--   stream_events            rebuilt to admit 'announcement' and 'announcement_reaction' (its CHECK names the kinds),
--                            with the same rows and ids. The four triggers that write it are made again exactly as
--                            0032_streaming_lists and 0035_streaming_public made them, and so is its index.
--
-- Bounds: src/platform/stored-bounds.ts (ANNOUNCEMENT_TEXT_BYTES, MAX_ANNOUNCEMENTS, MAX_LIVE_ANNOUNCEMENTS,
-- REACTION_NAME_BYTES, MAX_REACTION_NAMES), which test/migrations.test.ts compares with the literals below; stored
-- form and refusals: docs/dump-format.md. Each CHECK judges raw bytes first, then NUL and controls, then the structure.
-- No trigger reads the time, so an imported schedule in the past passes and the cron publishes it.
--
-- Cost: three empty tables with their indexes and triggers, which read no row; the journal's copy reads its rows, at
-- most a 4,096-id span (the triggers stop recording past it). Nothing else is read.

CREATE TABLE announcements (
  id TEXT NOT NULL PRIMARY KEY,
  text TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT announcement_id_is_a_snowflake CHECK (typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 18
    AND length(id) = 18 AND id NOT GLOB '*[^0-9]*'),
  -- bytes, then NUL, then not blank in SQLite's ASCII sense (the writer refuses Unicode-blank text too)
  CONSTRAINT announcement_text_within_10000_bytes CHECK (typeof(text) = 'text'
    AND length(CAST(text AS BLOB)) BETWEEN 1 AND 10000
    AND instr(CAST(text AS BLOB), x'00') = 0
    AND trim(text, ' ' || char(9, 10, 11, 12, 13)) <> ''),
  -- times as Kopje writes them (workerd refuses a long GLOB pattern, so strftime judges them, as in
  -- 0055_local_custom_emojis: it rewrites anything else but hour 24, which it keeps, so the hour is 00 to 23)
  CONSTRAINT announcement_times_iso CHECK (
    (starts_at IS NULL OR (typeof(starts_at) = 'text' AND length(CAST(starts_at AS BLOB)) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', starts_at) IS starts_at AND substr(starts_at, 12, 2) BETWEEN '00' AND '23'))
    AND (ends_at IS NULL OR (typeof(ends_at) = 'text' AND length(CAST(ends_at AS BLOB)) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', ends_at) IS ends_at AND substr(ends_at, 12, 2) BETWEEN '00' AND '23'))
    AND (published_at IS NULL OR (typeof(published_at) = 'text' AND length(CAST(published_at AS BLOB)) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS published_at
      AND substr(published_at, 12, 2) BETWEEN '00' AND '23'))
    AND (scheduled_at IS NULL OR (typeof(scheduled_at) = 'text' AND length(CAST(scheduled_at AS BLOB)) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_at) IS scheduled_at
      AND substr(scheduled_at, 12, 2) BETWEEN '00' AND '23'))
    AND typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) BETWEEN '00' AND '23'
    AND typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND substr(updated_at, 12, 2) BETWEEN '00' AND '23'),
  -- both ends or neither (Mastodon's presence pair), the end not before the start
  CONSTRAINT announcement_range CHECK ((starts_at IS NULL) = (ends_at IS NULL)
    AND (starts_at IS NULL OR ends_at >= starts_at)),
  CONSTRAINT announcement_flags CHECK (all_day IN (0, 1) AND published IN (0, 1)),
  -- published: it has a publication time and no schedule (publish! clears it), so live = published + scheduled
  CONSTRAINT announcement_publication CHECK (published = 0 OR (published_at IS NOT NULL AND scheduled_at IS NULL))
);

CREATE INDEX announcements_published ON announcements (id) WHERE published = 1;
CREATE INDEX announcements_scheduled ON announcements (scheduled_at, id) WHERE scheduled_at IS NOT NULL;

CREATE TRIGGER announcements_cap BEFORE INSERT ON announcements
WHEN (SELECT count(*) FROM announcements) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'announcements: more than 1000');
END;

-- The two counts are disjoint (announcement_publication), each a covering scan of its partial index.
CREATE TRIGGER announcements_live_insert BEFORE INSERT ON announcements
WHEN (NEW.published = 1 OR NEW.scheduled_at IS NOT NULL)
  AND (SELECT count(*) FROM announcements WHERE published = 1)
    + (SELECT count(*) FROM announcements WHERE scheduled_at IS NOT NULL) >= 16
BEGIN
  SELECT RAISE(ABORT, 'announcements: more than 16 published or scheduled');
END;

CREATE TRIGGER announcements_live_update BEFORE UPDATE OF published, scheduled_at ON announcements
WHEN (NEW.published = 1 OR NEW.scheduled_at IS NOT NULL) AND OLD.published = 0 AND OLD.scheduled_at IS NULL
  AND (SELECT count(*) FROM announcements WHERE published = 1)
    + (SELECT count(*) FROM announcements WHERE scheduled_at IS NOT NULL) >= 16
BEGIN
  SELECT RAISE(ABORT, 'announcements: more than 16 published or scheduled');
END;

CREATE TRIGGER announcements_immutable BEFORE UPDATE OF id, created_at ON announcements
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'announcements: an announcement''s id and creation time never change');
END;

CREATE TABLE announcement_reactions (
  id INTEGER PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- no cascade: emoji are never deleted
  custom_emoji_id TEXT REFERENCES custom_emojis (id),
  -- bytes, then NUL and controls, then the form: a custom emoji's name is an ASCII shortcode; any other name holds a
  -- character past ASCII (every emoji does)
  CONSTRAINT announcement_reaction_name_within_128_bytes CHECK (typeof(name) = 'text'
    AND length(CAST(name AS BLOB)) BETWEEN 1 AND 128
    AND instr(CAST(name AS BLOB), x'00') = 0
    AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND CASE WHEN custom_emoji_id IS NULL THEN length(name) < length(CAST(name AS BLOB))
      ELSE name NOT GLOB '*[^A-Za-z0-9_]*' END)
);

CREATE UNIQUE INDEX announcement_reactions_name ON announcement_reactions (announcement_id, name, account_id);
CREATE INDEX announcement_reactions_emoji ON announcement_reactions (custom_emoji_id) WHERE custom_emoji_id IS NOT NULL;

CREATE TRIGGER announcement_reactions_names BEFORE INSERT ON announcement_reactions
WHEN NOT EXISTS (SELECT 1 FROM announcement_reactions WHERE announcement_id = NEW.announcement_id AND name = NEW.name)
  AND (SELECT count(DISTINCT name) FROM announcement_reactions WHERE announcement_id = NEW.announcement_id) >= 8
BEGIN
  SELECT RAISE(ABORT, 'announcement_reactions: more than 8 names for one announcement');
END;

CREATE TRIGGER announcement_reactions_emoji BEFORE INSERT ON announcement_reactions
WHEN NEW.custom_emoji_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM custom_emojis WHERE id = NEW.custom_emoji_id AND shortcode = NEW.name)
BEGIN
  SELECT RAISE(ABORT, 'announcement_reactions: a custom emoji reaction is named by its shortcode');
END;

CREATE TRIGGER announcement_reactions_immutable BEFORE UPDATE ON announcement_reactions
BEGIN
  SELECT RAISE(ABORT, 'announcement_reactions: a reaction is added or removed, never changed');
END;

CREATE TABLE announcement_dismissals (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  announcement_id TEXT NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, announcement_id)
) WITHOUT ROWID;

CREATE INDEX announcement_dismissals_announcement ON announcement_dismissals (announcement_id);

-- The journal, as 0032_streaming_lists rebuilt it, with two more kinds. The triggers that write it name it, so they
-- are dropped before the rebuild and made again after it.
DROP TRIGGER stream_notification_inserted;
DROP TRIGGER stream_status_inserted;
DROP TRIGGER stream_status_edited;
DROP TRIGGER stream_conversation_changed;

CREATE TABLE stream_events_next (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('status', 'edit', 'notification', 'delete', 'merged', 'conversation',
    'announcement', 'announcement_reaction')),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO stream_events_next (id, kind, subject, created_at) SELECT id, kind, subject, created_at FROM stream_events;

DROP TABLE stream_events;

ALTER TABLE stream_events_next RENAME TO stream_events;

CREATE INDEX stream_events_conversation ON stream_events (subject, id) WHERE kind = 'conversation';

CREATE TRIGGER stream_notification_inserted AFTER INSERT ON notifications
WHEN NEW.filtered = 0
  AND EXISTS (SELECT 1 FROM stream_subscriptions WHERE account_id = NEW.account_id)
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('notification', CAST(NEW.id AS TEXT), NEW.created_at);
END;

CREATE TRIGGER stream_status_inserted AFTER INSERT ON statuses
WHEN (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key = 'user')
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;')
    OR (NEW.visibility = 'public' AND NEW.reblog_of_id IS NULL
      AND (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key >= 'public' AND stream_key < 'public;')
        OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'hashtag:' AND stream_key < 'hashtag;'))))
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('status', NEW.id, NEW.created_at);
END;

CREATE TRIGGER stream_status_edited AFTER UPDATE OF edited_at ON statuses
WHEN NEW.edited_at IS NOT NULL AND NEW.edited_at IS NOT OLD.edited_at
  AND (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key IN ('user', 'user:notification'))
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;')
    OR (NEW.visibility = 'public' AND NEW.reblog_of_id IS NULL
      AND (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key >= 'public' AND stream_key < 'public;')
        OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'hashtag:' AND stream_key < 'hashtag;'))))
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('edit', NEW.id, NEW.edited_at);
END;

CREATE TRIGGER stream_conversation_changed AFTER UPDATE OF seq ON stream_conversation_marks
WHEN NOT EXISTS (SELECT 1 FROM stream_events WHERE kind = 'conversation' AND subject = NEW.account_id
    AND id > (SELECT event_id FROM stream_cursor WHERE id = 1))
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at)
  VALUES ('conversation', NEW.account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
