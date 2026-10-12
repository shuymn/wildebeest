-- Kopje Store schema 0000 (28 tables). Applied by the Store DO; never edit after release (checksummed).
--
-- Conventions
--   IDs      : id is an 18-digit snowflake stored as TEXT (same value as the API ID); uri is the ActivityPub ID.
--              Never read ids as JS numbers. notifications and edge tables use INTEGER ids (paging cursors only).
--   Local    : accounts.domain IS NULL marks a local row. Local rows are authoritative in columns and have no raw.
--              raw (received JSON) exists only on remote copies.
--   Time     : domain timestamps are ISO 8601 UTC TEXT ('YYYY-MM-DDTHH:MM:SS.sssZ').
--              Queue-like tables (outbound_activities, deliveries, outbound_receipts, inbound_retractions,
--              inbound_spool, fedify_kv) use INTEGER epoch ms.
--   FKs      : SQLite FKs are always on (foreign_keys = OFF has no effect on D1 or DO). Never rebuild a parent table
--              (child rows would silently CASCADE away). Every child FK column is indexed.
--              Rows only local users own reference local_accounts, so locality is enforced by the FK.
--              Triggers keep local_accounts on local accounts and raw off local statuses.
--   Legacy   : legacy_id (old API ID) and legacy_ap_o (uuid of an old /ap/o/<uuid>) are filled by migration only.

-- ============================================================
-- Actors
-- ============================================================

CREATE TABLE accounts (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  uri TEXT NOT NULL UNIQUE,                       -- AP actor ID. Local: https://DOMAIN/ap/users/<handle>
  username TEXT NOT NULL,                         -- preferredUsername, case as received
  domain TEXT CHECK (domain IS NULL OR domain = lower(domain)),
  actor_type TEXT NOT NULL DEFAULT 'Person',      -- Person / Service / Group ... (open set, no CHECK)
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',                  -- sanitized HTML
  url TEXT,                                       -- remote profile URL; derived for local rows
  avatar_url TEXT,
  header_url TEXT,
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  discoverable INTEGER CHECK (discoverable IN (0, 1)),
  inbox_url TEXT,
  shared_inbox_url TEXT,
  followers_count INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0,
  statuses_count INTEGER NOT NULL DEFAULT 0,
  raw TEXT CHECK (raw IS NULL OR json_valid(raw)),
  fetched_at TEXT,                                -- last remote fetch (refetched asynchronously after 24h)
  search_text TEXT,                               -- NFKC, lowercased, whitespace-collapsed; matched with instr
  legacy_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (domain IS NOT NULL OR (raw IS NULL AND fetched_at IS NULL))
);

CREATE INDEX accounts_domain_username ON accounts (domain, lower(username));
CREATE UNIQUE INDEX accounts_local_username ON accounts (lower(username)) WHERE domain IS NULL;
-- account search: username prefix across domains
CREATE INDEX accounts_username ON accounts (lower(username));
CREATE UNIQUE INDEX accounts_legacy_id ON accounts (legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE local_accounts (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE,
  privkey BLOB NOT NULL,                          -- private key wrapped with the KEK
  privkey_salt BLOB NOT NULL,
  pubkey TEXT NOT NULL,                           -- authoritative; the actor document's publicKey derives from it
  also_known_as TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(also_known_as) AND json_type(also_known_as) = 'array'),
  default_visibility TEXT NOT NULL DEFAULT 'public' CHECK (default_visibility IN ('public', 'unlisted', 'private', 'direct')),
  default_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (default_sensitive IN (0, 1)),
  default_language TEXT,
  suspended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER local_accounts_local_insert BEFORE INSERT ON local_accounts
WHEN (SELECT domain FROM accounts WHERE id = NEW.account_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'local_accounts requires a local account');
END;

CREATE TRIGGER local_accounts_local_update BEFORE UPDATE OF account_id ON local_accounts
WHEN (SELECT domain FROM accounts WHERE id = NEW.account_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'local_accounts requires a local account');
END;

CREATE TRIGGER accounts_local_keeps_domain BEFORE UPDATE OF domain ON accounts
WHEN NEW.domain IS NOT NULL AND EXISTS (SELECT 1 FROM local_accounts WHERE account_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a local account cannot get a domain');
END;

-- ============================================================
-- Statuses (a boost is a row with reblog_of_id)
-- ============================================================

CREATE TABLE statuses (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  uri TEXT NOT NULL UNIQUE,                       -- local: https://DOMAIN/ap/o/<uuid>; remote: original ID; boost: Announce ID
  url TEXT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  reblog_of_id TEXT REFERENCES statuses (id) ON DELETE CASCADE,
  in_reply_to_uri TEXT,                           -- kept even while unresolved
  in_reply_to_id TEXT REFERENCES statuses (id) ON DELETE SET NULL,
  in_reply_to_account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,  -- conversation partner, carried through self-replies (Mastodon)
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private', 'direct', 'limited')),  -- full Mastodon set; limited is exposed as private
  spoiler_text TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',               -- sanitized HTML
  source_text TEXT,                               -- local only
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  language TEXT,
  published_at TEXT NOT NULL,
  edited_at TEXT,
  replies_count INTEGER NOT NULL DEFAULT 0,
  reblogs_count INTEGER NOT NULL DEFAULT 0,
  favourites_count INTEGER NOT NULL DEFAULT 0,
  client_key TEXT,                                -- Idempotency-Key (local only)
  raw TEXT CHECK (raw IS NULL OR json_valid(raw)),
  search_text TEXT,
  legacy_id TEXT,
  legacy_ap_o TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- when the row was received (GC age)
  CHECK (reblog_of_id IS NULL OR (reblog_of_id <> id AND in_reply_to_uri IS NULL AND content = '')),
  CHECK (in_reply_to_id IS NULL OR in_reply_to_uri IS NOT NULL)
);

CREATE INDEX statuses_account ON statuses (account_id, id);
-- feeds; queries repeat the same WHERE expression
CREATE INDEX statuses_feed ON statuses (account_id, id) WHERE visibility IN ('public', 'unlisted', 'private');
CREATE UNIQUE INDEX statuses_reblog ON statuses (reblog_of_id, account_id) WHERE reblog_of_id IS NOT NULL;
-- search: an account's originals and boosted originals by the id they return, and the newest public originals
CREATE INDEX statuses_account_originals ON statuses (account_id, id) WHERE reblog_of_id IS NULL;
CREATE INDEX statuses_account_reblogs ON statuses (account_id, reblog_of_id) WHERE reblog_of_id IS NOT NULL;
CREATE INDEX statuses_public ON statuses (id) WHERE visibility = 'public' AND reblog_of_id IS NULL;
CREATE INDEX statuses_in_reply_to ON statuses (in_reply_to_id) WHERE in_reply_to_id IS NOT NULL;
CREATE INDEX statuses_in_reply_to_account ON statuses (in_reply_to_account_id) WHERE in_reply_to_account_id IS NOT NULL;
CREATE INDEX statuses_unresolved_reply ON statuses (in_reply_to_uri) WHERE in_reply_to_id IS NULL AND in_reply_to_uri IS NOT NULL;
CREATE UNIQUE INDEX statuses_client_key ON statuses (account_id, client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX statuses_legacy_id ON statuses (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX statuses_legacy_ap_o ON statuses (legacy_ap_o) WHERE legacy_ap_o IS NOT NULL;

-- Local statuses are authoritative in columns and never hold raw. A missing account leaves the check to the FK.
CREATE TRIGGER statuses_local_no_raw_insert BEFORE INSERT ON statuses
WHEN NEW.raw IS NOT NULL AND (SELECT domain IS NULL FROM accounts WHERE id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'local statuses cannot hold raw');
END;

CREATE TRIGGER statuses_local_no_raw_update BEFORE UPDATE OF raw, account_id ON statuses
WHEN NEW.raw IS NOT NULL AND (SELECT domain IS NULL FROM accounts WHERE id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'local statuses cannot hold raw');
END;

CREATE TRIGGER accounts_local_no_status_raw BEFORE UPDATE OF domain ON accounts
WHEN NEW.domain IS NULL AND EXISTS (SELECT 1 FROM statuses WHERE account_id = NEW.id AND raw IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'local statuses cannot hold raw');
END;

CREATE TABLE status_edits (
  id INTEGER PRIMARY KEY,
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  spoiler_text TEXT NOT NULL DEFAULT '',
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  media_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX status_edits_status ON status_edits (status_id, id);

CREATE TABLE media_attachments (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status_id TEXT REFERENCES statuses (id) ON DELETE CASCADE,  -- NULL: uploaded, not attached yet
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('image', 'gifv', 'video', 'audio', 'unknown')),
  url TEXT NOT NULL,                              -- '' while a local upload is processing
  preview_url TEXT,                               -- NULL: url
  description TEXT NOT NULL DEFAULT '',
  -- Local uploads (B4). The original is in R2 at originals/<id>; the re-encoded files that are served are at
  -- files/<file_token>/{full,small}, so the token in the URL is the capability (MEDIA-2). Remote rows keep NULLs.
  file_token TEXT UNIQUE,
  content_type TEXT,                              -- type of the served files
  meta TEXT CHECK (meta IS NULL OR json_valid(meta)),  -- {"original":{"width","height"},"small":{...}}
  focus_x REAL NOT NULL DEFAULT 0 CHECK (focus_x BETWEEN -1 AND 1),
  focus_y REAL NOT NULL DEFAULT 0 CHECK (focus_y BETWEEN -1 AND 1),
  processed INTEGER NOT NULL DEFAULT 1 CHECK (processed IN (0, 1)),  -- 0 while the uploading request may still write to R2
  gc_at TEXT,                                     -- unattached local upload: deleted (with its R2 objects) from then on
  legacy_ap_o TEXT,                               -- uuid of the old local Image /ap/o/<uuid>
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (status_id IS NULL OR processed = 1)
);

CREATE INDEX media_attachments_status ON media_attachments (status_id, position) WHERE status_id IS NOT NULL;
CREATE INDEX media_attachments_account ON media_attachments (account_id);
CREATE INDEX media_attachments_gc ON media_attachments (gc_at) WHERE status_id IS NULL AND gc_at IS NOT NULL;

-- Tombstones of uploads that never completed (abandoned, expired, or refused at the deadline). The sweep deletes
-- such a row after deleting its R2 objects and records it here, so a write that lands later is deleted when the
-- tombstone falls due. Media reconciliation deletes only what is recorded here, never objects merely missing a row.
-- Not part of a dump (dump-catalog.ts): a restored or imported Store starts with none.
CREATE TABLE media_orphans (
  file_token TEXT NOT NULL PRIMARY KEY,
  media_id TEXT NOT NULL,
  delete_after TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX media_orphans_due ON media_orphans (delete_after);

-- The scheduled backup's media index (jobs/backup.ts): one row per R2 original that a backup's dump references, and
-- where its encrypted copy is. `destination` fingerprints the bucket that holds the copy and the recipients it is
-- encrypted to; a copy made under another fingerprint counts as missing. Rows no successful backup needs are pruned, so the table is bounded by the number of originals.
-- Not part of a dump (dump-catalog.ts): it describes one backup bucket, not instance data.
CREATE TABLE backup_media (
  source TEXT NOT NULL PRIMARY KEY,               -- originals/<media id>
  required_run TEXT NOT NULL,                     -- the last backup run whose dump references it
  state TEXT NOT NULL CHECK (state IN ('pending', 'copied', 'absent')),  -- absent: not in R2
  destination TEXT,
  key TEXT,
  size INTEGER,
  sha256 TEXT,
  plain_size INTEGER,
  plain_sha256 TEXT,
  copied_run TEXT,
  CHECK ((state = 'copied') = (key IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX backup_media_run ON backup_media (required_run, state, source);
CREATE UNIQUE INDEX media_attachments_legacy_ap_o ON media_attachments (legacy_ap_o) WHERE legacy_ap_o IS NOT NULL;

CREATE TABLE status_mentions (
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  silent INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1)),  -- addressed but not tagged: used for visibility, hidden from API and notifications
  PRIMARY KEY (status_id, account_id)
) WITHOUT ROWID;

CREATE INDEX status_mentions_account ON status_mentions (account_id, status_id);

CREATE TABLE status_tags (
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  name TEXT NOT NULL,                             -- normalized (NFKC, lowercase)
  PRIMARY KEY (status_id, name)
) WITHOUT ROWID;

CREATE INDEX status_tags_name ON status_tags (name, status_id);

-- ============================================================
-- Edges (federated ones keep the sent/received activity ID in uri). Ids are paging cursors
-- that clients hold, so they are AUTOINCREMENT and never reused.
-- ============================================================

CREATE TABLE follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
  uri TEXT,                                       -- Follow activity ID (may be NULL in migrated data)
  show_reblogs INTEGER NOT NULL DEFAULT 1 CHECK (show_reblogs IN (0, 1)),
  notify INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1)),
  languages TEXT CHECK (languages IS NULL OR json_valid(languages)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (account_id <> target_account_id)
);

CREATE UNIQUE INDEX follows_pair ON follows (account_id, target_account_id);
CREATE INDEX follows_target ON follows (target_account_id, state);
-- following-only account search reads accepted follows without touching pending ones
CREATE INDEX follows_accepted ON follows (account_id, target_account_id) WHERE state = 'accepted';

CREATE TABLE favourites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  uri TEXT,                                       -- Like activity ID
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX favourites_pair ON favourites (status_id, account_id);
CREATE INDEX favourites_account ON favourites (account_id, id);
CREATE INDEX favourites_account_status ON favourites (account_id, status_id);  -- search, by status id

CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX bookmarks_pair ON bookmarks (status_id, account_id);
CREATE INDEX bookmarks_account ON bookmarks (account_id, id);
CREATE INDEX bookmarks_account_status ON bookmarks (account_id, status_id);  -- search, by status id

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  uri TEXT,                                       -- Block activity ID
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (account_id <> target_account_id)
);

CREATE UNIQUE INDEX blocks_pair ON blocks (account_id, target_account_id);
CREATE INDEX blocks_target ON blocks (target_account_id, account_id);

CREATE TABLE mutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  hide_notifications INTEGER NOT NULL DEFAULT 1 CHECK (hide_notifications IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (account_id <> target_account_id)
);

CREATE UNIQUE INDEX mutes_pair ON mutes (account_id, target_account_id);
CREATE INDEX mutes_target ON mutes (target_account_id);

CREATE TABLE domain_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain = lower(domain)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX domain_blocks_pair ON domain_blocks (account_id, domain);

CREATE TABLE lists (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  replies_policy TEXT NOT NULL DEFAULT 'list' CHECK (replies_policy IN ('followed', 'list', 'none')),
  exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX lists_account ON lists (account_id);

CREATE TABLE list_accounts (
  list_id TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, account_id)
) WITHOUT ROWID;

CREATE INDEX list_accounts_account ON list_accounts (account_id, list_id);

-- ============================================================
-- Notifications
-- ============================================================

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,           -- keeps migrated ids; clients hold them
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,  -- recipient
  type TEXT NOT NULL,                             -- open set, no CHECK
  from_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status_id TEXT REFERENCES statuses (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- natural key: write with INSERT ... ON CONFLICT DO NOTHING RETURNING id; push only when a row is returned
CREATE UNIQUE INDEX notifications_natural ON notifications (account_id, type, from_account_id, IFNULL(status_id, ''));
CREATE INDEX notifications_account ON notifications (account_id, id);
CREATE INDEX notifications_from ON notifications (from_account_id);
CREATE INDEX notifications_status ON notifications (status_id) WHERE status_id IS NOT NULL;

-- ============================================================
-- Delivery and inbound
-- ============================================================

-- Pending outbound activities. Deleted in the same transaction as their last deliveries row once fully expanded.
-- object_uri is the local object the activity is about (the status of a Create, Update or Delete; the id of a Like,
-- Announce or Follow; the Follow an Accept or Reject answers). retracts marks a Delete, Undo or Reject of it;
-- superseded marks an activity a later one about the same object follows, which the operator may not send again.
-- pending_targets holds the inboxes still to expand (JSON), expanded in id order a step at a time.
CREATE TABLE outbound_activities (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,  -- signer
  body TEXT NOT NULL CHECK (json_valid(body)),
  object_uri TEXT,
  retracts INTEGER NOT NULL DEFAULT 0 CHECK (retracts IN (0, 1)),
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  pending_targets TEXT CHECK (pending_targets IS NULL OR (json_valid(pending_targets) AND json_type(pending_targets) = 'array')),
  created_at INTEGER NOT NULL
);

CREATE INDEX outbound_activities_object ON outbound_activities (account_id, object_uri);
CREATE INDEX outbound_activities_expanding ON outbound_activities (id) WHERE pending_targets IS NOT NULL;

-- Per-inbox delivery state. A lane is (account_id, lane), lane being the inbox's origin, and is delivered in id order,
-- so everything one actor sends one server (shared and personal inboxes alike) arrives in order. Only a lane's oldest
-- active row is pending or leased; the rows behind it are queued and promoted when it settles, so the due index holds
-- lane heads only. For leased rows next_attempt_at doubles as the lease deadline. addressee, when set, is the one
-- silent recipient a personal copy is addressed to. A delivered row is deleted (its inbox goes to outbound_receipts);
-- a gave_up row stays for the operator until retried or swept.
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,           -- never reused, so a late completion cannot hit another row
  activity_id INTEGER NOT NULL REFERENCES outbound_activities (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,                       -- lane key (sender)
  inbox_url TEXT NOT NULL,
  lane TEXT NOT NULL,                             -- lane key: the origin of inbox_url
  addressee TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('queued', 'pending', 'leased', 'gave_up')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  last_status INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'leased') = (lease_token IS NOT NULL))
);

CREATE INDEX deliveries_lane ON deliveries (account_id, lane, id) WHERE state IN ('queued', 'pending', 'leased');
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE state IN ('pending', 'leased');
CREATE INDEX deliveries_activity ON deliveries (activity_id);
CREATE INDEX deliveries_gave_up ON deliveries (updated_at) WHERE state = 'gave_up';

-- Inboxes that accepted an activity about a local status (its Create or Update, or the Announce that is a boost): a
-- later Delete or Undo also goes to them, even if they left the audience since. Owned by the status, so they go with
-- it (a boost cascading away with its original included: receivers drop boosts with the original's Delete), and
-- never written for a status that no longer exists.
CREATE TABLE outbound_receipts (
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  inbox_url TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (status_id, inbox_url)
) WITHOUT ROWID;

CREATE INDEX outbound_receipts_account ON outbound_receipts (account_id);

-- Retraction records: Undo/Delete targets kept per (actor, ID) for 30 days.
CREATE TABLE inbound_retractions (
  actor_uri TEXT NOT NULL,
  target_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (actor_uri, target_uri)
) WITHOUT ROWID;

CREATE INDEX inbound_retractions_expires ON inbound_retractions (expires_at);

-- Public keys listed by stored remote actor documents, by key id (B1b). Only a key whose own owner is the listing
-- actor is kept, so a key id maps to exactly the account that owns it, whatever the shape of its URL.
CREATE TABLE remote_keys (
  key_id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  pem TEXT NOT NULL,
  fetched_at INTEGER NOT NULL                     -- when the listing document was fetched; trusted for 24h
) WITHOUT ROWID;

CREATE INDEX remote_keys_account ON remote_keys (account_id);

-- Inbound work done in bounded batches and resumed by the Queue or cron (B1b):
--   purge  key = the deleted actor's URI. The row is also the actor's tombstone: while it exists, the actor is not
--          stored again. It expires 30 days after the purge is done, independently of inbound_retractions.
--   move   key = the Move activity's id. bound is the highest follows.id that existed when the Move arrived, so a
--          replay never moves a follow made after it; cursor is the last follows.id moved.
CREATE TABLE inbound_jobs (
  kind TEXT NOT NULL CHECK (kind IN ('purge', 'move')),
  key TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  target_account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  bound TEXT,
  cursor TEXT,
  done_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key),
  CHECK (kind <> 'move' OR (target_account_id IS NOT NULL AND bound IS NOT NULL)),
  CHECK ((done_at IS NULL) = (expires_at IS NULL))
) WITHOUT ROWID;

CREATE INDEX inbound_jobs_pending ON inbound_jobs (created_at) WHERE done_at IS NULL;
CREATE INDEX inbound_jobs_expires ON inbound_jobs (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX inbound_jobs_target ON inbound_jobs (target_account_id) WHERE target_account_id IS NOT NULL;

-- Parts of inbox requests spooled during maintenance that did not fit one Queue message.
-- Assembled on replay once all parts are present and deleted with the replay result; incomplete
-- sets older than the Queue retention are purged by scheduled. A rowid table because fragments are large.
CREATE TABLE inbound_spool (
  spool_id TEXT NOT NULL,
  part INTEGER NOT NULL CHECK (part >= 0),
  part_count INTEGER NOT NULL CHECK (part_count > 0 AND part < part_count),
  fragment BLOB NOT NULL,                         -- deflated bytes
  spooled_at INTEGER NOT NULL,
  PRIMARY KEY (spool_id, part)
);

CREATE INDEX inbound_spool_spooled_at ON inbound_spool (spooled_at);

-- Fedify KvStore (key cache, remote documents, activity idempotency).
CREATE TABLE fedify_kv (
  key TEXT NOT NULL PRIMARY KEY CHECK (json_valid(key) AND json_type(key) = 'array'),
  value TEXT NOT NULL CHECK (json_valid(value)),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > 0)
) WITHOUT ROWID;

CREATE INDEX fedify_kv_expires_at ON fedify_kv (expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================
-- Clients and settings
-- ============================================================

CREATE TABLE oauth_clients (
  id TEXT NOT NULL PRIMARY KEY,                   -- client_id
  secret TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  website TEXT,
  scopes TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Authorization codes (kind = 'code', 10 minutes, single use via DELETE ... RETURNING) and access tokens.
-- Only sha256 of the opaque value is stored. An access row with NULL account_id is an app token.
CREATE TABLE oauth_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('code', 'access')),
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  account_id TEXT REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  redirect_uri TEXT,
  code_challenge TEXT,                            -- optional PKCE, S256 only
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (kind = 'access' OR (account_id IS NOT NULL AND redirect_uri IS NOT NULL AND expires_at IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX oauth_tokens_account ON oauth_tokens (account_id);
CREATE INDEX oauth_tokens_client ON oauth_tokens (client_id);

-- Web Push subscriptions, one per access token (removed with revoke and suspension).
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE REFERENCES oauth_tokens (token_hash) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  key_p256dh TEXT NOT NULL,
  key_auth TEXT NOT NULL,
  alerts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(alerts)),
  policy TEXT NOT NULL DEFAULT 'all' CHECK (policy IN ('all', 'followed', 'follower', 'none')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The only settings store; env only supplies defaults. Server rules live at name = 'rules' as a JSON array.
CREATE TABLE instance_settings (
  name TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
