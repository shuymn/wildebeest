-- Changed from cloudflare/wildebeest (Apache-2.0) by the Kopje contributors.
-- Migration number: 0003 	 2023-02-02T15:03:27.478Z

CREATE TABLE "peers" (
  "domain" TEXT UNIQUE NOT NULL
);
