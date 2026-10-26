-- Kopje Store schema 0075: a withdrawn local boost kept until its job removes it. Never edit after release
-- (checksummed).
--
--   statuses_reblog                  every boost of an original by (reblog_of_id, account_id), no longer unique: a
--                                    withdrawn boost (statuses.withdrawn, its Undo recorded) stays until its job
--                                    deletes it (statuses.ts removeReblog, inbox.ts deleteStatusBatch), and its
--                                    booster may boost the original again meanwhile. Cleanup and enumeration walk it,
--                                    withdrawn rows included.
--   statuses_account_reblogs_kept    replaces statuses_account_reblogs: the kept boosts by (account_id,
--                                    reblog_of_id), unique, so an account boosts an original once at a time (as
--                                    Mastodon's uniqueness validation runs under its kept scope). The viewer's own
--                                    boost of an original (unreblog, reblog, the reblogged flag, search) is one seek
--                                    of it; each such read names the index and repeats its WHERE terms.
--
-- Existing rows cannot break the new unique index: the old statuses_reblog was unique over every boost.
--
-- Cost: each partial index is built by a scan of statuses and a sort of its boosts; nothing else is read.

DROP INDEX statuses_reblog;

CREATE INDEX statuses_reblog ON statuses (reblog_of_id, account_id) WHERE reblog_of_id IS NOT NULL;

DROP INDEX statuses_account_reblogs;

CREATE UNIQUE INDEX statuses_account_reblogs_kept ON statuses (account_id, reblog_of_id)
  WHERE reblog_of_id IS NOT NULL AND withdrawn = 0;
