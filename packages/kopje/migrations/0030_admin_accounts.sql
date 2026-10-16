-- Kopje Store schema 0030: the admin API's display-name search. Never edit after release (checksummed).
--
-- The admin's list of accounts (GET /api/v1/admin/accounts and /api/v2/admin/accounts, src/domain/admin-accounts.ts,
-- R37) searches display names by a case-insensitive prefix, as Mastodon's Account.matches_display_name does. It reads
-- the candidates as one range of this index, from the lowercased prefix to its successor, at most 2,000 of them
-- (and one more to see that there are more). SQLite's lower() folds ASCII letters only, and the search lowercases the
-- prefix the same way, so both sides fold alike.
--
-- Cost: one pass over the accounts and a sort of their lowercased display names; nothing else is read or written.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags, 10,000 reports, 20 local accounts) in workerd's local Durable
-- Object SQLite: 2,815 ms for the upgrade of this file through the kernel (its bookmark, transaction and schema
-- verification), within the 5,000 ms each migration file may take.

CREATE INDEX accounts_display_name ON accounts (lower(display_name));
