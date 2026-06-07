-- Phase 1.6 backfill: set TTL for existing remote content (idempotent)
UPDATE actors
SET cached_at = cdate,
    expires_at = datetime(cdate, '+90 days')
WHERE domain IS NOT NULL
  AND cached_at IS NULL;

UPDATE actors
SET cached_at = NULL,
    expires_at = NULL,
    interaction_count = 0
WHERE domain IS NULL
  AND cached_at IS NULL;

UPDATE objects
SET cached_at = cdate,
    expires_at = datetime(cdate, '+30 days')
WHERE local = 0
  AND cached_at IS NULL;

UPDATE objects
SET cached_at = NULL,
    expires_at = NULL,
    interaction_count = 0
WHERE local = 1
  AND cached_at IS NULL;
