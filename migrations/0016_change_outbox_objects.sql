CREATE TABLE "new_outbox_objects" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "published_date" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
  "to" TEXT NOT NULL DEFAULT (json_array()),
  "cc" TEXT NOT NULL DEFAULT (json_array()),

  CONSTRAINT "outbox_objects_actor_id_fkey" FOREIGN KEY ("actor_id")  REFERENCES "actors" ("id") ON DELETE CASCADE,
  CONSTRAINT "outbox_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id") ON DELETE CASCADE
);

INSERT INTO new_outbox_objects (id, actor_id, object_id, cdate, published_date, `to`)
SELECT id, actor_id, object_id, cdate, published_date, json_array(target) FROM outbox_objects;

DROP TABLE outbox_objects;
ALTER TABLE new_outbox_objects RENAME TO outbox_objects;

CREATE INDEX "outbox_objects_actor_id" ON "outbox_objects" ("actor_id");
CREATE INDEX "outbox_objects_to" ON "outbox_objects" ("to");
CREATE INDEX "outbox_objects_cc" ON "outbox_objects" ("cc");
