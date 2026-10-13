-- Phase 2.3: Interaction tables
CREATE TABLE bookmarks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "status_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "bookmarks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "bookmarks_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "bookmarks_unique" ON "bookmarks" ("account_id", "status_id");

CREATE TABLE status_pins (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "status_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "status_pins_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "status_pins_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "status_pins_unique" ON "status_pins" ("account_id", "status_id");

-- Phase 2.4: Media attachments table
CREATE TABLE media_attachments (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mastodon_id" TEXT UNIQUE NOT NULL,
  "account_id" TEXT NOT NULL,
  "status_id" TEXT,
  "type" TEXT NOT NULL DEFAULT 'unknown',
  "url" TEXT,
  "preview_url" TEXT,
  "remote_url" TEXT,
  "description" TEXT,
  "blurhash" TEXT,
  "meta" TEXT NOT NULL DEFAULT '{}',
  "processing_state" TEXT NOT NULL DEFAULT 'complete',
  "file_name" TEXT,
  "file_content_type" TEXT,
  "file_size" INTEGER,
  "remote" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "media_attachments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "media_attachments_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE SET NULL
);
CREATE INDEX "media_attachments_account_id" ON "media_attachments" ("account_id");
CREATE INDEX "media_attachments_status_id" ON "media_attachments" ("status_id");
