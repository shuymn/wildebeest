PRAGMA foreign_keys = false;
DROP TABLE actor_reblogs;
ALTER TABLE new_actor_reblogs RENAME TO actor_reblogs;
PRAGMA foreign_keys = true;

CREATE INDEX IF NOT EXISTS actor_reblogs_actor_id ON actor_reblogs(actor_id);
CREATE INDEX IF NOT EXISTS actor_reblogs_object_id ON actor_reblogs(object_id);
