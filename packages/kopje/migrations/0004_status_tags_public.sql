-- Kopje Store schema 0004: which hashtags a hashtag timeline can show. Never edit after release (checksummed).
--
-- status_tags.public is 1 when the row's status is public: the only statuses a hashtag timeline lists (publicConditions
-- in src/domain/timelines.ts). A status's visibility is fixed when it is written (an edit or a remote Update never
-- changes it), so the writers of status_tags set it from the status as they write the row. The partial index holds
-- only those rows, so the timeline and a tag's history read the tag's public statuses and never its unlisted, private,
-- direct or limited ones.
--
-- The backfill makes one pass over status_tags and looks up each row's status by its primary key, so its work follows
-- the number of hashtag rows.

ALTER TABLE status_tags ADD COLUMN public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1));

UPDATE status_tags SET public = 1 WHERE (SELECT s.visibility FROM statuses s WHERE s.id = status_tags.status_id) = 'public';

CREATE INDEX status_tags_public ON status_tags (name, status_id) WHERE public = 1;
