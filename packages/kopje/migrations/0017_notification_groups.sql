-- Kopje Store schema 0017: the group of a notification. Never edit after release (checksummed).
--
-- notifications.group_key names the group a notification joins in the grouped notifications of the API v2 (Mastodon's
-- Notification#group_key): a favourite or a boost of the same status, or a follow, within a span of hours. It is set
-- once, when the notification is written (notify in src/domain/notifications.ts); a notification of any other type
-- has none and is a group of its own. The partial index holds only the grouped rows, by recipient and group, so a
-- group's notifications are read without reading the recipient's others.
--
-- The notifications already stored keep no group, as Mastodon left those it stored before it grouped them: each is
-- shown as a group of its own. The file adds a column with no default to fill and builds the index in one pass over
-- the table, which finds no grouped row: its work grows linearly with the notifications stored.

ALTER TABLE notifications ADD COLUMN group_key TEXT;

CREATE INDEX notifications_group ON notifications (account_id, group_key, id) WHERE group_key IS NOT NULL;
