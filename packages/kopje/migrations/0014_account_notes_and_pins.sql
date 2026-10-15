-- Kopje Store schema 0014: private notes on accounts and endorsed accounts. Never edit after release (checksummed).
--
-- account_notes holds a local user's private note on an account (Mastodon's AccountNote): one per pair, at most 2,000
-- characters and never empty (a blank note is deleted instead, as Api::V1::Accounts::NotesController does). Only its
-- author is shown it, in the Relationship of that account.
--
-- account_pins holds the accounts a local user endorses (Mastodon's AccountPin), which the user must follow (an
-- accepted follow; AccountPin#validate_follow_relationship, checked when one is added). Mastodon deletes the pin when
-- the follow is destroyed (Follow#remove_endorsements); here the trigger account_pins_follow_ended does it: whatever
-- ends a follow (an unfollow, a block either way, a removal from followers, a domain block's cleanup, a Reject, a
-- Move, a purge), the endorsement goes in the same statement, through the pair key.
--
-- Both belong to the local account and go with it (ON DELETE CASCADE). A remote account's purge deletes the rows that
-- name it in bounded batches (purgeRelationships in src/domain/inbox.ts), through the indexes by target, before its
-- follows; the cascade from accounts is only a backstop. The file only creates empty tables and a trigger: its work
-- does not grow with the Store.

CREATE TABLE account_notes (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  comment TEXT NOT NULL CHECK (length(comment) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, target_account_id)
) WITHOUT ROWID;

CREATE INDEX account_notes_target ON account_notes (target_account_id, account_id);

-- The primary key orders an account's endorsements by the endorsed account's id, which the listings page by.
CREATE TABLE account_pins (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, target_account_id),
  CHECK (account_id <> target_account_id)
) WITHOUT ROWID;

CREATE INDEX account_pins_target ON account_pins (target_account_id, account_id);

CREATE TRIGGER account_pins_follow_ended AFTER DELETE ON follows
BEGIN
  DELETE FROM account_pins WHERE account_id = OLD.account_id AND target_account_id = OLD.target_account_id;
END;
