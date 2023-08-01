CREATE TABLE IF NOT EXISTS actor_activities (
    id TEXT NOT NULL PRIMARY KEY,
    actor_id TEXT NOT NULL,
    type TEXT NOT NULL GENERATED ALWAYS AS (json_extract(activity, '$.type')) STORED,
    cdate DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),
    activity TEXT NOT NULL,

    FOREIGN KEY(actor_id) REFERENCES actors(id) ON DELETE CASCADE
);
