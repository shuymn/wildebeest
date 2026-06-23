DELETE FROM actor_replies
WHERE id NOT IN (
  SELECT COALESCE(
    (
      SELECT canonical.id
      FROM actor_replies AS canonical
      INNER JOIN objects AS reply ON reply.id = canonical.object_id
      WHERE canonical.object_id = actor_replies.object_id
        AND canonical.in_reply_to_object_id = reply.in_reply_to_id
      ORDER BY canonical.id
      LIMIT 1
    ),
    (
      SELECT canonical.id
      FROM actor_replies AS canonical
      INNER JOIN objects AS reply ON reply.id = canonical.object_id
      LEFT JOIN objects AS parent ON parent.id = canonical.in_reply_to_object_id
      WHERE canonical.object_id = actor_replies.object_id
        AND (
          canonical.in_reply_to_object_id = json_extract(reply.properties, '$.inReplyTo')
          OR parent.original_object_id = json_extract(reply.properties, '$.inReplyTo')
      )
      ORDER BY canonical.id
      LIMIT 1
    ),
    MIN(grouped.id)
  )
  FROM actor_replies AS grouped
  WHERE grouped.object_id = actor_replies.object_id
);

CREATE UNIQUE INDEX IF NOT EXISTS "actor_replies_unique_object_id" ON "actor_replies" ("object_id");
