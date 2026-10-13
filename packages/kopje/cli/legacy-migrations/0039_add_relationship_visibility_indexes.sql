CREATE INDEX IF NOT EXISTS "blocks_target_account_id_account_id" ON "blocks" ("target_account_id", "account_id");
CREATE INDEX IF NOT EXISTS "outbox_objects_object_id_published_date" ON "outbox_objects" ("object_id", "published_date");
