-- Kopje Store schema 0012: scheduled statuses. Never edit after release (checksummed).
--
-- A scheduled status is a post a local account asked to publish later (Mastodon's ScheduledStatus): the parameters
-- of the post, checked when it was scheduled, and the time it is due. It belongs to its account alone and goes with
-- it. src/domain/scheduled-statuses.ts writes and reads it; nothing else reads it, so nothing of it is shown,
-- notified or delivered before the cron publishes it through the path of an ordinary post, in the transaction that
-- deletes the row.
--
-- params is the post as a JSON object of a fixed shape (REST::ScheduledStatusSerializer's params), bounded by the
-- bounds of what it holds (the status text's raw bound, at most four media ids) and, here, to 128 KiB. client_key is
-- the sha256 of the Idempotency-Key it was scheduled with, unique per account as statuses.client_key is.
--
-- media_attachments.scheduled_status_id holds the uploads a scheduled status will attach, in their order
-- (position). Such an upload has neither status_id nor gc_at, so the sweep of unattached uploads (gc_at) leaves it, and
-- nothing else attaches it. Publication attaches it to the new status; deleting the scheduled status, or dropping it
-- at publication, detaches it with a new grace period, as deleting a status does.
--
-- The indexes: an account's scheduled statuses by id (the API's pages), by time (the daily limit), and all of them by
-- time (the cron's due ones). The table is new and the column starts NULL; adding it checks each stored upload once,
-- and the partial index over it is built in one pass over media_attachments.

CREATE TABLE scheduled_statuses (
  id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 18 AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*'),
  account_id TEXT NOT NULL REFERENCES local_accounts (account_id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL CHECK (length(scheduled_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_at) = scheduled_at),
  params TEXT NOT NULL CHECK (json_valid(params) AND json_type(params) = 'object' AND length(CAST(params AS BLOB)) <= 131072),
  client_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, client_key)
);

CREATE INDEX scheduled_statuses_account ON scheduled_statuses (account_id, id);

CREATE INDEX scheduled_statuses_account_time ON scheduled_statuses (account_id, scheduled_at);

CREATE INDEX scheduled_statuses_due ON scheduled_statuses (scheduled_at, id);

ALTER TABLE media_attachments ADD COLUMN scheduled_status_id TEXT
  REFERENCES scheduled_statuses (id) ON DELETE SET NULL
  CHECK (scheduled_status_id IS NULL OR status_id IS NULL);

CREATE INDEX media_attachments_scheduled ON media_attachments (scheduled_status_id, position)
  WHERE scheduled_status_id IS NOT NULL;
