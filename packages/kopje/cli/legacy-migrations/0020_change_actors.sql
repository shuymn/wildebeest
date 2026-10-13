ALTER TABLE `actors` ADD COLUMN `username` text;
ALTER TABLE `actors` ADD COLUMN `domain` text;

CREATE INDEX "actors_mastodon_id" ON "actors" ("mastodon_id");
CREATE INDEX "actors_username" ON "actors" ("username");
CREATE INDEX "actors_domain" ON "actors" ("domain");

UPDATE actors SET domain = substr(substr(id, instr(id, '//') + 2), 0, instr(substr(id, instr(id, '//') + 2), '/'));
UPDATE actors SET username = lower(json_extract(properties, '$.preferredUsername'));

UPDATE actors SET mastodon_id = printf('%s-%s-%s-%s-%s', lower(hex(randomblob(4))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(6)))) WHERE mastodon_id IS NULL;
UPDATE actors SET `type` = json_extract(properties, '$.type');

UPDATE actors SET properties = json_set(properties, '$.type', type) WHERE json_extract(properties, '$.type') IS NULL;
UPDATE actors SET properties = json_set(properties, '$.id', id) WHERE json_extract(properties, '$.id') IS NULL;

UPDATE actors SET properties = json_set(properties, '$.featured', id || '/featured')
  WHERE json_extract(properties, '$.featured') IS NULL AND email IS NOT NULL;

UPDATE actors SET properties = json_set(properties, '$.publicKey', json_patch(json_object('id', id || '#main-key'), json_object('publicKeyPem', pubkey)))
  WHERE json_extract(properties, '$.publicKey') IS NULL AND email IS NOT NULL;

UPDATE actors SET properties = json_set(properties, '$.url', 'https://' || domain || '/@' || username)
  WHERE json_extract(properties, '$.url') IS NULL AND email IS NOT NULL;

DROP INDEX `actors_email`;
ALTER TABLE `actors` DROP COLUMN `email`;
ALTER TABLE `actors` DROP COLUMN `pubkey`;
ALTER TABLE `actors` DROP COLUMN `privkey`;
ALTER TABLE `actors` DROP COLUMN `privkey_salt`;
ALTER TABLE `actors` DROP COLUMN `is_admin`;

DROP TRIGGER `actors_search_fts_insert`;
DROP TRIGGER `actors_search_fts_update`;

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
