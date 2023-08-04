-- Migration number: 0003 	 2023-02-02T15:03:27.478Z

CREATE TABLE "peers" (
  "domain" TEXT UNIQUE NOT NULL
);
