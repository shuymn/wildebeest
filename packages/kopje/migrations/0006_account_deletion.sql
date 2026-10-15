-- Kopje Store schema 0006: accounts whose deletion has started. Never edit after release (checksummed).
--
-- accounts.deleted_at is the time a remote actor's deletion started (its Delete arrived): the purge job that removes
-- what the account has (domain/inbox.ts, purgeBatch) sets it in its first transaction, and the account row goes with
-- the purge's last batch. From then on the account is unavailable (availableSql in src/domain/audience.ts, R1): its
-- statuses, notifications and interactions are shown to nobody while the purge still removes them. Only a remote
-- account is deleted this way: the CHECK refuses the column on a local account.
--
-- The partial index accounts_deleted holds only those accounts, so availableSql's lookup of an account that is not
-- being deleted finds nothing in it and reads no row.
--
-- A purge already running when this file is applied marks its account from the time the purge began; each running
-- purge finds its account by its unique uri. The CHECK and the index build each pass over accounts once.

ALTER TABLE accounts ADD COLUMN deleted_at TEXT CHECK (deleted_at IS NULL OR domain IS NOT NULL);

UPDATE accounts SET deleted_at = (
	SELECT strftime('%Y-%m-%dT%H:%M:%fZ', j.created_at / 1000.0, 'unixepoch') FROM inbound_jobs j
	WHERE j.kind = 'purge' AND j.key = accounts.uri
)
WHERE domain IS NOT NULL
	AND uri IN (SELECT key FROM inbound_jobs WHERE kind = 'purge' AND done_at IS NULL);

CREATE INDEX accounts_deleted ON accounts (id) WHERE deleted_at IS NOT NULL;
