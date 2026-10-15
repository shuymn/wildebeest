-- Kopje Store schema 0013: polls. Never edit after release (checksummed).
--
-- A poll belongs to its status (Mastodon's Poll, at most one per status), local or remote, and goes with it (ON DELETE
-- CASCADE); its API id is its status's id. src/domain/polls.ts writes and reads it.
--
-- options are the choices' titles, a JSON array (at most 4 for a local poll, 100 for a remote one), bounded here to
-- 128 KiB; tallies the votes per choice, a JSON array of as many counts (Mastodon's cached_tallies), and votes_count
-- their sum; voters_count the accounts that voted (NULL when a remote poll does not say). They are counted as votes
-- are cast, or taken as the remote server reports them, and never recounted from poll_votes on read. expires_at is
-- when the poll ends (NULL: a remote poll without an end). ended marks a poll whose end the cron has handled (the
-- 'poll' notifications, once), and update_due_at when the Update of a local poll's counts is due (Mastodon's
-- DistributePollUpdateWorker, debounced); each has a partial index for the cron's rounds.
--
-- poll_votes are the votes cast: by a local account (in any poll it may see) or by a remote one (in a local poll), one
-- row per choice. A vote goes with its poll and with its account. uri is a remote vote's Note id. Only polls.ts reads
-- the table, and only a viewer's own votes are shown: who voted is never (R27).
--
-- status_edits.poll_options keeps the choices of a poll as each version of its status had them (StatusEdit's
-- poll_options); NULL: none.
--
-- New tables, and a column that starts NULL: it is quick.

CREATE TABLE polls (
  status_id TEXT NOT NULL PRIMARY KEY REFERENCES statuses (id) ON DELETE CASCADE,
  options TEXT NOT NULL CHECK (json_valid(options) AND json_type(options) = 'array'
    AND json_array_length(options) BETWEEN 1 AND 100 AND length(CAST(options AS BLOB)) <= 131072),
  tallies TEXT NOT NULL CHECK (json_valid(tallies) AND json_type(tallies) = 'array'),
  multiple INTEGER NOT NULL DEFAULT 0 CHECK (multiple IN (0, 1)),
  hide_totals INTEGER NOT NULL DEFAULT 0 CHECK (hide_totals IN (0, 1)),
  expires_at TEXT CHECK (expires_at IS NULL OR (length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at)),
  votes_count INTEGER NOT NULL DEFAULT 0 CHECK (votes_count >= 0),
  voters_count INTEGER CHECK (voters_count IS NULL OR voters_count >= 0),
  ended INTEGER NOT NULL DEFAULT 0 CHECK (ended IN (0, 1)),
  update_due_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (json_array_length(tallies) = json_array_length(options))
);

CREATE INDEX polls_ending ON polls (expires_at) WHERE ended = 0 AND expires_at IS NOT NULL;

CREATE INDEX polls_update_due ON polls (update_due_at) WHERE update_due_at IS NOT NULL;

CREATE TABLE poll_votes (
  id INTEGER PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls (status_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  choice INTEGER NOT NULL CHECK (choice >= 0 AND choice < 100),
  uri TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (poll_id, account_id, choice)
);

CREATE INDEX poll_votes_account ON poll_votes (account_id);

ALTER TABLE status_edits ADD COLUMN poll_options TEXT CHECK (poll_options IS NULL OR (json_valid(poll_options) AND json_type(poll_options) = 'array'));
