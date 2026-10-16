-- Kopje Store schema 0027: quote posts received from remote servers, and their verification. Never edit after release
-- (checksummed).
--
-- Mastodon 4.5 stores a quote as a row keyed by the quoting status (Quote, status_id unique) with the quoted status,
-- its state and the approval (the quoted author's QuoteAuthorization stamp) that accepted it. Kopje does the same
-- (src/domain/quotes.ts), storing and verifying quotes of remote statuses; nothing is shown to clients yet.
--
-- - quotes holds one row per quoting status. quoted_uri is the quoted status as the quoting Note names it (NULL only
--   for a quote of a Tombstone without an id, which is 'deleted'); quoted_status_id is that status once Kopje stores
--   it, linked by uri, never a boost, and quoted_account_id its author (no foreign key: it is set and cleared with
--   quoted_status_id, so a stamp's Delete finds the quotes of its author's statuses by index, as Mastodon's
--   quoted_account does). state is Mastodon's (pending, accepted, rejected, revoked, deleted); accepted only with a
--   quoted status present. legacy marks a Note without a `quote` property (a Misskey or Fedibird quote), which
--   Mastodon never shows unless accepted. approval_uri is the remote stamp's id.
--   The row carries its own verification work, written in the transaction that makes it due: verify_after (ms, NULL
--   when nothing is due), attempts, hops (the traversal budget left for this work: 2 for a status that arrived as a
--   root, one less for a status stored as a quoted target during verification), fetch_as (the local account
--   whose key may fetch for it, rechecked before each use) and need_author (the author of the quoted status, learned
--   from a fetch of it, when Kopje does not have that account yet: the next stage fetches the author, the one after
--   fetches the status again, now storable. Only this address is kept between stages, never a fetched document).
-- - quote_revocations records, for good, every stamp whose Delete by an author revoked a stored quote of that author's
--   status: the stamp never verifies a quote of that author's statuses again, whatever later happens to the quote row.
--   It is keyed by the stamp and the author, so nobody else's Delete of the same URI revokes anything of the author's. pending marks one whose matching quotes are still being
--   processed in bounded batches (inbox.ts runInboundJobs).
-- - statuses.quotes_count is the number of accepted quotes of a status, kept by the triggers below as transactional
--   deltas (Mastodon's counter cache), never recounted.
--
-- Cost: the new tables, indexes and triggers start empty; the added column has a constant default and no CHECK, so
-- SQLite neither rewrites nor reads the stored statuses. Nothing is backfilled: stored remote statuses keep their quote
-- properties in raw, as before.

CREATE TABLE quotes (
  status_id TEXT NOT NULL PRIMARY KEY REFERENCES statuses (id) ON DELETE CASCADE,
  quoted_uri TEXT,
  quoted_status_id TEXT REFERENCES statuses (id) ON DELETE SET NULL,
  quoted_account_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'revoked', 'deleted')),
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  approval_uri TEXT,
  verify_after INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  hops INTEGER NOT NULL DEFAULT 0 CHECK (hops BETWEEN 0 AND 2),
  fetch_as TEXT REFERENCES local_accounts (account_id) ON DELETE SET NULL,
  need_author TEXT CHECK (length(need_author) <= 2048),
  updated_at TEXT NOT NULL,
  CHECK (state <> 'accepted' OR quoted_status_id IS NOT NULL),
  CHECK (quoted_uri IS NOT NULL OR state = 'deleted'),
  CHECK (verify_after IS NULL OR state IN ('pending', 'accepted')),
  CHECK ((quoted_status_id IS NULL) = (quoted_account_id IS NULL)),
  CHECK (need_author IS NULL OR (quoted_status_id IS NULL AND state = 'pending'))
);

-- The quotes of a status (its delete detaches them), the unresolved ones a newly stored status links by uri, the ones
-- a stamp's Delete names among the quotes of its author's statuses, and the verification work due.
CREATE INDEX quotes_quoted ON quotes (quoted_status_id) WHERE quoted_status_id IS NOT NULL;

CREATE INDEX quotes_unresolved ON quotes (quoted_uri) WHERE quoted_status_id IS NULL AND state = 'pending';

CREATE INDEX quotes_approval ON quotes (approval_uri, quoted_account_id, state) WHERE approval_uri IS NOT NULL;

CREATE INDEX quotes_due ON quotes (verify_after) WHERE verify_after IS NOT NULL;

CREATE TABLE quote_revocations (
  authorization TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
  PRIMARY KEY (authorization, actor_uri)
) WITHOUT ROWID;

CREATE INDEX quote_revocations_pending ON quote_revocations (revoked_at) WHERE pending = 1;

ALTER TABLE statuses ADD COLUMN quotes_count INTEGER NOT NULL DEFAULT 0;

-- One statuses row per accepted quote of a status inserted, deleted, or changed into or out of counting: a change of
-- state, or of the quoted status (an Update naming another status, a Tombstone or one not stored yet), takes it off
-- the old status and adds it to the new. A detach (the quoted status going) also takes it off that status, one write
-- more for the batch that does it (inbox.ts STATUS_CHILDREN).
CREATE TRIGGER quotes_count_inserted AFTER INSERT ON quotes
WHEN NEW.state = 'accepted' AND NEW.quoted_status_id IS NOT NULL
BEGIN
  UPDATE statuses SET quotes_count = quotes_count + 1 WHERE id = NEW.quoted_status_id;
END;

CREATE TRIGGER quotes_count_changed AFTER UPDATE OF state, quoted_status_id ON quotes
WHEN (OLD.state = 'accepted' AND OLD.quoted_status_id IS NOT NULL) <> (NEW.state = 'accepted' AND NEW.quoted_status_id IS NOT NULL)
  OR (OLD.state = 'accepted' AND NEW.state = 'accepted' AND OLD.quoted_status_id IS NOT NEW.quoted_status_id)
BEGIN
  UPDATE statuses SET quotes_count = max(0, quotes_count - 1) WHERE OLD.state = 'accepted' AND id = OLD.quoted_status_id;
  UPDATE statuses SET quotes_count = quotes_count + 1 WHERE NEW.state = 'accepted' AND id = NEW.quoted_status_id;
END;

CREATE TRIGGER quotes_count_deleted AFTER DELETE ON quotes
WHEN OLD.state = 'accepted' AND OLD.quoted_status_id IS NOT NULL
BEGIN
  UPDATE statuses SET quotes_count = max(0, quotes_count - 1) WHERE id = OLD.quoted_status_id;
END;
