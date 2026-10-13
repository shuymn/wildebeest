[Index](../README.md) ┊ [Troubleshooting](troubleshooting.md)

## Backing up your instance

Your instance's data lives in two places that only exist inside your Cloudflare account: the **D1 database** (actors, keys, statuses, follows, tokens) and the **Cloudflare Images** originals (avatars, headers, uploaded media). The `Backup` workflow (`.github/workflows/backup.yml`) copies both, **encrypted**, to an S3-compatible bucket **outside Cloudflare**, once a day.

Backups are **opt-in**: if the secrets below are not set, the workflow finishes successfully with a notice and does nothing. Nothing changes for forks that do not want it.

### Why the backup runs in GitHub Actions

The deploy workflow already holds a Cloudflare API token with full D1 access in your repository secrets, so running the backup from the same place does not widen the trust boundary. Plaintext exists only on the ephemeral runner, and both the dump and the manifest are encrypted with [age](https://github.com/FiloSottile/age) **before** they are uploaded. The destination credentials are write-oriented bucket credentials, and the age **private** identity is never put in GitHub — only the public recipient is.

### Required secrets

Set these as GitHub Actions **secrets** on your repository (Settings → Secrets and variables → Actions):

| Secret                         | Description                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `BACKUP_AGE_RECIPIENT`         | Your age **public** recipient (`age1...`, or an `ssh-ed25519 ...` public key). Not a secret key. |
| `BACKUP_S3_ENDPOINT`           | Endpoint URL of the S3-compatible bucket, e.g. `https://s3.us-west-004.backblazeb2.com`.    |
| `BACKUP_S3_REGION`             | Bucket region, e.g. `us-west-004`.                                                          |
| `BACKUP_S3_BUCKET`             | Bucket name.                                                                                |
| `BACKUP_S3_PREFIX`             | Optional key prefix inside the bucket, e.g. `wildebeest`.                                   |
| `BACKUP_S3_ACCESS_KEY_ID`      | Access key id for the bucket.                                                               |
| `BACKUP_S3_SECRET_ACCESS_KEY`  | Secret access key for the bucket.                                                           |

The workflow reuses the deploy secrets `CF_ACCOUNT_ID` and `CF_API_TOKEN`, and the optional variable `OVERRIDE_NAME_SUFFIX`, so there is nothing else to configure.

Pick a bucket **in a different provider than Cloudflare** — a backup that shares a failure domain with the thing it protects is not a backup.

### Cloudflare API token permissions

The backup needs a token that can, on the account that hosts the instance:

- **D1** — read and export (`Account → D1 → Read` is enough; the deploy token's `Edit` also works)
- **Cloudflare Images** — read (`Account → Cloudflare Images → Read`)
- **Cloudflare Pages** — read (`Account → Cloudflare Pages → Read`), used to find which D1 database the instance is actually bound to

The deploy token created by the one-click install already covers all three. If you prefer a separate, narrower token for backups, create one with exactly those three read permissions and store it as `CF_API_TOKEN` in a dedicated environment.

### What a backup contains

Under the bucket prefix:

- `d1/<YYYY>/<MM>/<DD>/<HHMMSSZ>/dump.sql.age` — the SQL dump, one `wrangler d1 export --remote --table …` per table concatenated. Tables are exported one at a time because a whole-database export fails when full-text-search virtual tables exist; FTS virtual tables and their shadow tables, `_cf_*` and `sqlite_*` are skipped and are rebuilt from the schema on restore.
- `d1/<…>/manifest.json.age` — table list, per-table row counts, export start and finish times, the applied migration level from `d1_migrations`, and the sha256 of the dump.
- `images/<image-id>.age` — one encrypted original per Cloudflare Image. This part is **incremental**: each run lists the account's images and uploads only the ids that are not in the bucket yet.

### Why the schedule is at 18:30 UTC

`wrangler d1 export` snapshots the database on Cloudflare's side, and during that snapshot **the database is unresponsive for roughly 1 second per 10 MB** of data. For a live instance that means a short window of request failures, so the job is scheduled at a low-traffic hour. Change the `cron` in `.github/workflows/backup.yml` to whatever is quietest for your instance, and avoid running `workflow_dispatch` during peak hours. The backup and deploy workflows share a concurrency group, so a deploy that starts during a backup waits for it instead of failing its migration step.

### Keep the age identity offline

Generate the key pair once, on a machine you control:

```bash
age-keygen -o wildebeest-backup-identity.txt
# prints: Public key: age1....
```

Put **only** the public key into `BACKUP_AGE_RECIPIENT`. Keep `wildebeest-backup-identity.txt` offline — a password manager, a hardware token or paper — and never in the repository, in GitHub secrets or on the runner. Without it no backup can be read; with it anyone can read every backup, including the instance's private keys and access tokens.

### Verifying a backup

Run the verify script on your own machine, with `age`, `jq` and `sqlite3` installed:

```bash
./scripts/backup/verify.sh \
  --identity ~/wildebeest-backup-identity.txt \
  --dump ./dump.sql.age \
  --manifest ./manifest.json.age
```

It decrypts both files, checks the dump against the sha256 in the manifest, loads the dump into a **fresh** sqlite3 database and compares every table's row count with the manifest. It exits non-zero on any mismatch. Do this after your first successful backup, and occasionally afterwards — an unverified backup is a guess.

### Restoring

1. Download the newest `d1/<…>/` pair from the bucket and verify it as above.
2. Decrypt the dump: `age -d -i <identity> -o dump.sql dump.sql.age`.
3. Create a fresh D1 database: `npx wrangler d1 create wildebeest-<suffix>-restored`.
4. Load the dump: `npx wrangler d1 execute wildebeest-<suffix>-restored --remote --file dump.sql`.
5. Bind the restored database as `DATABASE` on the **production** environment of the `wildebeest-<suffix>` Pages project.
6. Re-run the deploy workflow. It reads the `DATABASE` binding of the Pages project and migrates **that** database, so it will pick up the restored one and will not create another.
7. Re-upload the images you need: `age -d -i <identity> images/<id>.age` and push each original back through the Cloudflare Images API. Image ids are referenced from the database rows, so keep the ids you restore.

Restoring does **not** restore the VAPID keys, which live in the `wildebeest-terraform-<suffix>-state` KV namespace under `vapid_jwk`. If that namespace is intact the deploy reuses them; if it is gone the deploy stops rather than silently issuing new keys, because new keys invalidate every existing Web Push subscription.
