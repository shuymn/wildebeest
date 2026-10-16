-- Kopje Store schema 0021: the profile directory's order. Never edit after release (checksummed).
--
-- accounts.last_status_id is the id of the account's newest public, unlisted or private status, boosts included: the
-- status whose date the account presenter shows as `last_status_at` (ACCOUNT_COLUMNS in src/domain/accounts.ts). The
-- profile directory (GET /api/v1/directory, src/domain/directory.ts) orders by it with `order=active`, as Mastodon
-- orders by AccountStat#last_status_at. Triggers keep it whatever writes statuses (a post, a received status, a delete,
-- a purge, an import): a status stored that is newer raises it; a status deleted or hidden (a deletion in progress
-- makes it direct first) that was the newest moves it back to the newest left, read through the partial index
-- statuses_feed, one seek; a direct or limited status never touches it. The visibility list is REACHES_FOLLOWERS_SQL,
-- in the order of statuses_feed, so SQLite uses that index.
--
-- The four partial indexes hold only the discoverable accounts (accounts.discoverable = 1: a local account's setting,
-- or what a remote actor published), all of them or the local ones alone, by the directory's two orders. A page reads
-- them from the start, a bounded window of entries, never the accounts that are not discoverable. Queries name them
-- (INDEXED BY in src/domain/directory.ts): renaming or dropping them breaks those queries.
--
-- The file adds a column with no default to fill, gives each account its newest status through statuses_feed (one
-- seek per account) and builds the indexes, each in one pass over accounts: its work grows linearly with the accounts
-- stored, whatever the statuses.

ALTER TABLE accounts ADD COLUMN last_status_id TEXT;

UPDATE accounts SET last_status_id = (
  SELECT s.id FROM statuses s
  WHERE s.account_id = accounts.id AND s.visibility IN ('public', 'unlisted', 'private')
  ORDER BY s.id DESC LIMIT 1
);

CREATE TRIGGER statuses_last_status_stored AFTER INSERT ON statuses
WHEN NEW.visibility IN ('public', 'unlisted', 'private')
BEGIN
  UPDATE accounts SET last_status_id = NEW.id
    WHERE id = NEW.account_id AND (last_status_id IS NULL OR last_status_id < NEW.id);
END;

CREATE TRIGGER statuses_last_status_removed AFTER DELETE ON statuses
WHEN OLD.visibility IN ('public', 'unlisted', 'private')
BEGIN
  UPDATE accounts SET last_status_id = (
    SELECT s.id FROM statuses s
    WHERE s.account_id = OLD.account_id AND s.visibility IN ('public', 'unlisted', 'private')
    ORDER BY s.id DESC LIMIT 1
  )
    WHERE id = OLD.account_id AND last_status_id = OLD.id;
END;

CREATE TRIGGER statuses_last_status_changed AFTER UPDATE OF visibility, account_id ON statuses
WHEN OLD.visibility IS NOT NEW.visibility OR OLD.account_id IS NOT NEW.account_id
BEGIN
  UPDATE accounts SET last_status_id = (
    SELECT s.id FROM statuses s
    WHERE s.account_id = accounts.id AND s.visibility IN ('public', 'unlisted', 'private')
    ORDER BY s.id DESC LIMIT 1
  )
    WHERE id IN (OLD.account_id, NEW.account_id);
END;

-- order=active: the newest status first, accounts without one last (NULL sorts first ascending, so last when the
-- index is read backwards), then the newest account.
CREATE INDEX accounts_directory_active ON accounts (last_status_id, id) WHERE discoverable = 1;
CREATE INDEX accounts_directory_local_active ON accounts (last_status_id, id) WHERE discoverable = 1 AND domain IS NULL;
-- order=new: the newest account first.
CREATE INDEX accounts_directory_new ON accounts (id) WHERE discoverable = 1;
CREATE INDEX accounts_directory_local_new ON accounts (id) WHERE discoverable = 1 AND domain IS NULL;
