-- Kopje Store schema 0031: the admin API's list of active accounts. Never edit after release (checksummed).
--
-- The admin's list of accounts with status=active (GET /api/v1/admin/accounts by default, src/domain/admin-accounts.ts,
-- R37) walks the accounts by id, newest first, and leaves out the unavailable ones (R1): the suspended local accounts
-- and the remote accounts whose deletion has started. This partial index holds the accounts whose deletion has not
-- started, in id order, so the walk skips only the suspended local accounts (an operator-sized set), however many
-- remote accounts are waiting for their purge.
--
-- Cost: one pass over the accounts and a sort of their ids; nothing else is read or written.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags, 10,000 reports, 20 local accounts) in workerd's local Durable
-- Object SQLite: 2,828 ms for the upgrade of this file through the kernel (its bookmark, transaction and schema
-- verification), within the 5,000 ms each migration file may take.

CREATE INDEX accounts_available ON accounts (id) WHERE deleted_at IS NULL;
