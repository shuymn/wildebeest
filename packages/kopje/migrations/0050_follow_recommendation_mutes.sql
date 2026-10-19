-- Kopje Store schema 0050: dismissed follow suggestions. Never edit after release (checksummed).
--
-- follow_recommendation_mutes holds the accounts a local user dismissed from their follow suggestions (Mastodon's
-- FollowRecommendationMute, DELETE /api/v1/suggestions/:id): one row per pair, written only by its owner
-- (dismissSuggestion in src/domain/suggestions.ts), read only by the suggestion rule (R39, suggestionCandidateSql in
-- src/domain/audience.ts). No cap, as Mastodon has none (nor Kopje on blocks or mutes).
--
--   follow_recommendation_mutes_target   the rows naming an account, which a remote account's purge deletes in
--                                        bounded batches (purgeRelationships in src/domain/inbox.ts) before the
--                                        account row; the cascade from accounts is only a backstop.
--
-- The rows go with their local account (ON DELETE CASCADE). The cutover carries none: legacy has no suggestions.
--
-- Cost: a new empty table and its index; no existing row is read.

CREATE TABLE follow_recommendation_mutes (
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, target_account_id)
) WITHOUT ROWID;

CREATE INDEX follow_recommendation_mutes_target ON follow_recommendation_mutes (target_account_id, account_id);
