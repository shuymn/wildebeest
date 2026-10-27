-- Changed from cloudflare/wildebeest (Apache-2.0) by the Kopje contributors.
-- Migration number: 0001 	 2023-01-16T13:09:04.033Z

CREATE UNIQUE INDEX "unique_actor_following" ON "actor_following" ("actor_id", "target_actor_id");
