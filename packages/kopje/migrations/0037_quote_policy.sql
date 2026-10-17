-- Kopje Store schema 0037: quote policies. Never edit after release (checksummed).
--
-- Mastodon 4.5 lets the author of a status say who may quote it (Status::InteractionPolicyConcern), and lets each
-- user choose the policy their new posts get (UserSettings default_quote_policy). Kopje stores both
-- (src/domain/audience.ts R36, src/domain/statuses.ts):
--
--   statuses.quote_policy                Mastodon's bit flags, automatic approval in the high 16 bits and manual approval
--                                        in the low ones, each of unsupported_policy (1), public (2), followers (4) and
--                                        following (8). A local status gets it when it is posted (public, followers or
--                                        nobody; 0 for a private or direct one) and keeps it until its author changes it.
--                                        Every stored status keeps 0, nobody: a post written before quote policies
--                                        existed stays unquotable, as Mastodon's existing statuses did.
--   local_accounts.default_quote_policy  the policy a local account's new posts get when the post names none: public,
--                                        followers or nobody; public by default, as Mastodon's.
--
-- Cost: two ALTERs adding a column with a constant default (a change of the schema alone). The statuses column has no
-- CHECK, so SQLite neither rewrites nor reads the stored statuses; the local_accounts one has a CHECK, which SQLite
-- tests against each stored local account, a handful of rows. Nothing is backfilled. Measured on the benchmark store
-- of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses with their mentions and
-- tags, 200,000 quotes, 10,000 reports, 20 local accounts) in workerd's local Durable Object SQLite: MEASURED for the
-- upgrade of this file through the kernel (its bookmark, transaction and schema verification), within the 5,000 ms
-- each migration file may take.

ALTER TABLE statuses ADD COLUMN quote_policy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_accounts ADD COLUMN default_quote_policy TEXT NOT NULL DEFAULT 'public'
  CHECK (default_quote_policy IN ('public', 'followers', 'nobody'));
