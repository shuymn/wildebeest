CREATE TABLE
  actors (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mastodon_id" TEXT,
    "type" TEXT,
    "username" TEXT,
    "domain" TEXT,
    "properties" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW'))
  );

CREATE INDEX "actors_mastodon_id" ON "actors" ("mastodon_id");

CREATE INDEX "actors_username" ON "actors" ("username");

CREATE INDEX "actors_domain" ON "actors" ("domain");

CREATE TRIGGER "actors_search_fts_insert" AFTER INSERT ON "actors" BEGIN
INSERT INTO
  "search_fts" ("rowid", "type", "name", "preferredUsername")
VALUES
  (
    "new"."rowid",
    "new"."type",
    json_extract ("new"."properties", '$.name'),
    "new"."username"
  );

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
  (
    "new"."rowid",
    "new"."type",
    json_extract ("new"."properties", '$.name'),
    "new"."username"
  );

END;

CREATE TABLE
  actor_following (
    "id" TEXT PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "target_actor_id" TEXT NOT NULL,
    "target_actor_acct" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
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
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    "original_actor_id" TEXT,
    "original_object_id" TEXT UNIQUE,
    "reply_to_object_id" TEXT,
    "properties" TEXT NOT NULL DEFAULT (json_object ()),
    "local" INTEGER NOT NULL
  );

CREATE TABLE
  inbox_objects (
    "id" TEXT PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
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
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
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
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "actor_favourites_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "actor_favourites_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
  );

CREATE INDEX "actor_favourites_actor_id" ON "actor_favourites" ("actor_id");

CREATE INDEX "actor_favourites_object_id" ON "actor_favourites" ("object_id");

CREATE TABLE
  clients (
    "id" TEXT PRIMARY KEY,
    "secret" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirect_uris" TEXT NOT NULL,
    "website" TEXT,
    "scopes" TEXT,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW'))
  );

CREATE VIRTUAL TABLE search_fts USING "fts5" ("type", "name", "preferredUsername", "status");

CREATE TABLE
  search_fts_data ("id" INTEGER PRIMARY KEY, "block" BLOB);

CREATE TABLE
  search_fts_idx (
    "segid",
    "term",
    "pgno",
    PRIMARY KEY ("segid", "term")
  ) WITHOUT ROWID;

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
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "actor_replies_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "actor_replies_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id"),
    CONSTRAINT "actor_replies_in_reply_to_object_id_fkey" FOREIGN KEY ("in_reply_to_object_id") REFERENCES "objects" ("id")
  );

CREATE INDEX "actor_replies_in_reply_to_object_id" ON "actor_replies" ("in_reply_to_object_id");

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
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
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
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "subscriptions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
    CONSTRAINT "subscriptions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients" ("id")
  );

CREATE UNIQUE INDEX "unique_subscriptions" ON "subscriptions" ("actor_id", "client_id");

CREATE TABLE
  server_settings (
    "setting_name" TEXT UNIQUE NOT NULL,
    "setting_value" TEXT NOT NULL
  );

CREATE TABLE
  server_rules (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "text" TEXT NOT NULL
  );

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
  id_sequences (
    "key" TEXT PRIMARY KEY,
    "value" INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE
  client_credentials (
    "id" TEXT PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "client_credentials_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients" ("id") ON DELETE CASCADE
  );

CREATE TABLE
  actor_activities (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "type" TEXT NOT NULL GENERATED ALWAYS AS (json_extract (activity, '$.type')) STORED,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    "activity" TEXT NOT NULL,
    CONSTRAINT "actor_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE CASCADE
  );

CREATE TABLE
  outbox_objects (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    "published_date" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    "to" TEXT NOT NULL DEFAULT (json_array ()),
    "cc" TEXT NOT NULL DEFAULT (json_array ()),
    CONSTRAINT "outbox_objects_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE CASCADE,
    CONSTRAINT "outbox_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id") ON DELETE CASCADE
  );

CREATE INDEX "outbox_objects_actor_id" ON "outbox_objects" ("actor_id");

CREATE INDEX "outbox_objects_to" ON "outbox_objects" ("to");

CREATE INDEX "outbox_objects_cc" ON "outbox_objects" ("cc");

CREATE TABLE
  actor_reblogs (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mastodon_id" TEXT UNIQUE NOT NULL,
    "actor_id" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "outbox_object_id" TEXT UNIQUE NOT NULL,
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
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
    "cdate" DATETIME NOT NULL DEFAULT (STRFTIME ('%Y-%m-%d %H:%M:%f', 'NOW')),
    CONSTRAINT "users_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE RESTRICT
  );

CREATE INDEX "users_email" ON "users" ("email");
