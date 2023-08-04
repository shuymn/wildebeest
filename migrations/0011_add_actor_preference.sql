CREATE TABLE "actor_preferences" (
    "id" TEXT PRIMARY KEY,
    "posting_default_visibility" TEXT NOT NULL DEFAULT 'public',
    "posting_default_sensitive" INTEGER NOT NULL DEFAULT 0,
    "posting_default_language" TEXT,
    "reading_expand_media" TEXT NOT NULL DEFAULT 'default',
    "reading_expand_spoilers" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "actor_preferences_id_fkey" FOREIGN KEY ("id") REFERENCES "actors"("id") ON DELETE CASCADE
);

INSERT INTO "actor_preferences" SELECT id, 'public', 0, null, 'default', 0 FROM "actors"
WHERE "id" = (SELECT "id" FROM "actors" ORDER BY "cdate" ASC LIMIT 1);
