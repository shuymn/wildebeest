-- Phase 2.5: Tag tables
CREATE TABLE tags (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT UNIQUE NOT NULL,
  "display_name" TEXT NOT NULL,
  "usable" INTEGER NOT NULL DEFAULT 1,
  "trendable" INTEGER NOT NULL DEFAULT 1,
  "listable" INTEGER NOT NULL DEFAULT 1,
  "last_status_at" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE TABLE status_tags (
  "status_id" TEXT NOT NULL,
  "tag_id" INTEGER NOT NULL,
  PRIMARY KEY ("status_id", "tag_id"),
  CONSTRAINT "status_tags_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE,
  CONSTRAINT "status_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
);

CREATE TABLE followed_tags (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "followed_tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "followed_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "followed_tags_unique" ON "followed_tags" ("account_id", "tag_id");

CREATE TABLE featured_tags (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "statuses_count" INTEGER NOT NULL DEFAULT 0,
  "last_status_at" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "featured_tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "featured_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "featured_tags_unique" ON "featured_tags" ("account_id", "tag_id");

-- Phase 2.6: Mention table
CREATE TABLE mentions (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "status_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "silent" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "mentions_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE,
  CONSTRAINT "mentions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE INDEX "mentions_status_id" ON "mentions" ("status_id");
CREATE INDEX "mentions_account_id" ON "mentions" ("account_id");
CREATE UNIQUE INDEX "mentions_unique" ON "mentions" ("status_id", "account_id");

-- Phase 2.7: List tables
CREATE TABLE lists (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "replies_policy" TEXT NOT NULL DEFAULT 'list',
  "exclusive" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "lists_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE INDEX "lists_account_id" ON "lists" ("account_id");

CREATE TABLE list_accounts (
  "list_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "follow_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("list_id", "account_id"),
  CONSTRAINT "list_accounts_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists" ("id") ON DELETE CASCADE,
  CONSTRAINT "list_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE INDEX "list_accounts_account_id" ON "list_accounts" ("account_id");
