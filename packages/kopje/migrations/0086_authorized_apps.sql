-- Kopje Store schema 0086: authorized apps. Never edit after release (checksummed).
--
--   oauth_clients.authorized   1 once a user's code was issued for the app (src/domain/oauth.ts markAuthorized, in the
--                              code's transaction; every user token is exchanged from a code), else 0; it stays 1 when
--                              the codes and tokens go (revocation, suspension, expiry). The storage budget of
--                              anonymous registration counts, evicts and sweeps only apps at 0 (RES-6); Mastodon never
--                              removes an app a user authorized. CHECK oauth_client_authorized refuses any value but
--                              the integer 0 or 1.
--   oauth_clients_pending      the apps at 0 in (created_at, id) order: the budget's count, eviction and sweep walk it.
--
-- The upgrade sets 1 on every app that holds a user's code or token (account_id set); an app whose user tokens were all
-- revoked before it has no record of them and stays 0.
--
-- Cost: adding the column checks its CHECK on every app; the UPDATE reads each app and seeks its tokens by
-- oauth_tokens_client; the index reads the apps once. No other table is read.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 statuses with their
-- mentions, tags, media and cards, 2,000,000 notifications) in workerd's local Durable Object SQLite, the Store's
-- foreign key check skipped as declared: 7 ms for the upgrade of this file through the kernel, within the budget, at a
-- load average of about 9.

ALTER TABLE oauth_clients ADD COLUMN authorized INTEGER NOT NULL DEFAULT 0
  CONSTRAINT oauth_client_authorized CHECK (typeof(authorized) = 'integer' AND authorized IN (0, 1));

UPDATE oauth_clients SET authorized = 1
WHERE EXISTS (SELECT 1 FROM oauth_tokens t INDEXED BY oauth_tokens_client
	WHERE t.client_id = oauth_clients.id AND t.account_id IS NOT NULL);

CREATE INDEX oauth_clients_pending ON oauth_clients (created_at, id) WHERE authorized = 0;
