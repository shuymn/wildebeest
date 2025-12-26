-- name: InsertRemoteObject :exec
INSERT INTO
  objects (
    "id",
    "mastodon_id",
    "type",
    "cdate",
    "original_actor_id",
    "original_object_id",
    "reply_to_object_id",
    "properties",
    "local"
  )
VALUES
  (?, ?, ?, ?, ?, ?, ?, ?, 0);

-- name: InsertLocalObject :exec
INSERT INTO
  objects (
    "id",
    "mastodon_id",
    "type",
    "cdate",
    "original_actor_id",
    "original_object_id",
    "reply_to_object_id",
    "properties",
    "local"
  )
VALUES
  (@id, @mastodonId, @type, @cdate, @originalActorId, @id, @replyToObjectId, @properties, 1);

-- name: UpdateObjectMastodonIdByMastodonId :exec
UPDATE objects
SET
  mastodon_id = @next
WHERE
  mastodon_id = @current;

-- name: SelectObject :one
SELECT
  *
FROM
  objects
WHERE
  id = ?;

-- name: SelectObjectByOriginalObjectId :one
SELECT
  *
FROM
  objects
WHERE
  original_object_id = ?;

-- name: SelectObjectByMastodonId :one
SELECT
  *
FROM
  objects
WHERE
  mastodon_id = ?;

-- name: UpdateObjectProperties :exec
UPDATE objects
SET
  properties = ?
WHERE
  id = ?;
