-- Kopje Store schema 0080: the retry state of the inbound jobs. Never edit after release (checksummed).
--
--   inbound_jobs.attempts, due_at   a job's consecutive failed or stalled batches since it last advanced, and when it
--                                   may run again (src/domain/job-attempts.ts, RES-5): fresh (0, NULL), backing off
--                                   (1 to 5, an integer time in ms within 0 to 2^53 - 1) or parked (6, NULL), every
--                                   accepted row exactly one of them, imported rows included. Every stored job starts
--                                   fresh.
--   inbound_jobs_fresh              the fresh pending jobs in their order: the round's seek for the next job.
--   inbound_jobs_failing            the pending jobs backing off or parked, by due_at: the seek for a due retry, and
--                                   the walk of POST /admin/jobs/retry.
--
-- Cost: the columns' CHECKs may read every inbound_jobs row, and each index reads them once; nothing else is read or
-- written. Measured on the benchmark store of test/bench/migration-cost.ts (its 10,000 inbound jobs,
-- half of them done, beside the rest) in workerd's local Durable Object SQLite: 17 to 18 ms for the upgrade of this
-- file through the kernel, at a load average of 5 to 17.

ALTER TABLE inbound_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 6);
ALTER TABLE inbound_jobs ADD COLUMN due_at INTEGER CHECK (
  (attempts = 0 AND due_at IS NULL)
  OR (attempts BETWEEN 1 AND 5 AND typeof(due_at) = 'integer' AND due_at BETWEEN 0 AND 9007199254740991)
  OR (attempts = 6 AND due_at IS NULL));
CREATE INDEX inbound_jobs_fresh ON inbound_jobs (created_at, kind, key) WHERE done_at IS NULL AND attempts = 0;
CREATE INDEX inbound_jobs_failing ON inbound_jobs (due_at) WHERE done_at IS NULL AND attempts > 0;
