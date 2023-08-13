-- name: InsertUser :exec
INSERT INTO
  users ("id", "actor_id", "email", "privkey", "privkey_salt", "pubkey", "is_admin", "cdate")
VALUES
  (?, ?, ?, ?, ?, ?, ?, ?);

-- name: SelectUserByEmail :one
SELECT
  actors."id",
  actors."mastodon_id",
  actors."type",
  users."pubkey",
  actors."cdate",
  actors."properties",
  users.is_admin
FROM
  actors
  INNER JOIN users ON users.actor_id = actors.id
WHERE
  email = ?;

-- name: SelectAdminByEmail :one
SELECT
  actors."id",
  actors."mastodon_id",
  actors."type",
  users."pubkey",
  actors."cdate",
  actors."properties"
FROM
  actors
  INNER JOIN users ON users.actor_id = actors.id
WHERE
  users.is_admin = 1
  AND users.email = ?;
