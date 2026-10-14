-- Kopje Store schema 0003: domain blocks in the form they are matched in. Never edit after release (checksummed).
--
-- A domain block is compared as stored with an account's normalized domain and actor host (domain/audience.ts,
-- inDomainSql), so a stored domain must be what the API stores: lowercase (the schema checks it), punycode and without
-- a trailing dot. Converters before this release kept a legacy block's trailing dot ('blocked.example.'), which the
-- Store matched by normalizing at compare time; such a row would stop applying. Here each such row loses its trailing
-- dots, and a row that then names a domain its account already blocks is merged into the oldest one (the survivor).
-- Rows in another case cannot exist (the CHECK), and Unicode domains need no fix: legacy only stored ASCII
-- letter-digit-hyphen names (its domainPattern) and Kopje's API stores punycode.
--
-- A cleanup is written only by the API's block, which never stores a trailing dot, so no merged row is expected to
-- have one. Should one, it moves to the survivor unless the survivor has its own (UPDATE OR IGNORE keeps the first),
-- and the cleanups left on merged rows go with them.

UPDATE OR IGNORE domain_block_cleanups
SET domain_block_id = (
  SELECT min(s.id) FROM domain_blocks d JOIN domain_blocks s
    ON s.account_id = d.account_id AND rtrim(s.domain, '.') = rtrim(d.domain, '.')
  WHERE d.id = domain_block_cleanups.domain_block_id
)
WHERE domain_block_id IN (
  SELECT d.id FROM domain_blocks d JOIN domain_blocks s
    ON s.account_id = d.account_id AND rtrim(s.domain, '.') = rtrim(d.domain, '.') AND s.id < d.id
);

DELETE FROM domain_block_cleanups WHERE domain_block_id IN (
  SELECT d.id FROM domain_blocks d JOIN domain_blocks s
    ON s.account_id = d.account_id AND rtrim(s.domain, '.') = rtrim(d.domain, '.') AND s.id < d.id
);

DELETE FROM domain_blocks WHERE id IN (
  SELECT d.id FROM domain_blocks d JOIN domain_blocks s
    ON s.account_id = d.account_id AND rtrim(s.domain, '.') = rtrim(d.domain, '.') AND s.id < d.id
);

UPDATE domain_blocks SET domain = rtrim(domain, '.') WHERE domain LIKE '%.';
