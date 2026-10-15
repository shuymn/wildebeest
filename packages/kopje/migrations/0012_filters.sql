-- Kopje Store schema 0012: filters. Never edit after release (checksummed).
--
-- A filter belongs to a local account and goes with it, as Mastodon's custom_filters do (account_id, ON DELETE
-- CASCADE). context is a JSON array of the contexts it applies in (home, notifications, public, thread, account);
-- action is warn, hide or blur; expires_at is an ISO 8601 UTC time, or NULL for never. A filter matches a status by its
-- keywords (filter_keywords, whole_word as Mastodon's CustomFilterKeyword#to_regex reads it) or by the statuses it names
-- (filter_statuses, which go with their status). src/domain/filters.ts caps the filters of an account and the keywords
-- and statuses of a filter, so the viewer's filters for a context are read and compiled whole on each read.
--
-- filters_account reads an account's filters in id order; filter_keywords_filter and filter_statuses_pair read a
-- filter's rules, and filter_statuses_pair seeks a filter's row for one status, so a page's statuses are matched by
-- seeks per filter however many statuses other filters name. filter_statuses_status lets a status's deletion find its
-- rows. The file only creates empty tables: its work does not grow with the Store.

CREATE TABLE filters (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  context TEXT NOT NULL CHECK (json_valid(context) AND json_type(context) = 'array'),
  action TEXT NOT NULL DEFAULT 'warn' CHECK (action IN ('warn', 'hide', 'blur')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX filters_account ON filters (account_id, id);

CREATE TABLE filter_keywords (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  filter_id TEXT NOT NULL REFERENCES filters (id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  whole_word INTEGER NOT NULL DEFAULT 1 CHECK (whole_word IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX filter_keywords_filter ON filter_keywords (filter_id, id);

CREATE TABLE filter_statuses (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  filter_id TEXT NOT NULL REFERENCES filters (id) ON DELETE CASCADE,
  status_id TEXT NOT NULL REFERENCES statuses (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX filter_statuses_pair ON filter_statuses (filter_id, status_id);
CREATE INDEX filter_statuses_status ON filter_statuses (status_id);
