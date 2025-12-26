-- name: SelectAllPeerDomains :many
SELECT
  domain
FROM
  peers;

-- name: InsertPeer :exec
INSERT OR IGNORE INTO
  peers (domain)
VALUES
  (?);
