-- Kopje Store schema 0046: instance domain blocks. Never edit after release (checksummed).
--
-- The instance's own domain policy (R38, VIS-30; Mastodon's DomainBlock), one row per domain, written by the Store
-- operations of src/domain/instance-domain-blocks.ts:
--
--   id                 AUTOINCREMENT: clients act on a block by its id, and an id is never given twice (Mastodon never
--                      reuses one; a plain INTEGER PRIMARY KEY would reuse the newest after its delete).
--   domain             normalized as blockedDomain (src/platform/domain-name.ts) returns it, of at most
--                      MAX_BLOCK_LABELS (8) labels, so a host's rule is found among its suffixes of at most that many.
--   severity           'suspend' covers the domain and its subdomains (availability, deliveries, fetches, inbound);
--                      'noop' covers nothing and, as the longest matching rule, exempts its subdomain tree from a
--                      parent's suspend (Mastodon's DomainBlock.rule_for).
--   reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at, updated_at: the admin
--                      API's fields, stored as given.
--
--   instance_domain_blocks_suspend   the suspend blocks by id: availableSql's one constant seek per query, which
--                                    finds none on an instance without one and skips the per-account rule.
--
-- Cost: a new empty table and its indexes; no existing row is read. Measured on the benchmark store of
-- test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses with their mentions and
-- tags, 2,000,000 favourites, 200,000 boosts, 2,000,000 notifications, 200,000 quotes, 10,000 reports, 500,000
-- outbound activities, 20 local accounts) in workerd's local Durable Object SQLite: 5,888 ms for the upgrade of this
-- file through the kernel (6,026 and 6,355 ms in two more runs, at load averages of 6 to 10), within the 10,000 ms
-- each migration file may take; it is the overhead of an upgrade on a store that size.

CREATE TABLE instance_domain_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE CHECK (
    domain = lower(domain) AND domain GLOB '?*.?*' AND length(domain) - length(replace(domain, '.', '')) < 8
  ),
  severity TEXT NOT NULL CHECK (severity IN ('suspend', 'noop')),
  reject_media INTEGER NOT NULL DEFAULT 0 CHECK (reject_media IN (0, 1)),
  reject_reports INTEGER NOT NULL DEFAULT 0 CHECK (reject_reports IN (0, 1)),
  obfuscate INTEGER NOT NULL DEFAULT 0 CHECK (obfuscate IN (0, 1)),
  private_comment TEXT,
  public_comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- availableSql names this index (INDEXED BY): renaming or dropping it breaks it.
CREATE INDEX instance_domain_blocks_suspend ON instance_domain_blocks (id) WHERE severity = 'suspend';
