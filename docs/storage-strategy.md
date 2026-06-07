# Storage Strategy Options for Wildebeest

## Context

- D1 storage limit: 10GB per database (hard limit)
- Target use case: Individual or small-group instances (1-10 users)
- Need: Mastodon API compatibility with federation

## Options Overview

| Option | Complexity | Cost | Max Storage | Best For |
|--------|------------|------|-------------|----------|
| 1. Single D1 + Retention | Low | $ | 10GB | Personal instance |
| 2. Multi-D1 Sharding | Medium | $ | 30GB+ | Small group |
| 3. Durable Objects | High | $$$ | Unlimited | Special cases |
| 4. D1 + R2 Hybrid | Medium | $$ | 10GB + R2 | Media-heavy |
| 5. External DB (Turso) | Medium | $-$$ | 5GB+ | Growth path |
| 6. Smart Cache Strategy | Medium | $ | 10GB | Federation-heavy |

---

## Option 1: Single D1 with Retention Policies (Recommended for Personal)

**Approach**: Use one D1 database with automatic data cleanup.

### Data Retention Rules

| Data Type | Retention | Condition |
|-----------|-----------|-----------|
| Local statuses | Forever | User's own data |
| Remote statuses | 30 days | Unless favourited/reblogged by local |
| Remote accounts | 90 days | Unless followed by local user |
| Notifications | 90 days | |
| Inbox entries | After processing | Delete once handled |
| Outbox entries | 30 days | Keep for retry/audit |
| Delivery failures | 7 days | |

### Cleanup Worker

```typescript
// Scheduled worker (runs daily)
export async function cleanupOldData(db: D1Database) {
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  // Delete old remote statuses not interacted with
  await db.prepare(`
    DELETE FROM statuses
    WHERE local = 0
      AND created_at < ?
      AND id NOT IN (SELECT status_id FROM favourites WHERE status_id IS NOT NULL)
      AND id NOT IN (SELECT status_id FROM bookmarks WHERE status_id IS NOT NULL)
      AND id NOT IN (SELECT reblog_of_id FROM statuses WHERE reblog_of_id IS NOT NULL)
  `).bind(thirtyDaysAgo.toISOString()).run()

  // Delete old notifications
  await db.prepare(`
    DELETE FROM notifications WHERE created_at < ?
  `).bind(ninetyDaysAgo.toISOString()).run()

  // Delete processed inbox entries
  await db.prepare(`
    DELETE FROM inbox_entries WHERE processed = 1
  `).run()

  // Delete old remote accounts not followed
  await db.prepare(`
    DELETE FROM accounts
    WHERE domain IS NOT NULL
      AND updated_at < ?
      AND id NOT IN (SELECT target_account_id FROM follows)
      AND id NOT IN (SELECT account_id FROM statuses WHERE local = 1)
  `).bind(ninetyDaysAgo.toISOString()).run()
}
```

### Storage Estimate with Retention

| Data Type | Max Size | Notes |
|-----------|----------|-------|
| Local data | ~500MB | Users, local statuses, settings |
| Remote cache | ~2GB | 30-day rolling window |
| Notifications | ~500MB | 90-day rolling window |
| Federation queue | ~500MB | 7-day rolling window |
| **Total** | **~3-4GB** | Well under 10GB limit |

### Pros
- Simplest implementation
- Single database, simple queries
- No external dependencies
- Works for years at personal scale

### Cons
- Can't scroll back indefinitely on remote content
- Need to implement cleanup jobs
- May lose context on old threads

---

## Option 2: Multi-D1 Sharding by Data Type

**Approach**: Separate D1 databases for different data categories.

### Database Split

```
wildebeest-core (D1)
├── accounts (local + frequently accessed remote)
├── users
├── follows
├── blocks / mutes
├── lists / list_accounts
├── filters
├── preferences
├── server_settings
├── server_rules
└── oauth (applications, tokens)

wildebeest-content (D1)
├── statuses
├── status_edits
├── media_attachments
├── polls / poll_options / poll_votes
├── tags / status_tags
├── mentions
└── conversations

wildebeest-federation (D1)
├── remote_accounts_cache
├── inbox_entries
├── outbox_entries
├── known_instances
├── delivery_failures
└── notifications
```

### Implementation

```typescript
// Environment bindings
interface Env {
  DB_CORE: D1Database
  DB_CONTENT: D1Database
  DB_FEDERATION: D1Database
}

// Repository pattern for cross-database queries
class StatusRepository {
  constructor(
    private core: D1Database,
    private content: D1Database
  ) {}

  async getStatusWithAccount(statusId: string) {
    // Get status from content DB
    const status = await this.content.prepare(
      'SELECT * FROM statuses WHERE id = ?'
    ).bind(statusId).first()

    if (!status) return null

    // Get account from core DB
    const account = await this.core.prepare(
      'SELECT * FROM accounts WHERE id = ?'
    ).bind(status.account_id).first()

    return { ...status, account }
  }
}
```

### Storage Budget

| Database | Size Budget | Content |
|----------|-------------|---------|
| wildebeest-core | 2GB | User data, relationships |
| wildebeest-content | 5GB | Statuses, media metadata |
| wildebeest-federation | 3GB | Inbox, remote cache |
| **Total** | **10GB** | With retention on each |

### Pros
- 30GB total capacity
- Clear separation of concerns
- Can apply different retention per DB
- Core data protected from federation growth

### Cons
- No cross-database joins (application-level)
- More complex queries
- Multiple bindings to manage
- Slightly higher complexity

---

## Option 3: Durable Objects with SQLite Backend

**Approach**: Per-user data storage in Durable Objects.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                   D1 (Global)                       │
│  - Server settings, rules                           │
│  - Remote account cache (shared)                    │
│  - Tag registry                                     │
│  - Public timeline index                            │
└─────────────────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   User DO    │ │   User DO    │ │   User DO    │
│   (alice)    │ │   (bob)      │ │   (carol)    │
├──────────────┤ ├──────────────┤ ├──────────────┤
│ SQLite:      │ │ SQLite:      │ │ SQLite:      │
│ - statuses   │ │ - statuses   │ │ - statuses   │
│ - favourites │ │ - favourites │ │ - favourites │
│ - bookmarks  │ │ - bookmarks  │ │ - bookmarks  │
│ - notifs     │ │ - notifs     │ │ - notifs     │
│ - follows    │ │ - follows    │ │ - follows    │
│ - inbox      │ │ - inbox      │ │ - inbox      │
└──────────────┘ └──────────────┘ └──────────────┘
```

### Implementation Sketch

```typescript
// User Durable Object
export class UserDO extends DurableObject {
  private sql: SqlStorage

  constructor(state: DurableObjectState) {
    super(state)
    this.sql = state.storage.sql
  }

  async initialize() {
    // Create tables using sql.run() method
    this.sql.run(`
      CREATE TABLE IF NOT EXISTS statuses (...);
      CREATE TABLE IF NOT EXISTS notifications (...);
      CREATE TABLE IF NOT EXISTS inbox (...);
    `)
  }

  async createStatus(params: CreateStatusParams) {
    // User's own status stored in their DO
    return this.sql.run(`INSERT INTO statuses ...`, [...params])
  }

  async getHomeTimeline(params: PaginationParams) {
    // Query local + followed users' statuses
    // Requires coordination with other DOs or global index
  }
}
```

### Challenges

1. **Home Timeline**: Requires querying multiple DOs or maintaining a global index
2. **Public Timeline**: Needs global coordination
3. **Search**: Cannot search across DOs efficiently
4. **Federation**: Inbox delivery needs to route to correct DO

### When to Use

- **Good for**: Write-heavy workloads, strong per-user isolation
- **Bad for**: Read-heavy timelines, cross-user queries, small instances

### Storage

- Each DO: Up to 10GB SQLite (Workers Paid plan)
- Scales with user count
- For small instance: Overkill complexity

### Pros
- Unlimited horizontal scaling
- Strong per-user consistency
- Natural data isolation

### Cons
- Very complex timeline aggregation
- Higher cost (DO invocations)
- Overkill for 1-10 user instance
- Complex federation routing

---

## Option 4: D1 + R2 Hybrid

**Approach**: D1 for indexes/metadata, R2 for large content.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                      D1                              │
│  - Status metadata (id, account, timestamps, flags) │
│  - Relationships (follows, blocks, favs)            │
│  - Accounts (profile data)                          │
│  - Indexes (timeline ordering)                      │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                      R2                              │
│  - Status content (HTML)                            │
│  - Media files (images, videos)                     │
│  - ActivityPub activity JSON                        │
│  - Large JSON blobs                                 │
└─────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// Status table in D1 (lean)
interface StatusRow {
  id: string
  mastodon_id: string
  account_id: string
  visibility: string
  sensitive: boolean
  language: string | null
  in_reply_to_id: string | null
  replies_count: number
  reblogs_count: number
  favourites_count: number
  created_at: string
  content_key: string  // R2 object key
}

// Content in R2
interface StatusContent {
  content: string       // HTML
  spoiler_text: string
  text: string | null   // Source
  mentions: Mention[]
  tags: Tag[]
  emojis: CustomEmoji[]
  media_attachments: MediaAttachment[]
}

// Repository
class StatusRepository {
  constructor(private db: D1Database, private r2: R2Bucket) {}

  async getStatus(id: string): Promise<Status | null> {
    const row = await this.db.prepare(
      'SELECT * FROM statuses WHERE id = ?'
    ).bind(id).first<StatusRow>()

    if (!row) return null

    const contentObj = await this.r2.get(row.content_key)
    const content = await contentObj?.json<StatusContent>()

    return { ...row, ...content }
  }

  async createStatus(params: CreateStatusParams): Promise<Status> {
    const id = generateId()
    const contentKey = `statuses/${id}/content.json`

    // Store content in R2
    await this.r2.put(contentKey, JSON.stringify({
      content: params.content,
      spoiler_text: params.spoiler_text,
      // ...
    }))

    // Store metadata in D1
    await this.db.prepare(`
      INSERT INTO statuses (id, account_id, content_key, ...)
      VALUES (?, ?, ?, ...)
    `).bind(id, params.account_id, contentKey).run()

    return this.getStatus(id)
  }
}
```

### Storage Distribution

| Store | Content | Size |
|-------|---------|------|
| D1 | Metadata, indexes | ~2-3GB |
| R2 | Content, media | Unlimited (cheap) |

### Pros
- D1 stays lean for fast queries
- R2 is cheap and virtually unlimited
- Good for media-heavy instances
- Natural separation of concerns

### Cons
- Two round trips for full status
- R2 is not queryable (can't search content)
- More complex writes
- Content not available if R2 fails

---

## Option 5: External Database (Turso)

**Approach**: Use Turso (distributed SQLite) instead of D1.

### Why Turso?

- SQLite-compatible (minimal code changes)
- 5GB storage on free tier
- Distributed replicas for low latency
- Better for growth

### Implementation

```typescript
import { createClient } from '@libsql/client'

const db = createClient({
  url: 'libsql://your-database.turso.io',
  authToken: env.TURSO_AUTH_TOKEN
})

// Same SQL queries work
const result = await db.execute({
  sql: 'SELECT * FROM statuses WHERE id = ?',
  args: [statusId]
})
```

### Migration Path

1. Start with D1
2. If approaching limits, migrate to Turso
3. Same schema, minimal code changes

### Pros
- SQLite compatible
- Distributed replicas
- Growth path without architecture change
- Paid plans offer significantly more storage

### Cons
- External dependency
- Network latency (vs D1 colocated)
- May have costs at scale
- Vendor dependency

---

## Option 6: Smart Caching Strategy

**Approach**: Treat remote data as ephemeral cache, local as permanent.

### Principles

1. **Local data is permanent**: User's statuses, follows, preferences
2. **Remote data is cache**: Can be refetched via ActivityPub
3. **Interactions anchor remote data**: Favourited/reblogged = keep longer

### Implementation

```sql
-- Remote status cache table with TTL
CREATE TABLE remote_status_cache (
  id TEXT PRIMARY KEY,
  uri TEXT UNIQUE NOT NULL,
  account_id TEXT NOT NULL,
  content TEXT NOT NULL,
  properties TEXT NOT NULL,
  cached_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,  -- TTL
  pin_count INTEGER DEFAULT 0    -- Interactions keep it alive
);

-- When favouriting, increment pin_count
-- When unfavouriting, decrement
-- Only delete if pin_count = 0 AND expired
```

### Fetch Strategy

```typescript
async function getRemoteStatus(uri: string): Promise<Status | null> {
  // Check cache first
  const cached = await db.prepare(
    'SELECT * FROM remote_status_cache WHERE uri = ? AND (expires_at > ? OR pin_count > 0)'
  ).bind(uri, new Date().toISOString()).first()

  if (cached) {
    return deserializeStatus(cached)
  }

  // Fetch from source
  const status = await fetchActivityPubObject(uri)
  if (!status) return null

  // Cache with 7-day TTL
  await cacheRemoteStatus(status, { ttlDays: 7 })
  return status
}
```

### Pros
- Natural fit for ActivityPub (everything is refetchable)
- Local data always available
- Predictable storage usage
- Simple mental model

### Cons
- Remote content may take longer to load
- Can't search old remote posts
- Thread context may be incomplete

---

## Recommendation for Wildebeest

### For Personal Instance (1-3 users)

**Recommended: Option 1 (Single D1 + Retention)**

- Simplest to implement
- 10GB is plenty with retention policies
- Add cleanup worker as part of data model

### For Small Group (3-10 users)

**Recommended: Option 1 → Option 2 migration path**

- Start with single D1
- If approaching 7GB, split to multi-D1
- Keep schema compatible with both

### Implementation Priority

1. **Phase 1**: Implement retention policies in schema
   - Add `expires_at` column to remote data tables
   - Add cleanup triggers/workers

2. **Phase 2**: Add storage monitoring
   - Track per-table sizes
   - Alert when approaching limits

3. **Phase 3**: Prepare sharding (if needed)
   - Design repository layer for multi-DB
   - Keep schema split-friendly

---

## Schema Modifications for Storage Efficiency

### Add to data-model-design.md

```sql
-- Add expiration tracking to remote content
ALTER TABLE statuses ADD COLUMN "cached_at" DATETIME;
ALTER TABLE statuses ADD COLUMN "expires_at" DATETIME;
ALTER TABLE statuses ADD COLUMN "interaction_count" INTEGER DEFAULT 0;

-- Index for cleanup queries
CREATE INDEX "statuses_cleanup" ON "statuses" ("local", "expires_at", "interaction_count")
  WHERE "local" = 0;

-- Add to accounts for remote cleanup
ALTER TABLE accounts ADD COLUMN "cached_at" DATETIME;
ALTER TABLE accounts ADD COLUMN "expires_at" DATETIME;
ALTER TABLE accounts ADD COLUMN "interaction_count" INTEGER DEFAULT 0;

CREATE INDEX "accounts_cleanup" ON "accounts" ("domain", "expires_at", "interaction_count")
  WHERE "domain" IS NOT NULL;
```

### Retention Configuration

```typescript
// Config type
interface RetentionConfig {
  remoteStatuses: {
    defaultTtlDays: number      // Default: 30
    interactedTtlDays: number   // Default: 90
    replyChainTtlDays: number   // Default: 60 (keep thread context)
  }
  remoteAccounts: {
    defaultTtlDays: number      // Default: 90
    followedTtlDays: number     // Default: never (null)
  }
  notifications: {
    ttlDays: number             // Default: 90
  }
  inboxEntries: {
    processedTtlDays: number    // Default: 1
  }
}

// Default config
const defaultRetention: RetentionConfig = {
  remoteStatuses: {
    defaultTtlDays: 30,
    interactedTtlDays: 90,
    replyChainTtlDays: 60
  },
  remoteAccounts: {
    defaultTtlDays: 90,
    followedTtlDays: null  // Never expire if followed
  },
  notifications: {
    ttlDays: 90
  },
  inboxEntries: {
    processedTtlDays: 1
  }
}
```

---

## Storage Monitoring

```typescript
// Scheduled worker to monitor storage
export async function monitorStorage(db: D1Database): Promise<StorageReport> {
  const tables = [
    'accounts', 'statuses', 'notifications', 'inbox_entries',
    'media_attachments', 'follows', 'favourites'
  ]

  const sizes: Record<string, TableSize> = {}

  for (const table of tables) {
    const result = await db.prepare(`
      SELECT COUNT(*) as count FROM ${table}
    `).first()

    sizes[table] = {
      rows: result?.count ?? 0,
    }
  }

  return {
    tables: sizes,
    alert: false  // Calculate based on actual storage metrics
  }
}
```

---

## Conclusion

For Wildebeest's target use case (individual/small group):

1. **Start simple**: Single D1 with retention policies
2. **Plan for growth**: Design schema to be split-friendly
3. **Monitor usage**: Track storage and alert early
4. **Migrate if needed**: Multi-D1 or Turso as escape hatch

The key insight is that **most storage growth comes from federated content**, which is inherently ephemeral and refetchable. Aggressive retention policies on remote data keep storage manageable while preserving all local user data.
