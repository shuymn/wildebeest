-- Kopje Store schema 0033: the streaming API's lists and direct messages (`list`: update, status.update, delete;
-- `direct`: conversation). Never edit after release (checksummed).
--
-- Migrations 0026_streaming and 0028_streaming_home made the journal (stream_events) and its triggers for `user`. This
-- file adds what the `list` and `direct` streams need (src/domain/streaming.ts, src/stream-hub.ts):
--
--   stream_status_inserted,  recreated so a status (or boost) inserted or edited is journaled while some account
--   stream_status_edited     subscribes to a list (`list:<id>`) too, not only to `user` (or `user:notification`). Each
--                            message is still judged when it is made (R33), by the list's read positioned at the status.
--   stream_conversation_marks the per-owner high-water mark of conversation changes: created at the owner's first
--                            `direct` subscription from the highest stream_seq of their conversations, never lowered or
--                            deleted (but with the account). Every write of a conversation of an owner with a mark takes
--                            the next value and stores it in the row's stream_seq, in the same write.
--   conversations.stream_seq the change sequence of the row (0 until its owner has a mark), and conversations_stream,
--                            the index a turn reads an owner's newest changes through (at most 20 a turn).
--   conversation_statuses_removed recreated: when a status's removal moves a conversation's last status back, the
--                            owner's mark (if any) moves first, and the row takes its value. A link's delete therefore
--                            writes at most three rows (the link, the mark, the conversation), and the batched delete
--                            that removes links (STATUS_CHILDREN in src/domain/inbox.ts) takes a third of the rows left.
--
-- The mark is streaming state of one object: dumps leave it out (stream_*, src/platform/dump-catalog.ts), and a
-- restored Store makes it again from the restored stream_seq, so it never moves back.
--
-- Adding a column with a constant default reads nothing, and the triggers read no row when made. The index reads each
-- conversation once; nothing else of the Store is read.

CREATE TABLE stream_conversation_marks (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL
) WITHOUT ROWID;

ALTER TABLE conversations ADD COLUMN stream_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX conversations_stream ON conversations (account_id, stream_seq);

DROP TRIGGER stream_status_inserted;

CREATE TRIGGER stream_status_inserted AFTER INSERT ON statuses
WHEN (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key = 'user')
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;'))
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('status', NEW.id, NEW.created_at);
END;

DROP TRIGGER stream_status_edited;

CREATE TRIGGER stream_status_edited AFTER UPDATE OF edited_at ON statuses
WHEN NEW.edited_at IS NOT NULL AND NEW.edited_at IS NOT OLD.edited_at
  AND (EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key IN ('user', 'user:notification'))
    OR EXISTS (SELECT 1 FROM stream_subscriptions WHERE stream_key > 'list:' AND stream_key < 'list;'))
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('edit', NEW.id, NEW.edited_at);
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
