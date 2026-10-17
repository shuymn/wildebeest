-- Kopje Store schema 0043: indexes for three read windows. Never edit after release (checksummed).
--
-- Paged reads read a candidate window from their cursor in cursor order (src/domain/windows.ts, docs/visibility.md
-- "Read bounds", RES-7); without an index in that order a window sorts every row it ranges over first:
--
--   follows_following       an account's accepted follows by follow id: the following list (listFollows).
--                           follows_accepted (0000_initial) orders them by target account.
--   favourites_status       a status's favourites by favourite id: favourited_by (statuses.ts interactors).
--                           favourites_pair orders them by account.
--   statuses_reblogged_by   a status's public and unlisted boosts by boost id: reblogged_by. statuses_reblog orders
--                           them by account and holds the boosts it never lists.
--
-- Cost: three index builds, each a pass over its table and a sort of the rows it holds; nothing else is read or
-- written. One file, not three: each upgrade pays the kernel's overhead once. Measured on the benchmark store of
-- test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses with their mentions and
-- tags, 200,000 boosts, 2,000,000 favourites, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local
-- accounts) in workerd's local Durable Object SQLite: 8,138 ms for the upgrade of this file through the kernel (its
-- bookmark, transaction and schema verification; 8,243 and 8,563 ms in two more runs, load average 1.6 to 4.2),
-- within the 10,000 ms each migration file may take. About 6 s of it is the overhead of upgrading one file alone on
-- that store, its schema verification above all, which an upgrade runs once after all pending files
-- (0042_report_action_fence measured 5,981 and 5,893 ms there), so the three builds take about 2.5 s.

CREATE INDEX follows_following ON follows (account_id, id) WHERE state = 'accepted';

CREATE INDEX favourites_status ON favourites (status_id, id);

CREATE INDEX statuses_reblogged_by ON statuses (reblog_of_id, id)
  WHERE reblog_of_id IS NOT NULL AND visibility IN ('public', 'unlisted');
