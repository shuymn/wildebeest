-- name: SelectObjectRevisionsByObjectID :many
SELECT
  properties
FROM
  object_revisions
WHERE
  object_id = ?;

-- name: InsertObjectRevision :exec
INSERT INTO
  object_revisions ("object_id", "properties")
VALUES
  (?, ?);
