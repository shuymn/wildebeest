PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "new_actors" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mastodon_id" TEXT NOT NULL,
  "type" TEXT NOT NULL GENERATED ALWAYS AS (json_extract("properties", '$.type')) STORED,
  "username" TEXT NOT NULL GENERATED ALWAYS AS (lower(json_extract("properties", '$.preferredUsername'))) STORED,
  "domain" TEXT NOT NULL,
  "properties" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

UPDATE actors SET properties = json_set(properties, '$.type', type) WHERE json_extract(properties, '$.type') IS NULL;
UPDATE actors SET properties = json_set(properties, '$.id', id) WHERE json_extract(properties, '$.id') IS NULL;
UPDATE actors SET properties = json_set(properties, '$.featured', id || '/featured')
  WHERE json_extract(properties, '$.featured') IS NULL AND email IS NOT NULL;
UPDATE actors SET properties = json_set(properties, '$.publicKey', json_patch(json_object('id', id || '#main-key'), json_object('publicKeyPem', pubkey)))
  WHERE json_extract(properties, '$.publicKey') IS NULL AND email IS NOT NULL;

INSERT INTO new_actors(id, mastodon_id, domain, properties, cdate)
SELECT
	json_extract(properties, '$.id') as id,
	ifnull(mastodon_id, printf('%s-%s-%s-%s-%s', lower(hex(randomblob(4))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(6))))) as mastodon_id,
	substr(substr(id, instr(id, '//') + 2), 0, instr(substr(id, instr(id, '//') + 2), '/')) as domain,
	properties,
	cdate
FROM actors;

DROP TABLE actors;
ALTER TABLE new_actors RENAME TO actors;

CREATE INDEX "actors_mastodon_id" ON "actors" ("mastodon_id");
CREATE INDEX "actors_username" ON "actors" ("username");
CREATE INDEX "actors_domain" ON "actors" ("domain");

CREATE TRIGGER "actors_search_fts_insert" AFTER INSERT ON "actors"
BEGIN
    INSERT INTO "search_fts" ("rowid", "type", "name", "preferredUsername")
    VALUES ("new"."rowid",
            "new"."type",
            json_extract("new"."properties", '$.name'),
            json_extract("new"."properties", '$.preferredUsername'));
END;

CREATE TRIGGER "actors_search_fts_delete" AFTER DELETE ON "actors"
BEGIN
    DELETE FROM "search_fts" WHERE "rowid"="old"."rowid";
END;

CREATE TRIGGER "actors_search_fts_update" AFTER UPDATE ON "actors"
BEGIN
    DELETE FROM "search_fts" WHERE "rowid"="old"."rowid";
    INSERT INTO "search_fts" ("rowid", "type", "name", "preferredUsername")
    VALUES ("new"."rowid",
            "new"."type",
            json_extract("new"."properties", '$.name'),
            json_extract("new"."properties", '$.preferredUsername'));
END;
