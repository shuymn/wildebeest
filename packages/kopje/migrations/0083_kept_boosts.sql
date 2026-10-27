-- Kopje Store schema 0083: a status's kept public and unlisted boosts in id order. Never edit after release
-- (checksummed).
--
--   statuses_reblogged_by   replaces 0043_read_window_indexes's index of that name, (reblog_of_id, id) over the
--                           public and unlisted boosts, with the same columns over those that are not withdrawn: a
--                           withdrawn boost (its removal under way) is gone for everyone (R2, VIS-6) and a candidate
--                           of its author's reads only (RES-7), so it never becomes a cursor of reblogged_by or of a
--                           status page's Boosts tab (src/domain/statuses.ts interactorsWithin), which read their
--                           window from it in id order, however many withdrawn boosts the status has. The list is
--                           DISTRIBUTABLE_SQL's, in its order (src/domain/audience.ts), which SQLite needs to match the
--                           read to this index. No other read uses it.
--
-- Cost: the index reads every statuses row once and holds the kept public and unlisted boosts; nothing else is read or
-- written. A file that drops an index cannot declare foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade
-- checks every reference of the Store. Measured on the benchmark store of test/bench/migration-cost.ts (its 2,000,000
-- statuses and 200,000 boosts) in workerd's local Durable Object SQLite: see the CHANGELOG entry of this file.

DROP INDEX statuses_reblogged_by;

CREATE INDEX statuses_reblogged_by ON statuses (reblog_of_id, id)
  WHERE reblog_of_id IS NOT NULL AND visibility IN ('public', 'unlisted') AND withdrawn = 0;
