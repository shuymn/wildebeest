-- Kopje Store schema 0043: the provenance of a delivery. Never edit after release (checksummed).
--
-- VIS-30's send-time check (src/domain/deliveries.ts sendRefused) reads who is behind a row, which its inbox does not
-- say: a shared inbox serves many accounts, and an inbox may be on another host than its accounts. Staging writes it
-- with each target (the outbound_targets JSON keys accounts, domains and many), and expansion copies it here:
--
--   recipient_accounts   a JSON array of the remote recipients' account ids, at most 16; NULL above that or when
--                        unknown.
--   recipient_domains    a JSON array of the distinct hosts of their actor ids, at most 16; NULL above that or when
--                        unknown.
--   recipients_many      1 when more than 16 recipients are behind the row: not all of them are unavailable.
--
-- A row with none of them has no provenance: the rows queued before this file, phase A's staged reach, and the earlier
-- receivers of a retraction. The check then reads the inbox host only. The JSON arrays carry no CHECK.
--
-- Cost: three ALTERs adding a column with no default and no CHECK, a change of the schema alone that reads and
-- writes no row (test/migrations.test.ts, 0043). Measured on the benchmark store of test/bench/migration-cost.ts in
-- workerd's local Durable Object SQLite: see the CHANGELOG entry for this release.

ALTER TABLE deliveries ADD COLUMN recipient_accounts TEXT;
ALTER TABLE deliveries ADD COLUMN recipient_domains TEXT;
ALTER TABLE deliveries ADD COLUMN recipients_many INTEGER;
