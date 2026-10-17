-- Kopje Store schema 0036: the quotes list. Never edit after release (checksummed).
--
-- GET /api/v1/statuses/:id/quotes (src/domain/statuses.ts statusQuotes, R35) lists the accepted quotes of a status,
-- newest quoting status first, paged by the quoting status's id. Each page reads one window of candidates from its
-- cursor through this partial index: the accepted quotes of a status in quoting status order, so neither a quote in
-- another state nor the quotes beyond the window are read, however many the status has. quotes_quoted (migration
-- 0033_quotes) holds every quote of a status by its row, in no useful order, so a page would read and sort them all.
--
-- Cost: one pass over the quotes and a sort of the accepted ones; nothing else is read or written.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 3,000,000 follows,
-- 2,000,000 statuses with their mentions and tags, 200,000 quotes of which a quarter accepted, 10,000 reports, 20 local
-- accounts) in workerd's local Durable Object SQLite: 2,351 ms for the upgrade of this file through the kernel (its
-- bookmark, transaction and schema verification; 2,521 ms in a second run), within the 5,000 ms each migration file
-- may take.

CREATE INDEX quotes_accepted ON quotes (quoted_status_id, status_id) WHERE state = 'accepted';
