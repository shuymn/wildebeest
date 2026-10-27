-- Kopje Store schema 0083: the retry state of the other job families. Never edit after release (checksummed).
--
--   <t>.attempts, due_at   a job's consecutive failed batches or rounds since it last ran through, and when it may run
--                          again (src/domain/job-attempts.ts, RES-5), as 0080 gave inbound_jobs: fresh (0, NULL),
--                          backing off (1 to 5, an integer time in ms within 0 to 2^53 - 1) or parked (6, NULL), every
--                          accepted row exactly one of them, imported rows included. Every stored job starts fresh.
--   <t>_fresh              the fresh jobs in their order: the round's seek for the next job. In the rowid tables it
--                          holds attempts alone, its entries in rowid order (the order the round takes); a pending
--                          revocation's is by revoked_at.
--   <t>_failing            the jobs backing off or parked, by due_at: the seek for a due retry, and the walk of
--                          POST /admin/jobs/retry.
--
-- for each <t> of quote_revocations (its pending ones), domain_block_cleanups, notification_request_jobs,
-- notification_clears, notification_dismissals, moderation_jobs and remote_moderation_jobs. domain_block_cleanups_next
-- and quote_revocations_pending are no longer read; they stay, since a file declared foreignKeys unchanged drops no
-- index (test/migration-sql.ts).
--
-- Cost: the columns' CHECKs may read every row of each table, and each index reads them once; nothing else is read or
-- written. Measured on the benchmark store of test/bench/migration-cost.ts (its 180 local and 11,001 remote moderation
-- jobs, 10,000 stamp revocations, half of them pending, 1,000 domain block cleanups, notification request jobs and
-- dismissals, and 20 clears, beside the rest) in workerd's local Durable Object SQLite: 49 to 60 ms for the upgrade of
-- this file through the kernel, at load averages of 2 to 14.

ALTER TABLE quote_revocations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE quote_revocations ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX quote_revocations_fresh ON quote_revocations (revoked_at) WHERE pending = 1 AND attempts = 0;
CREATE INDEX quote_revocations_failing ON quote_revocations (due_at) WHERE pending = 1 AND attempts > 0;
ALTER TABLE domain_block_cleanups ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE domain_block_cleanups ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX domain_block_cleanups_fresh ON domain_block_cleanups (created_at, domain_block_id) WHERE attempts = 0;
CREATE INDEX domain_block_cleanups_failing ON domain_block_cleanups (due_at) WHERE attempts > 0;
ALTER TABLE notification_request_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE notification_request_jobs ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX notification_request_jobs_fresh ON notification_request_jobs (attempts) WHERE attempts = 0;
CREATE INDEX notification_request_jobs_failing ON notification_request_jobs (due_at) WHERE attempts > 0;
ALTER TABLE notification_clears ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE notification_clears ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX notification_clears_fresh ON notification_clears (attempts) WHERE attempts = 0;
CREATE INDEX notification_clears_failing ON notification_clears (due_at) WHERE attempts > 0;
ALTER TABLE notification_dismissals ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE notification_dismissals ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX notification_dismissals_fresh ON notification_dismissals (attempts) WHERE attempts = 0;
CREATE INDEX notification_dismissals_failing ON notification_dismissals (due_at) WHERE attempts > 0;
ALTER TABLE moderation_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE moderation_jobs ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX moderation_jobs_fresh ON moderation_jobs (attempts) WHERE attempts = 0;
CREATE INDEX moderation_jobs_failing ON moderation_jobs (due_at) WHERE attempts > 0;
ALTER TABLE remote_moderation_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE remote_moderation_jobs ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX remote_moderation_jobs_fresh ON remote_moderation_jobs (attempts) WHERE attempts = 0;
CREATE INDEX remote_moderation_jobs_failing ON remote_moderation_jobs (due_at) WHERE attempts > 0;
