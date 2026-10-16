-- Kopje Store schema 0032: the admin API's local suspension. Never edit after release (checksummed).
--
-- The OAuth admin suspends and unsuspends local accounts through the Mastodon admin API, and the Access admin
-- unsuspends them through /admin (src/domain/suspension.ts, R37, VIS-29). A suspension commits in one bounded
-- transaction; the work that grows with the account runs afterwards in rounds of durable jobs.
--
--   local_accounts.tokens_valid_after   the token fence: every access token and authorization code of the account
--                                       created at or before it is refused, also after the account is unsuspended,
--                                       so an unsuspension never revives a token still waiting for its deletion.
--                                       Set to the suspension's time; NULL for an account never suspended.
--
-- moderation_jobs holds the jobs a suspension or an unsuspension leaves, each bound to the generation it was made for:
--
--   tokens       deletes the fenced tokens of the account child-first (their push deliveries, then their push
--                subscriptions, then the tokens), within a fixed budget of rows per round. generation is the fence. It
--                is never cancelled: the fence stays.
--   suspension   resolves the reports on the account filed up to report_bound and untouched since the suspension,
--                then stages the audience of the suspension's Update (intent_id) in moderation_reach and writes it as
--                the Update's targets. generation is the suspension's time (suspended_at); a round finds the account
--                no longer suspended at that time and ends the job.
--   reach        stages the audience of the unsuspension's Update the same way. generation is the fence of the
--                suspension it lifts; a round finds the account suspended again, or unsuspended from a later
--                suspension, and ends the job.
--
-- follow_bound freezes the follows the audience is read from, cutoff the time since which recent mentions and follows
-- count (two days before the suspension, as Mastodon's AccountReachFinder), and phase and state the job's persisted
-- cursor and counts. actor_account_id is the admin who suspended, whom the resolved reports name. intent_id names an
-- outbound_activities row without a foreign key: the row may be superseded and go first, which ends the staging.
--
-- moderation_reach is the staged audience: one row per inbox, so each inbox appears once. Its foreign key does not
-- cascade: a job deletes its rows in rounds before itself.
--
-- Cost: an ALTER without a CHECK on an operator-sized table, and two new tables; nothing is read or written.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags, 10,000 reports, 20 local accounts) in workerd's local Durable
-- Object SQLite: 2,974 ms for the upgrade of this file through the kernel (its bookmark, transaction and schema
-- verification; a first run on a busier machine took 4,134 ms), within the 5,000 ms each migration file may take.

ALTER TABLE local_accounts ADD COLUMN tokens_valid_after TEXT;

CREATE TABLE moderation_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tokens', 'suspension', 'reach')),
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
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
