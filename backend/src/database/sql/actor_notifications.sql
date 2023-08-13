-- name: SelectNotificationsByActorId :many
SELECT
  objects.id,
  objects.type,
  objects.properties,
  objects.mastodon_id,
  objects.cdate,
  objects.original_actor_id,
  actor_notifications.type AS notification_type,
  actor_notifications.actor_id AS notification_actor_id,
  actor_notifications.from_actor_id AS notification_from_actor_id,
  actor_notifications.cdate AS notification_cdate,
  actor_notifications.id AS notification_id
FROM
  actor_notifications
  LEFT JOIN objects ON objects.id = actor_notifications.object_id
WHERE
  actor_notifications.actor_id = ?1
ORDER BY
  actor_notifications.cdate DESC
LIMIT
  ?2;

-- name: SelectNotificationsByIdAndActorId :one
SELECT
  objects.id,
  objects.type,
  objects.properties,
  objects.mastodon_id,
  objects.cdate,
  objects.original_actor_id,
  actor_notifications.type AS notification_type,
  actor_notifications.actor_id AS notification_actor_id,
  actor_notifications.from_actor_id AS notification_from_actor_id,
  actor_notifications.cdate AS notification_cdate,
  actor_notifications.id AS notification_id
FROM
  actor_notifications
  LEFT JOIN objects ON objects.id = actor_notifications.object_id
WHERE
  actor_notifications.id = ?
  AND actor_notifications.actor_id = ?;
