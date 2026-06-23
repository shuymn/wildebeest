CREATE TABLE
  actors (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mastodon_id" TEXT,
    "type" TEXT,
    "username" TEXT,
    "domain" TEXT,
    "properties" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "display_name" TEXT,
    "note" TEXT,
    "avatar" TEXT,
    "avatar_static" TEXT,
    "header" TEXT,
    "header_static" TEXT,
    "locked" INTEGER,
    "bot" INTEGER,
    "group" INTEGER,
    "discoverable" INTEGER,
    "indexable" INTEGER,
    "hide_collections" INTEGER,
    "followers_count" INTEGER,
    "following_count" INTEGER,
    "statuses_count" INTEGER,
    "last_status_at" TEXT,
    "suspended_at" DATETIME,
    "silenced_at" DATETIME,
    "uri" TEXT,
    "acct" TEXT,
    "url" TEXT,
    "updated_at" DATETIME,
    "cached_at" DATETIME,
    "expires_at" DATETIME,
    "interaction_count" INTEGER NOT NULL DEFAULT 0
  );

CREATE INDEX "actors_mastodon_id" ON "actors" ("mastodon_id");

CREATE INDEX "actors_username" ON "actors" ("username");

CREATE INDEX "actors_domain" ON "actors" ("domain");

CREATE INDEX "actors_cleanup" ON "actors" ("domain", "expires_at", "interaction_count")
  WHERE "domain" IS NOT NULL;

CREATE TRIGGER "actors_search_fts_insert" AFTER INSERT ON "actors" BEGIN
INSERT INTO
  "search_fts" ("rowid", "type", "name", "preferredUsername")
VALUES
  ("new"."rowid", "new"."type", JSON_EXTRACT("new"."properties", '$.name'), "new"."username");

END;

CREATE TRIGGER "actors_search_fts_delete" AFTER DELETE ON "actors" BEGIN
DELETE FROM "search_fts"
WHERE
  "rowid" = "old"."rowid";

END;

CREATE TRIGGER "actors_search_fts_update" AFTER
UPDATE ON "actors" BEGIN
DELETE FROM "search_fts"
WHERE
  "rowid" = "old"."rowid";

INSERT INTO
  "search_fts" ("rowid", "type", "name", "preferredUsername")
VALUES
  ("new"."rowid", "new"."type", JSON_EXTRACT("new"."properties", '$.name'), "new"."username");

END;

CREATE TABLE
  actor_following (
    "id" TEXT PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "target_actor_id" TEXT NOT NULL,
    "target_actor_acct" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "show_reblogs" INTEGER DEFAULT 1,
    "notify" INTEGER DEFAULT 0,
    "languages" TEXT,
    "uri" TEXT,
    "updated_at" DATETIME,
    CONSTRAINT "actor_following_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "actor_following_target_actor_id_fkey" FOREIGN KEY ("target_actor_id") REFERENCES "actors" ("id")
  );

CREATE UNIQUE INDEX "unique_actor_following" ON "actor_following" ("actor_id", "target_actor_id");

CREATE INDEX "actor_following_actor_id" ON "actor_following" ("actor_id");

CREATE INDEX "actor_following_target_actor_id" ON "actor_following" ("target_actor_id");

CREATE TABLE
  objects (
    "id" TEXT PRIMARY KEY,
    "mastodon_id" TEXT UNIQUE NOT NULL,
    "type" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "original_actor_id" TEXT,
    "original_object_id" TEXT UNIQUE,
    "reply_to_object_id" TEXT,
    "properties" TEXT NOT NULL DEFAULT (JSON_OBJECT()),
    "local" INTEGER NOT NULL,
    "content" TEXT,
    "text" TEXT,
    "spoiler_text" TEXT,
    "sensitive" INTEGER,
    "language" TEXT,
    "visibility" TEXT,
    "url" TEXT,
    "account_id" TEXT,
    "in_reply_to_id" TEXT,
    "in_reply_to_account_id" TEXT,
    "conversation_id" TEXT,
    "reblog_of_id" TEXT,
    "poll_id" TEXT,
    "application_name" TEXT,
    "application_website" TEXT,
    "replies_count" INTEGER,
    "reblogs_count" INTEGER,
    "favourites_count" INTEGER,
    "edited_at" DATETIME,
    "deleted_at" DATETIME,
    "updated_at" DATETIME,
    "cached_at" DATETIME,
    "expires_at" DATETIME,
    "interaction_count" INTEGER NOT NULL DEFAULT 0
  );

CREATE INDEX "objects_mastodon_id" ON "objects" ("mastodon_id");

CREATE INDEX "objects_original_actor_id" ON "objects" ("original_actor_id");

CREATE INDEX "objects_original_object_id" ON "objects" ("original_object_id");

CREATE INDEX "objects_in_reply_to_id" ON "objects" ("in_reply_to_id")
  WHERE "in_reply_to_id" IS NOT NULL;

CREATE INDEX "objects_cleanup" ON "objects" ("local", "expires_at", "interaction_count")
  WHERE "local" = 0;

CREATE TABLE
  inbox_objects (
    "id" TEXT PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "inbox_objects_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "inbox_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
  );

CREATE TABLE
  actor_notifications (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "from_actor_id" TEXT NOT NULL,
    "object_id" TEXT,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "group_key" TEXT,
    "read" INTEGER DEFAULT 0,
    "filtered" INTEGER DEFAULT 0,
    "report_id" TEXT,
    "account_warning_id" INTEGER,
    CONSTRAINT "actor_notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "actor_notifications_from_actor_id_fkey" FOREIGN KEY ("from_actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "actor_notifications_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
  );

CREATE INDEX "actor_notifications_actor_id" ON "actor_notifications" ("actor_id");

CREATE TABLE
  actor_favourites (
    "id" TEXT PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "actor_favourites_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "actor_favourites_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
  );

CREATE INDEX "actor_favourites_actor_id" ON "actor_favourites" ("actor_id");

CREATE INDEX "actor_favourites_object_id" ON "actor_favourites" ("object_id");

CREATE UNIQUE INDEX "unique_actor_favourites" ON "actor_favourites" ("actor_id", "object_id");

CREATE TABLE
  clients (
    "id" TEXT PRIMARY KEY,
    "secret" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT NOT NULL,
    "website" TEXT,
    "scopes" TEXT,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
  );

CREATE VIRTUAL TABLE search_fts USING "fts5" ("type", "name", "preferredUsername", "status");

CREATE TABLE
  search_fts_data ("id" INTEGER PRIMARY KEY, "block" BLOB);

CREATE TABLE
  search_fts_idx ("segid", "term", "pgno", PRIMARY KEY ("segid", "term")) WITHOUT ROWID;

CREATE TABLE
  search_fts_content ("id" INTEGER PRIMARY KEY, "c0", "c1", "c2", "c3");

CREATE TABLE
  search_fts_docsize ("id" INTEGER PRIMARY KEY, "sz" BLOB);

CREATE TABLE
  search_fts_config ("k" PRIMARY KEY, "v") WITHOUT ROWID;

CREATE TABLE
  actor_replies (
    "id" TEXT PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "in_reply_to_object_id" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "actor_replies_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "actor_replies_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id"),
    CONSTRAINT "actor_replies_in_reply_to_object_id_fkey" FOREIGN KEY ("in_reply_to_object_id") REFERENCES "objects" ("id")
  );

CREATE INDEX "actor_replies_in_reply_to_object_id" ON "actor_replies" ("in_reply_to_object_id");

CREATE UNIQUE INDEX "actor_replies_unique_object_id" ON "actor_replies" ("object_id");

CREATE TABLE
  peers ("domain" TEXT UNIQUE NOT NULL);

CREATE TABLE
  idempotency_keys (
    "key" TEXT PRIMARY KEY,
    "object_id" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "idempotency_keys_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
  );

CREATE TABLE
  note_hashtags (
    "value" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "note_hashtags_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
  );

CREATE TABLE
  subscriptions (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "actor_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "key_p256dh" TEXT NOT NULL,
    "key_auth" TEXT NOT NULL,
    "alert_mention" INTEGER NOT NULL,
    "alert_status" INTEGER NOT NULL,
    "alert_reblog" INTEGER NOT NULL,
    "alert_follow" INTEGER NOT NULL,
    "alert_follow_request" INTEGER NOT NULL,
    "alert_favourite" INTEGER NOT NULL,
    "alert_poll" INTEGER NOT NULL,
    "alert_update" INTEGER NOT NULL,
    "alert_admin_sign_up" INTEGER NOT NULL,
    "alert_admin_report" INTEGER NOT NULL,
    "policy" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "subscriptions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "subscriptions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients" ("id")
  );

CREATE UNIQUE INDEX "unique_subscriptions" ON "subscriptions" ("actor_id", "client_id");

CREATE TABLE
  server_settings ("setting_name" TEXT UNIQUE NOT NULL, "setting_value" TEXT NOT NULL);

CREATE TABLE
  server_rules ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "text" TEXT NOT NULL);

CREATE TABLE
  actor_preferences (
    "id" TEXT PRIMARY KEY,
    "posting_default_visibility" TEXT NOT NULL DEFAULT 'public',
    "posting_default_sensitive" INTEGER NOT NULL DEFAULT 0,
    "posting_default_language" TEXT,
    "reading_expand_media" TEXT NOT NULL DEFAULT 'default',
    "reading_expand_spoilers" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "actor_preferences_id_fkey" FOREIGN KEY ("id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE TABLE
  id_sequences ("key" TEXT PRIMARY KEY, "value" INTEGER NOT NULL DEFAULT 0);

CREATE TABLE
  client_credentials (
    "id" TEXT PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "client_credentials_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients" ("id") ON DELETE CASCADE
  );

CREATE TABLE
  actor_activities (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "type" TEXT NOT NULL GENERATED ALWAYS AS (JSON_EXTRACT(activity, '$.type')) STORED,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "activity" TEXT NOT NULL,
    CONSTRAINT "actor_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE TABLE
  outbox_objects (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "published_date" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "to" TEXT NOT NULL DEFAULT (JSON_ARRAY()),
    "cc" TEXT NOT NULL DEFAULT (JSON_ARRAY()),
    CONSTRAINT "outbox_objects_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "outbox_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id") ON DELETE CASCADE
  );

CREATE INDEX "outbox_objects_actor_id" ON "outbox_objects" ("actor_id");

CREATE INDEX "outbox_objects_object_id_published_date" ON "outbox_objects" ("object_id", "published_date");

CREATE INDEX "outbox_objects_to" ON "outbox_objects" ("to");

CREATE INDEX "outbox_objects_cc" ON "outbox_objects" ("cc");

CREATE TABLE
  actor_reblogs (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mastodon_id" TEXT UNIQUE NOT NULL,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "outbox_object_id" TEXT UNIQUE NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "actor_reblogs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "actor_reblogs_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id") ON DELETE CASCADE,
    CONSTRAINT "actor_reblogs_outbox_object_id_fkey" FOREIGN KEY ("outbox_object_id") REFERENCES "outbox_objects" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "unique_actor_reblogs" ON "actor_reblogs" ("actor_id", "object_id");

CREATE INDEX "actor_reblogs_actor_id" ON "actor_reblogs" ("actor_id");

CREATE INDEX "actor_reblogs_object_id" ON "actor_reblogs" ("object_id");

CREATE TABLE
  users (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_id" TEXT UNIQUE NOT NULL,
    "email" TEXT UNIQUE NOT NULL,
    "privkey" BLOB UNIQUE NOT NULL,
    "privkey_salt" BLOB UNIQUE NOT NULL,
    "pubkey" TEXT NOT NULL,
    "is_admin" INTEGER NOT NULL DEFAULT 0,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "is_moderator" INTEGER DEFAULT 0,
    "approved" INTEGER DEFAULT 1,
    "disabled" INTEGER DEFAULT 0,
    "confirmed_at" DATETIME,
    "locale" TEXT,
    "updated_at" DATETIME,
    CONSTRAINT "users_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE RESTRICT
  );

CREATE INDEX "users_email" ON "users" ("email");

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

CREATE TABLE
  account_fields (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "account_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "verified_at" DATETIME,
    CONSTRAINT "account_fields_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE INDEX "account_fields_account_id" ON "account_fields" ("account_id");

CREATE TABLE
  account_notes (
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

CREATE TABLE
  blocks (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "target_account_id" TEXT NOT NULL,
    "uri" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "blocks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "blocks_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "blocks_unique" ON "blocks" ("account_id", "target_account_id");

CREATE INDEX "blocks_target_account_id_account_id" ON "blocks" ("target_account_id", "account_id");

CREATE TABLE
  mutes (
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

CREATE TABLE
  domain_blocks (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "domain_blocks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "domain_blocks_unique" ON "domain_blocks" ("account_id", "domain");

CREATE TABLE
  endorsements (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "target_account_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "endorsements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "endorsements_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "endorsements_unique" ON "endorsements" ("account_id", "target_account_id");

CREATE TABLE
  bookmarks (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "status_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "bookmarks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "bookmarks_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "bookmarks_unique" ON "bookmarks" ("account_id", "status_id");

CREATE INDEX "bookmarks_status_id" ON "bookmarks" ("status_id");

CREATE TABLE
  status_pins (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "status_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "status_pins_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "status_pins_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "status_pins_unique" ON "status_pins" ("account_id", "status_id");

CREATE INDEX "status_pins_status_id" ON "status_pins" ("status_id");

CREATE TABLE
  media_attachments (
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

CREATE TABLE
  tags (
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

CREATE TABLE
  status_tags (
    "status_id" TEXT NOT NULL,
    "tag_id" INTEGER NOT NULL,
    PRIMARY KEY ("status_id", "tag_id"),
    CONSTRAINT "status_tags_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE,
    CONSTRAINT "status_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
  );

CREATE INDEX "status_tags_tag_id" ON "status_tags" ("tag_id");

CREATE TABLE
  followed_tags (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "tag_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "followed_tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "followed_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "followed_tags_unique" ON "followed_tags" ("account_id", "tag_id");

CREATE TABLE
  featured_tags (
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

CREATE TABLE
  mentions (
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

CREATE TABLE
  lists (
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

CREATE TABLE
  list_accounts (
    "list_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "follow_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    PRIMARY KEY ("list_id", "account_id"),
    CONSTRAINT "list_accounts_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists" ("id") ON DELETE CASCADE,
    CONSTRAINT "list_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE INDEX "list_accounts_account_id" ON "list_accounts" ("account_id");

CREATE TABLE
  markers (
    "account_id" TEXT NOT NULL,
    "timeline" TEXT NOT NULL,
    "last_read_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    PRIMARY KEY ("account_id", "timeline"),
    CONSTRAINT "markers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE TABLE
  polls (
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

CREATE TABLE
  poll_options (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "poll_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "votes_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "poll_options_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE CASCADE
  );

CREATE UNIQUE INDEX "poll_options_poll_position" ON "poll_options" ("poll_id", "position");

CREATE TABLE
  poll_votes (
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

CREATE TABLE
  filters (
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

CREATE INDEX "filters_account_id" ON "filters" ("account_id");

CREATE TABLE
  filter_keywords (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filter_id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "whole_word" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "filter_keywords_filter_id_fkey" FOREIGN KEY ("filter_id") REFERENCES "filters" ("id") ON DELETE CASCADE
  );

CREATE INDEX "filter_keywords_filter_id" ON "filter_keywords" ("filter_id");

CREATE TABLE
  filter_statuses (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filter_id" TEXT NOT NULL,
    "status_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "filter_statuses_filter_id_fkey" FOREIGN KEY ("filter_id") REFERENCES "filters" ("id") ON DELETE CASCADE,
    CONSTRAINT "filter_statuses_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "objects" ("id") ON DELETE CASCADE
  );

CREATE INDEX "filter_statuses_filter_id" ON "filter_statuses" ("filter_id");

CREATE INDEX "filter_statuses_status_id" ON "filter_statuses" ("status_id");

CREATE TABLE
  conversations (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uri" TEXT UNIQUE,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
  );

CREATE TABLE
  conversation_accounts (
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

CREATE TABLE
  conversation_mutes (
    "conversation_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    PRIMARY KEY ("conversation_id", "account_id"),
    CONSTRAINT "conversation_mutes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
    CONSTRAINT "conversation_mutes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE TABLE
  status_edits (
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
