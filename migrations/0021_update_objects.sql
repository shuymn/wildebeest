UPDATE objects
SET
  properties = JSON_SET(properties, '$.id', id)
WHERE
  JSON_EXTRACT(properties, '$.id') IS NULL;

UPDATE objects
SET
  original_object_id = id
WHERE
  original_object_id IS NULL;

UPDATE objects
SET
  reply_to_object_id = JSON_EXTRACT(properties, '$.inReplyTo');
