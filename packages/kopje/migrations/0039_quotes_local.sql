-- Kopje Store schema 0039: quotes written by local users. Never edit after release (checksummed).
--
-- Mastodon 4.5 lets a user quote a status (PostStatusService#attach_quote!): a quote of a local status is accepted at
-- once by the author's policy, a quote of a remote one waits for the quoted author's Accept of the QuoteRequest sent to
-- them. Kopje does the same (src/domain/quotes.ts, docs/threat-model.md VIS-28):
--
--   quotes.local               1 for the quote of a local quoting status, 0 for a received one. A local row is never
--                              verified by a job round (it has no work): only Kopje's posting, the quoted author's Accept,
--                              Reject or stamp Delete, and the removal paths change its state.
--   quotes_local_stamp         one local quote per remote stamp and quoted author: the Accept that would name a stamp a
--                              second local quote already names is refused, so a stamp Delete forwards for one local
--                              quote at most, found by one seek whatever the number of received quotes naming it. A
--                              local row keeps its stamp (approval_uri) after it leaves accepted, until the quoted
--                              author's proven Delete of the stamp is forwarded, which clears it.
--
-- Cost: an ALTER adding a column with a constant default and a CHECK, which SQLite tests against each stored quote (all
-- 0: no local user could quote before), and an index over the quotes, empty since no stored quote is local. Nothing is
-- backfilled. Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags, 200,000 quotes, 10,000 reports, 20 local accounts) in workerd's
-- local Durable Object SQLite: 2,513 ms for the upgrade of this file through the kernel (its bookmark, transaction and
-- schema verification; 2,811 ms in a second run), within the 5,000 ms each migration file may take.

ALTER TABLE quotes ADD COLUMN local INTEGER NOT NULL DEFAULT 0 CHECK (local IN (0, 1));

CREATE UNIQUE INDEX quotes_local_stamp ON quotes (approval_uri, quoted_account_id)
WHERE local = 1 AND approval_uri IS NOT NULL;
