# Kopje scheduled backup

Kopje backs itself up once a day to S3-compatible storage outside Cloudflare. Every object is encrypted with
[age](https://age-encryption.org) to your public key before it leaves the Worker, so the storage provider (and anyone
who obtains the bucket) sees only ciphertext. No Cloudflare API token is involved. `src/jobs/backup.ts` implements it.

The job is on by default. Until the settings below are present it does nothing, and `kopje-admin health` reports
`backup: not-configured` with the names of the missing settings.

## What a backup contains

Under the prefix (`kopje-backup/` by default), for the backup of UTC day `<id>` (for example `2026-10-13`):

| Object                                | Content                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `backups/<id>/dump.kopje.age`         | The Store's dump, in the import format of [dump-format.md](dump-format.md)              |
| `media/<id>/originals/<media id>.age` | Each R2 original uploaded since the previous successful backup, one encrypted file each |
| `backups/<id>/manifest.json.age`      | The manifest. It is written last, so a backup without it is incomplete                  |

The manifest (JSON, once decrypted) lists:

- `id`, `createdAt`, and `kopje.version`, the Kopje version that made it;
- `schema.version` and `schema.migrations`, the Store's applied migrations (an import target must have the same);
- `dump`: its key, its size and SHA-256 as stored (`size`, `sha256`) and before encryption (`plaintext`);
- `media`: the originals copied by this backup (`objects`, each with both digests), after `media.after` up to
  `media.through`;
- `recipients`: the public keys it was encrypted to.

Media is incremental: each backup copies only the originals added since the previous one, under its own `media/<id>/`
folder. A restore needs every `media/` folder up to the backup it restores. Retention never deletes `media/`.
Originals uploaded within the last hour wait for the next day's backup, so an upload still in progress is never missed.
The served, re-encoded files (`files/` in R2) are not backed up.

## How it runs

The 5-minute cron starts a backup at the first run on or after `BACKUP_HOUR_UTC` each UTC day, and continues a backup
in progress. Nothing runs while the env sets `MAINTENANCE`.

1. **Dump.** The Store enters its dump freeze. It turns readonly, and inbound activities are spooled and replayed
   afterwards, so nothing is lost. The dump is read in 4 MiB chunks, encrypted as it streams, and uploaded in 8 MiB
   parts of one multipart upload. The freeze ends as soon as the last chunk is read. It also ends when the job fails,
   and within 3 minutes if the Worker dies, through the dump lease. The whole dump is never held in memory.
2. **Media.** New R2 originals are copied one by one, and progress is saved after each one. This stage stops after
   10 minutes and continues at the next cron, so a large media set spans several invocations. At most 2,000 originals
   go into one backup; the rest go into the next. Nothing is ever deleted from R2.
3. **Manifest**, then **retention**.

A backup that is interrupted resumes where it stopped. The one exception is an interrupted dump: age's stream
cannot be continued, so its upload is aborted and the dump starts again. Multipart uploads under `backups/` that no
run holds are aborted before each dump. A failure is recorded with a reason code and retried after an hour. A run that
dies three times in a row is recorded as `interrupted`.

The dump must finish within one cron invocation: 15 minutes of wall time, and 30 seconds of Worker CPU for the
5-minute cron. Reading the dump costs the Store's CPU, not the Worker's. In the Worker, age encrypts at about
300 MB/s and SHA-256 runs natively, so the CPU limit allows dumps of several GB, far more than a Kopje instance stores.
The wall time is mostly the upload: at 10 MB/s, 15 minutes is about 9 GB.

## Settings

Set the two credentials as secrets and the rest as variables (or as secrets; both work). Variables set in the
dashboard survive deploys (`keep_vars`).

```sh
wrangler secret put BACKUP_S3_ACCESS_KEY_ID
wrangler secret put BACKUP_S3_SECRET_ACCESS_KEY
```

| Name                          | Required | Default         | Meaning                                                                                             |
| ----------------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `BACKUP_AGE_RECIPIENT`        | yes      |                 | Your age public key (`age1...`). Several keys may be given, separated by spaces                     |
| `BACKUP_S3_ENDPOINT`          | yes      |                 | The S3 endpoint's https origin, without a path, for example `https://s3.eu-central-1.amazonaws.com` |
| `BACKUP_S3_BUCKET`            | yes      |                 | The bucket. Requests are path-style: `<endpoint>/<bucket>/<key>`                                    |
| `BACKUP_S3_ACCESS_KEY_ID`     | yes      |                 | Secret. The access key id                                                                           |
| `BACKUP_S3_SECRET_ACCESS_KEY` | yes      |                 | Secret. The secret access key                                                                       |
| `BACKUP_S3_REGION`            | no       | `us-east-1`     | The signing region (`auto` for some providers)                                                      |
| `BACKUP_S3_PREFIX`            | no       | `kopje-backup/` | Every object the job writes, lists or deletes is under it. Must end with `/`                        |
| `BACKUP_RETENTION`            | no       | `7`             | How many complete daily backups to keep (1-366)                                                     |
| `BACKUP_HOUR_UTC`             | no       | `0`             | The UTC hour from which the day's backup may start (0-23)                                           |
| `BACKUP_ENABLED`              | no       | `true`          | `false` turns the job off                                                                           |

Create the key pair on a machine you trust, and keep the identity (the private key) offline, never in Cloudflare:

```sh
age-keygen -o kopje-backup-key.txt    # prints the public key: age1...
```

Losing the identity makes every backup unreadable. Keep two copies, or give a second recipient.

The settings are checked apart from the rest of the configuration. A mistake there stops only the backup, which
`health` reports as `invalid` with the setting's name. The instance keeps serving.

### Storage requirements

Any S3-compatible storage that supports SigV4, path-style requests, multipart uploads and ListObjectsV2. AWS S3,
Backblaze B2, Wasabi and MinIO are examples. ListMultipartUploads is used to find abandoned uploads; where it is
missing, the job logs that and relies on the bucket's lifecycle rule. Configure in the bucket:

- a lifecycle rule that aborts incomplete multipart uploads after 1 day (a second line of cleanup);
- optionally, object versioning or object lock on the prefix with a retention longer than `BACKUP_RETENTION` days. The
  job's credentials can delete under the prefix, so this is what protects backups if the Worker or its secrets are
  compromised.

### Minimal credentials

The job needs to put, list and delete objects, and to abort and list multipart uploads, under its prefix only. It never
reads objects back. Give it its own key, not one that restores. For AWS (other providers have equivalent scoped keys;
for B2, an application key limited to the bucket and the name prefix):

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Action": ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
			"Resource": "arn:aws:s3:::BUCKET/kopje-backup/*"
		},
		{
			"Effect": "Allow",
			"Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
			"Resource": "arn:aws:s3:::BUCKET",
			"Condition": { "StringLike": { "s3:prefix": ["kopje-backup/*"] } }
		}
	]
}
```

Restoring uses `GetObject`, with credentials kept on your own machine.

## Retention

After each successful backup, the job lists `backups/` and keeps the newest `BACKUP_RETENTION` complete backups (with a
manifest). It deletes every backup older than the oldest kept one, complete or not. It deletes the manifest first, so a
half-deleted backup never looks complete. The newest complete backup is never deleted. It deletes only
`backups/<date>/dump.kopje.age` and `backups/<date>/manifest.json.age`; anything else in the bucket, `media/` included,
is left alone. A retention failure does not fail the backup. It is shown as `retentionFailure` and tried again after
the next backup.

## Status

`kopje-admin health` (and `GET /admin/health`) shows `checks.backup`:

| Field                         | Meaning                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `state`                       | `disabled`, `not-configured`, `invalid`, `idle`, `pending` (a run waits) or `running` |
| `lastSuccess`                 | The id, time, manifest key and `manifestSha256` of the last complete backup           |
| `lastFailure`                 | The id, time, stage and reason code of the last failure                               |
| `inProgress`                  | The run in progress: its stage, uploaded parts and media copied so far                |
| `retryAt`, `retentionFailure` | When a failed run is tried again; the last retention failure                          |

The check fails (and the public `/health` answers `fail`) when the last failure is newer than the last success, or when
the settings are invalid. "Not configured" is only a warning. Reason codes name the step and status, for example
`s3-upload-part-403`, `dump-dump-in-progress` or `interrupted`. They never contain a message from the storage
provider, a URL or a secret. Workers Logs has `kopje.backup.*` events with the same codes.

## Restore

You need the identity file, a copy of `kopje-admin`, and read access to the bucket with your own credentials.

1. **Choose the backup.** List `backups/` and take the newest `<id>` that has a `manifest.json.age`. Check that the
   SHA-256 of the downloaded `manifest.json.age` equals `manifestSha256` in that day's `kopje.backup.succeeded` log
   entry (or in `health` if it is the latest). Anyone with your public key and write access to the bucket could write
   a manifest that decrypts, so this ties the manifest to what your instance wrote.

2. **Download and decrypt** the manifest and the dump:

    ```sh
    age -d -i kopje-backup-key.txt -o manifest.json manifest.json.age
    age -d -i kopje-backup-key.txt -o dump.kopje dump.kopje.age
    ```

3. **Verify** them against the manifest (sizes and SHA-256, before and after encryption):

    ```sh
    kopje-admin backup-verify manifest.json dump.kopje --encrypted dump.kopje.age
    ```

4. **Import** into an empty Store whose `kopje-admin catalog` shows the manifest's `schema.migrations`. Run the same
   Kopje version, or deploy it first. Set the instance configuration with `kopje-admin config` (an import never carries
   it), then import:

    ```sh
    kopje-admin import dump.kopje
    ```

    The import checks the dump's own trailer again (table checksums, statement count and body SHA-256) and verifies
    the rows in the Store; see [dump-format.md](dump-format.md).

5. **Media.** Download every `media/<date>/` folder up to `<id>`, decrypt each file to its R2 key, verify, and put them
   back into the media bucket:

    ```sh
    for f in media/*/originals/*.age; do
      out="restore/originals/$(basename "$f" .age)"
      mkdir -p restore/originals && age -d -i kopje-backup-key.txt -o "$out" "$f"
    done
    # for each backup's manifest (each date folder's own manifest, while it is retained):
    kopje-admin backup-verify manifest.json dump.kopje --media restore
    for f in restore/originals/*; do
      wrangler r2 object put "kopje-media/originals/$(basename "$f")" --file "$f" --remote
    done
    ```

    Served images (`files/` in R2) are not in the backup, so restored media is not served until it is re-encoded.

Restore drills into a scratch instance follow the same steps.
