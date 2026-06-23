UPDATE objects SET reblogs_count = (
  SELECT COUNT(*) FROM actor_reblogs
  WHERE actor_reblogs.object_id = objects.id
);

CREATE INDEX IF NOT EXISTS "objects_in_reply_to_id" ON "objects" ("in_reply_to_id")
  WHERE "in_reply_to_id" IS NOT NULL;
