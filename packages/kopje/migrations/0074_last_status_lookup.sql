-- Kopje Store schema 0074: the account's last status read through its index. Never edit after release (checksummed).
--
--   statuses_last_status_removed   the triggers of migration 0021_directory, recreated with the same effect: the
--   statuses_last_status_changed   account's newest public, unlisted or private status, read through statuses_feed
--                                  (INDEXED BY), whose WHERE term the lookup names, so the read is one index seek
--                                  however stale the statistics: without the pin, the planner may walk the
--                                  account's statuses through statuses_account past every newer direct one (a local
--                                  status's hide, statuses.ts deleteStatus, fires the second trigger).
--
-- Cost: two triggers dropped and created; no row is read or written.

DROP TRIGGER statuses_last_status_removed;

DROP TRIGGER statuses_last_status_changed;

CREATE TRIGGER statuses_last_status_removed AFTER DELETE ON statuses
WHEN OLD.visibility IN ('public', 'unlisted', 'private')
BEGIN
  UPDATE accounts SET last_status_id = (
    SELECT s.id FROM statuses s INDEXED BY statuses_feed
    WHERE s.account_id = OLD.account_id AND s.visibility IN ('public', 'unlisted', 'private')
    ORDER BY s.id DESC LIMIT 1
  )
    WHERE id = OLD.account_id AND last_status_id = OLD.id;
END;

CREATE TRIGGER statuses_last_status_changed AFTER UPDATE OF visibility, account_id ON statuses
WHEN OLD.visibility IS NOT NEW.visibility OR OLD.account_id IS NOT NEW.account_id
BEGIN
  UPDATE accounts SET last_status_id = (
    SELECT s.id FROM statuses s INDEXED BY statuses_feed
    WHERE s.account_id = accounts.id AND s.visibility IN ('public', 'unlisted', 'private')
    ORDER BY s.id DESC LIMIT 1
  )
    WHERE id IN (OLD.account_id, NEW.account_id);
END;
