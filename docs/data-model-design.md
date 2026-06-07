# Wildebeest Data Model Design

## Overview

This document defines the comprehensive database schema and TypeScript types for Mastodon API compatibility.
The design follows a **hybrid approach**:
- Normalized columns for frequently queried fields and well-defined Mastodon API fields
- JSON `properties` columns for ActivityPub extensibility and federation compatibility with non-Mastodon servers

## Design Principles

1. **Spec Conformance**: Support all Mastodon API v4.x entities and fields
2. **Federation Flexibility**: Accept varied data from non-Mastodon ActivityPub servers via JSON properties
3. **Query Performance**: Normalize fields used in WHERE/ORDER BY/INDEX clauses
4. **Data Integrity**: Use foreign keys, constraints, and proper indexes
5. **SQLite Compatibility**: Design for Cloudflare D1 (SQLite) limitations
6. **Storage Efficiency**: Implement retention policies for remote/federated data to stay within D1 limits

---

## Data Retention Strategy

To manage D1's 10GB storage limit, the schema includes retention tracking for remote/federated data.

### Retention Principles

1. **Local data is permanent**: User's own statuses, follows, preferences
2. **Remote data is ephemeral**: Can be refetched via ActivityPub when needed
3. **Interactions extend retention**: Favourited/reblogged remote content stays longer
4. **Configurable TTLs**: Retention periods adjustable via environment variables

### Default Retention Periods

| Data Type | Default TTL | Environment Variable |
|-----------|-------------|---------------------|
| Remote statuses | 30 days | `RETENTION_REMOTE_STATUSES_DAYS` |
| Remote statuses (interacted) | 90 days | `RETENTION_REMOTE_STATUSES_INTERACTED_DAYS` |
| Remote accounts | 90 days | `RETENTION_REMOTE_ACCOUNTS_DAYS` |
| Remote accounts (followed) | Never | - |
| Notifications | 90 days | `RETENTION_NOTIFICATIONS_DAYS` |
| Processed inbox entries | 1 day | `RETENTION_INBOX_PROCESSED_DAYS` |
| Delivery failures | 7 days | `RETENTION_DELIVERY_FAILURES_DAYS` |

### Retention Columns

Tables storing remote/federated data include these columns:

- `cached_at`: When the remote data was first fetched
- `expires_at`: When this data becomes eligible for cleanup
- `interaction_count`: Number of local interactions (prevents cleanup while > 0)

---

## Entity Relationship Diagram (Conceptual)

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────┐
│   actors    │──1:N─│  actor_following │──N:1─│   actors    │
└─────────────┘      └──────────────────┘      └─────────────┘
       │                                              │
       │ 1:1                                          │
       ▼                                              │
┌─────────────┐                                       │
│    users    │ (local users only)                    │
└─────────────┘                                       │
       │                                              │
       │ 1:N                                          │
       ▼                                              │
┌─────────────┐      ┌──────────────────┐      ┌─────────────┐
│  statuses   │──1:N─│ status_mentions  │──N:1─│   actors    │
└─────────────┘      └──────────────────┘      └─────────────┘
       │
       │ 1:N
       ▼
┌─────────────────────┐
│  media_attachments  │
└─────────────────────┘
```

---

## Table Definitions

### Core Tables

#### accounts (Renamed from actors)

Stores both local and remote ActivityPub actors. The term "account" aligns with Mastodon API terminology.

```sql
CREATE TABLE accounts (
  -- Identifiers
  "id" TEXT NOT NULL PRIMARY KEY,                    -- Internal UUID
  "uri" TEXT UNIQUE NOT NULL,                        -- ActivityPub actor URI (canonical identifier)
  "mastodon_id" TEXT UNIQUE,                         -- Numeric-like ID for Mastodon API (ULID or snowflake)

  -- Actor Identity
  "type" TEXT NOT NULL DEFAULT 'Person',             -- Person, Service, Application, Group, Organization
  "username" TEXT NOT NULL,                          -- Local username (without @)
  "domain" TEXT,                                     -- NULL for local accounts, domain for remote
  "acct" TEXT NOT NULL,                              -- username or username@domain

  -- Display Properties (normalized for queries)
  "display_name" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',                   -- Bio (HTML for local, may be HTML or plain for remote)
  "url" TEXT,                                        -- Web profile URL

  -- Media
  "avatar" TEXT NOT NULL DEFAULT '',
  "avatar_static" TEXT NOT NULL DEFAULT '',
  "header" TEXT NOT NULL DEFAULT '',
  "header_static" TEXT NOT NULL DEFAULT '',

  -- Flags (normalized for queries)
  "locked" INTEGER NOT NULL DEFAULT 0,               -- Requires follow approval
  "bot" INTEGER NOT NULL DEFAULT 0,                  -- Automated account
  "group" INTEGER NOT NULL DEFAULT 0,                -- Group actor
  "discoverable" INTEGER,                            -- NULL = not set, 0 = false, 1 = true
  "indexable" INTEGER NOT NULL DEFAULT 0,            -- Opt-in to search indexing
  "hide_collections" INTEGER NOT NULL DEFAULT 0,    -- Hide followers/following
  "noindex" INTEGER,                                 -- Robots noindex (local only)
  "memorial" INTEGER,                                -- Memorial account (local only)

  -- Moderation States
  "suspended_at" DATETIME,                           -- When suspended (NULL = not suspended)
  "silenced_at" DATETIME,                            -- When silenced/limited (NULL = not silenced)
  "sensitized_at" DATETIME,                          -- When marked sensitive (NULL = not sensitized)

  -- Cached Counts (denormalized for performance)
  "followers_count" INTEGER NOT NULL DEFAULT 0,
  "following_count" INTEGER NOT NULL DEFAULT 0,
  "statuses_count" INTEGER NOT NULL DEFAULT 0,

  -- Activity Tracking
  "last_status_at" TEXT,                             -- Date only: YYYY-MM-DD
  "last_webfingered_at" DATETIME,                    -- Last WebFinger refresh

  -- Migration
  "moved_to_account_id" TEXT,                        -- Account migrated to

  -- ActivityPub Extension Data (JSON)
  -- Contains: publicKey, endpoints, alsoKnownAs, attachment (fields), icon, image, etc.
  "properties" TEXT NOT NULL DEFAULT '{}',

  -- Retention (for remote accounts only)
  "cached_at" DATETIME,                              -- When first fetched (NULL for local)
  "expires_at" DATETIME,                             -- When eligible for cleanup (NULL = never)
  "interaction_count" INTEGER NOT NULL DEFAULT 0,   -- Local follows/mentions keep account alive

  -- Timestamps
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  -- Constraints
  CONSTRAINT "accounts_moved_to_fkey" FOREIGN KEY ("moved_to_account_id") REFERENCES "accounts" ("id") ON DELETE SET NULL
);

-- Indexes
CREATE UNIQUE INDEX "accounts_uri" ON "accounts" ("uri");
CREATE UNIQUE INDEX "accounts_mastodon_id" ON "accounts" ("mastodon_id");
CREATE INDEX "accounts_username_domain" ON "accounts" ("username", "domain");
CREATE INDEX "accounts_domain" ON "accounts" ("domain");
CREATE INDEX "accounts_discoverable" ON "accounts" ("discoverable") WHERE "discoverable" = 1;
CREATE INDEX "accounts_created_at" ON "accounts" ("created_at" DESC);

-- Cleanup index for remote accounts
CREATE INDEX "accounts_cleanup" ON "accounts" ("domain", "expires_at", "interaction_count")
  WHERE "domain" IS NOT NULL AND "expires_at" IS NOT NULL;
```

#### account_fields

Profile metadata fields (max 4 per account per Mastodon spec).

```sql
CREATE TABLE account_fields (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "account_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,             -- Display order (0-3)
  "name" TEXT NOT NULL,                              -- Field label
  "value" TEXT NOT NULL,                             -- Field value (HTML)
  "verified_at" DATETIME,                            -- Link verification timestamp

  CONSTRAINT "account_fields_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "account_fields_account_id" ON "account_fields" ("account_id");
CREATE UNIQUE INDEX "account_fields_account_position" ON "account_fields" ("account_id", "position");
```

#### users (Local users only)

Authentication and local user data. One-to-one with accounts for local users.

```sql
CREATE TABLE users (
  "id" TEXT NOT NULL PRIMARY KEY,                    -- Same as accounts.id for simplicity
  "account_id" TEXT UNIQUE NOT NULL,
  "email" TEXT UNIQUE NOT NULL,

  -- Authentication
  "privkey" BLOB NOT NULL,                           -- Encrypted private key
  "privkey_salt" BLOB NOT NULL,                      -- Encryption salt
  "pubkey" TEXT NOT NULL,                            -- Public key (PEM)

  -- Account Status
  "is_admin" INTEGER NOT NULL DEFAULT 0,
  "is_moderator" INTEGER NOT NULL DEFAULT 0,
  "approved" INTEGER NOT NULL DEFAULT 1,             -- Account approval status
  "disabled" INTEGER NOT NULL DEFAULT 0,             -- Account disabled

  -- Email Confirmation
  "confirmed_at" DATETIME,
  "confirmation_token" TEXT,
  "confirmation_sent_at" DATETIME,

  -- Password Reset
  "reset_password_token" TEXT,
  "reset_password_sent_at" DATETIME,

  -- Sign-in Tracking
  "sign_in_count" INTEGER NOT NULL DEFAULT 0,
  "current_sign_in_at" DATETIME,
  "last_sign_in_at" DATETIME,
  "current_sign_in_ip" TEXT,
  "last_sign_in_ip" TEXT,

  -- Preferences
  "locale" TEXT,                                     -- User's preferred language

  -- Timestamps
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT
);

CREATE INDEX "users_email" ON "users" ("email");
CREATE INDEX "users_confirmation_token" ON "users" ("confirmation_token") WHERE "confirmation_token" IS NOT NULL;
CREATE INDEX "users_reset_password_token" ON "users" ("reset_password_token") WHERE "reset_password_token" IS NOT NULL;
```

#### user_roles

Roles for permission management.

```sql
CREATE TABLE user_roles (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT UNIQUE NOT NULL,
  "color" TEXT NOT NULL DEFAULT '',                  -- Hex color for display
  "position" INTEGER NOT NULL DEFAULT 0,             -- Priority (higher = more powerful)
  "permissions" INTEGER NOT NULL DEFAULT 0,          -- Bitmask of permissions
  "highlighted" INTEGER NOT NULL DEFAULT 0,          -- Show on profile
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE TABLE user_role_assignments (
  "user_id" TEXT NOT NULL,
  "role_id" INTEGER NOT NULL,
  PRIMARY KEY ("user_id", "role_id"),
  CONSTRAINT "user_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "user_role_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "user_roles" ("id") ON DELETE CASCADE
);
```

---

### Status Tables

#### statuses (Renamed from objects)

Stores posts/notes. Clearer naming aligned with Mastodon API.

```sql
CREATE TABLE statuses (
  -- Identifiers
  "id" TEXT NOT NULL PRIMARY KEY,                    -- Internal UUID
  "uri" TEXT UNIQUE NOT NULL,                        -- ActivityPub object URI
  "mastodon_id" TEXT UNIQUE NOT NULL,                -- Numeric-like ID for Mastodon API

  -- Type & Origin
  "type" TEXT NOT NULL DEFAULT 'Note',               -- Note, Article, Question, etc.
  "account_id" TEXT NOT NULL,                        -- Author account
  "local" INTEGER NOT NULL DEFAULT 0,                -- 1 = created locally

  -- Content
  "content" TEXT NOT NULL DEFAULT '',                -- HTML content
  "text" TEXT,                                       -- Plain text source (local only)
  "spoiler_text" TEXT NOT NULL DEFAULT '',           -- Content warning
  "sensitive" INTEGER NOT NULL DEFAULT 0,            -- NSFW flag
  "language" TEXT,                                   -- ISO 639-1 language code
  "url" TEXT,                                        -- Web URL

  -- Visibility
  "visibility" TEXT NOT NULL DEFAULT 'public',       -- public, unlisted, private, direct

  -- Reply Threading
  "in_reply_to_id" TEXT,                             -- Status being replied to
  "in_reply_to_account_id" TEXT,                     -- Account being replied to
  "conversation_id" TEXT,                            -- Conversation thread ID

  -- Reblog (Announce)
  "reblog_of_id" TEXT,                               -- Original status if this is a reblog

  -- Quote (Mastodon 4.x feature)
  "quote_id" TEXT,                                   -- Quoted status

  -- Poll
  "poll_id" TEXT,                                    -- Associated poll

  -- Posting Application
  "application_name" TEXT,
  "application_website" TEXT,

  -- Cached Counts (denormalized)
  "replies_count" INTEGER NOT NULL DEFAULT 0,
  "reblogs_count" INTEGER NOT NULL DEFAULT 0,
  "favourites_count" INTEGER NOT NULL DEFAULT 0,
  "quotes_count" INTEGER NOT NULL DEFAULT 0,

  -- Editing
  "edited_at" DATETIME,                              -- Last edit timestamp

  -- Deletion
  "deleted_at" DATETIME,                             -- Soft delete timestamp

  -- ActivityPub Extension Data (JSON)
  -- Contains: to, cc, attachment (raw), tag (raw), etc.
  "properties" TEXT NOT NULL DEFAULT '{}',

  -- Retention (for remote statuses only)
  "cached_at" DATETIME,                              -- When first fetched (NULL for local)
  "expires_at" DATETIME,                             -- When eligible for cleanup (NULL = never)
  "interaction_count" INTEGER NOT NULL DEFAULT 0,   -- Local favs/reblogs/bookmarks keep status alive

  -- Timestamps
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "statuses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "statuses_in_reply_to_id_fkey" FOREIGN KEY ("in_reply_to_id") REFERENCES "statuses" ("id") ON DELETE SET NULL,
  CONSTRAINT "statuses_in_reply_to_account_id_fkey" FOREIGN KEY ("in_reply_to_account_id") REFERENCES "accounts" ("id") ON DELETE SET NULL,
  CONSTRAINT "statuses_reblog_of_id_fkey" FOREIGN KEY ("reblog_of_id") REFERENCES "statuses" ("id") ON DELETE CASCADE,
  CONSTRAINT "statuses_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "statuses" ("id") ON DELETE SET NULL,
  CONSTRAINT "statuses_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE SET NULL
);

-- Indexes for timeline queries
CREATE INDEX "statuses_mastodon_id" ON "statuses" ("mastodon_id");
CREATE INDEX "statuses_account_id" ON "statuses" ("account_id");
CREATE INDEX "statuses_account_id_created_at" ON "statuses" ("account_id", "created_at" DESC);
CREATE INDEX "statuses_in_reply_to_id" ON "statuses" ("in_reply_to_id") WHERE "in_reply_to_id" IS NOT NULL;
CREATE INDEX "statuses_conversation_id" ON "statuses" ("conversation_id") WHERE "conversation_id" IS NOT NULL;
CREATE INDEX "statuses_reblog_of_id" ON "statuses" ("reblog_of_id") WHERE "reblog_of_id" IS NOT NULL;
CREATE INDEX "statuses_visibility" ON "statuses" ("visibility");
CREATE INDEX "statuses_local_created_at" ON "statuses" ("local", "created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "statuses_public_timeline" ON "statuses" ("created_at" DESC) WHERE "visibility" = 'public' AND "reblog_of_id" IS NULL AND "deleted_at" IS NULL;

-- Cleanup index for remote statuses
CREATE INDEX "statuses_cleanup" ON "statuses" ("local", "expires_at", "interaction_count")
  WHERE "local" = 0 AND "expires_at" IS NOT NULL AND "deleted_at" IS NULL;
```

#### status_edits

Stores edit history for statuses.

```sql
CREATE TABLE status_edits (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "status_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,                        -- Editor (should be same as author)
  "content" TEXT NOT NULL,
  "spoiler_text" TEXT NOT NULL DEFAULT '',
  "sensitive" INTEGER NOT NULL DEFAULT 0,
  "media_attachments_json" TEXT NOT NULL DEFAULT '[]',  -- Snapshot of attachments
  "poll_json" TEXT,                                  -- Snapshot of poll options
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "status_edits_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE,
  CONSTRAINT "status_edits_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "status_edits_status_id" ON "status_edits" ("status_id");
```

---

### Media Tables

#### media_attachments

Stores media files attached to statuses.

```sql
CREATE TABLE media_attachments (
  "id" TEXT NOT NULL PRIMARY KEY,                    -- UUID
  "mastodon_id" TEXT UNIQUE NOT NULL,
  "account_id" TEXT NOT NULL,                        -- Uploader
  "status_id" TEXT,                                  -- NULL until attached

  -- Media Type
  "type" TEXT NOT NULL DEFAULT 'unknown',            -- image, gifv, video, audio, unknown

  -- URLs
  "url" TEXT,                                        -- Full media URL (NULL if processing)
  "preview_url" TEXT,                                -- Thumbnail URL
  "remote_url" TEXT,                                 -- Original remote URL

  -- Metadata
  "description" TEXT,                                -- Alt text
  "blurhash" TEXT,                                   -- BlurHash placeholder
  "meta" TEXT NOT NULL DEFAULT '{}',                 -- JSON: dimensions, fps, duration, etc.

  -- Processing State
  "processing_state" TEXT NOT NULL DEFAULT 'pending', -- pending, processing, complete, failed

  -- File Info (for local uploads)
  "file_name" TEXT,
  "file_content_type" TEXT,
  "file_size" INTEGER,

  -- Remote tracking
  "remote" INTEGER NOT NULL DEFAULT 0,               -- 1 = fetched from remote

  -- Timestamps
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "media_attachments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "media_attachments_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE SET NULL
);

CREATE INDEX "media_attachments_account_id" ON "media_attachments" ("account_id");
CREATE INDEX "media_attachments_status_id" ON "media_attachments" ("status_id") WHERE "status_id" IS NOT NULL;
CREATE INDEX "media_attachments_pending" ON "media_attachments" ("processing_state") WHERE "processing_state" = 'pending';
```

---

### Poll Tables

#### polls

```sql
CREATE TABLE polls (
  "id" TEXT NOT NULL PRIMARY KEY,                    -- UUID
  "status_id" TEXT UNIQUE,                           -- Associated status
  "account_id" TEXT NOT NULL,                        -- Poll creator

  -- Poll Configuration
  "multiple" INTEGER NOT NULL DEFAULT 0,             -- Allow multiple choices
  "hide_totals" INTEGER NOT NULL DEFAULT 0,          -- Hide results until ended
  "expires_at" DATETIME,                             -- NULL = no expiration

  -- Cached Counts
  "votes_count" INTEGER NOT NULL DEFAULT 0,
  "voters_count" INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "polls_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE,
  CONSTRAINT "polls_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);
```

#### poll_options

```sql
CREATE TABLE poll_options (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "poll_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,                       -- Display order (0-indexed)
  "title" TEXT NOT NULL,
  "votes_count" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "poll_options_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE CASCADE
);

CREATE INDEX "poll_options_poll_id" ON "poll_options" ("poll_id");
CREATE UNIQUE INDEX "poll_options_poll_position" ON "poll_options" ("poll_id", "position");
```

#### poll_votes

```sql
CREATE TABLE poll_votes (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "poll_id" TEXT NOT NULL,
  "poll_option_id" INTEGER NOT NULL,
  "account_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "poll_votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls" ("id") ON DELETE CASCADE,
  CONSTRAINT "poll_votes_poll_option_id_fkey" FOREIGN KEY ("poll_option_id") REFERENCES "poll_options" ("id") ON DELETE CASCADE,
  CONSTRAINT "poll_votes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "poll_votes_poll_id" ON "poll_votes" ("poll_id");
CREATE INDEX "poll_votes_account_id" ON "poll_votes" ("account_id");
-- For multiple=false polls, ensure one vote per user
-- For multiple=true polls, ensure one vote per option per user
CREATE UNIQUE INDEX "poll_votes_unique" ON "poll_votes" ("poll_id", "poll_option_id", "account_id");
```

---

### Relationship Tables

#### follows

Replaces actor_following with clearer naming and additional fields.

```sql
CREATE TABLE follows (
  "id" TEXT NOT NULL PRIMARY KEY,                    -- UUID
  "account_id" TEXT NOT NULL,                        -- Follower
  "target_account_id" TEXT NOT NULL,                 -- Being followed

  -- State
  "state" TEXT NOT NULL DEFAULT 'pending',           -- pending, accepted

  -- Relationship Settings
  "show_reblogs" INTEGER NOT NULL DEFAULT 1,         -- Show boosts in timeline
  "notify" INTEGER NOT NULL DEFAULT 0,               -- Notify on posts
  "languages" TEXT,                                  -- JSON array of language codes, NULL = all

  -- ActivityPub
  "uri" TEXT,                                        -- Follow activity URI

  -- Timestamps
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "follows_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "follows_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "follows_unique" ON "follows" ("account_id", "target_account_id");
CREATE INDEX "follows_account_id" ON "follows" ("account_id");
CREATE INDEX "follows_target_account_id" ON "follows" ("target_account_id");
CREATE INDEX "follows_pending" ON "follows" ("target_account_id", "state") WHERE "state" = 'pending';
```

#### blocks

Account-level blocks.

```sql
CREATE TABLE blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- Blocker
  "target_account_id" TEXT NOT NULL,                 -- Blocked
  "uri" TEXT,                                        -- Block activity URI
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "blocks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "blocks_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "blocks_unique" ON "blocks" ("account_id", "target_account_id");
CREATE INDEX "blocks_account_id" ON "blocks" ("account_id");
CREATE INDEX "blocks_target_account_id" ON "blocks" ("target_account_id");
```

#### mutes

Account-level mutes.

```sql
CREATE TABLE mutes (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- Muter
  "target_account_id" TEXT NOT NULL,                 -- Muted
  "hide_notifications" INTEGER NOT NULL DEFAULT 1,   -- Also hide notifications
  "expires_at" DATETIME,                             -- Temporary mute expiration
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "mutes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "mutes_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "mutes_unique" ON "mutes" ("account_id", "target_account_id");
CREATE INDEX "mutes_account_id" ON "mutes" ("account_id");
CREATE INDEX "mutes_expires_at" ON "mutes" ("expires_at") WHERE "expires_at" IS NOT NULL;
```

#### domain_blocks

User-level domain blocks.

```sql
CREATE TABLE domain_blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "domain_blocks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "domain_blocks_unique" ON "domain_blocks" ("account_id", "domain");
CREATE INDEX "domain_blocks_account_id" ON "domain_blocks" ("account_id");
```

#### account_notes

Private notes about other accounts.

```sql
CREATE TABLE account_notes (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- Note author
  "target_account_id" TEXT NOT NULL,                 -- About whom
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "account_notes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "account_notes_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "account_notes_unique" ON "account_notes" ("account_id", "target_account_id");
```

#### endorsements

Featured/endorsed accounts on profile.

```sql
CREATE TABLE endorsements (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- Endorser
  "target_account_id" TEXT NOT NULL,                 -- Endorsed
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "endorsements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "endorsements_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "endorsements_unique" ON "endorsements" ("account_id", "target_account_id");
CREATE INDEX "endorsements_account_id" ON "endorsements" ("account_id");
```

---

### Interaction Tables

#### favourites

```sql
CREATE TABLE favourites (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "status_id" TEXT NOT NULL,
  "uri" TEXT,                                        -- Like activity URI
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "favourites_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "favourites_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "favourites_unique" ON "favourites" ("account_id", "status_id");
CREATE INDEX "favourites_account_id" ON "favourites" ("account_id");
CREATE INDEX "favourites_status_id" ON "favourites" ("status_id");
```

#### bookmarks

```sql
CREATE TABLE bookmarks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "status_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "bookmarks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "bookmarks_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "bookmarks_unique" ON "bookmarks" ("account_id", "status_id");
CREATE INDEX "bookmarks_account_id" ON "bookmarks" ("account_id");
```

#### status_pins

Pinned statuses on profile.

```sql
CREATE TABLE status_pins (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "status_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "status_pins_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "status_pins_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "status_pins_unique" ON "status_pins" ("account_id", "status_id");
CREATE INDEX "status_pins_account_id" ON "status_pins" ("account_id");
```

#### Reblog Modeling (No Separate Table)

**Reblogs are modeled as statuses**, following Mastodon's design:

- A reblog is a status row with `reblog_of_id` pointing to the original status
- The reblog status has its own `id`, `account_id` (who reblogged), `created_at`, and `uri` (the Announce activity)
- Content fields (`content`, `text`, `spoiler_text`) are typically empty for reblogs
- `reblogs_count` on the original status is derived from: `SELECT COUNT(*) FROM statuses WHERE reblog_of_id = ?`

**Why no separate `reblogs` table:**
- Single source of truth (the status table)
- Reblogs appear naturally in timelines as statuses
- No count drift between table and column
- Cleanup logic only needs to consider statuses
- Matches Mastodon's proven data model

**Migration note:** The current `actor_reblogs` table will be replaced by creating actual status rows for each reblog. See migration Phase 3 for details.

```sql
-- Index for efficient reblog lookups and count calculation
CREATE INDEX "statuses_reblog_of_id" ON "statuses" ("reblog_of_id") WHERE "reblog_of_id" IS NOT NULL;
```

---

### Mention & Tag Tables

#### mentions

Status mentions of accounts.

```sql
CREATE TABLE mentions (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "status_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,                        -- Mentioned account
  "silent" INTEGER NOT NULL DEFAULT 0,               -- Silent mention (no notification)

  CONSTRAINT "mentions_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE,
  CONSTRAINT "mentions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "mentions_status_id" ON "mentions" ("status_id");
CREATE INDEX "mentions_account_id" ON "mentions" ("account_id");
CREATE UNIQUE INDEX "mentions_unique" ON "mentions" ("status_id", "account_id");
```

#### tags

Hashtag registry.

```sql
CREATE TABLE tags (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT UNIQUE NOT NULL,                       -- Normalized lowercase name
  "display_name" TEXT NOT NULL,                      -- Display version (may have casing)

  -- Discoverability
  "usable" INTEGER NOT NULL DEFAULT 1,               -- Can be used in posts
  "trendable" INTEGER NOT NULL DEFAULT 1,            -- Can appear in trends
  "listable" INTEGER NOT NULL DEFAULT 1,             -- Can appear in discovery

  -- Stats
  "last_status_at" TEXT,                             -- Date: YYYY-MM-DD

  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE UNIQUE INDEX "tags_name" ON "tags" ("name");
```

#### status_tags

Junction table for status-tag relationships.

```sql
CREATE TABLE status_tags (
  "status_id" TEXT NOT NULL,
  "tag_id" INTEGER NOT NULL,
  PRIMARY KEY ("status_id", "tag_id"),

  CONSTRAINT "status_tags_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE,
  CONSTRAINT "status_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
);

CREATE INDEX "status_tags_tag_id" ON "status_tags" ("tag_id");
```

#### followed_tags

Tags followed by accounts.

```sql
CREATE TABLE followed_tags (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "followed_tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "followed_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "followed_tags_unique" ON "followed_tags" ("account_id", "tag_id");
CREATE INDEX "followed_tags_account_id" ON "followed_tags" ("account_id");
```

#### featured_tags

Featured hashtags on profile.

```sql
CREATE TABLE featured_tags (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "tag_id" INTEGER NOT NULL,
  "statuses_count" INTEGER NOT NULL DEFAULT 0,
  "last_status_at" TEXT,                             -- Date: YYYY-MM-DD
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "featured_tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "featured_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "featured_tags_unique" ON "featured_tags" ("account_id", "tag_id");
CREATE INDEX "featured_tags_account_id" ON "featured_tags" ("account_id");
```

---

### Notification Tables

#### notifications

```sql
CREATE TABLE notifications (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "account_id" TEXT NOT NULL,                        -- Recipient
  "from_account_id" TEXT NOT NULL,                   -- Actor causing notification

  -- Type
  "type" TEXT NOT NULL,                              -- mention, status, reblog, follow, follow_request, favourite, poll, update, admin.sign_up, admin.report, severed_relationships, moderation_warning

  -- Related entities (depending on type)
  "status_id" TEXT,
  "report_id" TEXT,
  "account_warning_id" INTEGER,

  -- Grouping
  "group_key" TEXT,                                  -- For notification grouping

  -- State
  "read" INTEGER NOT NULL DEFAULT 0,
  "filtered" INTEGER NOT NULL DEFAULT 0,

  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "notifications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "notifications_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "notifications_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE
);

CREATE INDEX "notifications_account_id" ON "notifications" ("account_id", "id" DESC);
CREATE INDEX "notifications_account_id_type" ON "notifications" ("account_id", "type");
CREATE INDEX "notifications_account_id_created_at" ON "notifications" ("account_id", "created_at" DESC);
CREATE INDEX "notifications_group_key" ON "notifications" ("account_id", "group_key") WHERE "group_key" IS NOT NULL;
```

#### notification_policies

Per-account notification filtering policies.

```sql
CREATE TABLE notification_policies (
  "account_id" TEXT NOT NULL PRIMARY KEY,
  "for_not_following" TEXT NOT NULL DEFAULT 'accept', -- accept, filter, drop
  "for_not_followers" TEXT NOT NULL DEFAULT 'accept',
  "for_new_accounts" TEXT NOT NULL DEFAULT 'accept',
  "for_private_mentions" TEXT NOT NULL DEFAULT 'filter',
  "for_limited_accounts" TEXT NOT NULL DEFAULT 'filter',
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "notification_policies_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);
```

#### notification_requests

Filtered notification requests pending approval.

```sql
CREATE TABLE notification_requests (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- Recipient
  "from_account_id" TEXT NOT NULL,                   -- Requester
  "last_status_id" TEXT,
  "notifications_count" INTEGER NOT NULL DEFAULT 0,
  "dismissed" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "notification_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "notification_requests_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "notification_requests_last_status_id_fkey" FOREIGN KEY ("last_status_id") REFERENCES "statuses" ("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "notification_requests_unique" ON "notification_requests" ("account_id", "from_account_id");
CREATE INDEX "notification_requests_account_id" ON "notification_requests" ("account_id");
```

---

### List Tables

#### lists

```sql
CREATE TABLE lists (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- List owner
  "title" TEXT NOT NULL,
  "replies_policy" TEXT NOT NULL DEFAULT 'list',     -- list, followed, none
  "exclusive" INTEGER NOT NULL DEFAULT 0,            -- Exclusive list
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "lists_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "lists_account_id" ON "lists" ("account_id");
```

#### list_accounts

```sql
CREATE TABLE list_accounts (
  "list_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "follow_id" TEXT,                                  -- Associated follow relationship
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("list_id", "account_id"),

  CONSTRAINT "list_accounts_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists" ("id") ON DELETE CASCADE,
  CONSTRAINT "list_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "list_accounts_follow_id_fkey" FOREIGN KEY ("follow_id") REFERENCES "follows" ("id") ON DELETE CASCADE
);

CREATE INDEX "list_accounts_account_id" ON "list_accounts" ("account_id");
```

---

### Conversation Tables

#### conversations

```sql
CREATE TABLE conversations (
  "id" TEXT NOT NULL PRIMARY KEY,
  "uri" TEXT UNIQUE,                                 -- ActivityPub context URI if applicable
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);
```

#### conversation_accounts

Per-account conversation state.

```sql
CREATE TABLE conversation_accounts (
  "conversation_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "last_status_id" TEXT,
  "unread" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("conversation_id", "account_id"),

  CONSTRAINT "conversation_accounts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
  CONSTRAINT "conversation_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "conversation_accounts_last_status_id_fkey" FOREIGN KEY ("last_status_id") REFERENCES "statuses" ("id") ON DELETE SET NULL
);

CREATE INDEX "conversation_accounts_account_id" ON "conversation_accounts" ("account_id");
```

#### conversation_mutes

```sql
CREATE TABLE conversation_mutes (
  "conversation_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("conversation_id", "account_id"),

  CONSTRAINT "conversation_mutes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE,
  CONSTRAINT "conversation_mutes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);
```

---

### Filter Tables

#### filters

Content filters (v2 API).

```sql
CREATE TABLE filters (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '[]',              -- JSON array: home, notifications, public, thread, account
  "filter_action" TEXT NOT NULL DEFAULT 'warn',      -- warn, hide
  "expires_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "filters_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "filters_account_id" ON "filters" ("account_id");
CREATE INDEX "filters_expires_at" ON "filters" ("expires_at") WHERE "expires_at" IS NOT NULL;
```

#### filter_keywords

```sql
CREATE TABLE filter_keywords (
  "id" TEXT NOT NULL PRIMARY KEY,
  "filter_id" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "whole_word" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "filter_keywords_filter_id_fkey" FOREIGN KEY ("filter_id") REFERENCES "filters" ("id") ON DELETE CASCADE
);

CREATE INDEX "filter_keywords_filter_id" ON "filter_keywords" ("filter_id");
```

#### filter_statuses

```sql
CREATE TABLE filter_statuses (
  "id" TEXT NOT NULL PRIMARY KEY,
  "filter_id" TEXT NOT NULL,
  "status_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "filter_statuses_filter_id_fkey" FOREIGN KEY ("filter_id") REFERENCES "filters" ("id") ON DELETE CASCADE,
  CONSTRAINT "filter_statuses_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE
);

CREATE INDEX "filter_statuses_filter_id" ON "filter_statuses" ("filter_id");
CREATE UNIQUE INDEX "filter_statuses_unique" ON "filter_statuses" ("filter_id", "status_id");
```

---

### Report Tables

#### reports

```sql
CREATE TABLE reports (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- Reporter
  "target_account_id" TEXT NOT NULL,                 -- Reported account

  -- Report Details
  "comment" TEXT NOT NULL DEFAULT '',
  "category" TEXT NOT NULL DEFAULT 'other',          -- spam, legal, violation, other
  "rule_ids" TEXT NOT NULL DEFAULT '[]',             -- JSON array of rule IDs
  "status_ids" TEXT NOT NULL DEFAULT '[]',           -- JSON array of status IDs
  "forward" INTEGER NOT NULL DEFAULT 0,              -- Forward to remote instance
  "forwarded_to_domains" TEXT NOT NULL DEFAULT '[]', -- JSON array of forwarded domains

  -- Moderation
  "assigned_account_id" TEXT,                        -- Assigned moderator
  "action_taken" INTEGER NOT NULL DEFAULT 0,
  "action_taken_at" DATETIME,
  "action_taken_by_account_id" TEXT,

  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "reports_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "reports_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "reports_assigned_account_id_fkey" FOREIGN KEY ("assigned_account_id") REFERENCES "accounts" ("id") ON DELETE SET NULL,
  CONSTRAINT "reports_action_taken_by_account_id_fkey" FOREIGN KEY ("action_taken_by_account_id") REFERENCES "accounts" ("id") ON DELETE SET NULL
);

CREATE INDEX "reports_target_account_id" ON "reports" ("target_account_id");
CREATE INDEX "reports_assigned_account_id" ON "reports" ("assigned_account_id") WHERE "assigned_account_id" IS NOT NULL;
CREATE INDEX "reports_pending" ON "reports" ("action_taken") WHERE "action_taken" = 0;
```

---

### Admin Tables

#### admin_domain_blocks

Server-level domain blocks.

```sql
CREATE TABLE admin_domain_blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "domain" TEXT UNIQUE NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'silence',        -- silence, suspend, noop
  "reject_media" INTEGER NOT NULL DEFAULT 0,
  "reject_reports" INTEGER NOT NULL DEFAULT 0,
  "private_comment" TEXT,
  "public_comment" TEXT,
  "obfuscate" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE UNIQUE INDEX "admin_domain_blocks_domain" ON "admin_domain_blocks" ("domain");
```

#### admin_domain_allows

For limited federation mode.

```sql
CREATE TABLE admin_domain_allows (
  "id" TEXT NOT NULL PRIMARY KEY,
  "domain" TEXT UNIQUE NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE UNIQUE INDEX "admin_domain_allows_domain" ON "admin_domain_allows" ("domain");
```

#### admin_ip_blocks

```sql
CREATE TABLE admin_ip_blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ip" TEXT NOT NULL,                                -- IP address or CIDR range
  "severity" TEXT NOT NULL DEFAULT 'sign_up_requires_approval', -- sign_up_requires_approval, sign_up_block, no_access
  "comment" TEXT,
  "expires_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE INDEX "admin_ip_blocks_ip" ON "admin_ip_blocks" ("ip");
```

#### admin_email_domain_blocks

```sql
CREATE TABLE admin_email_domain_blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "domain" TEXT UNIQUE NOT NULL,
  "allow_with_approval" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);
```

#### admin_canonical_email_blocks

```sql
CREATE TABLE admin_canonical_email_blocks (
  "id" TEXT NOT NULL PRIMARY KEY,
  "canonical_email_hash" TEXT UNIQUE NOT NULL,
  "reference_account_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "admin_canonical_email_blocks_reference_account_id_fkey" FOREIGN KEY ("reference_account_id") REFERENCES "accounts" ("id") ON DELETE SET NULL
);
```

#### account_warnings

Moderation warnings issued to accounts.

```sql
CREATE TABLE account_warnings (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "account_id" TEXT NOT NULL,                        -- Warned account
  "target_account_id" TEXT NOT NULL,                 -- Account receiving warning
  "action" TEXT NOT NULL,                            -- none, disable, sensitive, silence, suspend
  "text" TEXT NOT NULL DEFAULT '',
  "status_ids" TEXT NOT NULL DEFAULT '[]',           -- JSON array
  "overruled_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "account_warnings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "account_warnings_target_account_id_fkey" FOREIGN KEY ("target_account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "account_warnings_target_account_id" ON "account_warnings" ("target_account_id");
```

---

### Announcement Tables

#### announcements

```sql
CREATE TABLE announcements (
  "id" TEXT NOT NULL PRIMARY KEY,
  "content" TEXT NOT NULL,
  "starts_at" DATETIME,
  "ends_at" DATETIME,
  "all_day" INTEGER NOT NULL DEFAULT 0,
  "published" INTEGER NOT NULL DEFAULT 0,
  "published_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE INDEX "announcements_published" ON "announcements" ("published", "published_at" DESC);
```

#### announcement_reads

```sql
CREATE TABLE announcement_reads (
  "announcement_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("announcement_id", "account_id"),

  CONSTRAINT "announcement_reads_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements" ("id") ON DELETE CASCADE,
  CONSTRAINT "announcement_reads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);
```

#### announcement_reactions

```sql
CREATE TABLE announcement_reactions (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "announcement_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,                              -- Emoji name
  "custom_emoji_id" INTEGER,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "announcement_reactions_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements" ("id") ON DELETE CASCADE,
  CONSTRAINT "announcement_reactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "announcement_reactions_unique" ON "announcement_reactions" ("announcement_id", "account_id", "name");
```

---

### Custom Emoji Tables

#### custom_emojis

```sql
CREATE TABLE custom_emojis (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "shortcode" TEXT NOT NULL,
  "domain" TEXT,                                     -- NULL for local emojis
  "url" TEXT NOT NULL,
  "static_url" TEXT NOT NULL,
  "visible_in_picker" INTEGER NOT NULL DEFAULT 1,
  "category" TEXT,
  "disabled" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE UNIQUE INDEX "custom_emojis_shortcode_domain" ON "custom_emojis" ("shortcode", "domain");
CREATE INDEX "custom_emojis_domain" ON "custom_emojis" ("domain");
```

---

### Scheduled Status Tables

#### scheduled_statuses

```sql
CREATE TABLE scheduled_statuses (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "scheduled_at" DATETIME NOT NULL,
  "params" TEXT NOT NULL,                            -- JSON: status params
  "media_attachment_ids" TEXT NOT NULL DEFAULT '[]', -- JSON array
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "scheduled_statuses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);

CREATE INDEX "scheduled_statuses_account_id" ON "scheduled_statuses" ("account_id");
CREATE INDEX "scheduled_statuses_scheduled_at" ON "scheduled_statuses" ("scheduled_at");
```

---

### Marker Tables

#### markers

Timeline position markers.

```sql
CREATE TABLE markers (
  "account_id" TEXT NOT NULL,
  "timeline" TEXT NOT NULL,                          -- home, notifications
  "last_read_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,              -- Optimistic locking
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  PRIMARY KEY ("account_id", "timeline"),

  CONSTRAINT "markers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);
```

---

### Preferences Tables

#### user_preferences

Replaces actor_preferences with expanded fields.

```sql
CREATE TABLE user_preferences (
  "account_id" TEXT NOT NULL PRIMARY KEY,

  -- Posting
  "posting_default_visibility" TEXT NOT NULL DEFAULT 'public',
  "posting_default_sensitive" INTEGER NOT NULL DEFAULT 0,
  "posting_default_language" TEXT,

  -- Reading
  "reading_expand_media" TEXT NOT NULL DEFAULT 'default', -- default, show_all, hide_all
  "reading_expand_spoilers" INTEGER NOT NULL DEFAULT 0,
  "reading_auto_unfold_cws" INTEGER NOT NULL DEFAULT 0,

  -- Notification
  "notification_emails_follow" INTEGER NOT NULL DEFAULT 1,
  "notification_emails_reblog" INTEGER NOT NULL DEFAULT 0,
  "notification_emails_favourite" INTEGER NOT NULL DEFAULT 0,
  "notification_emails_mention" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "user_preferences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE
);
```

---

### OAuth Tables

#### oauth_applications

Replaces clients table.

```sql
CREATE TABLE oauth_applications (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "redirect_uris" TEXT NOT NULL,                     -- Newline-separated URIs
  "scopes" TEXT NOT NULL DEFAULT 'read',
  "website" TEXT,
  "owner_type" TEXT,                                 -- 'User' for user-owned apps
  "owner_id" TEXT,
  "superapp" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);
```

#### oauth_access_tokens

```sql
CREATE TABLE oauth_access_tokens (
  "id" TEXT NOT NULL PRIMARY KEY,
  "application_id" TEXT,
  "resource_owner_id" TEXT,                          -- User ID
  "token" TEXT UNIQUE NOT NULL,
  "refresh_token" TEXT UNIQUE,
  "scopes" TEXT NOT NULL DEFAULT '',
  "revoked_at" DATETIME,
  "expires_in" INTEGER,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "oauth_access_tokens_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "oauth_applications" ("id") ON DELETE CASCADE,
  CONSTRAINT "oauth_access_tokens_resource_owner_id_fkey" FOREIGN KEY ("resource_owner_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE INDEX "oauth_access_tokens_token" ON "oauth_access_tokens" ("token");
CREATE INDEX "oauth_access_tokens_resource_owner_id" ON "oauth_access_tokens" ("resource_owner_id");
CREATE INDEX "oauth_access_tokens_refresh_token" ON "oauth_access_tokens" ("refresh_token") WHERE "refresh_token" IS NOT NULL;
```

---

### Web Push Tables

#### web_push_subscriptions

Replaces subscriptions table.

```sql
CREATE TABLE web_push_subscriptions (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "account_id" TEXT NOT NULL,
  "access_token_id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "key_p256dh" TEXT NOT NULL,
  "key_auth" TEXT NOT NULL,

  -- Alert settings
  "alert_follow" INTEGER NOT NULL DEFAULT 0,
  "alert_follow_request" INTEGER NOT NULL DEFAULT 0,
  "alert_favourite" INTEGER NOT NULL DEFAULT 0,
  "alert_reblog" INTEGER NOT NULL DEFAULT 0,
  "alert_mention" INTEGER NOT NULL DEFAULT 0,
  "alert_poll" INTEGER NOT NULL DEFAULT 0,
  "alert_status" INTEGER NOT NULL DEFAULT 0,
  "alert_update" INTEGER NOT NULL DEFAULT 0,
  "alert_admin_sign_up" INTEGER NOT NULL DEFAULT 0,
  "alert_admin_report" INTEGER NOT NULL DEFAULT 0,

  "policy" TEXT NOT NULL DEFAULT 'all',              -- all, followed, follower, none

  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "web_push_subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "web_push_subscriptions_access_token_id_fkey" FOREIGN KEY ("access_token_id") REFERENCES "oauth_access_tokens" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "web_push_subscriptions_token" ON "web_push_subscriptions" ("access_token_id");
CREATE INDEX "web_push_subscriptions_account_id" ON "web_push_subscriptions" ("account_id");
```

---

### Server Configuration Tables

#### server_settings

```sql
CREATE TABLE server_settings (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);
```

#### server_rules

```sql
CREATE TABLE server_rules (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "text" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "hint" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);
```

---

### Federation Tables

#### known_instances (Replaces peers)

```sql
CREATE TABLE known_instances (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "domain" TEXT UNIQUE NOT NULL,
  "accounts_count" INTEGER NOT NULL DEFAULT 0,
  "last_successful_at" DATETIME,
  "last_failure_at" DATETIME,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "software" TEXT,                                   -- Mastodon, Pleroma, etc.
  "software_version" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "updated_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE UNIQUE INDEX "known_instances_domain" ON "known_instances" ("domain");
```

#### delivery_failures

Track failed ActivityPub deliveries for retry.

```sql
CREATE TABLE delivery_failures (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "inbox_url" TEXT NOT NULL,
  "error_code" INTEGER,
  "error_message" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE INDEX "delivery_failures_inbox_url" ON "delivery_failures" ("inbox_url");
CREATE INDEX "delivery_failures_created_at" ON "delivery_failures" ("created_at");
```

---

### ActivityPub Inbox/Outbox Tables

#### inbox_entries

Incoming ActivityPub activities.

```sql
CREATE TABLE inbox_entries (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,                        -- Recipient
  "activity" TEXT NOT NULL,                          -- Full ActivityPub activity JSON
  "processed" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
);

CREATE INDEX "inbox_entries_account_id" ON "inbox_entries" ("account_id");
CREATE INDEX "inbox_entries_pending" ON "inbox_entries" ("processed") WHERE "processed" = 0;
```

#### outbox_entries

Outgoing ActivityPub activities.

```sql
CREATE TABLE outbox_entries (
  "id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "status_id" TEXT,
  "activity_type" TEXT NOT NULL,                     -- Create, Update, Delete, Announce, Like, Follow, etc.
  "activity" TEXT NOT NULL,                          -- Full ActivityPub activity JSON
  "to" TEXT NOT NULL DEFAULT '[]',                   -- JSON array
  "cc" TEXT NOT NULL DEFAULT '[]',                   -- JSON array
  "published_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "created_at" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "outbox_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE,
  CONSTRAINT "outbox_entries_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "statuses" ("id") ON DELETE CASCADE
);

CREATE INDEX "outbox_entries_account_id" ON "outbox_entries" ("account_id", "created_at" DESC);
```

---

### Full-Text Search

#### search_index

Full-text search index.

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  "type",                                            -- account, status, tag
  "content",                                         -- Searchable text
  "account_id",                                      -- For filtering
  "target_id",                                       -- ID of indexed entity
  content="",                                        -- Contentless FTS
  tokenize="unicode61 remove_diacritics 2"
);
```

---

### Utility Tables

#### id_sequences

For generating sequential IDs.

```sql
CREATE TABLE id_sequences (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0
);
```

#### idempotency_keys

For preventing duplicate operations.

```sql
CREATE TABLE idempotency_keys (
  "key" TEXT PRIMARY KEY NOT NULL,
  "response" TEXT NOT NULL,                          -- Cached response JSON
  "expires_at" DATETIME NOT NULL
);

CREATE INDEX "idempotency_keys_expires_at" ON "idempotency_keys" ("expires_at");
```

---

## Summary

### Table Count by Category

| Category | Tables |
|----------|--------|
| Core | accounts, account_fields, users, user_roles, user_role_assignments |
| Status | statuses, status_edits |
| Media | media_attachments |
| Polls | polls, poll_options, poll_votes |
| Relationships | follows, blocks, mutes, domain_blocks, account_notes, endorsements |
| Interactions | favourites, bookmarks, status_pins, reblogs |
| Mentions & Tags | mentions, tags, status_tags, followed_tags, featured_tags |
| Notifications | notifications, notification_policies, notification_requests |
| Lists | lists, list_accounts |
| Conversations | conversations, conversation_accounts, conversation_mutes |
| Filters | filters, filter_keywords, filter_statuses |
| Reports | reports |
| Admin | admin_domain_blocks, admin_domain_allows, admin_ip_blocks, admin_email_domain_blocks, admin_canonical_email_blocks, account_warnings |
| Announcements | announcements, announcement_reads, announcement_reactions |
| Emojis | custom_emojis |
| Scheduled | scheduled_statuses |
| Markers | markers |
| Preferences | user_preferences |
| OAuth | oauth_applications, oauth_access_tokens |
| Push | web_push_subscriptions |
| Server | server_settings, server_rules |
| Federation | known_instances, delivery_failures, inbox_entries, outbox_entries |
| Search | search_index |
| Utility | id_sequences, idempotency_keys |

**Total: ~55 tables**

### Key Design Decisions

1. **Renamed tables** for Mastodon API alignment: `actors` → `accounts`, `objects` → `statuses`

2. **Normalized key fields** from JSON properties for queryability:
   - Account: locked, bot, discoverable, counts, timestamps
   - Status: visibility, language, sensitive, counts, timestamps

3. **Kept JSON properties** for ActivityPub extensibility:
   - `accounts.properties`: publicKey, endpoints, alsoKnownAs, etc.
   - `statuses.properties`: raw to/cc, attachment, tag arrays

4. **Added comprehensive indexes** for timeline queries and filtering

5. **Proper foreign keys** with appropriate cascade rules

6. **Soft deletes** for statuses (`deleted_at` column)

7. **Versioning** for optimistic locking (markers)
