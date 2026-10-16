-- Kopje Store schema 0028: the streaming API's home events (`user`: update, status.update, delete). Never edit after
-- release (checksummed).
--
-- Migration 0026_streaming made the journal (stream_events) with the notification trigger. This file adds what the
-- `user` stream carries of statuses (src/domain/streaming.ts, src/stream-hub.ts):
--
--   stream_status_inserted  a trigger that journals a status (or boost) inserted while some account subscribes to
--                           `user`, as 'status' (the `update` event). Ids only: each message is judged when it is made
--                           (R33), by home positioned at the status.
--   stream_status_edited    a trigger that journals a status whose edited_at changed while some account subscribes to
--                           `user` or `user:notification`, as 'edit' (`status.update`: home, or the mention).
--   stream_delete_viewers   the capture of a delete (R32): written once, before the first change to the status's
--                           audience, one row per account listening on `user` that could view the status (R3), with
--                           the boosts of it the account could view (at most 40), and with the list ids whose read
--                           returned it (empty until lists stream). It names its journal row by id only, with no
--                           foreign key: streamPrune deletes a finished event's journal row at once, so the journal's
--                           span shrinks, and its capture rows in bounded chunks after.
--   stream_cursor.subject   the position within a viewer's units of a delete event: the status is subject 0, the
--                           viewer's captured boosts follow by id, so a unit is one subject for one viewer.
--   stream_subscriptions_key the registry by stream key, so the triggers' guard and the capture seek a key's listeners
--                           rather than scan every account's keys.
--
-- Both triggers record nothing once the journal spans 4,096 ids, as 0026's does. Every table here is streaming state
-- of one object: dumps leave them out (stream_*, src/platform/dump-catalog.ts).
--
-- The registry and the position hold rows of the open sockets only (at most 256 accounts of 16 keys each, and one
-- position row), the journal and its captures are empty or bounded by the same caps: indexing the registry and adding
-- a column with a constant default do not read the Store's statuses, so the work of this file does not grow with them.

CREATE INDEX stream_subscriptions_key ON stream_subscriptions (stream_key, account_id);

ALTER TABLE stream_cursor ADD COLUMN subject INTEGER NOT NULL DEFAULT 0;

CREATE TABLE stream_delete_viewers (
  event_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  lists TEXT NOT NULL,   -- JSON: subscribed list ids whose positioned read returned the status
  boosts TEXT NOT NULL,  -- JSON: [[boost id, [list ids]], ...], oldest first, at most 40
  PRIMARY KEY (event_id, account_id)
) WITHOUT ROWID;

CREATE TRIGGER stream_status_inserted AFTER INSERT ON statuses
WHEN EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key = 'user')
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('status', NEW.id, NEW.created_at);
END;

CREATE TRIGGER stream_status_edited AFTER UPDATE OF edited_at ON statuses
WHEN NEW.edited_at IS NOT NULL AND NEW.edited_at IS NOT OLD.edited_at
  AND EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key IN ('user', 'user:notification'))
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('edit', NEW.id, NEW.edited_at);
END;
