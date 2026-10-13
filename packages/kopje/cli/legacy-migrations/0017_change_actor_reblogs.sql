CREATE TABLE "new_actor_reblogs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mastodon_id" TEXT UNIQUE NOT NULL,
  "actor_id" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "outbox_object_id" TEXT UNIQUE NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "actor_reblogs_actor_id_fkey" FOREIGN KEY ("actor_id")  REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "actor_reblogs_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id") ON DELETE CASCADE,
  CONSTRAINT "actor_reblogs_outbox_object_id_fkey" FOREIGN KEY ("outbox_object_id") REFERENCES "outbox_objects" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "unique_actor_reblogs" ON "new_actor_reblogs" ("actor_id", "object_id");

-- D1 does not support transactions, so between the execution of the migration and
-- the deployment of the Workers, it will not be possible to receive or post reblogs.

-- Ideally, the id of the received or created announce activity should be inserted,
-- but since it was not retained, the URL is made to look appropriate even though it cannot be accessed.
-- And this query probably won't work in PostgreSQL.
INSERT INTO new_actor_reblogs (id, mastodon_id, actor_id, object_id, outbox_object_id, cdate)
SELECT
	'https://' || substr(
		tmp.object_id,
		instr(tmp.object_id, '//') + 2,
		instr(substr(tmp.object_id, instr(tmp.object_id, '//') + 2), '/') - 1
	) || '/ap/a/' || actor_reblogs.id AS id,
	actor_reblogs.id AS mastodon_id,
	actor_reblogs.actor_id,
	actor_reblogs.object_id,
	tmp.id AS outbox_object_id,
	actor_reblogs.cdate
FROM actor_reblogs
INNER JOIN (
	SELECT *, ROW_NUMBER() OVER (PARTITION BY actor_id, object_id ORDER BY cdate DESC) AS rn
	FROM outbox_objects
) tmp ON tmp.actor_id = actor_reblogs.actor_id AND tmp.object_id = actor_reblogs.object_id
WHERE tmp.rn = 1;

DROP TABLE actor_reblogs;
ALTER TABLE new_actor_reblogs RENAME TO actor_reblogs;
