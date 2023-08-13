-- name: InsertIdSequence :one
INSERT INTO
  id_sequences ("key", "value")
VALUES
  (
    ?1,
    COALESCE(
      (
        SELECT
          "value"
        FROM
          id_sequences
        WHERE
          "key" = ?1
      ),
      0
    ) + 1
  )
ON CONFLICT ("key") DO
UPDATE
SET
  "value" = excluded."value" RETURNING "value";
