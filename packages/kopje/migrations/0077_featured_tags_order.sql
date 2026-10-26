-- Kopje Store schema 0077: an account's featured hashtags in id order. Never edit after release (checksummed).
--
--   featured_tags_account_id   featured_tags by (account_id, id): the order every list of an account's featured
--                              hashtags answers in (GET /api/v1/accounts/:id/featured_tags, the profile's Featured
--                              tab), so a read that stops after its first rows reads no more of the account's rows
--                              than it shows, however many an import left it (src/domain/featured-tags.ts).
--
-- Cost: the index reads every featured_tags row once; nothing else is read or written. Measured on the benchmark store
-- of test/bench/migration-cost.ts (its 100,000 featured hashtags, ten of each of 10,000 accounts, beside the rest) in
-- workerd's local Durable Object SQLite: 28 to 31 ms for the upgrade of this file through the kernel, at a load average
-- of 6 to 22.

CREATE INDEX featured_tags_account_id ON featured_tags (account_id, id);
