CREATE TABLE "actor_activities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "type" TEXT NOT NULL GENERATED ALWAYS AS (json_extract(activity, '$.type')) STORED,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "activity" TEXT NOT NULL,

    CONSTRAINT "actor_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
