-- Kopje Store schema 0059: the contact account and activity. Never edit after release (checksummed).
--
--   local_accounts.active_on   NULL (never recorded), or the UTC day YYYY-MM-DD of the account's last authenticated
--                              API or web request (src/domain/auth.ts noteActivity), which /api/v2/instance counts as
--                              usage.users.active_month. CHECK active_on_date refuses any other value.
--   instance_settings_contact_insert   BEFORE INSERT and BEFORE UPDATE OF name, value on instance_settings:
--   instance_settings_contact_update   RAISE(ABORT, 'instance_settings: a value past its stored bound') for a
--                              contact_username that is not a fixed point of its projection.
--
-- Bounds and the projection: src/platform/stored-bounds.ts (CONTACT_SETTING_BOUNDS); the statements below are the
-- output of contactActivityMigrationSql (test/migrations.test.ts compares them); stored form: docs/dump-format.md.
--
-- Cost: the CHECK reads the local accounts once; the triggers read no row. No row is rewritten: the column is NULL in
-- every row and no contact_username row exists before this migration.

ALTER TABLE local_accounts ADD COLUMN active_on TEXT
  CONSTRAINT active_on_date CHECK (active_on IS NULL OR (typeof(active_on) = 'text'
    AND length(CAST(active_on AS BLOB)) = 10 AND instr(CAST(active_on AS BLOB), x'00') = 0
    AND active_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(active_on) IS active_on));

-- 0049's triggers end in ELSE 0 and 0057's name only the trends settings; these bound contact_username.

CREATE TRIGGER instance_settings_contact_insert BEFORE INSERT ON instance_settings
WHEN NEW.name = 'contact_username' AND (CASE WHEN typeof(NEW.value) <> 'text' THEN NULL
	WHEN length(CAST(NEW.value AS BLOB)) > 509 THEN NULL
	WHEN instr(CAST(NEW.value AS BLOB), x'00') > 0 THEN NULL
	WHEN NEW.value = '' OR NEW.value GLOB '*[^-.0-9@A-Z_a-z]*' OR NEW.value GLOB '@*' OR NEW.value GLOB '*@'
		OR NEW.value GLOB '*@*@*' THEN NULL
	WHEN (CASE instr(NEW.value, '@') WHEN 0 THEN length(NEW.value) ELSE instr(NEW.value, '@') - 1 END)
		> 255 THEN NULL
	ELSE NEW.value END) IS NOT NEW.value
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;

CREATE TRIGGER instance_settings_contact_update BEFORE UPDATE OF name, value ON instance_settings
WHEN NEW.name = 'contact_username' AND (CASE WHEN typeof(NEW.value) <> 'text' THEN NULL
	WHEN length(CAST(NEW.value AS BLOB)) > 509 THEN NULL
	WHEN instr(CAST(NEW.value AS BLOB), x'00') > 0 THEN NULL
	WHEN NEW.value = '' OR NEW.value GLOB '*[^-.0-9@A-Z_a-z]*' OR NEW.value GLOB '@*' OR NEW.value GLOB '*@'
		OR NEW.value GLOB '*@*@*' THEN NULL
	WHEN (CASE instr(NEW.value, '@') WHEN 0 THEN length(NEW.value) ELSE instr(NEW.value, '@') - 1 END)
		> 255 THEN NULL
	ELSE NEW.value END) IS NOT NEW.value
BEGIN
  SELECT RAISE(ABORT, 'instance_settings: a value past its stored bound');
END;
