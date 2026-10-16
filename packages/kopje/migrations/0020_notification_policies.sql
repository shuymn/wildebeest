-- Kopje Store schema 0020: notification policies, filtered notifications and notification requests. Never edit after
-- release (checksummed).
--
-- notifications.filtered marks a notification the recipient's policy filtered (Mastodon's Notification#filtered,
-- NotifyService::FilterCondition): it is written, but no list, count or push shows it unless the request asks for
-- filtered ones (include_filtered or account_id, Notification.browserable). notify in src/domain/notifications.ts
-- decides it, with notificationPolicySql in src/domain/audience.ts (R15). The partial index notifications_unfiltered
-- holds only the unfiltered rows, by recipient and id, as Mastodon's index_notifications_on_filtered does, so the
-- lists, the grouped walk and the unread counts never read a filtered notification, however many a sender writes
-- (RES-7).
--
-- notification_policies holds a local account's choices (Mastodon's NotificationPolicy): for each condition, accept,
-- filter or drop, with Mastodon's defaults (private mentions and limited accounts filtered, the rest accepted). An
-- account without a row has the defaults. It goes with its account.
--
-- notification_permissions holds the senders a local account accepted a request from (NotificationPermission): their
-- notifications are never filtered or dropped by the policy. A sender may be remote, so a remote account's purge
-- deletes its rows in its batches (purgeBatch in src/domain/inbox.ts); the index by sender serves it.
--
-- notification_requests holds a request per recipient and sender (NotificationRequest): the sender's filtered
-- mentions, how many (at most 100, NotificationRequest::MAX_MEANINGFUL_COUNT) and the newest one's status. Its id is
-- its order in the API, newest first. The sender's purge deletes it, and the last status's removal clears it
-- (ON DELETE SET NULL, as Mastodon's foreign key nullifies it), in their batches.
--
-- notification_request_jobs holds the work an accepted or dismissed request leaves for later batches: unfiltering
-- the sender's filtered notifications (UnfilterNotificationsWorker) or deleting them
-- (FilteredNotificationCleanupWorker), walking the sender's notifications by id, newest first, from the newest one
-- when the request was answered: `cursor` is the id below which the walk goes on. The first batches run in the
-- request; runNotificationRequestJobs runs the rest with the inbound jobs.
--
-- The new column has a constant default, so adding it reads no row. The partial index is built in one pass over the
-- notifications stored, every one of them unfiltered: its work grows linearly with the notifications stored, as
-- 0017_notification_groups's did. The tables are created empty.

ALTER TABLE notifications ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0;

CREATE INDEX notifications_unfiltered ON notifications (account_id, id) WHERE filtered = 0;

CREATE TABLE notification_policies (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  for_not_following TEXT NOT NULL DEFAULT 'accept' CHECK (for_not_following IN ('accept', 'filter', 'drop')),
  for_not_followers TEXT NOT NULL DEFAULT 'accept' CHECK (for_not_followers IN ('accept', 'filter', 'drop')),
  for_new_accounts TEXT NOT NULL DEFAULT 'accept' CHECK (for_new_accounts IN ('accept', 'filter', 'drop')),
  for_private_mentions TEXT NOT NULL DEFAULT 'filter' CHECK (for_private_mentions IN ('accept', 'filter', 'drop')),
  for_limited_accounts TEXT NOT NULL DEFAULT 'filter' CHECK (for_limited_accounts IN ('accept', 'filter', 'drop')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE TABLE notification_permissions (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  from_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, from_account_id)
) WITHOUT ROWID;

CREATE INDEX notification_permissions_from ON notification_permissions (from_account_id);

CREATE TABLE notification_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  from_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  last_status_id TEXT REFERENCES statuses (id) ON DELETE SET NULL,
  notifications_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One request per recipient and sender; the recipient's requests by id are its pages.
CREATE UNIQUE INDEX notification_requests_pair ON notification_requests (account_id, from_account_id);
CREATE INDEX notification_requests_account ON notification_requests (account_id, id);
CREATE INDEX notification_requests_from ON notification_requests (from_account_id);
CREATE INDEX notification_requests_last_status ON notification_requests (last_status_id) WHERE last_status_id IS NOT NULL;

CREATE TABLE notification_request_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  from_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('accept', 'dismiss')),
  cursor INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A recipient's pending unfiltering (`merged`); a sender's jobs, for its purge.
CREATE INDEX notification_request_jobs_account ON notification_request_jobs (account_id, kind);
CREATE INDEX notification_request_jobs_from ON notification_request_jobs (from_account_id);
