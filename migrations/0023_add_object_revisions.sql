CREATE TABLE
  object_revisions (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL GENERATED ALWAYS AS (JSON_EXTRACT("properties", '$.type')) STORED,
    "object_id" TEXT NOT NULL,
    "properties" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "object_revisions_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id") ON DELETE CASCADE
  );

CREATE INDEX "object_revisions_object_id" ON "object_revisions" ("object_id");
