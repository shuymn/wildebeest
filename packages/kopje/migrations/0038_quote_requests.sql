-- Kopje Store schema 0038: remote servers quoting local posts. Never edit after release (checksummed).
--
-- Mastodon 4.5 answers a QuoteRequest for a local status by the author's quote policy (R36), and an accepted quote's
-- approval is a QuoteAuthorization stamp served at <author>/quote_authorizations/<id>. Kopje does the same
-- (src/domain/quotes.ts, docs/threat-model.md VIS-28):
--
--   quotes.authorization_id  the id of Kopje's own stamp for an accepted quote of a local status: 128 random bits,
--                            drawn on each transition into accepted and never reused. It exists exactly while the quote
--                            is accepted (CHECK), so every statement that leaves accepted clears it in the same
--                            statement, and the two triggers below record the id it held in quote_revocations, before
--                            the change, whatever the path (a revoke, a quoter's Update replacing or dropping the
--                            quote, a detach, a delete, a purge). A recorded id is never served again.
--   quotes.activity_uri      the QuoteRequest id that accepted the quote; NULL otherwise.
--   quote_requests           every QuoteRequest Kopje answered (Accept or Reject), kept apart from the quote row so that
--                            a later Update replacing the row cannot erase it: a request id found here is never answered
--                            again (ID-7). instrument_uri and quoted_status_id name the quote it was about, so a revoke
--                            sends a Reject of each request answered for that quote. Pruned by age (RETRACTION_TTL_MS,
--                            30 days) and capped per actor by refusal, never by evicting a live row (quotes.ts).
--
-- quote_revocations rows written here carry the quoted author's uri as actor_uri and pending 0: the revocation batches
-- (pending 1) never see them, and an id of ours has no scheme, so it never equals a remote stamp's.
--
-- Cost: two ALTERs adding a nullable column (a change of the schema alone); the authorization_id CHECK is tested
-- against each stored quote, all of which hold NULL. The index, table and triggers start empty. Nothing is backfilled.

ALTER TABLE quotes ADD COLUMN authorization_id TEXT CHECK (authorization_id IS NULL OR state = 'accepted');
ALTER TABLE quotes ADD COLUMN activity_uri TEXT;

CREATE UNIQUE INDEX quotes_authorization ON quotes (authorization_id) WHERE authorization_id IS NOT NULL;

CREATE TABLE quote_requests (
  activity_uri TEXT NOT NULL PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  instrument_uri TEXT NOT NULL,
  quoted_status_id TEXT NOT NULL,
  answered_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The live requests of an actor (the cap), the requests of a quote (a revoke's Rejects), and the expired ones (the
-- sweep).
CREATE INDEX quote_requests_actor ON quote_requests (actor_uri, answered_at);

CREATE INDEX quote_requests_instrument ON quote_requests (instrument_uri, quoted_status_id);

CREATE INDEX quote_requests_answered ON quote_requests (answered_at);

-- One quote_revocations row per authorization retired: by a change of authorization_id (the only way out of accepted
-- for a quote that holds one) or by the quote's delete.
CREATE TRIGGER quotes_authorization_retired BEFORE UPDATE OF authorization_id ON quotes
WHEN OLD.authorization_id IS NOT NULL AND NEW.authorization_id IS NOT OLD.authorization_id
BEGIN
  INSERT INTO quote_revocations (authorization, actor_uri, revoked_at)
  VALUES (OLD.authorization_id, COALESCE((SELECT uri FROM accounts WHERE id = OLD.quoted_account_id), ''),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER quotes_authorization_deleted BEFORE DELETE ON quotes
WHEN OLD.authorization_id IS NOT NULL
BEGIN
  INSERT INTO quote_revocations (authorization, actor_uri, revoked_at)
  VALUES (OLD.authorization_id, COALESCE((SELECT uri FROM accounts WHERE id = OLD.quoted_account_id), ''),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  ON CONFLICT DO NOTHING;
END;
