CREATE UNIQUE INDEX IF NOT EXISTS "unique_actor_favourites" ON "actor_favourites" ("actor_id", "object_id");
