-- Backfill reply columns before read paths depend on objects.in_reply_to_id.
-- This migration must be applied before deploying Workers that read objects.in_reply_to_id.
UPDATE objects SET in_reply_to_id = (
  SELECT ar.in_reply_to_object_id
  FROM actor_replies ar
  INNER JOIN objects AS reply ON reply.id = ar.object_id
  INNER JOIN objects AS parent ON parent.id = ar.in_reply_to_object_id
  WHERE ar.object_id = objects.id
    AND (
      ar.in_reply_to_object_id = reply.reply_to_object_id
      OR parent.original_object_id = reply.reply_to_object_id
    )
  ORDER BY ar.id
  LIMIT 1
)
WHERE in_reply_to_id IS NULL
  AND EXISTS (
    SELECT 1 FROM actor_replies ar
    INNER JOIN objects AS reply ON reply.id = ar.object_id
    INNER JOIN objects AS parent ON parent.id = ar.in_reply_to_object_id
    WHERE ar.object_id = objects.id
      AND (
        ar.in_reply_to_object_id = reply.reply_to_object_id
        OR parent.original_object_id = reply.reply_to_object_id
      )
  );

UPDATE objects SET in_reply_to_id = (
  SELECT parent.id
  FROM objects AS parent
  WHERE parent.id = objects.reply_to_object_id
     OR parent.original_object_id = objects.reply_to_object_id
  ORDER BY parent.id
  LIMIT 1
)
WHERE in_reply_to_id IS NULL
  AND reply_to_object_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM objects AS parent
    WHERE parent.id = objects.reply_to_object_id
       OR parent.original_object_id = objects.reply_to_object_id
  );

UPDATE objects SET in_reply_to_account_id = (
  SELECT original_actor_id FROM objects AS parent
  WHERE parent.id = objects.in_reply_to_id
)
WHERE in_reply_to_id IS NOT NULL
  AND in_reply_to_account_id IS NULL;

UPDATE objects SET replies_count = (
  SELECT COUNT(*) FROM objects AS replies
  WHERE replies.in_reply_to_id = objects.id
);
