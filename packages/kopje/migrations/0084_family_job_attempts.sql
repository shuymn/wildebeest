-- Kopje Store schema 0084: the retry state of the other job families. Never edit after release (checksummed).
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
-- The values these jobs carry past 2^53 are read exactly from here on (as TEXT, DATA-6); the ones earlier builds wrote
-- through JavaScript numbers are made what those builds meant:
--   notification_request_jobs.cursor   becomes inclusive (the highest notification id the walk still reads): an
--                                      exclusive INTEGER c becomes c - 1, a REAL the highest INTEGER below it
--                                      (INT64_MAX for a successor of INT64_MAX that overflowed). A cursor at or below
--                                      INT64_MIN left nothing to read: its job is done, and its row goes, as a round
--                                      ends a job (the round's notifications_merged event, to sockets open at that
--                                      moment, has none to reach during the upgrade).
--   follow_bound, domain_block_cleanups.bound and cursor
--                                      a REAL (a bound of INT64_MAX that a number rounded to 2^63) becomes the INTEGER it
--                                      casts to.
--   the follower cursor of a local job's followers phase (moderation_jobs.state), and the follow id of a remote job's
--   severing cursor ('state id', in an account job's cursor or a domain job's side)
--                                      the id that build's Number() parsed from what it stored (its shortest decimal),
--                                      CAST(CAST(x AS REAL) AS INTEGER), where it resumed.
--
-- Cost: the columns' CHECKs may read every row of each table, each index reads them once, and the normalization reads
-- each table once more and rewrites the request jobs and the rows of the shapes above. Measured on the benchmark store
-- of test/bench/migration-cost.ts (its 180 local and 11,001 remote moderation jobs, 10,000 stamp revocations, half of
-- them pending, 1,000 domain block cleanups, notification request jobs and dismissals, and 20 clears, beside the rest,
-- with the legacy shapes above seeded: half the request jobs' cursors a REAL, the local reach jobs at a numeric
-- followers cursor, the suspension jobs' bounds a REAL, 10,000 remote account jobs severing from 'accepted N') in
-- workerd's local Durable Object SQLite: 56 to 111 ms for the upgrade of this file through the kernel in four runs, at
-- load averages of 3 to 13.

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
DELETE FROM notification_request_jobs WHERE typeof(cursor) IN ('integer', 'real') AND cursor <= -9223372036854775808;
UPDATE notification_request_jobs SET cursor = cursor - 1 WHERE typeof(cursor) = 'integer';
UPDATE notification_request_jobs SET cursor = CAST(cursor AS INTEGER) - (cursor <= CAST(cursor AS INTEGER))
  WHERE typeof(cursor) = 'real';
UPDATE moderation_jobs SET follow_bound = CAST(follow_bound AS INTEGER) WHERE typeof(follow_bound) = 'real';
UPDATE remote_moderation_jobs SET follow_bound = CAST(follow_bound AS INTEGER) WHERE typeof(follow_bound) = 'real';
UPDATE domain_block_cleanups SET bound = CAST(bound AS INTEGER), cursor = CAST(cursor AS INTEGER)
  WHERE typeof(bound) = 'real' OR typeof(cursor) = 'real';
UPDATE moderation_jobs
  SET state = json_set(state, '$.cursor', CAST(CAST(CAST(json_extract(state, '$.cursor') AS REAL) AS INTEGER) AS TEXT))
  WHERE phase = 'followers' AND json_type(state, '$.cursor') IN ('integer', 'real');
UPDATE remote_moderation_jobs
  SET cursor = substr(cursor, 1, instr(cursor, ' '))
    || CAST(CAST(CAST(substr(cursor, instr(cursor, ' ') + 1) AS REAL) AS INTEGER) AS TEXT)
  WHERE kind = 'account' AND phase = 'in' AND instr(cursor, ' ') > 0;
UPDATE remote_moderation_jobs
  SET cursor = json_set(cursor, '$.side.cursor',
    substr(json_extract(cursor, '$.side.cursor'), 1, instr(json_extract(cursor, '$.side.cursor'), ' '))
    || CAST(CAST(CAST(substr(json_extract(cursor, '$.side.cursor'), instr(json_extract(cursor, '$.side.cursor'), ' ') + 1)
      AS REAL) AS INTEGER) AS TEXT))
  WHERE kind = 'domain' AND phase = 'mark' AND json_valid(cursor) AND json_extract(cursor, '$.side.dir') = 'in'
    AND instr(json_extract(cursor, '$.side.cursor'), ' ') > 0;
