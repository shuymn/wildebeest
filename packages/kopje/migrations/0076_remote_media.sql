-- Kopje Store schema 0076: the cache of remote media (src/domain/remote-media.ts; MEDIA-7). Never edit after release
-- (checksummed).
--
--   remote_media                  one slot per remote file per owner: an account's avatar or header, a remote
--                                 attachment or its thumbnail (owner_id and account_id set), or an emoji by the
--                                 domain that named its url (owner_id and account_id NULL). A slot is pending (due_at
--                                 set: its claim, attempts and generation), failed (failed_at), or stored (token, ext,
--                                 still_ext and stored_at: the object it shows).
--   remote_media_owner            UNIQUE over (owner_id, kind): a presenter's one seek per slot.
--   remote_media_emoji            UNIQUE over an emoji's (domain, url).
--   remote_media_due              the pending slots by (lane, due_at, id): the claim's walk.
--   remote_media_expiry           the pending slots by enqueued_at: their expiry.
--   remote_media_account          the slots of an account: the purge, suspension and presenters.
--   remote_media_objects          the R2 ledger: one row per token under remote/<token>/, recorded before any key
--                                 exists: reserved (its claim's), stored, or doomed (its deletion due), with the bytes
--                                 it is charged, its types and the hosts of its fetch.
--   remote_media_objects_slot     UNIQUE over the slot of a live object: at most one a slot.
--   remote_media_objects_due      the doomed objects by due_at: deletion.
--   remote_media_objects_reserved the reserved objects by claimed_at: reservation expiry.
--   remote_media_objects_stored   the stored objects by (kind, stored_at): reclamation's order.
--   remote_media_objects_validation
--                                 the stored objects by token: a restore's validation walk.
--   remote_media_usage            one row: the bytes charged, the doomed bytes and the pending slots.
--   *_bounds_insert, *_update     BEFORE INSERT and BEFORE UPDATE of every column on each table: RAISE(ABORT, '<table>:
--                                 a value past its stored bound') for a value past its bound or a row breaking its
--                                 invariants. No trigger writes.
--
-- Bounds and the predicates: src/platform/stored-bounds.ts (remoteMediaSlotPastBoundSql,
-- remoteMediaObjectPastBoundSql, remoteMediaUsagePastBoundSql); the statements below are the output of
-- remoteMediaMigrationSql (test/migrations.test.ts compares them). The tables are not dumped (docs/dump-format.md).
--
-- Cost: three empty tables, their indexes and triggers, and one row; no existing table is read or changed. The file
-- creates tables, so it is not declared foreignKeys: 'unchanged' and the whole Store's foreign keys are verified.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000
-- statuses with their mentions and tags and 200,000 boosts, 2,000,000 notifications, 200,000 quotes, 10,000 reports,
-- 20 local accounts, 200,000 attached cards and 10,000 pending ones) in workerd's local Durable Object SQLite, with the
-- whole Store's foreign keys verified: 6,237 ms for the upgrade of this file through the kernel, within the budget, at
-- a load average of 25 to 31.

CREATE TABLE remote_media (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_id TEXT,
  account_id TEXT,
  domain TEXT,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  category TEXT NOT NULL,
  lane INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  due_at INTEGER,
  enqueued_at INTEGER NOT NULL,
  claim INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  token TEXT,
  ext TEXT,
  still_ext TEXT,
  stored_at INTEGER,
  failed_at INTEGER,
  seen_at INTEGER
);

CREATE UNIQUE INDEX remote_media_owner ON remote_media (owner_id, kind) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX remote_media_emoji ON remote_media (domain, url) WHERE kind = 'emoji';
CREATE INDEX remote_media_due ON remote_media (lane, due_at, id) WHERE due_at IS NOT NULL;
CREATE INDEX remote_media_expiry ON remote_media (enqueued_at) WHERE due_at IS NOT NULL;
CREATE INDEX remote_media_account ON remote_media (account_id) WHERE account_id IS NOT NULL;

CREATE TRIGGER remote_media_bounds_insert BEFORE INSERT ON remote_media
WHEN CASE WHEN typeof(NEW.kind) <> 'text' OR NEW.kind NOT IN ('avatar', 'header', 'attachment', 'thumbnail', 'emoji') THEN 1
	WHEN NEW.owner_id IS NOT NULL AND CASE WHEN typeof(NEW.owner_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.owner_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.owner_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.owner_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.account_id IS NOT NULL AND CASE WHEN typeof(NEW.account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.account_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.domain IS NOT NULL AND CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.host) <> 'text' THEN 1
	WHEN length(CAST(NEW.host AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.host AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.host GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.host NOT GLOB '?*.?*' OR NEW.host GLOB '.*' OR NEW.host GLOB '*.' OR NEW.host GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.category) <> 'text' OR NEW.category NOT IN ('image', 'video', 'audio') THEN 1
	WHEN typeof(NEW.lane) <> 'integer' OR NEW.lane NOT BETWEEN 0 AND 1 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 4 THEN 1
	WHEN CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.ext IS NULL THEN 0
	WHEN typeof(NEW.ext) <> 'text' THEN 1
	WHEN NEW.ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_ext IS NULL THEN 0
	WHEN typeof(NEW.still_ext) <> 'text' THEN 1
	WHEN NEW.still_ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.failed_at IS NOT NULL AND (typeof(NEW.failed_at) <> 'integer' OR NEW.failed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.seen_at IS NOT NULL AND (typeof(NEW.seen_at) <> 'integer' OR NEW.seen_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN (NEW.owner_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.account_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.domain IS NULL) = (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.token IS NULL) <> (NEW.ext IS NULL) OR (NEW.token IS NULL) <> (NEW.stored_at IS NULL) THEN 1
	WHEN NEW.token IS NOT NULL AND (NEW.due_at IS NOT NULL OR NEW.failed_at IS NOT NULL) THEN 1
	WHEN NEW.still_ext IS NOT NULL AND NEW.token IS NULL THEN 1
	WHEN NEW.failed_at IS NOT NULL AND NEW.due_at IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media: a value past its stored bound');
END;

CREATE TRIGGER remote_media_bounds_update BEFORE UPDATE OF id, kind, owner_id, account_id, domain, url, host, category, lane, generation, due_at, enqueued_at, claim, attempts, token, ext, still_ext, stored_at, failed_at, seen_at ON remote_media
WHEN CASE WHEN typeof(NEW.kind) <> 'text' OR NEW.kind NOT IN ('avatar', 'header', 'attachment', 'thumbnail', 'emoji') THEN 1
	WHEN NEW.owner_id IS NOT NULL AND CASE WHEN typeof(NEW.owner_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.owner_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.owner_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.owner_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.account_id IS NOT NULL AND CASE WHEN typeof(NEW.account_id) <> 'text' THEN 1
	WHEN length(CAST(NEW.account_id AS BLOB)) <> 18 THEN 1
	WHEN instr(CAST(NEW.account_id AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.account_id GLOB '*[^0-9]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.domain IS NOT NULL AND CASE WHEN typeof(NEW.domain) <> 'text' THEN 1
	WHEN length(CAST(NEW.domain AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.domain AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.domain GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.domain NOT GLOB '?*.?*' OR NEW.domain GLOB '.*' OR NEW.domain GLOB '*.' OR NEW.domain GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.url) <> 'text' THEN 1
	WHEN length(CAST(NEW.url AS BLOB)) > 2048 THEN 1
	WHEN instr(CAST(NEW.url AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.url NOT GLOB 'https://?*' THEN 1
	WHEN NEW.url GLOB '*[^!-~]*' THEN 1
	WHEN NEW.url GLOB '*["<>\^`{|}]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN typeof(NEW.host) <> 'text' THEN 1
	WHEN length(CAST(NEW.host AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(NEW.host AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.host GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN NEW.host NOT GLOB '?*.?*' OR NEW.host GLOB '.*' OR NEW.host GLOB '*.' OR NEW.host GLOB '*..*' THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.category) <> 'text' OR NEW.category NOT IN ('image', 'video', 'audio') THEN 1
	WHEN typeof(NEW.lane) <> 'integer' OR NEW.lane NOT BETWEEN 0 AND 1 THEN 1
	WHEN typeof(NEW.generation) <> 'integer' OR NEW.generation NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.enqueued_at) <> 'integer' OR NEW.enqueued_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.claim) <> 'integer' OR NEW.claim NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.attempts) <> 'integer' OR NEW.attempts NOT BETWEEN 0 AND 4 THEN 1
	WHEN CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.ext IS NULL THEN 0
	WHEN typeof(NEW.ext) <> 'text' THEN 1
	WHEN NEW.ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_ext IS NULL THEN 0
	WHEN typeof(NEW.still_ext) <> 'text' THEN 1
	WHEN NEW.still_ext NOT IN ('jpg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm', 'm4a', 'mp3', 'flac', 'wav') THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.failed_at IS NOT NULL AND (typeof(NEW.failed_at) <> 'integer' OR NEW.failed_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.seen_at IS NOT NULL AND (typeof(NEW.seen_at) <> 'integer' OR NEW.seen_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN (NEW.owner_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.account_id IS NULL) <> (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.domain IS NULL) = (NEW.kind = 'emoji') THEN 1
	WHEN (NEW.token IS NULL) <> (NEW.ext IS NULL) OR (NEW.token IS NULL) <> (NEW.stored_at IS NULL) THEN 1
	WHEN NEW.token IS NOT NULL AND (NEW.due_at IS NOT NULL OR NEW.failed_at IS NOT NULL) THEN 1
	WHEN NEW.still_ext IS NOT NULL AND NEW.token IS NULL THEN 1
	WHEN NEW.failed_at IS NOT NULL AND NEW.due_at IS NOT NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media: a value past its stored bound');
END;

CREATE TABLE remote_media_objects (
  token TEXT NOT NULL PRIMARY KEY,
  slot_id INTEGER,
  state TEXT NOT NULL,
  charge INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT,
  still_type TEXT,
  hosts TEXT,
  claimed_at INTEGER NOT NULL,
  stored_at INTEGER,
  due_at INTEGER,
  delete_attempts INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE UNIQUE INDEX remote_media_objects_slot ON remote_media_objects (slot_id) WHERE slot_id IS NOT NULL;
CREATE INDEX remote_media_objects_due ON remote_media_objects (due_at) WHERE state = 'doomed';
CREATE INDEX remote_media_objects_reserved ON remote_media_objects (claimed_at) WHERE state = 'reserved';
CREATE INDEX remote_media_objects_stored ON remote_media_objects (kind, stored_at) WHERE state = 'stored';
CREATE INDEX remote_media_objects_validation ON remote_media_objects (token) WHERE state = 'stored';

CREATE TRIGGER remote_media_objects_bounds_insert BEFORE INSERT ON remote_media_objects
WHEN CASE WHEN NEW.token IS NULL OR CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.slot_id IS NOT NULL AND (typeof(NEW.slot_id) <> 'integer' OR NEW.slot_id NOT BETWEEN 1 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.state) <> 'text' OR NEW.state NOT IN ('reserved', 'stored', 'doomed') THEN 1
	WHEN typeof(NEW.charge) <> 'integer' OR NEW.charge NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.kind) <> 'text' OR NEW.kind NOT IN ('avatar', 'header', 'attachment', 'thumbnail', 'emoji') THEN 1
	WHEN CASE WHEN NEW.content_type IS NULL THEN 0
	WHEN typeof(NEW.content_type) <> 'text' THEN 1
	WHEN NEW.content_type NOT IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/flac', 'audio/wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_type IS NULL THEN 0
	WHEN typeof(NEW.still_type) <> 'text' THEN 1
	WHEN NEW.still_type NOT IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/flac', 'audio/wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.hosts IS NULL THEN 0
	WHEN typeof(NEW.hosts) <> 'text' THEN 1
	WHEN length(CAST(NEW.hosts AS BLOB)) > 1026 THEN 1
	WHEN instr(CAST(NEW.hosts AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.hosts) OR json_type(NEW.hosts) <> 'array' THEN 1
	WHEN json_array_length(NEW.hosts) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.hosts) h WHERE h.type <> 'text' OR CASE WHEN typeof(h.value) <> 'text' THEN 1
	WHEN length(CAST(h.value AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(h.value AS BLOB), x'00') > 0 THEN 1
	WHEN h.value GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN h.value NOT GLOB '?*.?*' OR h.value GLOB '.*' OR h.value GLOB '*.' OR h.value GLOB '*..*' THEN 1
	ELSE 0 END) THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.claimed_at) <> 'integer' OR NEW.claimed_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.delete_attempts) <> 'integer' OR NEW.delete_attempts NOT BETWEEN 0 AND 64 THEN 1
	WHEN (NEW.state = 'doomed') <> (NEW.due_at IS NOT NULL) THEN 1
	WHEN (NEW.state = 'doomed') = (NEW.slot_id IS NOT NULL) THEN 1
	WHEN NEW.state = 'stored' AND (NEW.content_type IS NULL OR NEW.stored_at IS NULL) THEN 1
	WHEN NEW.state = 'reserved' AND (NEW.content_type IS NOT NULL OR NEW.stored_at IS NOT NULL) THEN 1
	WHEN NEW.still_type IS NOT NULL AND NEW.content_type IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media_objects: a value past its stored bound');
END;

CREATE TRIGGER remote_media_objects_bounds_update BEFORE UPDATE OF token, slot_id, state, charge, kind, content_type, still_type, hosts, claimed_at, stored_at, due_at, delete_attempts ON remote_media_objects
WHEN CASE WHEN NEW.token IS NULL OR CASE WHEN NEW.token IS NULL THEN 0
	WHEN typeof(NEW.token) <> 'text' THEN 1
	WHEN length(CAST(NEW.token AS BLOB)) NOT BETWEEN 32 AND 64 THEN 1
	WHEN instr(CAST(NEW.token AS BLOB), x'00') > 0 THEN 1
	WHEN NEW.token GLOB '*[^A-Za-z0-9_-]*' THEN 1
	ELSE 0 END THEN 1
	WHEN NEW.slot_id IS NOT NULL AND (typeof(NEW.slot_id) <> 'integer' OR NEW.slot_id NOT BETWEEN 1 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.state) <> 'text' OR NEW.state NOT IN ('reserved', 'stored', 'doomed') THEN 1
	WHEN typeof(NEW.charge) <> 'integer' OR NEW.charge NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.kind) <> 'text' OR NEW.kind NOT IN ('avatar', 'header', 'attachment', 'thumbnail', 'emoji') THEN 1
	WHEN CASE WHEN NEW.content_type IS NULL THEN 0
	WHEN typeof(NEW.content_type) <> 'text' THEN 1
	WHEN NEW.content_type NOT IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/flac', 'audio/wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.still_type IS NULL THEN 0
	WHEN typeof(NEW.still_type) <> 'text' THEN 1
	WHEN NEW.still_type NOT IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/flac', 'audio/wav') THEN 1
	ELSE 0 END THEN 1
	WHEN CASE WHEN NEW.hosts IS NULL THEN 0
	WHEN typeof(NEW.hosts) <> 'text' THEN 1
	WHEN length(CAST(NEW.hosts AS BLOB)) > 1026 THEN 1
	WHEN instr(CAST(NEW.hosts AS BLOB), x'00') > 0 THEN 1
	WHEN NOT json_valid(NEW.hosts) OR json_type(NEW.hosts) <> 'array' THEN 1
	WHEN json_array_length(NEW.hosts) NOT BETWEEN 1 AND 4 THEN 1
	WHEN EXISTS (SELECT 1 FROM json_each(NEW.hosts) h WHERE h.type <> 'text' OR CASE WHEN typeof(h.value) <> 'text' THEN 1
	WHEN length(CAST(h.value AS BLOB)) NOT BETWEEN 3 AND 253 THEN 1
	WHEN instr(CAST(h.value AS BLOB), x'00') > 0 THEN 1
	WHEN h.value GLOB '*[^a-z0-9.-]*' THEN 1
	WHEN h.value NOT GLOB '?*.?*' OR h.value GLOB '.*' OR h.value GLOB '*.' OR h.value GLOB '*..*' THEN 1
	ELSE 0 END) THEN 1
	ELSE 0 END THEN 1
	WHEN typeof(NEW.claimed_at) <> 'integer' OR NEW.claimed_at NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.stored_at IS NOT NULL AND (typeof(NEW.stored_at) <> 'integer' OR NEW.stored_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN NEW.due_at IS NOT NULL AND (typeof(NEW.due_at) <> 'integer' OR NEW.due_at NOT BETWEEN 0 AND 9007199254740991) THEN 1
	WHEN typeof(NEW.delete_attempts) <> 'integer' OR NEW.delete_attempts NOT BETWEEN 0 AND 64 THEN 1
	WHEN (NEW.state = 'doomed') <> (NEW.due_at IS NOT NULL) THEN 1
	WHEN (NEW.state = 'doomed') = (NEW.slot_id IS NOT NULL) THEN 1
	WHEN NEW.state = 'stored' AND (NEW.content_type IS NULL OR NEW.stored_at IS NULL) THEN 1
	WHEN NEW.state = 'reserved' AND (NEW.content_type IS NOT NULL OR NEW.stored_at IS NOT NULL) THEN 1
	WHEN NEW.still_type IS NOT NULL AND NEW.content_type IS NULL THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media_objects: a value past its stored bound');
END;

CREATE TABLE remote_media_usage (
  id INTEGER PRIMARY KEY,
  bytes INTEGER NOT NULL,
  doomed INTEGER NOT NULL,
  pending INTEGER NOT NULL
);

CREATE TRIGGER remote_media_usage_bounds_insert BEFORE INSERT ON remote_media_usage
WHEN CASE WHEN typeof(NEW.id) <> 'integer' OR NEW.id <> 1 THEN 1
	WHEN typeof(NEW.bytes) <> 'integer' OR NEW.bytes NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.doomed) <> 'integer' OR NEW.doomed NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.pending) <> 'integer' OR NEW.pending NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.doomed > NEW.bytes THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media_usage: a value past its stored bound');
END;

CREATE TRIGGER remote_media_usage_bounds_update BEFORE UPDATE OF id, bytes, doomed, pending ON remote_media_usage
WHEN CASE WHEN typeof(NEW.id) <> 'integer' OR NEW.id <> 1 THEN 1
	WHEN typeof(NEW.bytes) <> 'integer' OR NEW.bytes NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.doomed) <> 'integer' OR NEW.doomed NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN typeof(NEW.pending) <> 'integer' OR NEW.pending NOT BETWEEN 0 AND 9007199254740991 THEN 1
	WHEN NEW.doomed > NEW.bytes THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'remote_media_usage: a value past its stored bound');
END;

INSERT INTO remote_media_usage (id, bytes, doomed, pending) VALUES (1, 0, 0, 0);
