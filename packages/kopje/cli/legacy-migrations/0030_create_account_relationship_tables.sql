-- Phase 2.1: Account-related tables
CREATE TABLE account_fields (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "account_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "name" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "verified_at" DATETIME,
  CONSTRAINT "account_fields_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE INDEX "account_fields_account_id" ON "account_fields" ("account_id");

CREATE TABLE account_notes (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "target_account_id" TEXT NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "account_notes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "account_notes_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "account_notes_unique" ON "account_notes" ("account_id", "target_account_id");

-- Phase 2.2: Relationship tables
CREATE TABLE blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "target_account_id" TEXT NOT NULL,
  "uri" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "blocks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "blocks_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "blocks_unique" ON "blocks" ("account_id", "target_account_id");

CREATE TABLE mutes (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "target_account_id" TEXT NOT NULL,
  "hide_notifications" INTEGER NOT NULL DEFAULT 1,
  "expires_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "mutes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "mutes_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "mutes_unique" ON "mutes" ("account_id", "target_account_id");

CREATE TABLE domain_blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "domain_blocks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "domain_blocks_unique" ON "domain_blocks" ("account_id", "domain");

CREATE TABLE endorsements (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "target_account_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "endorsements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "endorsements_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "endorsements_unique" ON "endorsements" ("account_id", "target_account_id");
