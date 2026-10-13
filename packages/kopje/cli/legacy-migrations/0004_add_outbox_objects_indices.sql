-- Migration number: 0004 	 2023-02-03T17:17:19.099Z

CREATE INDEX "outbox_objects_actor_id" ON "outbox_objects" ("actor_id");
CREATE INDEX "outbox_objects_target" ON "outbox_objects" ("target");
