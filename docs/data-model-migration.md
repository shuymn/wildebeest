# Database Migration Strategy

This document outlines the migration strategy from the current Wildebeest database schema to the new comprehensive schema designed for full Mastodon API compatibility.

## Migration Principles

1. **Backward Compatibility**: Maintain existing API endpoints during migration
2. **Incremental Migration**: Break into phases to reduce risk
3. **Data Preservation**: No data loss during migration
4. **Rollback Capability**: Each phase should be reversible
5. **Zero Downtime**: Use additive changes where possible

---

## Current State Analysis

### Tables to Rename (Phase 6 - Optional)

**Important:** Table renaming is optional and happens only in Phase 6. Phases 1-5 use current table names (`actors`, `objects`, etc.) to maintain compatibility. The API layer abstracts the difference.

| Current Table | New Table | Notes |
|--------------|-----------|-------|
| `actors` | `accounts` | Align with Mastodon terminology |
| `objects` | `statuses` | Clearer naming |
| `actor_following` | `follows` | Clearer naming |
| `actor_favourites` | `favourites` | Standard naming |
| `actor_notifications` | `notifications` | Standard naming |
| `actor_reblogs` | (removed) | Replaced by `statuses.reblog_of_id` - see Phase 3.13 |
| `actor_replies` | (removed) | Replaced by `statuses.in_reply_to_id` - see Phase 3.11 |
| `actor_preferences` | `user_preferences` | Expanded fields |
| `clients` | `oauth_applications` | Standard naming |
| `client_credentials` | `oauth_access_tokens` | Standard naming |
| `subscriptions` | `web_push_subscriptions` | Clearer naming |
| `peers` | `known_instances` | Extended fields |

### Columns to Rename (Phase 6 - Optional)

| Table | Current Column | New Column | Notes |
|-------|---------------|------------|-------|
| `users` | `actor_id` | `account_id` | After actors → accounts rename |
| `objects` | `original_actor_id` | `account_id` | Status author reference |

### Columns to Extract from JSON

#### From `actors.properties`:

| Field | New Column | Type |
|-------|-----------|------|
| `name` | `display_name` | TEXT |
| `summary` | `note` | TEXT |
| `icon.url` | `avatar` | TEXT |
| `image.url` | `header` | TEXT |
| `manuallyApprovesFollowers` | `locked` | INTEGER |
| `type == 'Service'` | `bot` | INTEGER |
| `discoverable` | `discoverable` | INTEGER |
| `indexable` | `indexable` | INTEGER |
| `attachment` | → `account_fields` table | - |
| `publicKey` | Keep in properties | - |
| `endpoints` | Keep in properties | - |

#### From `objects.properties`:

| Field | New Column | Type |
|-------|-----------|------|
| `content` | `content` | TEXT |
| `source.content` | `text` | TEXT |
| `summary` | `spoiler_text` | TEXT |
| `sensitive` | `sensitive` | INTEGER |
| `inReplyTo` | `in_reply_to_id` (resolve) | TEXT |
| `to`, `cc` | → derive `visibility` | TEXT |
| `attachment` | → `media_attachments` table | - |
| `tag` | → `mentions`, `status_tags` tables | - |

### New Tables Required

#### High Priority (Core functionality)
- `media_attachments`
- `mentions`
- `tags`
- `status_tags`
- `blocks`
- `mutes`
- `bookmarks`
- `status_pins`
- `account_fields`
- `lists`
- `list_accounts`

#### Medium Priority (Enhanced features)
- `polls`
- `poll_options`
- `poll_votes`
- `filters`
- `filter_keywords`
- `filter_statuses`
- `conversations`
- `conversation_accounts`
- `markers`
- `featured_tags`
- `followed_tags`
- `status_edits`

#### Lower Priority (Admin/Advanced)
- `reports`
- `admin_domain_blocks`
- `admin_domain_allows`
- `admin_ip_blocks`
- `admin_email_domain_blocks`
- `account_warnings`
- `announcements`
- `custom_emojis`
- `scheduled_statuses`

---

## Migration Phases

### Phase 1: Additive Schema Changes (Non-breaking)

**Goal**: Add new columns and tables without modifying existing ones.

```sql
-- 1.1: Add new columns to actors (nullable initially)
ALTER TABLE actors ADD COLUMN "display_name" TEXT;
ALTER TABLE actors ADD COLUMN "note" TEXT;
ALTER TABLE actors ADD COLUMN "avatar" TEXT;
ALTER TABLE actors ADD COLUMN "avatar_static" TEXT;
ALTER TABLE actors ADD COLUMN "header" TEXT;
ALTER TABLE actors ADD COLUMN "header_static" TEXT;
ALTER TABLE actors ADD COLUMN "locked" INTEGER;
ALTER TABLE actors ADD COLUMN "bot" INTEGER;
ALTER TABLE actors ADD COLUMN "group" INTEGER;
ALTER TABLE actors ADD COLUMN "discoverable" INTEGER;
ALTER TABLE actors ADD COLUMN "indexable" INTEGER;
ALTER TABLE actors ADD COLUMN "hide_collections" INTEGER;
ALTER TABLE actors ADD COLUMN "followers_count" INTEGER;
ALTER TABLE actors ADD COLUMN "following_count" INTEGER;
ALTER TABLE actors ADD COLUMN "statuses_count" INTEGER;
ALTER TABLE actors ADD COLUMN "last_status_at" TEXT;
ALTER TABLE actors ADD COLUMN "suspended_at" DATETIME;
ALTER TABLE actors ADD COLUMN "silenced_at" DATETIME;
ALTER TABLE actors ADD COLUMN "uri" TEXT;
ALTER TABLE actors ADD COLUMN "acct" TEXT;
ALTER TABLE actors ADD COLUMN "url" TEXT;
ALTER TABLE actors ADD COLUMN "updated_at" DATETIME;

-- 1.2: Add new columns to objects (nullable initially)
ALTER TABLE objects ADD COLUMN "content" TEXT;
ALTER TABLE objects ADD COLUMN "text" TEXT;
ALTER TABLE objects ADD COLUMN "spoiler_text" TEXT;
ALTER TABLE objects ADD COLUMN "sensitive" INTEGER;
ALTER TABLE objects ADD COLUMN "language" TEXT;
ALTER TABLE objects ADD COLUMN "visibility" TEXT;
ALTER TABLE objects ADD COLUMN "url" TEXT;
ALTER TABLE objects ADD COLUMN "account_id" TEXT;
ALTER TABLE objects ADD COLUMN "in_reply_to_id" TEXT;  -- Replaces actor_replies lookup
ALTER TABLE objects ADD COLUMN "in_reply_to_account_id" TEXT;
ALTER TABLE objects ADD COLUMN "conversation_id" TEXT;
ALTER TABLE objects ADD COLUMN "reblog_of_id" TEXT;
ALTER TABLE objects ADD COLUMN "poll_id" TEXT;
ALTER TABLE objects ADD COLUMN "application_name" TEXT;
ALTER TABLE objects ADD COLUMN "application_website" TEXT;
ALTER TABLE objects ADD COLUMN "replies_count" INTEGER;
ALTER TABLE objects ADD COLUMN "reblogs_count" INTEGER;
ALTER TABLE objects ADD COLUMN "favourites_count" INTEGER;
ALTER TABLE objects ADD COLUMN "edited_at" DATETIME;
ALTER TABLE objects ADD COLUMN "deleted_at" DATETIME;
ALTER TABLE objects ADD COLUMN "updated_at" DATETIME;

-- 1.3: Add new columns to actor_following
ALTER TABLE actor_following ADD COLUMN "show_reblogs" INTEGER DEFAULT 1;
ALTER TABLE actor_following ADD COLUMN "notify" INTEGER DEFAULT 0;
ALTER TABLE actor_following ADD COLUMN "languages" TEXT;
ALTER TABLE actor_following ADD COLUMN "uri" TEXT;
ALTER TABLE actor_following ADD COLUMN "updated_at" DATETIME;

-- 1.4: Add new columns to users
ALTER TABLE users ADD COLUMN "is_moderator" INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN "approved" INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN "disabled" INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN "confirmed_at" DATETIME;
ALTER TABLE users ADD COLUMN "locale" TEXT;
ALTER TABLE users ADD COLUMN "updated_at" DATETIME;

-- 1.5: Add new columns to actor_notifications
ALTER TABLE actor_notifications ADD COLUMN "group_key" TEXT;
ALTER TABLE actor_notifications ADD COLUMN "read" INTEGER DEFAULT 0;
ALTER TABLE actor_notifications ADD COLUMN "filtered" INTEGER DEFAULT 0;
ALTER TABLE actor_notifications ADD COLUMN "report_id" TEXT;
ALTER TABLE actor_notifications ADD COLUMN "account_warning_id" INTEGER;

-- 1.6: Add retention columns for remote content cleanup (see storage-strategy.md, cleanup-worker-spec.md)
-- Required before enabling the cleanup worker. Local content keeps NULL expires_at (never deleted).
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
```

**Backfill retention columns for existing data** (run after 1.6, before enabling cleanup worker):

```sql
-- Remote accounts: set TTL from fetch time (default 90 days)
UPDATE actors
SET cached_at = cdate,
    expires_at = datetime(cdate, '+90 days')
WHERE domain IS NOT NULL
  AND cached_at IS NULL;

-- Local accounts: never expire
UPDATE actors
SET cached_at = NULL,
    expires_at = NULL,
    interaction_count = 0
WHERE domain IS NULL;

-- Remote statuses: set TTL from fetch time (default 30 days)
UPDATE objects
SET cached_at = cdate,
    expires_at = datetime(cdate, '+30 days')
WHERE local = 0
  AND cached_at IS NULL;

-- Local statuses: never expire
UPDATE objects
SET cached_at = NULL,
    expires_at = NULL,
    interaction_count = 0
WHERE local = 1;
```

### Phase 2: Create New Tables

**Note:** All foreign keys reference current table names (`actors`, `objects`). If Phase 6 renaming is executed later, FKs will need to be recreated. Column names like `account_id` are used for forward compatibility but still FK to `actors`.

```sql
-- 2.1: Account-related tables
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

-- 2.2: Relationship tables
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

-- 2.3: Interaction tables
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

-- 2.4: Media attachments table
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

-- 2.5: Tag tables
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

-- 2.6: Mention table
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

-- 2.7: List tables
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

-- 2.8: Marker table
CREATE TABLE markers (
  "account_id" TEXT NOT NULL,
  "timeline" TEXT NOT NULL,
  "last_read_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("account_id", "timeline"),
  CONSTRAINT "markers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "actors" ("id") ON DELETE CASCADE
);

-- 2.9: Poll tables
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

-- 2.10: Filter tables
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

-- 2.11: Conversation tables
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

-- 2.12: Status edits table
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
```

### Phase 3: Data Migration

Run data migration scripts to populate new columns from JSON properties.

```sql
-- 3.1: Migrate actors data
UPDATE actors SET
  display_name = COALESCE(JSON_EXTRACT(properties, '$.name'), ''),
  note = COALESCE(JSON_EXTRACT(properties, '$.summary'), ''),
  avatar = COALESCE(JSON_EXTRACT(properties, '$.icon.url'), JSON_EXTRACT(properties, '$.icon[0].url'), ''),
  avatar_static = COALESCE(JSON_EXTRACT(properties, '$.icon.url'), JSON_EXTRACT(properties, '$.icon[0].url'), ''),
  header = COALESCE(JSON_EXTRACT(properties, '$.image.url'), JSON_EXTRACT(properties, '$.image[0].url'), ''),
  header_static = COALESCE(JSON_EXTRACT(properties, '$.image.url'), JSON_EXTRACT(properties, '$.image[0].url'), ''),
  locked = CASE WHEN JSON_EXTRACT(properties, '$.manuallyApprovesFollowers') = 1 THEN 1 ELSE 0 END,
  bot = CASE WHEN type = 'Service' THEN 1 ELSE 0 END,
  "group" = CASE WHEN type = 'Group' THEN 1 ELSE 0 END,
  discoverable = JSON_EXTRACT(properties, '$.discoverable'),
  indexable = COALESCE(JSON_EXTRACT(properties, '$.indexable'), 0),
  hide_collections = 0,
  uri = COALESCE(JSON_EXTRACT(properties, '$.id'), id),
  acct = CASE WHEN domain IS NULL THEN username ELSE username || '@' || domain END,
  url = JSON_EXTRACT(properties, '$.url'),
  updated_at = cdate
WHERE display_name IS NULL;

-- 3.2: Calculate follower/following counts
UPDATE actors SET followers_count = (
  SELECT COUNT(*) FROM actor_following
  WHERE target_actor_id = actors.id AND state = 'accepted'
);

UPDATE actors SET following_count = (
  SELECT COUNT(*) FROM actor_following
  WHERE actor_id = actors.id AND state = 'accepted'
);

UPDATE actors SET statuses_count = (
  SELECT COUNT(*) FROM objects
  WHERE original_actor_id = actors.id AND type = 'Note'
);

-- 3.3: Migrate objects data
UPDATE objects SET
  content = COALESCE(JSON_EXTRACT(properties, '$.content'), ''),
  text = JSON_EXTRACT(properties, '$.source.content'),
  spoiler_text = COALESCE(JSON_EXTRACT(properties, '$.summary'), ''),
  sensitive = COALESCE(JSON_EXTRACT(properties, '$.sensitive'), 0),
  language = JSON_EXTRACT(properties, '$.contentMap'),  -- Need to extract language key
  url = JSON_EXTRACT(properties, '$.url'),
  account_id = original_actor_id,
  in_reply_to_account_id = (
    SELECT original_actor_id FROM objects AS parent
    WHERE parent.id = objects.reply_to_object_id
  ),
  updated_at = cdate
WHERE content IS NULL;

-- 3.4: Derive visibility from to/cc arrays
UPDATE objects SET visibility =
  CASE
    WHEN JSON_EXTRACT(properties, '$.to') LIKE '%#Public%' THEN 'public'
    WHEN JSON_EXTRACT(properties, '$.cc') LIKE '%#Public%' THEN 'unlisted'
    WHEN JSON_EXTRACT(properties, '$.to') LIKE '%/followers%' THEN 'private'
    ELSE 'direct'
  END
WHERE visibility IS NULL;

-- 3.5: Calculate status counts (preliminary - recalculated after 3.11)
-- Note: Uses actor_replies as the source of truth for existing reply relationships.
-- Final counts are recalculated in step 3.11-D after in_reply_to_id backfill completes.
UPDATE objects SET replies_count = (
  SELECT COUNT(*) FROM actor_replies
  WHERE actor_replies.in_reply_to_object_id = objects.id
);

UPDATE objects SET reblogs_count = (
  SELECT COUNT(*) FROM actor_reblogs
  WHERE object_id = objects.id
);

UPDATE objects SET favourites_count = (
  SELECT COUNT(*) FROM actor_favourites
  WHERE object_id = objects.id
);

-- 3.6: Migrate account fields from JSON attachment array
INSERT INTO account_fields (account_id, position, name, value, verified_at)
SELECT
  actors.id,
  json_each.key,
  JSON_EXTRACT(json_each.value, '$.name'),
  JSON_EXTRACT(json_each.value, '$.value'),
  NULL
FROM actors, JSON_EACH(JSON_EXTRACT(actors.properties, '$.attachment'))
WHERE JSON_TYPE(JSON_EXTRACT(actors.properties, '$.attachment')) = 'array'
  AND JSON_EXTRACT(json_each.value, '$.type') = 'PropertyValue';

-- 3.7: Migrate tags from note_hashtags to tags table
INSERT OR IGNORE INTO tags (name, display_name)
SELECT LOWER(value), value FROM note_hashtags;

-- 3.8: Migrate status_tags from note_hashtags
INSERT OR IGNORE INTO status_tags (status_id, tag_id)
SELECT nh.object_id, t.id
FROM note_hashtags nh
JOIN tags t ON LOWER(nh.value) = t.name;

-- 3.9: Extract mentions from object properties
-- This requires parsing the tag array for type='Mention'
-- Implementation depends on JSON structure

-- 3.10: Migrate media attachments from object properties
-- This requires parsing the attachment array
-- Implementation depends on JSON structure and existing media storage

-- 3.11: Migrate in_reply_to_id from actor_replies (CRITICAL)
-- This step MUST complete before actor_replies can be dropped in Phase 7
-- The actor_replies table is currently used for:
--   - Counting replies (replies_count subquery)
--   - Finding replies for /api/v1/statuses/:id/context
--   - Timeline filtering for reply chains

-- Step A: Backfill in_reply_to_id from actor_replies
-- Note: Using LIMIT 1 in case of duplicate entries (no unique constraint on actor_replies)
UPDATE objects SET in_reply_to_id = (
  SELECT ar.in_reply_to_object_id
  FROM actor_replies ar
  WHERE ar.object_id = objects.id
  LIMIT 1
)
WHERE in_reply_to_id IS NULL
  AND EXISTS (SELECT 1 FROM actor_replies WHERE object_id = objects.id);

-- Step B: Also backfill from existing reply_to_object_id if present
-- (some statuses may have this set but not be in actor_replies)
UPDATE objects SET in_reply_to_id = reply_to_object_id
WHERE in_reply_to_id IS NULL
  AND reply_to_object_id IS NOT NULL;

-- Step C: Backfill in_reply_to_account_id for statuses with in_reply_to_id
UPDATE objects SET in_reply_to_account_id = (
  SELECT original_actor_id FROM objects AS parent
  WHERE parent.id = objects.in_reply_to_id
)
WHERE in_reply_to_id IS NOT NULL
  AND in_reply_to_account_id IS NULL;

-- Step D: Recalculate replies_count using the new in_reply_to_id column
-- This ensures counts are consistent with the migrated data
UPDATE objects SET replies_count = (
  SELECT COUNT(*) FROM objects AS replies
  WHERE replies.in_reply_to_id = objects.id
    AND replies.deleted_at IS NULL
);

-- Verification: Ensure all actor_replies entries are migrated
-- SELECT COUNT(*) FROM actor_replies ar
-- LEFT JOIN objects o ON ar.object_id = o.id
-- WHERE o.in_reply_to_id IS NULL OR o.in_reply_to_id != ar.in_reply_to_object_id;
-- Expected result: 0

-- 3.12: Update actor_following columns
UPDATE actor_following SET
  show_reblogs = 1,
  notify = 0,
  updated_at = cdate
WHERE show_reblogs IS NULL;

-- 3.13: Migrate actor_reblogs to status rows (CRITICAL)
-- This step MUST complete before actor_reblogs can be dropped in Phase 7
-- Reblogs become actual status rows with reblog_of_id set
--
-- Step A: Create status rows for each reblog
-- Note: This requires application code to generate proper IDs and handle
-- the outbox_objects relationship. The SQL below is conceptual.
INSERT INTO objects (
  id, mastodon_id, type, original_actor_id,
  reblog_of_id, account_id, visibility, local, cdate
)
SELECT
  ar.id,                                    -- Use reblog ID as status ID
  ar.mastodon_id,
  'Announce',                               -- ActivityPub type for reblogs
  ar.actor_id,
  ar.object_id,                             -- Points to original status
  ar.actor_id,
  COALESCE(orig.visibility, 'public'),      -- Inherit visibility
  CASE WHEN a.domain IS NULL THEN 1 ELSE 0 END,  -- local if actor is local
  ar.cdate
FROM actor_reblogs ar
JOIN objects orig ON ar.object_id = orig.id
JOIN actors a ON ar.actor_id = a.id
WHERE NOT EXISTS (
  SELECT 1 FROM objects WHERE reblog_of_id = ar.object_id AND original_actor_id = ar.actor_id
);

-- Step B: Recalculate reblogs_count using reblog_of_id
UPDATE objects SET reblogs_count = (
  SELECT COUNT(*) FROM objects AS reblogs
  WHERE reblogs.reblog_of_id = objects.id
    AND reblogs.deleted_at IS NULL
);

-- Verification: Ensure reblog counts match
-- SELECT o.id, o.reblogs_count as new_count,
--   (SELECT COUNT(*) FROM actor_reblogs WHERE object_id = o.id) as old_count
-- FROM objects o
-- WHERE o.reblogs_count != (SELECT COUNT(*) FROM actor_reblogs WHERE object_id = o.id);
-- Expected result: 0 rows (counts should match)
```

### Phase 4: Application Code Updates

Update application code to:
1. Use new columns instead of JSON extraction
2. Write to both old and new structures during transition
3. Update type definitions to match new schema
4. Add migration for TypeScript types

#### Critical: actor_replies Query Migration

The following queries currently depend on `actor_replies` and MUST be updated before Phase 7:

**Reply count subqueries** (timeline.ts:70, timeline.ts:199, reply.ts:45, accounts/[id]/statuses.ts:130):
```sql
-- Before (uses actor_replies):
(SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count

-- After (uses denormalized column or in_reply_to_id):
objects.replies_count as replies_count
-- OR if not denormalized:
(SELECT count(*) FROM objects AS replies WHERE replies.in_reply_to_id=objects.id) as replies_count
```

**Finding replies for context** (reply.ts:47-52):
```sql
-- Before (uses actor_replies JOIN):
INNER JOIN actor_replies ON actor_replies.object_id = outbox_objects.object_id
WHERE actor_replies.in_reply_to_object_id = ?1

-- After (uses in_reply_to_id):
WHERE objects.in_reply_to_id = ?1
```

**Insert reply** (reply.ts:9-22):
```typescript
// Before: Insert into actor_replies table
await query.insertReply(db, { ... })

// After: Set in_reply_to_id on the status itself during creation
// No separate table insert needed
```

**Delete object cleanup** (activitypub/objects/index.ts:518-519):
```typescript
// Before: Delete from actor_reblogs and actor_replies
db.prepare('DELETE FROM actor_reblogs WHERE object_id=?').bind(nodeId)
db.prepare('DELETE FROM actor_replies WHERE object_id=?1 OR in_reply_to_object_id=?1').bind(nodeId)

// After: Remove both lines entirely - tables no longer exist.
// Reblog statuses will be deleted via cascade when deleting the reblog status row.
// Note: reblog_of_id and in_reply_to_id references are NOT automatically nullified
// (SQLite FK constraints not enforced by default and not added in this migration).
```

#### Critical: actor_reblogs Query Migration

The following queries depend on `actor_reblogs` and MUST be updated before Phase 7:

**Reblog count subqueries** (timeline.ts:72, timeline.ts:198, accounts/[id]/statuses.ts:129):
```sql
-- Before (uses actor_reblogs):
(SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count

-- After (uses denormalized column or reblog_of_id):
objects.reblogs_count as reblogs_count
-- OR if not denormalized:
(SELECT count(*) FROM objects AS reblogs WHERE reblogs.reblog_of_id=objects.id AND reblogs.deleted_at IS NULL) as reblogs_count
```

**Reblog check for current user** (timeline.ts:72):
```sql
-- Before (uses actor_reblogs):
(SELECT count(*) > 0 FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id AND actor_reblogs.actor_id=?1) as reblogged

-- After (uses reblog_of_id):
(SELECT count(*) > 0 FROM objects AS reblogs WHERE reblogs.reblog_of_id=objects.id AND reblogs.original_actor_id=?1 AND reblogs.deleted_at IS NULL) as reblogged
```

**Create reblog** (mastodon/reblog.ts, activitypub/activities/announce.ts):
```typescript
// Before: Insert into actor_reblogs table
await db.prepare('INSERT INTO actor_reblogs ...').run()

// After: Create a status row with reblog_of_id set
await db.prepare('INSERT INTO objects (id, type, reblog_of_id, original_actor_id, ...) VALUES (...)').run()
```

**Delete reblog / Unreblog** (routes/api/v1/statuses/[id]/reblog.ts):
```typescript
// Before: Delete from actor_reblogs
await db.prepare('DELETE FROM actor_reblogs WHERE actor_id=? AND object_id=?').run()

// After: Delete the reblog status row
await db.prepare('DELETE FROM objects WHERE original_actor_id=? AND reblog_of_id=?').run()
// Also decrement reblogs_count on original status if denormalized
```

### Phase 5: Set Defaults and Add Constraints

```sql
-- 5.1: Set default values for new columns
UPDATE actors SET
  display_name = COALESCE(display_name, ''),
  note = COALESCE(note, ''),
  avatar = COALESCE(avatar, ''),
  avatar_static = COALESCE(avatar_static, ''),
  header = COALESCE(header, ''),
  header_static = COALESCE(header_static, ''),
  locked = COALESCE(locked, 0),
  bot = COALESCE(bot, 0),
  "group" = COALESCE("group", 0),
  indexable = COALESCE(indexable, 0),
  hide_collections = COALESCE(hide_collections, 0),
  followers_count = COALESCE(followers_count, 0),
  following_count = COALESCE(following_count, 0),
  statuses_count = COALESCE(statuses_count, 0);

UPDATE objects SET
  content = COALESCE(content, ''),
  spoiler_text = COALESCE(spoiler_text, ''),
  sensitive = COALESCE(sensitive, 0),
  visibility = COALESCE(visibility, 'public'),
  replies_count = COALESCE(replies_count, 0),
  reblogs_count = COALESCE(reblogs_count, 0),
  favourites_count = COALESCE(favourites_count, 0);

-- 5.2: Add new indexes for performance
CREATE INDEX IF NOT EXISTS "actors_discoverable" ON "actors" ("discoverable") WHERE "discoverable" = 1;
CREATE INDEX IF NOT EXISTS "actors_domain" ON "actors" ("domain");
CREATE INDEX IF NOT EXISTS "objects_visibility" ON "objects" ("visibility");
CREATE INDEX IF NOT EXISTS "objects_account_id" ON "objects" ("account_id");
-- Index for finding replies (used by context endpoint and replies_count)
CREATE INDEX IF NOT EXISTS "objects_in_reply_to_id" ON "objects" ("in_reply_to_id")
  WHERE "in_reply_to_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "objects_public_timeline" ON "objects" ("cdate" DESC)
  WHERE "visibility" = 'public' AND "in_reply_to_id" IS NULL AND "deleted_at" IS NULL;
```

### Phase 6: Table/Column Renaming (Optional)

**This phase is optional.** The API layer can abstract database names from API names. Only execute if you want database schema to match Mastodon naming exactly.

**Warning:** This phase requires significant coordination:
- All application code must be updated to use new names
- All FKs must be recreated (SQLite doesn't support FK renaming)
- Indexes must be recreated
- Consider executing during a maintenance window

```sql
-- Note: SQLite doesn't support ALTER TABLE RENAME COLUMN (before 3.25.0)
-- or changing FK constraints. The safest approach is:
-- 1. Create new table with desired schema
-- 2. Copy data
-- 3. Drop old table
-- 4. Rename new table (SQLite does support ALTER TABLE RENAME TO)

-- 6.1: Rename actors -> accounts
-- This is complex due to many FKs pointing to actors
-- Recommended: Use application-level aliasing instead

-- 6.2: Rename users.actor_id -> users.account_id
-- SQLite 3.25.0+ supports:
ALTER TABLE users RENAME COLUMN actor_id TO account_id;

-- For older SQLite, recreate table:
-- CREATE TABLE users_new (...account_id... );
-- INSERT INTO users_new SELECT ... FROM users;
-- DROP TABLE users;
-- ALTER TABLE users_new RENAME TO users;

-- 6.3: Rename objects.original_actor_id -> objects.account_id
ALTER TABLE objects RENAME COLUMN original_actor_id TO account_id;

-- 6.4: Full table renaming (if desired)
-- Due to FK complexity, recommend using views instead:
CREATE VIEW accounts AS SELECT * FROM actors;
CREATE VIEW statuses AS SELECT * FROM objects;
CREATE VIEW follows AS SELECT * FROM actor_following;
-- ... etc

-- Or update application code to use new names after full FK migration
```

**Recommended approach:** Skip table renaming and use the API/domain layer to translate between internal names (`actors`, `objects`) and external names (`accounts`, `statuses`). This avoids the complexity of FK recreation.

### Phase 7: Cleanup

**Prerequisites before executing Phase 7:**

1. Phase 1.6 (retention columns on `actors`/`objects`) MUST be complete and backfilled
2. Application code MUST maintain `interaction_count` on favourite/bookmark/reblog/follow operations (see `cleanup-worker-spec.md`)
3. Phase 3.11 (in_reply_to_id backfill) MUST be complete
4. Phase 3.13 (actor_reblogs migration) MUST be complete
5. Phase 4 query migrations MUST be deployed
6. Verify `actor_replies` data migrated:
   ```sql
   -- This should return 0:
   SELECT COUNT(*) FROM actor_replies ar
   LEFT JOIN objects o ON ar.object_id = o.id
   WHERE o.in_reply_to_id IS NULL OR o.in_reply_to_id != ar.in_reply_to_object_id;
   ```
7. Verify `actor_reblogs` data migrated:
   ```sql
   -- This should return 0 (all reblogs have corresponding status rows):
   SELECT COUNT(*) FROM actor_reblogs ar
   WHERE NOT EXISTS (
     SELECT 1 FROM objects o
     WHERE o.reblog_of_id = ar.object_id AND o.original_actor_id = ar.actor_id
   );
   ```
8. Verify retention columns populated:
   ```sql
   -- Remote rows should have expires_at set:
   SELECT COUNT(*) FROM objects WHERE local = 0 AND expires_at IS NULL;
   SELECT COUNT(*) FROM actors WHERE domain IS NOT NULL AND expires_at IS NULL;
   -- Local rows should never expire:
   SELECT COUNT(*) FROM objects WHERE local = 1 AND expires_at IS NOT NULL;
   SELECT COUNT(*) FROM actors WHERE domain IS NULL AND expires_at IS NOT NULL;
   ```
9. Test `/api/v1/statuses/:id/context` endpoint works correctly
10. Test timeline reply and reblog counts display correctly
11. Test reblog/unreblog endpoints work correctly

```sql
-- 7.1: Remove redundant tables (ONLY after prerequisites verified)
DROP TABLE IF EXISTS actor_replies;  -- Replaced by objects.in_reply_to_id
DROP TABLE IF EXISTS actor_reblogs;  -- Replaced by objects.reblog_of_id
DROP TABLE IF EXISTS note_hashtags;  -- Migrated to status_tags

-- 7.2: Remove obsolete columns (optional, after verification)
-- Could remove properties column if all data is migrated
-- ALTER TABLE actors DROP COLUMN properties;  -- Not supported in SQLite

-- 7.3: Clean up FTS triggers for renamed tables
-- Update search_fts triggers if tables renamed
```

---

## Rollback Procedures

### Phase 1 Rollback
New columns are nullable, so no rollback needed. Can be ignored by existing code.

### Phase 2 Rollback
```sql
DROP TABLE IF EXISTS account_fields;
DROP TABLE IF EXISTS account_notes;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS mutes;
-- ... etc for all new tables
```

### Phase 3 Rollback
Data in new columns can be ignored. Original JSON properties remain intact.

---

## Testing Strategy

### Pre-Migration Tests
1. Backup database
2. Run migration on copy
3. Verify row counts match
4. Compare random samples of migrated data

### Post-Migration Tests
1. API endpoint tests
2. Timeline rendering tests
3. Federation tests (send/receive)
4. Search functionality tests
5. Performance benchmarks

### Validation Queries

```sql
-- Verify account data migration
SELECT COUNT(*) FROM actors WHERE display_name IS NULL OR display_name = '';
SELECT COUNT(*) FROM actors WHERE avatar IS NULL OR avatar = '';

-- Verify status data migration
SELECT COUNT(*) FROM objects WHERE content IS NULL OR content = '';
SELECT COUNT(*) FROM objects WHERE visibility IS NULL;

-- Verify counts match
SELECT
  a.id,
  a.followers_count AS stored_count,
  (SELECT COUNT(*) FROM actor_following WHERE target_actor_id = a.id AND state = 'accepted') AS actual_count
FROM actors a
WHERE a.followers_count != (SELECT COUNT(*) FROM actor_following WHERE target_actor_id = a.id AND state = 'accepted');

-- Verify retention columns (Phase 1.6)
SELECT COUNT(*) FROM objects WHERE local = 0 AND expires_at IS NULL;
SELECT COUNT(*) FROM actors WHERE domain IS NOT NULL AND expires_at IS NULL;
SELECT COUNT(*) FROM objects WHERE local = 1 AND expires_at IS NOT NULL;
SELECT COUNT(*) FROM actors WHERE domain IS NULL AND expires_at IS NOT NULL;
```

---

## Performance Considerations

### Index Strategy
1. Add indexes before data migration for faster updates
2. Consider dropping and recreating indexes for large tables
3. Use ANALYZE after migration to update statistics

### Batch Processing
For large datasets, migrate data in batches:

```sql
-- Example: Migrate in batches of 1000
UPDATE actors SET display_name = ...
WHERE id IN (SELECT id FROM actors WHERE display_name IS NULL LIMIT 1000);
```

### Memory Usage
- Use transactions for related updates
- Commit frequently to avoid lock contention
- Consider `PRAGMA temp_store = FILE` for large operations

---

## Timeline

| Phase | Description | Risk | Reversible |
|-------|-------------|------|------------|
| 1 | Add columns | Low | Yes (ignore) |
| 2 | Create tables | Low | Yes (drop) |
| 3 | Migrate data | Medium | Yes (ignore new) |
| 4 | Update code | Medium | Yes (deploy old) |
| 5 | Add constraints | Low | Yes (remove) |
| 6 | Rename tables | High | Complex |
| 7 | Cleanup | Medium | No |

Recommended approach: Complete phases 1-5 before considering phase 6-7.

---

## Notes on Cloudflare D1

### D1-Specific Considerations
1. D1 uses SQLite, so standard SQLite limitations apply
2. No support for `ALTER TABLE ... DROP COLUMN`
3. Limited JSON functions compared to full SQLite
4. Consider D1's transaction limits for batch operations
5. Use D1's backup feature before major migrations

### Migration Execution
```typescript
// Using D1 binding in Cloudflare Workers
async function runMigration(db: D1Database) {
  await db.batch([
    db.prepare('ALTER TABLE actors ADD COLUMN display_name TEXT'),
    db.prepare('ALTER TABLE actors ADD COLUMN note TEXT'),
    // ... more statements
  ])
}
```

---

## Summary

This migration strategy provides a safe, incremental path from the current schema to full Mastodon API compatibility:

1. **Non-breaking additions** in early phases
2. **Data preservation** through parallel structures
3. **Rollback capability** at each phase
4. **Gradual code updates** with backward compatibility
5. **Optional cleanup** only after full verification

The hybrid approach maintains the JSON `properties` columns for federation flexibility while providing normalized columns for efficient Mastodon API queries.
