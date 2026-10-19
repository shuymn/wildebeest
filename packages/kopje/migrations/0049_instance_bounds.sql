-- Kopje Store schema 0049: bounds of the instance's public settings, and the public block list's index. Never edit
-- after release (checksummed).
--
-- RES-2: store every covered setting as P(x), keeping no copy, then refuse writes outside P's fixed points.
-- Projections, writers and bounds: src/platform/stored-bounds.ts (INSTANCE_SETTING_BOUNDS). It:
--
--   rewrites title and description cut to 1,024 and 200 code points;
--   deletes every covered row whose P is no row: contact_email past 254 bytes, rules past 65,536 bytes or not a JSON
--   array, extended_description, privacy_policy and terms_of_service past 50,000 bytes, any of these blank (only
--   space, tab, LF, VT, FF and CR), and a date, switch or stamp outside its form;
--   instance_settings_bounds_insert   BEFORE INSERT and BEFORE UPDATE OF name, value on instance_settings:
--   instance_settings_bounds_update   RAISE(ABORT, 'instance_settings: a value past its stored bound') when
--                                     P(NEW.value) IS NOT NEW.value for a covered name; other names are untouched;
--   instance_domain_blocks_public     the suspend blocks by domain: the public block list's chunks
--                                     (domain/instance-domain-blocks.ts publicDomainBlocks) never visit a noop block.
--
-- The statements below are the output of instanceBoundsMigrationSql (test/migrations.test.ts compares them).
-- Recovery of a rewritten value: the point-in-time bookmark the kernel records before the upgrade (docs/upgrade.md).
--
-- Cost: the instance settings (a few rows), and the partial index built over the suspend blocks; the upgrade's
-- verification then runs PRAGMA foreign_key_check over the Store. Measured on the benchmark store of
-- test/bench/migration-cost.ts (1,000,000 accounts, 2,000,000 statuses, 100,000 instance domain blocks of which 10,000
-- suspend, a value past its bound for each covered setting, and the rest of that store) in workerd's local Durable
-- Object SQLite, timing the whole upgrade through the kernel: 6,226 ms (6,515, 6,640 and 6,651 ms in three more runs,
-- at load averages of 5 to 30), within the 20,000 ms an upgrade may take; it is the overhead of an upgrade on a store
-- that size. Runs under heavier outside load took up to 15.6 s, while 0048_stored_bounds took 21 and 31 s.

UPDATE instance_settings SET value = CASE WHEN length(CAST(value AS BLOB)) <= 1024 THEN value ELSE substr(value, 1, 1024) END
WHERE name = 'title' AND (CASE WHEN length(CAST(value AS BLOB)) <= 1024 THEN value ELSE substr(value, 1, 1024) END) IS NOT value;

UPDATE instance_settings SET value = CASE WHEN length(CAST(value AS BLOB)) <= 200 THEN value ELSE substr(value, 1, 200) END
WHERE name = 'description' AND (CASE WHEN length(CAST(value AS BLOB)) <= 200 THEN value ELSE substr(value, 1, 200) END) IS NOT value;

DELETE FROM instance_settings
WHERE name IN ('title', 'description', 'contact_email', 'rules', 'extended_description', 'privacy_policy', 'terms_of_service', 'terms_of_service_effective_date', 'show_domain_blocks', 'show_domain_blocks_rationale', 'extended_description_updated_at', 'privacy_policy_updated_at') AND CASE name
  WHEN 'title' THEN (CASE WHEN trim(CASE WHEN length(CAST(value AS BLOB)) <= 1024 THEN value ELSE substr(value, 1, 1024) END, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE CASE WHEN length(CAST(value AS BLOB)) <= 1024 THEN value ELSE substr(value, 1, 1024) END END) IS NOT value
  WHEN 'description' THEN (CASE WHEN trim(CASE WHEN length(CAST(value AS BLOB)) <= 200 THEN value ELSE substr(value, 1, 200) END, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE CASE WHEN length(CAST(value AS BLOB)) <= 200 THEN value ELSE substr(value, 1, 200) END END) IS NOT value
  WHEN 'contact_email' THEN (CASE WHEN length(CAST(value AS BLOB)) > 254 THEN NULL WHEN trim(value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE value END) IS NOT value
  WHEN 'rules' THEN (CASE WHEN length(CAST(value AS BLOB)) > 65536 THEN NULL
	WHEN json_valid(value) THEN CASE WHEN json_type(value) = 'array' THEN value END END) IS NOT value
  WHEN 'extended_description' THEN (CASE WHEN length(CAST(value AS BLOB)) > 50000 THEN NULL WHEN trim(value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE value END) IS NOT value
  WHEN 'privacy_policy' THEN (CASE WHEN length(CAST(value AS BLOB)) > 50000 THEN NULL WHEN trim(value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE value END) IS NOT value
  WHEN 'terms_of_service' THEN (CASE WHEN length(CAST(value AS BLOB)) > 50000 THEN NULL WHEN trim(value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE value END) IS NOT value
  WHEN 'terms_of_service_effective_date' THEN (CASE WHEN length(CAST(value AS BLOB)) = 10 AND value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	AND date(value) = value THEN value END) IS NOT value
  WHEN 'show_domain_blocks' THEN (CASE WHEN value IN ('disabled', 'users', 'all') THEN value END) IS NOT value
  WHEN 'show_domain_blocks_rationale' THEN (CASE WHEN value IN ('disabled', 'users', 'all') THEN value END) IS NOT value
  WHEN 'extended_description_updated_at' THEN (CASE WHEN length(CAST(value AS BLOB)) = 24 AND substr(value, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', value) = value THEN value END) IS NOT value
  WHEN 'privacy_policy_updated_at' THEN (CASE WHEN length(CAST(value AS BLOB)) = 24 AND substr(value, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', value) = value THEN value END) IS NOT value
  ELSE 0 END;

CREATE TRIGGER instance_settings_bounds_insert BEFORE INSERT ON instance_settings
WHEN CASE NEW.name
  WHEN 'title' THEN (CASE WHEN trim(CASE WHEN length(CAST(NEW.value AS BLOB)) <= 1024 THEN NEW.value ELSE substr(NEW.value, 1, 1024) END, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE CASE WHEN length(CAST(NEW.value AS BLOB)) <= 1024 THEN NEW.value ELSE substr(NEW.value, 1, 1024) END END) IS NOT NEW.value
  WHEN 'description' THEN (CASE WHEN trim(CASE WHEN length(CAST(NEW.value AS BLOB)) <= 200 THEN NEW.value ELSE substr(NEW.value, 1, 200) END, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE CASE WHEN length(CAST(NEW.value AS BLOB)) <= 200 THEN NEW.value ELSE substr(NEW.value, 1, 200) END END) IS NOT NEW.value
  WHEN 'contact_email' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 254 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'rules' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 65536 THEN NULL
	WHEN json_valid(NEW.value) THEN CASE WHEN json_type(NEW.value) = 'array' THEN NEW.value END END) IS NOT NEW.value
  WHEN 'extended_description' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 50000 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'privacy_policy' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 50000 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'terms_of_service' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 50000 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'terms_of_service_effective_date' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) = 10 AND NEW.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	AND date(NEW.value) = NEW.value THEN NEW.value END) IS NOT NEW.value
  WHEN 'show_domain_blocks' THEN (CASE WHEN NEW.value IN ('disabled', 'users', 'all') THEN NEW.value END) IS NOT NEW.value
  WHEN 'show_domain_blocks_rationale' THEN (CASE WHEN NEW.value IN ('disabled', 'users', 'all') THEN NEW.value END) IS NOT NEW.value
  WHEN 'extended_description_updated_at' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) = 24 AND substr(NEW.value, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.value) = NEW.value THEN NEW.value END) IS NOT NEW.value
  WHEN 'privacy_policy_updated_at' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) = 24 AND substr(NEW.value, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.value) = NEW.value THEN NEW.value END) IS NOT NEW.value
  ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;

CREATE TRIGGER instance_settings_bounds_update BEFORE UPDATE OF name, value ON instance_settings
WHEN CASE NEW.name
  WHEN 'title' THEN (CASE WHEN trim(CASE WHEN length(CAST(NEW.value AS BLOB)) <= 1024 THEN NEW.value ELSE substr(NEW.value, 1, 1024) END, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE CASE WHEN length(CAST(NEW.value AS BLOB)) <= 1024 THEN NEW.value ELSE substr(NEW.value, 1, 1024) END END) IS NOT NEW.value
  WHEN 'description' THEN (CASE WHEN trim(CASE WHEN length(CAST(NEW.value AS BLOB)) <= 200 THEN NEW.value ELSE substr(NEW.value, 1, 200) END, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE CASE WHEN length(CAST(NEW.value AS BLOB)) <= 200 THEN NEW.value ELSE substr(NEW.value, 1, 200) END END) IS NOT NEW.value
  WHEN 'contact_email' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 254 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'rules' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 65536 THEN NULL
	WHEN json_valid(NEW.value) THEN CASE WHEN json_type(NEW.value) = 'array' THEN NEW.value END END) IS NOT NEW.value
  WHEN 'extended_description' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 50000 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'privacy_policy' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 50000 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'terms_of_service' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) > 50000 THEN NULL WHEN trim(NEW.value, char(32, 9, 10, 11, 12, 13)) = '' THEN NULL ELSE NEW.value END) IS NOT NEW.value
  WHEN 'terms_of_service_effective_date' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) = 10 AND NEW.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	AND date(NEW.value) = NEW.value THEN NEW.value END) IS NOT NEW.value
  WHEN 'show_domain_blocks' THEN (CASE WHEN NEW.value IN ('disabled', 'users', 'all') THEN NEW.value END) IS NOT NEW.value
  WHEN 'show_domain_blocks_rationale' THEN (CASE WHEN NEW.value IN ('disabled', 'users', 'all') THEN NEW.value END) IS NOT NEW.value
  WHEN 'extended_description_updated_at' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) = 24 AND substr(NEW.value, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.value) = NEW.value THEN NEW.value END) IS NOT NEW.value
  WHEN 'privacy_policy_updated_at' THEN (CASE WHEN length(CAST(NEW.value AS BLOB)) = 24 AND substr(NEW.value, 12, 2) < '24'
	AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.value) = NEW.value THEN NEW.value END) IS NOT NEW.value
  ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;

CREATE INDEX instance_domain_blocks_public ON instance_domain_blocks (domain) WHERE severity = 'suspend';
