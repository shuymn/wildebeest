-- Kopje Store schema 0045: the instance suspension of a remote account. Never edit after release (checksummed).
--
-- The OAuth admin suspends and unsuspends a remote account through the Mastodon admin API (src/domain/
-- remote-suspension.ts, R38, VIS-30). The account is unavailable (R1, availableSql in src/domain/audience.ts) from the
-- suspension's commit on, and the work that grows with it runs afterwards in rounds of its job:
--
--   accounts.suspended_at        the time of the suspension, shown only; nothing orders or fences by it.
--   accounts.suspension_source   the decision that holds it: 'account' (the admin's suspension of this account) or
--                                'domain' (an instance domain block). Both are set together, on remote accounts only,
--                                by their one writer (remote-suspension.ts); no CHECK states it (cost, below).
--                                Availability reads suspended_at alone.
--   accounts_suspended           the suspended accounts by id: availableSql's seek, which holds no entry for any other
--                                account, and the admin's list of suspended accounts.
--   accounts_active              the accounts neither suspended nor being deleted, by id: the admin's list of active
--                                accounts walks it, skipping only the suspended local accounts (an operator-sized
--                                set). It replaces 0031's accounts_available, which held the suspended ones.
--
-- remote_moderation_jobs holds one job per subject (UNIQUE (kind, subject)), with no foreign key, so an actor purge
-- deletes the account under its job and the next round ends it. Each transition resets its row in that transition's
-- transaction: the reset is the job's generation. kind 'account' names an account by id, mode the condition each
-- round requires ('account': the account is individually suspended); follow_bound, report_bound and action_bound are
-- frozen at the reset (the newest follow, report and moderation log row), actor_account_id is the suspending admin,
-- and phase and cursor are the walk's position. kind 'domain' and mode 'domain' are for instance domain blocks.
--
-- Cost: two ALTERs adding a column with no default and no CHECK (a change of the schema alone: SQLite would test an
-- added CHECK against every stored account, which measured 15,875 ms in all on the store below), two index builds
-- over the accounts, each a pass over them (one holding no entry, one every available account), the drop of 0031's
-- index, and a new table. Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts,
-- 3,000,000 follows, 2,000,000 statuses with their mentions and tags, 2,000,000 favourites, 200,000 boosts, 2,000,000
-- notifications, 200,000 quotes, 10,000 reports, 20 local accounts) in workerd's local Durable Object SQLite: 6,752 ms
-- for the upgrade of this file through the kernel (6,561 and 6,694 ms in two more runs, at load averages of 2 to 8),
-- within the 10,000 ms each migration file may take; about 6 s of it is the overhead of an upgrade on a store that
-- size.

ALTER TABLE accounts ADD COLUMN suspended_at TEXT;
ALTER TABLE accounts ADD COLUMN suspension_source TEXT;

-- Queries name these indexes (INDEXED BY in availableSql and src/domain/admin-accounts.ts): renaming or dropping
-- them breaks them.
CREATE INDEX accounts_suspended ON accounts (id) WHERE suspended_at IS NOT NULL;
CREATE INDEX accounts_active ON accounts (id) WHERE deleted_at IS NULL AND suspended_at IS NULL;
DROP INDEX accounts_available;

CREATE TABLE remote_moderation_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'domain')),
  subject TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('account', 'domain')),
  actor_account_id TEXT,
  follow_bound INTEGER NOT NULL,
  report_bound INTEGER,
  action_bound INTEGER,
  phase TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  UNIQUE (kind, subject)
);
