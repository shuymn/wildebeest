-- Kopje Store schema 0078: filter text units. Never edit after release (checksummed).
--
--   statuses.filter_text_units    NULL, or the UTF-16 code units of the status's searchable text
--                                 (Status#searchable_text, status-presenter.ts searchableText) cut at MAX_FILTER_TEXT
--                                 (10,000), as measureFilterText measures it after its writer stored the text, poll
--                                 and media. NULL: not measured (stored before 0078, converted, a boost, an input of
--                                 another storage class, or a text changed without a new measure); the filter text
--                                 level then reads filterTextBoundSql, an upper bound. Every row the upgrade carries
--                                 holds NULL.
--   statuses_filter_text_insert   BEFORE INSERT and BEFORE UPDATE OF filter_text_units on statuses:
--   statuses_filter_text_update   RAISE(ABORT, 'statuses: filter_text_units past its stored bound') for any value
--                                 but NULL or an integer from 0 to 10,000.
--   statuses_filter_text_stale    AFTER UPDATE OF content, spoiler_text, source_text on statuses: a measure the text
--                                 change left behind is cleared (one row, by key). Writers clear it in the same SET
--                                 and measure again, so it fires only for a writer that does neither.
--
-- Bounds and the predicate: src/platform/stored-bounds.ts (filterTextUnitsPastBoundSql); the statements below are the
-- output of filterTextUnitsMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the column has no default or CHECK, so adding it reads and rewrites no row; no index is made (the column is
-- read only with its row, by key); the triggers read no row.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 statuses with their
-- mentions, tags, media and cards, 2,000,000 notifications) in workerd's local Durable Object SQLite, the Store's
-- foreign key check skipped as declared: 5 ms for the upgrade of this file through the kernel, within the budget, at a
-- load average of about 6.

ALTER TABLE statuses ADD COLUMN filter_text_units INTEGER;

CREATE TRIGGER statuses_filter_text_insert BEFORE INSERT ON statuses
WHEN CASE WHEN NEW.filter_text_units IS NULL THEN 0
	WHEN typeof(NEW.filter_text_units) <> 'integer' THEN 1
	WHEN NEW.filter_text_units NOT BETWEEN 0 AND 10000 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: filter_text_units past its stored bound');
END;

CREATE TRIGGER statuses_filter_text_update BEFORE UPDATE OF filter_text_units ON statuses
WHEN CASE WHEN NEW.filter_text_units IS NULL THEN 0
	WHEN typeof(NEW.filter_text_units) <> 'integer' THEN 1
	WHEN NEW.filter_text_units NOT BETWEEN 0 AND 10000 THEN 1
	ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'statuses: filter_text_units past its stored bound');
END;

CREATE TRIGGER statuses_filter_text_stale AFTER UPDATE OF content, spoiler_text, source_text ON statuses
WHEN NEW.filter_text_units IS NOT NULL
BEGIN
  UPDATE statuses SET filter_text_units = NULL WHERE id = NEW.id;
END;
