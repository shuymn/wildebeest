-- Kopje Store schema 0015: media an edit drops stays with its status. Never edit after release (checksummed).
--
-- An edit that drops media keeps it attached to its status, as Mastodon keeps the status_id and only leaves the media
-- out of ordered_media_attachment_ids: the status's earlier versions (status_edits.media_json) still show it. shown is
-- 0 for such media: it is no part of what the status shows now (its media_attachments, its Note's attachments,
-- only_media), it is never swept while the status exists (it has a status_id), a later edit of the same status may
-- attach it again (shown 1), nothing else may attach it, and it goes with the status as the status's other media
-- does. Unattached media is always shown 1.
--
-- media_attachments_status is rebuilt over (status_id, shown, position), so a read of what statuses show seeks past
-- the media they no longer show.
--
-- Media that only earlier versions of a status name, kept unattached until now, is linked to that status with shown 0:
-- a local upload with files of its own, of the status's author, held by no scheduled status, not a profile image, and
-- either kept for good (no gc_at: what the cutover keeps for an image only earlier versions show) or detached by an
-- edit and still more than an hour from its sweep. The link is the media id an earlier version names; media that
-- earlier versions of more than one status name, or of none, stays as it is.
--
-- Cost: the column's check and the index build read each upload once; the link reads each edit's media once, groups
-- them by media id, and looks each group's upload up by id.

ALTER TABLE media_attachments ADD COLUMN shown INTEGER NOT NULL DEFAULT 1
  CHECK (shown IN (0, 1) AND (shown = 1 OR status_id IS NOT NULL));

DROP INDEX media_attachments_status;

CREATE INDEX media_attachments_status ON media_attachments (status_id, shown, position) WHERE status_id IS NOT NULL;

UPDATE media_attachments SET status_id = link.status_id, shown = 0, position = 0, gc_at = NULL
FROM (
  SELECT json_extract(j.value, '$.id') AS media_id, min(e.status_id) AS status_id
  FROM status_edits e, json_each(e.media_json) j
  WHERE json_type(j.value) = 'object'
  GROUP BY media_id
  HAVING count(DISTINCT e.status_id) = 1
) AS link
JOIN statuses s ON s.id = link.status_id
WHERE media_attachments.id = link.media_id
  AND media_attachments.account_id = s.account_id
  AND media_attachments.status_id IS NULL
  AND media_attachments.scheduled_status_id IS NULL
  AND media_attachments.file_token IS NOT NULL
  AND media_attachments.processed = 1
  AND media_attachments.url <> ''
  AND (media_attachments.gc_at IS NULL
    OR media_attachments.gc_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'))
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = media_attachments.account_id
    AND media_attachments.url IN (a.avatar_url, a.header_url));
