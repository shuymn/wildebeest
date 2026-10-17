-- Kopje Store schema 0035: the streaming API's public and hashtag streams (`public[:local|:remote][:media]` and
-- `hashtag[:local]`: update, status.update, delete). Never edit after release (checksummed).
--
-- Migrations 0026_streaming, 0028_streaming_home and 0032_streaming_lists made the journal (stream_events), its
-- triggers and the delete's capture for `user`, lists and `direct`. This file adds what the public and hashtag streams
-- need (src/domain/streaming.ts, src/stream-hub.ts):
--
--   stream_status_inserted,  recreated so a public status that is not a boost, inserted or edited, is journaled while
--   stream_status_edited     some account subscribes to a `public*` stream or a hashtag (`hashtag:<tag>` or
--                            `hashtag:local:<tag>`) too. Each message is still judged when it is made (R33), by the
--                            public or the hashtag's timeline positioned at the status. They fire on the same writes as
--                            before (a status insert, a change of edited_at), which no batched delete or purge makes.
--   stream_delete_tombstones the delete's tombstone (R32): written once with the capture, for a public status that is
--                            not a boost while some account listens on a feed it would reach. Whether the status was
--                            local and had media, and those of its hashtags some account subscribed to (at most
--                            MAX_STATUS_TAGS, each a subscribed key's tag of at most 256 bytes: under 27 KiB). The
--                            feeds a `delete` goes on are matched against it when it is sent. It names its journal row
--                            by id only, as stream_delete_viewers does: streamPrune deletes it after the event's
--                            viewers, in the same bounded calls.
--
-- Both triggers record nothing once the journal spans 4,096 ids, as before. The tombstone is streaming state of one
-- object: dumps leave it out (stream_*, src/platform/dump-catalog.ts).
--
-- Creating an empty table and triggers reads no row, so the work of this file does not grow with the Store.

CREATE TABLE stream_delete_tombstones (
  event_id INTEGER PRIMARY KEY,
  local INTEGER NOT NULL CHECK (local IN (0, 1)),
  media INTEGER NOT NULL CHECK (media IN (0, 1)),
  tags TEXT NOT NULL  -- JSON: the status's normalized hashtags some listener subscribed to
);

DROP TRIGGER stream_status_inserted;
DROP TRIGGER stream_status_edited;

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
