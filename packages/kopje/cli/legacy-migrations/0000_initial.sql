-- Migration number: 0000 	 2022-12-05T20:27:34.391Z

CREATE TABLE "actors" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "email" TEXT,
  "privkey" BLOB,
  "privkey_salt" BLOB,
  "pubkey" TEXT,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "properties" TEXT NOT NULL DEFAULT (json_object())
);

CREATE INDEX "actors_email" ON "actors" ("email");

CREATE TABLE "actor_following" (
  "id" TEXT PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "target_actor_id" TEXT NOT NULL,
  "target_actor_acct" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "actor_following_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "actor_following_target_actor_id_fkey" FOREIGN KEY ("target_actor_id") REFERENCES "actors" ("id")
);

CREATE INDEX "actor_following_actor_id" ON "actor_following" ("actor_id");
CREATE INDEX "actor_following_target_actor_id" ON "actor_following" ("target_actor_id");

CREATE TABLE "objects" (
  "id" TEXT PRIMARY KEY,
  "mastodon_id" TEXT UNIQUE NOT NULL,
  "type" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "original_actor_id" TEXT,
  "original_object_id" TEXT UNIQUE,
  "reply_to_object_id" TEXT,
  "properties" TEXT NOT NULL DEFAULT (json_object()),
  "local" INTEGER NOT NULL
);

CREATE TABLE "inbox_objects" (
  "id" TEXT PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "inbox_objects_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "inbox_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
);

CREATE TABLE "outbox_objects" (
  "id" TEXT PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "published_date" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "outbox_objects_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "outbox_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
);

CREATE TABLE "actor_notifications" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "type" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "from_actor_id" TEXT NOT NULL,
  "object_id" TEXT,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "actor_notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "actor_notifications_from_actor_id_fkey" FOREIGN KEY ("from_actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "actor_notifications_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
);

CREATE INDEX "actor_notifications_actor_id" ON "actor_notifications" ("actor_id");

CREATE TABLE "actor_favourites" (
  "id" TEXT PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "actor_favourites_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "actor_favourites_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
);

CREATE INDEX "actor_favourites_actor_id" ON "actor_favourites" ("actor_id");
CREATE INDEX "actor_favourites_object_id" ON "actor_favourites" ("object_id");

CREATE TABLE "actor_reblogs" (
  "id" TEXT PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "actor_reblogs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "actor_reblogs_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
);

CREATE INDEX "actor_reblogs_actor_id" ON "actor_reblogs" ("actor_id");
CREATE INDEX "actor_reblogs_object_id" ON "actor_reblogs" ("object_id");

CREATE TABLE "clients" (
  "id" TEXT PRIMARY KEY,
  "secret" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "redirect_uris" TEXT NOT NULL,
  "website" TEXT,
  "scopes" TEXT,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE TABLE "subscriptions" (
  "id" TEXT PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "endpoint" TEXT NULL,
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
  "policy" TEXT,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "subscriptions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id"),
  CONSTRAINT "subscriptions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients" ("id")
);

CREATE UNIQUE INDEX "unique_subscriptions" ON "subscriptions" ("actor_id", "client_id");

CREATE VIRTUAL TABLE "search_fts" USING "fts5" (
    "type",
    "name",
    "preferredUsername",
    "status"
);

CREATE TRIGGER "actors_search_fts_insert" AFTER INSERT ON "actors"
BEGIN
    INSERT INTO "search_fts" ("rowid", "type", "name", "preferredUsername")
    VALUES ("new"."rowid",
            "new"."type",
            json_extract("new"."properties", '$.name'),
            json_extract("new"."properties", '$.preferredUsername'));
END;

CREATE TRIGGER "actors_search_fts_delete" AFTER DELETE ON "actors"
BEGIN
    DELETE FROM "search_fts" WHERE "rowid"="old"."rowid";
END;

CREATE TRIGGER "actors_search_fts_update" AFTER UPDATE ON "actors"
BEGIN
    DELETE FROM "search_fts" WHERE "rowid"="old"."rowid";
    INSERT INTO "search_fts" ("rowid", "type", "name", "preferredUsername")
    VALUES ("new"."rowid",
            "new"."type",
            json_extract("new"."properties", '$.name'),
            json_extract("new"."properties", '$.preferredUsername'));
END;

CREATE TABLE "actor_replies" (
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
