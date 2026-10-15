-- Kopje Store schema 0018: pinned statuses and muted conversations. Never edit after release (checksummed).
--
-- status_pins holds the statuses a local user pins to their profile (Mastodon's StatusPin): their own statuses, never
-- a boost or a direct or limited status, at most five per account (StatusPinValidator, checked when a pin is added).
-- A pin goes with its status (ON DELETE CASCADE, as Mastodon's foreign key and RemoveStatusService delete it) and with
-- its account. A local status's delete cascades it; a remote status's removal deletes its pins in bounded batches
-- (deleteStatusWithin in src/domain/inbox.ts), though none is expected there, since only an author pins.
--
-- conversation_mutes holds the conversations a local user mutes (Mastodon's ConversationMute): a conversation is a
-- status's thread (statuses.thread, migration 0009_conversations), kept as its text, so a mute outlives the statuses
-- of its thread and applies to a later reply that joins it. A mute is its owner's alone and goes with its owner.
--
-- Both name only a local account as their owner, so a remote account's purge never meets their rows. The file only
-- creates empty tables: its work does not grow with the Store.

-- The primary key orders an account's pins by status, and holds no more than a few per account; the index by status
-- serves a status's delete.
CREATE TABLE status_pins (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, status_id)
) WITHOUT ROWID;

CREATE INDEX status_pins_status ON status_pins (status_id);

-- Looked up by owner and thread: whether a status presented to its owner, or notified to them, is in a muted thread.
CREATE TABLE conversation_mutes (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  thread TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, thread)
) WITHOUT ROWID;
