-- Kopje Store schema 0032: the streaming API's lists and direct messages (`list`: update, status.update, delete;
-- `direct`: conversation). Never edit after release (checksummed).
--
-- Migrations 0026_streaming and 0028_streaming_home made the journal (stream_events) and its triggers for `user`. This
-- file adds what the `list` and `direct` streams need (src/domain/streaming.ts, src/stream-hub.ts):
--
--   stream_status_inserted,  recreated so a status (or boost) inserted or edited is journaled while some account
--   stream_status_edited     subscribes to a list (`list:<id>`) too, not only to `user` (or `user:notification`). Each
--                            message is still judged when it is made (R33), by the list's read positioned at the
--                            status.
--   stream_conversation_marks the per-owner high-water mark of conversation changes: created at the owner's first
--                            `direct` subscription from the highest stream_seq of their conversations, never lowered or
--                            deleted (but with the account). Every write of a conversation of an owner with a mark
--                            takes the next value and stores it in the row's stream_seq, in the same write.
--   conversations.stream_seq the change sequence of the row (0 until its owner has a mark), and conversations_stream,
--                            the index an owner's newest changes are read through (at most 20 an event).
--   stream_events            rebuilt to admit the kind 'conversation' (its CHECK names the kinds), with the same rows
--                            and ids, and the triggers that write it made again; stream_events_conversation indexes
--                            the conversation rows by owner.
--   stream_cursor.ceiling   the highest change a conversation event sends, fixed when the fan-out enters the event (the
--                            owner's mark then, in the same write): later changes go to the owner's next row, so the
--                            event ends after at most 20 units however fast the owner's conversations change.
--   stream_conversation_changed a trigger that journals a 'conversation' event for the owner when its mark moves,
--                            unless the owner has one after the fan-out's position (not yet consumed): a burst of
--                            changes is one row, and a change after the row was consumed is a new row at the end.
--   conversation_statuses_removed recreated: when a status's removal moves a conversation's last status back, the
--                            owner's mark (if any) moves first, and the row takes its value. A link's delete therefore
--                            writes at most four rows (the link, the mark, its journal row, the conversation), and the
--                            batched delete that removes links (STATUS_CHILDREN in src/domain/inbox.ts) takes a fourth
--                            of the rows left.
--
-- The mark is streaming state of one object: dumps leave it out (stream_*, src/platform/dump-catalog.ts), and a
-- restored Store makes it again from the restored stream_seq, so it never moves back.
--
-- Adding a column with a constant default reads nothing, and the triggers read no row when made. The index reads each
-- conversation once; the journal's copy reads its rows, at most a 4,096-id span; nothing else of the Store is read.

ALTER TABLE stream_cursor ADD COLUMN ceiling INTEGER;

CREATE TABLE stream_conversation_marks (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL
) WITHOUT ROWID;

ALTER TABLE conversations ADD COLUMN stream_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX conversations_stream ON conversations (account_id, stream_seq);

DROP TRIGGER stream_notification_inserted;
DROP TRIGGER stream_status_inserted;
DROP TRIGGER stream_status_edited;

CREATE TABLE stream_events_next (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('status', 'edit', 'notification', 'delete', 'merged', 'conversation')),
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
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;'))
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('status', NEW.id, NEW.created_at);
END;

CREATE TRIGGER stream_status_edited AFTER UPDATE OF edited_at ON statuses
WHEN NEW.edited_at IS NOT NULL AND NEW.edited_at IS NOT OLD.edited_at
  AND (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key IN ('user', 'user:notification'))
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;'))
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

DROP TRIGGER conversation_statuses_removed;

CREATE TRIGGER conversation_statuses_removed AFTER DELETE ON conversation_statuses
WHEN EXISTS (SELECT 1 FROM conversations WHERE id = OLD.conversation_id)
BEGIN
  UPDATE stream_conversation_marks SET seq = seq + 1
    WHERE account_id = (SELECT account_id FROM conversations WHERE id = OLD.conversation_id
        AND last_status_id = OLD.status_id)
      AND EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
  UPDATE conversations
    SET last_status_id = (SELECT max(status_id) FROM conversation_statuses WHERE conversation_id = OLD.conversation_id),
      stream_seq = coalesce((SELECT m.seq FROM stream_conversation_marks m WHERE m.account_id = conversations.account_id),
        stream_seq)
    WHERE id = OLD.conversation_id AND last_status_id = OLD.status_id
      AND EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
  DELETE FROM conversations WHERE id = OLD.conversation_id
    AND NOT EXISTS (SELECT 1 FROM conversation_statuses WHERE conversation_id = OLD.conversation_id);
END;
