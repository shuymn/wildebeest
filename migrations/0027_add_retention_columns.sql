-- Phase 1.6: Retention columns for remote content cleanup
ALTER TABLE actors ADD COLUMN "cached_at" DATETIME;
ALTER TABLE actors ADD COLUMN "expires_at" DATETIME;
ALTER TABLE actors ADD COLUMN "interaction_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE objects ADD COLUMN "cached_at" DATETIME;
ALTER TABLE objects ADD COLUMN "expires_at" DATETIME;
ALTER TABLE objects ADD COLUMN "interaction_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "actors_cleanup" ON "actors" ("domain", "expires_at", "interaction_count")
  WHERE "domain" IS NOT NULL;

CREATE INDEX "objects_cleanup" ON "objects" ("local", "expires_at", "interaction_count")
  WHERE "local" = 0;
