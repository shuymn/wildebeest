CREATE TABLE "client_credentials" (
  "id" TEXT PRIMARY KEY,
  "client_id" TEXT NOT NULL,
  "access_token" TEXT NOT NULL,
  "scopes" TEXT NOT NULL,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "client_credentials_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients" ("id") ON DELETE CASCADE
);
