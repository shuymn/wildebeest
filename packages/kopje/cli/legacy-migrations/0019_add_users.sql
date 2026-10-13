CREATE TABLE "users" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor_id" TEXT UNIQUE NOT NULL,
  "email" TEXT UNIQUE NOT NULL,
  "privkey" BLOB UNIQUE NOT NULL,
  "privkey_salt" BLOB UNIQUE NOT NULL,
  "pubkey" TEXT NOT NULL,
  "is_admin" INTEGER NOT NULL DEFAULT 0,
  "cdate" DATETIME NOT NULL DEFAULT (STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')),

  CONSTRAINT "users_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON DELETE RESTRICT
);
CREATE INDEX "users_email" ON "users" ("email");

INSERT INTO users(id, actor_id, email, privkey, privkey_salt, pubkey, cdate, is_admin)
SELECT
	printf('%s-%s-%s-%s-%s', lower(hex(randomblob(4))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(2))), lower(hex(randomblob(6)))) as id,
	id as actor_id,
	email,
	privkey,
	privkey_salt,
  pubkey,
	cdate,
	ifnull(is_admin = 1, 0) as is_admin
FROM actors
WHERE email IS NOT NULL;
