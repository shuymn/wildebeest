UPDATE actors SET domain = substr(substr(id, instr(id, '//') + 2), 0, instr(substr(id, instr(id, '//') + 2), '/'));

UPDATE actors SET properties = json_set(properties, '$.type', type) WHERE json_extract(properties, '$.type') IS NULL;

UPDATE actors SET properties = json_set(properties, '$.id', id) WHERE json_extract(properties, '$.id') IS NULL;

UPDATE actors SET properties = json_set(properties, '$.featured', id || '/featured')
  WHERE json_extract(properties, '$.featured') IS NULL AND email IS NOT NULL;

UPDATE actors SET properties = json_set(properties, '$.publicKey', json_patch(json_object('id', id || '#main-key'), json_object('publicKeyPem', pubkey)))
  WHERE json_extract(properties, '$.publicKey') IS NULL AND email IS NOT NULL;

UPDATE actors SET mastodon_id = printf('%s-%s-%s-%s-%s', lower(hex(randomblob(4))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(6)))) WHERE mastodon_id IS NULL;

DROP INDEX `actors_email`;
ALTER TABLE `actors` DROP COLUMN `email`;
ALTER TABLE `actors` DROP COLUMN `pubkey`;
ALTER TABLE `actors` DROP COLUMN `privkey`;
ALTER TABLE `actors` DROP COLUMN `privkey_salt`;
ALTER TABLE `actors` DROP COLUMN `is_admin`;
