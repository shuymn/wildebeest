-- Kopje Store schema 0081: account invitations, the operator's list of who may make an account by signing in through
-- Access (MD-1, AUTH-9). Never edit after release (checksummed).
--
--   account_invitations             one row per invited identity: the email Access asserts, the username its account
--                                   takes, and when it was added. At most 10. An invitation is added or removed,
--                                   never changed; the first sign-in of its email makes the account and removes it
--                                   (src/domain/account-invitations.ts).
--   account_invitations_email       emails unique by SQLite's lower() (ASCII case only), the rule by which the sign-in
--                                   matches an email (src/domain/oauth.ts loginEmailMatchSql).
--   account_invitations_username    usernames unique ignoring ASCII case.
--   account_invitations_cap         RAISE(ABORT, 'account_invitations: more than 10') for an 11th row.
--   account_invitations_immutable   RAISE(ABORT) for any UPDATE.
--
-- Bounds: src/platform/stored-bounds.ts (INVITATION_EMAIL_BYTES, LOCAL_USERNAME_BYTES, MAX_ACCOUNT_INVITATIONS); the
-- statements below are the output of accountInvitationsMigrationSql (test/migrations.test.ts compares them); stored
-- form: docs/dump-format.md. No CHECK or trigger reads the time.
--
-- Cost: the table is new and empty and its triggers read no other table; nothing else is read or written. The file
-- creates a table, so it is not declared foreignKeys: 'unchanged' and the upgrade checks every reference of the Store.
-- Measured on the benchmark store of test/bench/migration-cost.ts (1,000,000 accounts, 20 local, 2,000,000 statuses
-- and the rest of its shape) in workerd's local Durable Object SQLite, the whole Store's foreign keys verified: 6,126 and
-- 7,746 ms for the upgrade of this file through the kernel in two runs, within the budget, at load averages of about
-- 10 and 21.

CREATE TABLE account_invitations (
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT account_invitation_email CHECK (typeof(email) = 'text'
    AND length(CAST(email AS BLOB)) BETWEEN 3 AND 254
    AND instr(CAST(email AS BLOB), x'00') = 0
    AND email NOT GLOB ('*[' || char(1) || '-' || char(32) || char(127) || ']*')
    AND instr(email, '@') > 1 AND instr(substr(email, instr(email, '@') + 1), '@') = 0
    AND substr(email, -1) <> '@'),
  CONSTRAINT account_invitation_username CHECK (typeof(username) = 'text'
    AND length(CAST(username AS BLOB)) BETWEEN 1 AND 30
    AND instr(CAST(username AS BLOB), x'00') = 0
    AND username NOT GLOB '*[^A-Za-z0-9_]*'),
  CONSTRAINT account_invitation_created_at_iso CHECK (typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at AND substr(created_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE UNIQUE INDEX account_invitations_email ON account_invitations (lower(email));

CREATE UNIQUE INDEX account_invitations_username ON account_invitations (lower(username));

CREATE TRIGGER account_invitations_cap BEFORE INSERT ON account_invitations
WHEN (SELECT count(*) FROM account_invitations) >= 10
BEGIN
  SELECT RAISE(ABORT, 'account_invitations: more than 10');
END;

CREATE TRIGGER account_invitations_immutable BEFORE UPDATE ON account_invitations
BEGIN
  SELECT RAISE(ABORT, 'account_invitations: an invitation is added or removed, never changed');
END;
