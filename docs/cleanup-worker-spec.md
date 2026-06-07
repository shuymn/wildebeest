# Cleanup Worker Specification

## Overview

The Cleanup Worker is a scheduled Cloudflare Worker that runs periodically to delete expired remote/federated data and maintain storage within D1's 10GB limit.

**Note on table names:** This spec uses target schema names (`statuses`, `accounts`, `follows`) from `data-model-design.md`. If migration Phase 6 (table renaming) is not executed, substitute with current names (`objects`, `actors`, `actor_following`). See `data-model-migration.md` for details.

## Prerequisites

Do not deploy the cleanup worker until all of the following are complete:

1. **Phase 1.6 migration** (`data-model-migration.md`): `cached_at`, `expires_at`, and `interaction_count` columns exist on `actors`/`objects` (or `accounts`/`statuses` after Phase 6), with backfill applied for existing remote data
2. **Application code** maintains `interaction_count` on favourite, bookmark, reblog, and follow operations (see "Interaction Count Maintenance" below)
3. **Phase 4 query migrations** deployed if using `actor_replies`/`actor_reblogs` replacement columns

## Goals

1. **Storage Management**: Keep D1 usage within safe limits
2. **Data Freshness**: Remove stale remote data that can be refetched
3. **Performance**: Avoid impacting normal request handling
4. **Observability**: Report cleanup results and storage stats

## Non-Goals

- Deleting local user-created statuses (always retained)
- Deleting local user relationships (follows, blocks, mutes - always retained)
- Real-time cleanup (batch processing is sufficient)
- Complex data archiving (out of scope)

**Note on ephemeral data**: Notifications, inbox entries, and delivery failures are considered ephemeral operational data, not permanent user content. These are cleaned up based on TTL regardless of origin. This matches Mastodon's behavior where notifications have retention limits.

**Note on remote content interactions**: When a remote status expires, local users' favourites and bookmarks of that status are also deleted. The interaction record is meaningless without its target. This is similar to how Mastodon handles deleted remote content - the favourite/bookmark simply disappears.

---

## Architecture

### Trigger

```toml
# wrangler.toml
[triggers]
crons = ["0 4 * * *"]  # Daily at 4:00 AM UTC
```

The worker runs once daily during low-traffic hours. The schedule can be adjusted via `wrangler.toml`.

### Entry Point

```typescript
// consumer/src/cleanup.ts
export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const config = parseRetentionConfig(env)
    const result = await runCleanup(env.DATABASE, config)

    // Log results
    console.log('Cleanup completed:', JSON.stringify(result))

    // Optionally send to analytics/monitoring
    if (env.ANALYTICS) {
      await reportCleanupResult(env.ANALYTICS, result)
    }
  }
}
```

---

## Cleanup Operations

### Order of Operations

Cleanup runs in this order to respect foreign key constraints:

1. **Inbox entries** (processed, no dependencies)
2. **Delivery failures** (no dependencies)
3. **Notifications** (references statuses/accounts)
4. **Status interactions** (favourites, bookmarks of expired statuses - must run BEFORE status deletion)
5. **Statuses** (remote, expired, no interactions)
6. **Accounts** (remote, expired, no interactions)

**Important:** The `interaction_count` column on statuses/accounts MUST be kept accurate by application code (increment on favourite/bookmark/reblog, decrement on unfavourite/unbookmark/unreblog). Stale counts can cause premature deletion or orphaned data.

### 1. Inbox Entries Cleanup

Delete processed inbox entries older than TTL.

```sql
-- Delete processed inbox entries
DELETE FROM inbox_entries
WHERE processed = 1
  AND created_at < datetime('now', '-' || ? || ' days')
```

**Parameters**:
- `?1`: `config.inboxEntries.processedTtlDays` (default: 1)

**Notes**:
- Only deletes entries where `processed = 1`
- Unprocessed entries are never deleted (may need retry)

### 2. Delivery Failures Cleanup

Delete old delivery failure records.

```sql
DELETE FROM delivery_failures
WHERE created_at < datetime('now', '-' || ? || ' days')
```

**Parameters**:
- `?1`: `config.deliveryFailures.ttlDays` (default: 7)

### 3. Notifications Cleanup

Delete old notifications.

```sql
DELETE FROM notifications
WHERE created_at < datetime('now', '-' || ? || ' days')
```

**Parameters**:
- `?1`: `config.notifications.ttlDays` (default: 90)

**Notes**:
- All notifications are cleaned up (ephemeral data, see Non-Goals note)
- Read/unread status does not affect cleanup
- This matches Mastodon's notification retention behavior

### 4. Status Interactions Cleanup

Delete favourites and bookmarks that reference expired/deleted statuses.

```sql
-- Delete favourites of expired remote statuses
DELETE FROM favourites
WHERE status_id IN (
  SELECT id FROM statuses
  WHERE local = 0
    AND expires_at IS NOT NULL
    AND expires_at < datetime('now')
    AND interaction_count = 0
);

-- Delete bookmarks of expired remote statuses
DELETE FROM bookmarks
WHERE status_id IN (
  SELECT id FROM statuses
  WHERE local = 0
    AND expires_at IS NOT NULL
    AND expires_at < datetime('now')
    AND interaction_count = 0
);
```

**Notes**:
- Runs BEFORE status deletion to avoid FK constraint violations
- Only targets interactions with statuses that will be deleted in step 5
- Local user's favourites/bookmarks of non-expired remote content are preserved

### 5. Remote Statuses Cleanup

Delete remote statuses that are expired and have no local interactions.

```sql
-- Delete expired remote statuses with no interactions
DELETE FROM statuses
WHERE local = 0
  AND deleted_at IS NULL
  AND expires_at IS NOT NULL
  AND expires_at < datetime('now')
  AND interaction_count = 0
  AND id NOT IN (
    -- Exclude statuses that are parents of local statuses
    SELECT DISTINCT in_reply_to_id FROM statuses
    WHERE in_reply_to_id IS NOT NULL AND local = 1
  )
  AND id NOT IN (
    -- Exclude statuses that are reblogged by local users (reblog_of_id points to this status)
    SELECT DISTINCT reblog_of_id FROM statuses
    WHERE reblog_of_id IS NOT NULL AND local = 1
  )
  AND id NOT IN (
    -- Exclude statuses with remaining favourites (safety check)
    SELECT DISTINCT status_id FROM favourites
  )
  AND id NOT IN (
    -- Exclude statuses with remaining bookmarks (safety check)
    SELECT DISTINCT status_id FROM bookmarks
  )
```

**Safety Checks**:
- Only remote statuses (`local = 0`)
- Not soft-deleted (`deleted_at IS NULL`)
- Expired (`expires_at < now`)
- No local interactions (`interaction_count = 0`)
- Not a parent of local replies
- Not reblogged by local users

### 6. Remote Accounts Cleanup

Delete remote accounts that are expired and have no local relationships.

```sql
-- Delete expired remote accounts with no interactions
DELETE FROM accounts
WHERE domain IS NOT NULL  -- Remote only
  AND expires_at IS NOT NULL
  AND expires_at < datetime('now')
  AND interaction_count = 0
  AND id NOT IN (
    -- Exclude accounts followed by local users
    SELECT DISTINCT target_account_id FROM follows
    WHERE target_account_id IS NOT NULL
  )
  AND id NOT IN (
    -- Exclude accounts that have authored statuses we keep
    SELECT DISTINCT account_id FROM statuses
    WHERE account_id IS NOT NULL AND deleted_at IS NULL
  )
  AND id NOT IN (
    -- Exclude accounts mentioned by local users
    SELECT DISTINCT account_id FROM mentions
    JOIN statuses ON mentions.status_id = statuses.id
    WHERE statuses.local = 1
  )
```

**Safety Checks**:
- Only remote accounts (`domain IS NOT NULL`)
- Expired (`expires_at < now`)
- No local interactions (`interaction_count = 0`)
- Not followed by local users
- No retained statuses
- Not mentioned by local users

---

## Interaction Count Management

The `interaction_count` column prevents cleanup of data that local users have interacted with.

### Incrementing

When a local user interacts with remote content:

```typescript
// On favourite
async function favouriteStatus(db: D1Database, accountId: string, statusId: string) {
  await db.batch([
    db.prepare('INSERT INTO favourites (id, account_id, status_id, ...) VALUES (?, ?, ?, ...)'),
    db.prepare('UPDATE statuses SET interaction_count = interaction_count + 1, favourites_count = favourites_count + 1 WHERE id = ?').bind(statusId),
  ])
}

// On follow
async function followAccount(db: D1Database, accountId: string, targetId: string) {
  await db.batch([
    db.prepare('INSERT INTO follows (id, account_id, target_account_id, ...) VALUES (?, ?, ?, ...)'),
    db.prepare('UPDATE accounts SET interaction_count = interaction_count + 1 WHERE id = ?').bind(targetId),
  ])
}
```

### Decrementing

When a local user removes an interaction:

```typescript
// On unfavourite
async function unfavouriteStatus(db: D1Database, accountId: string, statusId: string) {
  await db.batch([
    db.prepare('DELETE FROM favourites WHERE account_id = ? AND status_id = ?').bind(accountId, statusId),
    db.prepare('UPDATE statuses SET interaction_count = MAX(0, interaction_count - 1), favourites_count = favourites_count - 1 WHERE id = ?').bind(statusId),
  ])
}
```

### Interactions That Increment

| Entity | Interaction Types |
|--------|-------------------|
| Status | favourite, bookmark, reblog (local) |
| Account | follow, mention (by local user) |

---

## Expiration Date Calculation

### On Fetch (Remote Status)

```typescript
async function cacheRemoteStatus(
  db: D1Database,
  status: Status,
  config: RetentionConfig
): Promise<void> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + config.remoteStatuses.defaultTtlDays * 24 * 60 * 60 * 1000)

  await db.prepare(`
    INSERT INTO statuses (id, ..., cached_at, expires_at, interaction_count)
    VALUES (?, ..., ?, ?, 0)
    ON CONFLICT (id) DO UPDATE SET
      cached_at = COALESCE(cached_at, excluded.cached_at),
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).bind(status.id, ..., now.toISOString(), expiresAt.toISOString()).run()
}
```

### On Interaction (Extend TTL)

```typescript
async function extendStatusTtl(
  db: D1Database,
  statusId: string,
  config: RetentionConfig
): Promise<void> {
  const expiresAt = new Date(Date.now() + config.remoteStatuses.interactedTtlDays * 24 * 60 * 60 * 1000)

  await db.prepare(`
    UPDATE statuses
    SET expires_at = ?,
        interaction_count = interaction_count + 1
    WHERE id = ? AND local = 0
  `).bind(expiresAt.toISOString(), statusId).run()
}
```

---

## Storage Monitoring

### Collect Stats

Run before and after cleanup to measure effectiveness.

```typescript
async function collectStorageStats(db: D1Database): Promise<StorageStats> {
  const tables = [
    'accounts', 'statuses', 'notifications', 'inbox_entries',
    'media_attachments', 'follows', 'favourites', 'bookmarks'
  ]

  const stats: StorageStats = {
    tables: {},
    warning: false,
    collectedAt: new Date()
  }

  for (const table of tables) {
    const result = await db.prepare(
      `SELECT COUNT(*) as count FROM ${table}`
    ).first<{ count: number }>()

    stats.tables[table] = {
      rowCount: result?.count ?? 0
    }
  }

  // Check for warning conditions
  const totalRows = Object.values(stats.tables).reduce((sum, t) => sum + t.rowCount, 0)
  if (totalRows > 1_000_000) {
    stats.warning = true
  }

  return stats
}
```

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Total rows | > 1M | > 5M |
| Remote accounts | > 100K | > 500K |
| Remote statuses | > 500K | > 2M |

---

## Error Handling

### Retry Strategy

```typescript
async function runCleanupWithRetry(
  db: D1Database,
  config: RetentionConfig,
  maxRetries: number = 3
): Promise<CleanupSummary> {
  const results: CleanupResult[] = []

  for (const operation of CLEANUP_OPERATIONS) {
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation.run(db, config)
        results.push(result)
        break
      } catch (error) {
        lastError = error as Error
        console.error(`Cleanup ${operation.name} failed (attempt ${attempt}):`, error)

        if (attempt < maxRetries) {
          // Exponential backoff
          await sleep(1000 * Math.pow(2, attempt))
        }
      }
    }

    if (lastError) {
      results.push({
        table: operation.table,
        deletedCount: 0,
        durationMs: 0,
        error: lastError.message
      })
    }
  }

  return summarizeResults(results)
}
```

### Partial Failure

If one cleanup operation fails, others should still proceed:

```typescript
const CLEANUP_OPERATIONS = [
  { name: 'inbox_entries', table: 'inbox_entries', run: cleanupInboxEntries },
  { name: 'delivery_failures', table: 'delivery_failures', run: cleanupDeliveryFailures },
  { name: 'notifications', table: 'notifications', run: cleanupNotifications },
  { name: 'statuses', table: 'statuses', run: cleanupRemoteStatuses },
  { name: 'accounts', table: 'accounts', run: cleanupRemoteAccounts },
]
```

---

## Batch Processing

For large datasets, delete in batches to avoid D1 timeouts.

```typescript
async function cleanupRemoteStatusesBatched(
  db: D1Database,
  config: RetentionConfig,
  batchSize: number = 1000
): Promise<CleanupResult> {
  let totalDeleted = 0
  const startTime = Date.now()

  while (true) {
    const result = await db.prepare(`
      DELETE FROM statuses
      WHERE id IN (
        SELECT id FROM statuses
        WHERE local = 0
          AND expires_at IS NOT NULL
          AND expires_at < datetime('now')
          AND interaction_count = 0
          AND deleted_at IS NULL
        LIMIT ?
      )
    `).bind(batchSize).run()

    const deleted = result.meta?.changes ?? 0
    totalDeleted += deleted

    if (deleted < batchSize) {
      break  // No more rows to delete
    }

    // Small delay between batches
    await sleep(100)
  }

  return {
    table: 'statuses',
    deletedCount: totalDeleted,
    durationMs: Date.now() - startTime
  }
}
```

---

## Logging & Observability

### Log Format

```typescript
interface CleanupLog {
  timestamp: string
  event: 'cleanup_started' | 'cleanup_completed' | 'cleanup_error'
  table?: string
  deletedCount?: number
  durationMs?: number
  error?: string
  storageStats?: StorageStats
}

function logCleanup(log: CleanupLog): void {
  console.log(JSON.stringify(log))
}
```

### Example Output

```json
{"timestamp":"2025-01-15T04:00:00Z","event":"cleanup_started"}
{"timestamp":"2025-01-15T04:00:01Z","event":"cleanup_completed","table":"inbox_entries","deletedCount":1523,"durationMs":450}
{"timestamp":"2025-01-15T04:00:03Z","event":"cleanup_completed","table":"notifications","deletedCount":892,"durationMs":1200}
{"timestamp":"2025-01-15T04:00:08Z","event":"cleanup_completed","table":"statuses","deletedCount":15234,"durationMs":4500}
{"timestamp":"2025-01-15T04:00:10Z","event":"cleanup_completed","table":"accounts","deletedCount":423,"durationMs":2100}
{"timestamp":"2025-01-15T04:00:10Z","event":"cleanup_started","storageStats":{"tables":{"accounts":{"rowCount":5234},"statuses":{"rowCount":45123}}}}
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RETENTION_REMOTE_STATUSES_DAYS` | 30 | TTL for remote statuses |
| `RETENTION_REMOTE_STATUSES_INTERACTED_DAYS` | 90 | TTL for interacted remote statuses |
| `RETENTION_REMOTE_STATUSES_REPLY_CHAIN_DAYS` | 60 | TTL for reply chain statuses |
| `RETENTION_REMOTE_ACCOUNTS_DAYS` | 90 | TTL for remote accounts |
| `RETENTION_REMOTE_ACCOUNTS_FOLLOWED_DAYS` | (never) | TTL for followed accounts |
| `RETENTION_NOTIFICATIONS_DAYS` | 90 | TTL for notifications |
| `RETENTION_INBOX_PROCESSED_DAYS` | 1 | TTL for processed inbox |
| `RETENTION_DELIVERY_FAILURES_DAYS` | 7 | TTL for delivery failures |
| `CLEANUP_BATCH_SIZE` | 1000 | Rows to delete per batch |
| `CLEANUP_ENABLED` | true | Enable/disable cleanup |

### Disabling Cleanup

For debugging or during maintenance:

```toml
# wrangler.toml
[vars]
CLEANUP_ENABLED = "false"
```

---

## Testing Strategy

### Unit Tests

```typescript
describe('Cleanup Worker', () => {
  it('should not delete local statuses', async () => {
    const db = createTestDb()
    await insertStatus(db, { id: '1', local: true, expires_at: null })
    await insertStatus(db, { id: '2', local: false, expires_at: yesterday })

    await runCleanup(db, DEFAULT_RETENTION_CONFIG)

    expect(await getStatus(db, '1')).toBeDefined()
    expect(await getStatus(db, '2')).toBeNull()
  })

  it('should not delete statuses with interactions', async () => {
    const db = createTestDb()
    await insertStatus(db, { id: '1', local: false, expires_at: yesterday, interaction_count: 1 })

    await runCleanup(db, DEFAULT_RETENTION_CONFIG)

    expect(await getStatus(db, '1')).toBeDefined()
  })

  it('should respect configured TTLs', async () => {
    const db = createTestDb()
    const config = { ...DEFAULT_RETENTION_CONFIG, notifications: { ttlDays: 30 } }
    await insertNotification(db, { id: '1', created_at: daysAgo(31) })
    await insertNotification(db, { id: '2', created_at: daysAgo(29) })

    await runCleanup(db, config)

    expect(await getNotification(db, '1')).toBeNull()
    expect(await getNotification(db, '2')).toBeDefined()
  })
})
```

### Integration Tests

```typescript
describe('Cleanup Worker Integration', () => {
  it('should complete within time limit', async () => {
    const db = createTestDbWithLargeDataset()

    const start = Date.now()
    await runCleanup(db, DEFAULT_RETENTION_CONFIG)
    const duration = Date.now() - start

    expect(duration).toBeLessThan(30_000)  // 30 seconds max
  })

  it('should handle empty tables', async () => {
    const db = createEmptyTestDb()

    const result = await runCleanup(db, DEFAULT_RETENTION_CONFIG)

    expect(result.hasErrors).toBe(false)
    expect(result.totalDeleted).toBe(0)
  })
})
```

---

## Future Considerations

### Potential Enhancements

1. **Vacuum/Optimize**: Run `VACUUM` after large cleanups to reclaim space
2. **Incremental Cleanup**: More frequent, smaller cleanups instead of daily batch
3. **Smart Retention**: ML-based retention (keep popular content longer)
4. **Multi-DB Support**: Cleanup across sharded databases

### Known Limitations

1. **No Real-time Enforcement**: TTL is enforced by batch job, not on access
2. **Cascade Complexity**: Foreign keys may cause slower deletes
3. **D1 Timeouts**: Very large cleanups may need to span multiple invocations

---

## Summary

The Cleanup Worker provides automated data retention for Wildebeest, keeping D1 storage manageable for personal/small instances:

- **Daily execution** during low-traffic hours
- **Configurable TTLs** via environment variables
- **Safe deletion** with interaction count protection
- **Batch processing** to avoid timeouts
- **Comprehensive logging** for observability

Implementation priority: **Low** (implement when approaching storage limits or as part of production readiness).
