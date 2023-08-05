DROP TRIGGER `actors_search_fts_insert`;
DROP TRIGGER `actors_search_fts_update`;

ALTER TABLE `actors` DROP COLUMN `type`;
ALTER TABLE `actors` ADD COLUMN `type` text GENERATED ALWAYS AS (json_extract(properties, '$.type')) VIRTUAL NOT NULL;

ALTER TABLE `actors` ADD COLUMN `username` text GENERATED ALWAYS AS (lower(json_extract(properties, '$.preferredUsername'))) VIRTUAL NOT NULL;
ALTER TABLE `actors` ADD COLUMN `domain` text;

CREATE INDEX "actors_mastodon_id" ON "actors" ("mastodon_id");
CREATE INDEX "actors_username" ON "actors" ("username");
CREATE INDEX "actors_domain" ON "actors" ("domain");

CREATE TRIGGER "actors_search_fts_insert" AFTER INSERT ON "actors"
BEGIN
    INSERT INTO "search_fts" ("rowid", "type", "name", "preferredUsername")
    VALUES ("new"."rowid",
            "new"."type",
            json_extract("new"."properties", '$.name'),
            "new"."username");
END;

CREATE TRIGGER "actors_search_fts_update" AFTER UPDATE ON "actors"
BEGIN
    DELETE FROM "search_fts" WHERE "rowid"="old"."rowid";
    INSERT INTO "search_fts" ("rowid", "type", "name", "preferredUsername")
    VALUES ("new"."rowid",
            "new"."type",
            json_extract("new"."properties", '$.name'),
            "new"."username");
END;
