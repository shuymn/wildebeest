CREATE TABLE IF NOT EXISTS client_credentials (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  scopes TEXT NOT NULL,
  cdate DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
);
