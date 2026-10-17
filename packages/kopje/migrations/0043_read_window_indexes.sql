-- Kopje Store schema 0043: indexes for three read windows. Never edit after release (checksummed).
--
-- Paged reads read a candidate window from their cursor in cursor order (src/domain/windows.ts, docs/visibility.md
-- "Read bounds", RES-7). Three had no index in that order, so each window sorted every row it ranged over first:
--
--   follows_following       an account's accepted follows by follow id: the following list (listFollows).
--                           follows_accepted (0000_initial) orders them by target account.
--   favourites_status       a status's favourites by favourite id: favourited_by (statuses.ts interactors).
--                           favourites_pair orders them by account.
--   statuses_reblogged_by   a status's public and unlisted boosts by boost id: reblogged_by. statuses_reblog orders
--                           them by account and holds the boosts it never lists.
--
-- Cost: three index builds, each a pass over its table and a sort of the rows it holds; nothing else is read or
-- written. Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 20 local
-- accounts) in workerd's local Durable Object SQLite: 4,080 ms for the upgrade of this file through the kernel (its
-- bookmark, transaction and schema verification; 4,094 and 4,059 ms in two more runs), on a loaded machine (load
-- average 11 to 21), within the 5,000 ms each migration file may take. Most of it is the schema verification every
-- file pays and the follows index; that store holds no favourites and no boosts, whose indexes each cost a pass over
-- their table on a real one.

CREATE INDEX follows_following ON follows (account_id, id) WHERE state = 'accepted';

CREATE INDEX favourites_status ON favourites (status_id, id);

CREATE INDEX statuses_reblogged_by ON statuses (reblog_of_id, id)
  WHERE reblog_of_id IS NOT NULL AND visibility IN ('public', 'unlisted');
