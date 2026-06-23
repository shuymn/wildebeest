UPDATE objects SET reblogs_count = (
  SELECT COUNT(*) FROM actor_reblogs
  WHERE actor_reblogs.object_id = objects.id
);
