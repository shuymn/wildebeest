-- Kopje Store schema 0003: domain blocks in the form they are matched in. Never edit after release (checksummed).
--
-- A domain block is compared as stored with an account's normalized domain and actor host (domain/audience.ts,
-- inDomainSql), so a stored domain must be what the API stores: lowercase (the schema checks it), punycode and without
-- a trailing dot. Converters before this release kept a legacy block's trailing dot ('blocked.example.'), which the
-- Store matched by normalizing at compare time; such a row would stop applying. Here each such row loses its trailing
-- dots, and a row that then names a domain its account already blocks is merged into the survivor: the account's row
-- already in normal form, else the oldest dotted row of that domain.
-- Rows in another case cannot exist (the CHECK), and Unicode domains need no fix: legacy only stored ASCII
-- letter-digit-hyphen names (its domainPattern) and Kopje's API stores punycode.
--
-- A cleanup is written only by the API's block, which never stores a trailing dot, so no merged row is expected to
-- have one. Should one, it moves to the survivor unless the survivor has its own (UPDATE OR IGNORE keeps the first),
-- and the cleanups left on merged rows go with them.
--
-- The work follows the dotted rows, not the account's other blocks: each statement starts from rows ending in a dot
-- (one pass over the table, or from the few cleanups), and finds the survivor through the (account_id, domain) index,
-- with the normalizing function on the probe side only. Dotted rows of one domain are found in a range of that index
-- that starts at the domain followed by a dot.

UPDATE OR IGNORE domain_block_cleanups
SET domain_block_id = (SELECT COALESCE(
      (SELECT n.id FROM domain_blocks n WHERE n.account_id = x.account_id AND n.domain = rtrim(x.domain, '.')),
      (SELECT min(y.id) FROM domain_blocks y WHERE y.account_id = x.account_id
        AND y.domain >= rtrim(x.domain, '.') || '.' AND y.domain < rtrim(x.domain, '.') || '/'
        AND rtrim(y.domain, '.') = rtrim(x.domain, '.')))
  FROM domain_blocks x WHERE x.id = domain_block_cleanups.domain_block_id)
WHERE (SELECT x.domain FROM domain_blocks x WHERE x.id = domain_block_cleanups.domain_block_id) LIKE '%.';

DELETE FROM domain_block_cleanups
WHERE domain_block_id IN (SELECT x.id FROM domain_blocks x
  WHERE x.id = domain_block_cleanups.domain_block_id AND x.domain LIKE '%.' AND COALESCE(
      (SELECT n.id FROM domain_blocks n WHERE n.account_id = x.account_id AND n.domain = rtrim(x.domain, '.')),
      (SELECT min(y.id) FROM domain_blocks y WHERE y.account_id = x.account_id
        AND y.domain >= rtrim(x.domain, '.') || '.' AND y.domain < rtrim(x.domain, '.') || '/'
        AND rtrim(y.domain, '.') = rtrim(x.domain, '.'))) <> x.id);

DELETE FROM domain_blocks WHERE id IN (SELECT x.id FROM domain_blocks x
  WHERE x.domain LIKE '%.' AND COALESCE(
    (SELECT n.id FROM domain_blocks n WHERE n.account_id = x.account_id AND n.domain = rtrim(x.domain, '.')),
    (SELECT min(y.id) FROM domain_blocks y WHERE y.account_id = x.account_id
      AND y.domain >= rtrim(x.domain, '.') || '.' AND y.domain < rtrim(x.domain, '.') || '/'
      AND rtrim(y.domain, '.') = rtrim(x.domain, '.'))) <> x.id);

UPDATE domain_blocks SET domain = rtrim(domain, '.') WHERE domain LIKE '%.';
