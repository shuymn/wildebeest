-- Kopje Store schema 0002: Web Push (PUSH-1 to PUSH-3). Never edit after release (checksummed).
--
-- push_subscriptions gains the encoding a client asked for (standard: RFC 8291 aes128gcm; otherwise the legacy aesgcm
-- draft, Mastodon's default) and its access token sealed for the payload's access_token: AES-GCM under a key derived
-- from VAPID_JWK, which the Store never holds, so the Store keeps no usable token (AUTH-7). '' for none.
ALTER TABLE push_subscriptions ADD COLUMN standard INTEGER NOT NULL DEFAULT 0 CHECK (standard IN (0, 1));
ALTER TABLE push_subscriptions ADD COLUMN token_sealed TEXT NOT NULL DEFAULT '';

-- Pushes to send, one per (subscription, new notification), written in the transaction that writes the notification
-- (VIS-10). Both parents cascade: a revoked token, a deleted or replaced notification takes its pushes with it. Claimed
-- and retried as deliveries are (leases, backoff, a bound on attempts), and deleted once sent or given up. For leased
-- rows next_attempt_at doubles as the lease deadline. Epoch ms, as the other Queue-like tables.
CREATE TABLE push_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,           -- never reused, so a late completion cannot hit another row
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions (id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  last_status INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (subscription_id, notification_id),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL))
);

CREATE INDEX push_deliveries_due ON push_deliveries (next_attempt_at);
CREATE INDEX push_deliveries_notification ON push_deliveries (notification_id);
