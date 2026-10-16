-- Kopje Store schema 0023: cleared notifications and dismissed notification groups. Never edit after release
-- (checksummed).
--
-- Clearing a local account's notifications (POST /api/v1/notifications/clear, Mastodon's delete_all) records in
-- notification_clears the highest notification id of the account at that time; dismissing a group
-- (POST /api/v2/notifications/:group_key/dismiss, destroy_all of by_group_key) records in notification_dismissals the
-- highest id of the account's notifications of that group. The notification rule (R15, keptSql and keptFloorSql in
-- src/domain/audience.ts) shows none of the account's notifications at or below its clear, or of the group at or below
-- its dismissal, from the moment it is recorded: each is a key lookup, and a lower bound on the id for a read of the
-- account's notifications (or of the group's), so a read starts above it. The rows hidden are then deleted in batches,
-- newest first, the first in the request and the rest in the inbound job rounds (removeNotifications in
-- src/domain/notifications.ts); the row goes when none is left. A later clear or dismissal of the same group raises
-- the id. Notification ids are never reused (AUTOINCREMENT), so a notification written later is always above it.
--
-- Both go with their account. Only a local account has notifications, and a local account is never purged, so no
-- purge meets them. The tables are created empty.

CREATE TABLE notification_clears (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  max_id INTEGER NOT NULL
);

CREATE TABLE notification_dismissals (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  max_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, group_key)
);
