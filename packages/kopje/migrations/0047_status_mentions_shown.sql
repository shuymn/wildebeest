-- Kopje Store schema 0047: the shown mentions of a status. Never edit after release (checksummed).
--
-- A status presents its first MAX_STATUS_MENTION_ROWS mentions that are not silent, by account id
-- (src/domain/status-presenter.ts). Silent rows have no cap (a local edit keeps each mention it removes as one), so
-- reading the status's rows in key order and filtering them could read any number before the first shown one.
--
--   status_mentions_shown   the mentions that are not silent, by status and account id: the presenter's range, so
--                           its LIMIT counts only the rows it shows.
--
-- Cost: one pass over status_mentions to build the partial index. Measured on the benchmark store of
-- test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 statuses with 2,000,000 mentions and tags, and the rest
-- of that store) in workerd's local Durable Object SQLite: 7,134 ms for the upgrade of this file through the kernel
-- (7,233 ms in another run, and 9,678 ms in a first run at a load average of 7 to 14), within the 10,000 ms each
-- migration file may take.

CREATE INDEX status_mentions_shown ON status_mentions (status_id, account_id) WHERE silent = 0;
