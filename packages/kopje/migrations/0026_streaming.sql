-- Kopje Store schema 0026: the streaming API's registry, journal and position. Never edit after release (checksummed).
--
-- The streaming API (/api/v1/streaming, src/stream-hub.ts and src/domain/streaming.ts) keeps its sockets in the Store
-- with WebSocket Hibernation. These tables hold what the sockets' own attachments cannot, for SQL to see:
--
--   stream_subscriptions  the stream keys some open socket of an account subscribes to, with how many sockets do. It
--                         is derived from the sockets: written on subscribe, unsubscribe and close, and rebuilt from
--                         the open sockets by the first turn after the Store starts. It gates the journal trigger.
--   stream_events         the journal: what a write did that a stream may carry, by ids only. Each message is judged
--                         when it is made (R33), never here. A trigger records a notification inserted unfiltered for
--                         a recipient with a subscription, and records nothing once the journal spans 4,096 ids (the
--                         fan-out stalled; the turn logs it).
--   stream_cursor         the fan-out's position: the last unit sent, as (event id, viewer account id), the account
--                         null once the event is done. One row, moved by compare-and-set before a unit is sent.
--
-- All three are state of one object at one time, so dumps leave them out (src/platform/dump-catalog.ts). Nothing names
-- an account by foreign key: an account's rows go when its sockets do.
--
-- The kinds the journal will carry are the design's set; this release records only notifications.
--
-- Creating empty tables and a trigger reads no row, so the work of this file does not grow with the Store.

CREATE TABLE stream_subscriptions (
  account_id TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  sockets INTEGER NOT NULL CHECK (sockets > 0),
  PRIMARY KEY (account_id, stream_key)
) WITHOUT ROWID;

CREATE TABLE stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('status', 'edit', 'notification', 'delete', 'merged')),
  subject TEXT NOT NULL,           -- the notification id, as text
  created_at TEXT NOT NULL
);

CREATE TABLE stream_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_id INTEGER NOT NULL,
  account_id TEXT
);

INSERT INTO stream_cursor (id, event_id, account_id) VALUES (1, 0, NULL);

-- A notification the recipient's policy filtered is not streamed (NotifyService#push_notification! skips it), and one
-- accepted later becomes unfiltered by an update, which records nothing: REST shows it.
CREATE TRIGGER stream_notification_inserted AFTER INSERT ON notifications
WHEN NEW.filtered = 0
  AND EXISTS (SELECT 1 FROM stream_subscriptions WHERE account_id = NEW.account_id)
  AND coalesce((SELECT max(id) FROM stream_events) - (SELECT min(id) FROM stream_events), 0) < 4096
BEGIN
  INSERT INTO stream_events (kind, subject, created_at) VALUES ('notification', CAST(NEW.id AS TEXT), NEW.created_at);
END;
