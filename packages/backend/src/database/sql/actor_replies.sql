-- name: InsertReply :exec
INSERT INTO
  actor_replies (id, actor_id, object_id, in_reply_to_object_id)
VALUES
  (?, ?, ?, ?);
