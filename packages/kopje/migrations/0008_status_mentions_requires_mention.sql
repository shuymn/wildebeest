-- Kopje Store schema 0008: which mentions home's mentions stream can show. Never edit after release (checksummed).
--
-- status_mentions.requires_mention is 1 when the row's status is direct or limited (REQUIRES_MENTION_SQL in
-- src/domain/audience.ts): the statuses only a mention lets a follower see, and the only ones home reads from the
-- viewer's mentions (homeTimeline in src/domain/timelines.ts). A status's visibility stays in that set once written (a
-- direct status that gains a recipient becomes limited; an edit or a remote Update never changes it), so the writers
-- of status_mentions set it from the status as they write the row. The partial index holds only those rows, so home
-- reads the viewer's mentions in direct and limited statuses and never those in public, unlisted or private ones.
--
-- The backfill makes one pass over status_mentions and looks up each row's status by its primary key, so its work
-- follows the number of mention rows.

ALTER TABLE status_mentions ADD COLUMN requires_mention INTEGER NOT NULL DEFAULT 0 CHECK (requires_mention IN (0, 1));

UPDATE status_mentions SET requires_mention = 1
  WHERE (SELECT s.visibility FROM statuses s WHERE s.id = status_mentions.status_id) IN ('direct', 'limited');

CREATE INDEX status_mentions_requires_mention ON status_mentions (account_id, status_id) WHERE requires_mention = 1;
