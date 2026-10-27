-- Kopje Store schema 0085: the staged targets of a retraction (src/domain/deliveries.ts stageRetraction, RES-6). Never
-- edit after release (checksummed).
--
--   retraction_stagings   one row per retraction whose targets are being staged: its intent (activity_id), the
--                         follows it reads (follow_bound, the highest follows.id when it began), where its gathering
--                         stands (phase, subject: the forwarded share it walks; shared: whether one resolved; the
--                         after_* cursors) and whether its intent stopped staging (ended). AUTOINCREMENT: an id is
--                         never reused, so a stale outbound_activities.staged never names a later staging.
--                         outbound_activities.staged holds CAST(id AS TEXT) of its row; '' before the first call, and
--                         any other value restarts the staging. No foreign key names the intent: an intent with staged
--                         set is never deleted (deliveries.ts dropSettledActivity), and outbound_activities_staging_ended
--                         marks the row ended once staged is cleared (supersede). after_key is a status or account id,
--                         or a receipt's inbox within TARGET_CHUNK_BYTES (a larger receipt is deleted, never a cursor).
--   retraction_reach      the staged set: one row per target, keyed as the chunks of the retraction will hold them (a
--                         personal copy, neutral 0, by its addressee, with the inbox of the lowest account id behind it,
--                         '' when it has none; a neutral copy, neutral 1, by its inbox), with the recipients behind it
--                         (accounts, at most PROVENANCE_MAX + 1 ids; unknown once one is an earlier receiver). Its rows
--                         are deleted as they are written out, or by sweepDeliveries once their staging ended; the
--                         foreign key does not cascade.
--
-- The stored format of outbound_activities.staged changes for retractions: it held the key of the last target written;
-- it now names a retraction_stagings row. A retraction staging across the upgrade restarts, so a target it had written
-- may get its retraction twice (receivers deduplicate by activity id). Staged Updates (retracts 0) keep ''.
--
-- Cost: two new tables, an index and a trigger; nothing is read or written. A file that creates a table cannot declare
-- foreignKeys: 'unchanged' (test/migration-sql.ts), so its upgrade checks every reference of the Store. Measured on the
-- benchmark store of test/bench/migration-cost.ts in workerd's local Durable Object SQLite: see the CHANGELOG entry of
-- this file.

CREATE TABLE retraction_stagings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL CHECK (typeof(activity_id) = 'integer'),
  follow_bound INTEGER NOT NULL CHECK (typeof(follow_bound) = 'integer'),
  phase TEXT NOT NULL CHECK (phase IN ('accounts', 'mentions', 'parent', 'boosters', 'quoters', 'voters', 'followers',
    'unexpanded', 'deliveries', 'receipts', 'emit')),
  subject INTEGER NOT NULL DEFAULT 0 CHECK (typeof(subject) = 'integer' AND subject >= 0),
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  after_id INTEGER CHECK (after_id IS NULL OR typeof(after_id) = 'integer'),
  after_row INTEGER CHECK (after_row IS NULL OR typeof(after_row) = 'integer'),
  after_index INTEGER CHECK (after_index IS NULL OR (typeof(after_index) = 'integer' AND after_index >= 0)),
  after_key TEXT CHECK (after_key IS NULL OR (typeof(after_key) = 'text' AND length(CAST(after_key AS BLOB)) <= 524288)),
  ended INTEGER NOT NULL DEFAULT 0 CHECK (ended IN (0, 1))
);

CREATE INDEX retraction_stagings_ended ON retraction_stagings (id) WHERE ended = 1;

CREATE TABLE retraction_reach (
  staging_id INTEGER NOT NULL REFERENCES retraction_stagings (id),
  neutral INTEGER NOT NULL CHECK (neutral IN (0, 1)),
  key TEXT NOT NULL CHECK (typeof(key) = 'text'),
  inbox TEXT CHECK ((inbox IS NULL) = (neutral = 1) AND (inbox IS NULL OR typeof(inbox) = 'text')),
  inbox_account TEXT CHECK ((inbox_account IS NULL) = (neutral = 1)
    AND (inbox_account IS NULL OR (typeof(inbox_account) = 'text' AND length(CAST(inbox_account AS BLOB)) <= 18))),
  accounts TEXT NOT NULL CHECK (length(CAST(accounts AS BLOB)) <= 1024 AND json_valid(accounts)
    AND json_type(accounts) = 'array' AND json_array_length(accounts) <= 17),
  unknown INTEGER NOT NULL DEFAULT 0 CHECK (unknown IN (0, 1)),
  CHECK (length(CAST(key AS BLOB)) + length(CAST(COALESCE(inbox, '') AS BLOB)) <= 524288),
  PRIMARY KEY (staging_id, neutral, key)
) WITHOUT ROWID;

CREATE TRIGGER outbound_activities_staging_ended AFTER UPDATE OF staged ON outbound_activities
WHEN old.retracts = 1 AND old.staged IS NOT NULL AND old.staged <> '' AND new.staged IS NULL
BEGIN
  UPDATE retraction_stagings SET ended = 1
  WHERE id = CAST(old.staged AS INTEGER) AND activity_id = old.id AND ended = 0;
END;
