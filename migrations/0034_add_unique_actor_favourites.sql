DELETE FROM actor_favourites
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM actor_favourites
  GROUP BY actor_id, object_id
);

CREATE UNIQUE INDEX IF NOT EXISTS "unique_actor_favourites" ON "actor_favourites" ("actor_id", "object_id");
