-- Migration number: 0005 	 2023-02-07T10:57:21.848Z

CREATE TABLE "idempotency_keys" (
  "key" TEXT PRIMARY KEY,
  "object_id" TEXT NOT NULL,
  "expires_at" DATETIME NOT NULL,

  CONSTRAINT "idempotency_keys_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "objects" ("id")
);
