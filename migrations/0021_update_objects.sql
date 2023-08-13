UPDATE objects
SET
  properties = JSON_SET(properties, '$.id', id)
WHERE
  JSON_EXTRACT(properties, '$.id') IS NULL;

DELETE FROM outbox_objects
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM inbox_objects
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM actor_notifications
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM actor_favourites
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM actor_reblogs
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM actor_replies
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  )
  OR in_reply_to_object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM idempotency_keys
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM note_hashtags
WHERE
  object_id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

DELETE FROM objects
WHERE
  id IN (
    SELECT
      id
    FROM
      objects
    WHERE
      original_object_id IN (
        SELECT
          id
        FROM
          objects
      )
  );

UPDATE objects
SET
  original_object_id = id
WHERE
  original_object_id IS NULL;

UPDATE objects
SET
  reply_to_object_id = JSON_EXTRACT(properties, '$.inReplyTo');
