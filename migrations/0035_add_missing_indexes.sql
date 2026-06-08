CREATE INDEX IF NOT EXISTS "filters_account_id" ON "filters" ("account_id");
CREATE INDEX IF NOT EXISTS "filter_keywords_filter_id" ON "filter_keywords" ("filter_id");
CREATE INDEX IF NOT EXISTS "filter_statuses_filter_id" ON "filter_statuses" ("filter_id");
CREATE INDEX IF NOT EXISTS "filter_statuses_status_id" ON "filter_statuses" ("status_id");
CREATE INDEX IF NOT EXISTS "status_tags_tag_id" ON "status_tags" ("tag_id");
CREATE INDEX IF NOT EXISTS "bookmarks_status_id" ON "bookmarks" ("status_id");
CREATE INDEX IF NOT EXISTS "status_pins_status_id" ON "status_pins" ("status_id");
