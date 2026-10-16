-- Kopje Store schema 0032: the admin API's local suspension. Never edit after release (checksummed).
--
-- The OAuth admin suspends and unsuspends local accounts through the Mastodon admin API, and the Access admin
-- unsuspends them through /admin (src/domain/suspension.ts, R37, VIS-29). A suspension commits in one bounded
-- transaction; the work that grows with the account runs afterwards in rounds of durable jobs.
--
--   local_accounts.credential_epoch   the account's credential epoch: a suspension increments it in its transaction.
--   oauth_tokens.epoch                 the epoch a token, code or web session was issued in, stamped from its account
--                                      in the transaction that inserts it. A credential is valid only while its epoch
--                                      is its account's, so every credential issued before a suspension is refused
--                                      from its commit on, also after an unsuspension (which keeps the epoch), with no
--                                      clock involved, while the tokens job deletes them in rounds.
--
-- moderation_jobs holds the jobs a suspension or an unsuspension leaves, each bound to the generation it was made for:
--
--   tokens       deletes the account's credentials of earlier epochs child-first (their push deliveries, then their
--                push subscriptions, then the tokens), within a fixed budget of rows per round. generation is the
--                suspension's epoch. It is never cancelled: an unsuspension keeps the epoch.
--   suspension   resolves the reports on the account filed up to report_bound and untouched since the suspension,
--                then stages the audience of the suspension's Update (intent_id) in moderation_reach and writes it as
--                the Update's targets. generation is the suspension's epoch, since its time (suspended_at); a round
--                finds the account unsuspended or in a later epoch and ends the job.
--   reach        stages the audience of the unsuspension's Update the same way. generation is the account's epoch,
--                which the unsuspension keeps; a round finds the account suspended again, or in a later epoch, and
--                ends the job.
--
-- since is the suspension's time S (suspension jobs), against which its reports are judged. follow_bound freezes the follows the audience is read from, cutoff the time since which recent mentions and follows
-- count (two days before the suspension, as Mastodon's AccountReachFinder), and phase and state the job's persisted
-- cursor and counts. actor_account_id is the admin who suspended, whom the resolved reports name. intent_id names an
-- outbound_activities row without a foreign key: the row may be superseded and go first, which ends the staging.
--
-- moderation_reach is the staged audience: one row per inbox, so each inbox appears once. Its foreign key does not
-- cascade: a job deletes its rows in rounds before itself.
--
-- Cost: two ALTERs adding a column with a constant default and no CHECK (a change of the schema alone, whatever the
-- number of local accounts or tokens), and two new tables; nothing is read or written. Measured on the benchmark
-- store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses with their
-- mentions and tags, 10,000 reports, 20 local accounts) in workerd's local Durable Object SQLite: 2,266 ms for the
-- upgrade of this file through the kernel (its bookmark, transaction and schema verification), within the 5,000 ms
-- each migration file may take.

ALTER TABLE local_accounts ADD COLUMN credential_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oauth_tokens ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE moderation_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tokens', 'suspension', 'reach')),
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  since TEXT,
  actor_account_id TEXT,
  intent_id INTEGER,
  report_bound INTEGER,
  follow_bound INTEGER,
  cutoff TEXT,
  phase TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state)),
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, kind, generation)
);

CREATE TABLE moderation_reach (
  job_id INTEGER NOT NULL REFERENCES moderation_jobs (id),
  inbox TEXT NOT NULL,
  PRIMARY KEY (job_id, inbox)
) WITHOUT ROWID;
