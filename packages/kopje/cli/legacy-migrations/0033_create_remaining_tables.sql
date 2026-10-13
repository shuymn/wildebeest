-- Phase 2.8: Marker table
CREATE TABLE markers (
  "account_id" TEXT NOT NULL,
  "timeline" TEXT NOT NULL,
  "last_read_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("account_id", "timeline"),
  CONSTRAINT "markers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);

-- Phase 2.9: Poll tables
CREATE TABLE polls (
  "id" TEXT NOT NULL PRIMARY KEY,
  "status_id" TEXT UNIQUE,
  "account_id" TEXT NOT NULL,
  "multiple" INTEGER NOT NULL DEFAULT 0,
  "hide_totals" INTEGER NOT NULL DEFAULT 0,
  "expires_at" DATETIME,
  "votes_count" INTEGER NOT NULL DEFAULT 0,
  "voters_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "polls_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE,
  CONSTRAINT "polls_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);

CREATE TABLE poll_options (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "poll_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "votes_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "poll_options_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "poll_options_poll_position" ON "poll_options" ("poll_id", "position");

CREATE TABLE poll_votes (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "poll_id" TEXT NOT NULL,
  "poll_option_id" INTEGER NOT NULL,
  "account_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "poll_votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE CASCADE,
  CONSTRAINT "poll_votes_poll_option_id_fkey" FOREIGN KEY ("poll_option_id") REFERENCES "poll_options" ("id") ON DELETE CASCADE,
  CONSTRAINT "poll_votes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "poll_votes_unique" ON "poll_votes" ("poll_id", "poll_option_id", "account_id");

CREATE TRIGGER "poll_votes_single_choice_guard_insert"
BEFORE INSERT ON "poll_votes"
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM "polls" p
  WHERE p."id" = NEW."poll_id"
    AND p."multiple" = 0
)
AND EXISTS (
  SELECT 1
  FROM "poll_votes" pv
  WHERE pv."poll_id" = NEW."poll_id"
    AND pv."account_id" = NEW."account_id"
)
BEGIN
  SELECT RAISE(ABORT, 'single-choice poll already voted');
END;

CREATE TRIGGER "poll_votes_single_choice_guard_update"
BEFORE UPDATE ON "poll_votes"
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM "polls" p
  WHERE p."id" = NEW."poll_id"
    AND p."multiple" = 0
)
AND EXISTS (
  SELECT 1
  FROM "poll_votes" pv
  WHERE pv."poll_id" = NEW."poll_id"
    AND pv."account_id" = NEW."account_id"
    AND pv."id" != NEW."id"
)
BEGIN
  SELECT RAISE(ABORT, 'single-choice poll already voted');
END;

-- Phase 2.10: Filter tables
CREATE TABLE filters (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '[]',
  "filter_action" TEXT NOT NULL DEFAULT 'warn',
  "expires_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "filters_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);

CREATE TABLE filter_keywords (
  "id" TEXT NOT NULL PRIMARY KEY,
  "filter_id" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "whole_word" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "filter_keywords_filter_id_fkey" FOREIGN KEY ("filter_id") REFERENCES "filters" ("id") ON DELETE CASCADE
);

CREATE TABLE filter_statuses (
  "id" TEXT NOT NULL PRIMARY KEY,
  "filter_id" TEXT NOT NULL,
  "status_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "filter_statuses_filter_id_fkey" FOREIGN KEY ("filter_id") REFERENCES "filters" ("id") ON DELETE CASCADE,
  CONSTRAINT "filter_statuses_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE
);

-- Phase 2.11: Conversation tables
CREATE TABLE conversations (
  "id" TEXT NOT NULL PRIMARY KEY,
  "uri" TEXT UNIQUE,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE TABLE conversation_accounts (
  "conversation_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "last_status_id" TEXT,
  "unread" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("conversation_id", "account_id"),
  CONSTRAINT "conversation_accounts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
  CONSTRAINT "conversation_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);

CREATE TABLE conversation_mutes (
  "conversation_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("conversation_id", "account_id"),
  CONSTRAINT "conversation_mutes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
  CONSTRAINT "conversation_mutes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);

-- Phase 2.12: Status edits table
CREATE TABLE status_edits (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "status_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "spoiler_text" TEXT NOT NULL DEFAULT '',
  "sensitive" INTEGER NOT NULL DEFAULT 0,
  "media_attachments_json" TEXT NOT NULL DEFAULT '[]',
  "poll_json" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  CONSTRAINT "status_edits_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE,
  CONSTRAINT "status_edits_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);
CREATE INDEX "status_edits_status_id" ON "status_edits" ("status_id");
