-- name: InsertActor :exec
INSERT INTO
  actors ("id", "mastodon_id", "type", "username", "domain", "properties", "cdate")
VALUES
  (?, ?, ?, ?, ?, ?, ?);

-- name: UpdateActorAlias :exec
UPDATE actors
SET
  properties = JSON_SET(
    properties,
    '$.alsoKnownAs',
    IIF(
      JSON_EXTRACT(properties, '$.alsoKnownAs') IS NULL,
      JSON_ARRAY(@alias),
      JSON_SET(JSON_EXTRACT(properties, '$.alsoKnownAs'), '$[#]', @alias)
    )
  )
WHERE
  id = @id;

-- name: UpdateActorMastodonIdByMastodonId :exec
UPDATE actors
SET
  mastodon_id = @next
WHERE
  mastodon_id = @current;

-- name: SelectActor :one
SELECT
  "id",
  "mastodon_id",
  "type",
  "properties",
  "cdate"
FROM
  actors
WHERE
  id = ?;

-- name: SelectActorByMastodonId :one
SELECT
  "id",
  "mastodon_id",
  "type",
  "properties",
  "cdate"
FROM
  actors
WHERE
  mastodon_id = ?;

-- name: SelectActorByUsernameAndDomain :one
SELECT
  "id",
  "mastodon_id",
  "type",
  "properties",
  "cdate"
FROM
  actors
WHERE
  username = LOWER(@username)
  AND domain = @domain;

-- name: DeleteActor :exec
DELETE FROM actors
WHERE
  id = ?;
