# Kopje scheduled backup

Kopje backs itself up once a day to S3-compatible storage outside Cloudflare. Every object is encrypted with
[age](https://age-encryption.org) to your public key before it leaves the Worker, so the storage provider (and anyone
who obtains the bucket) sees only ciphertext. No Cloudflare API token is involved. `src/jobs/backup.ts` implements it.

The job is on by default. Until the settings below are present it does nothing, and `kopje-admin health` reports
`backup: not-configured` with the names of the missing settings.

## What a backup contains

Each backup run has an id, `<UTC date>-<8 hex digits>` (for example `2026-10-13-5f0c1a2b`). Each invocation that works
on it adds its own 16-hex-digit attempt id. Every object is written under both ids, below the prefix (`kopje-backup/`
by default):

| Object                                           | Content                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `backups/<run>/<attempt>/dump.kopje.age`         | The Store's dump, in the import format of [dump-format.md](dump-format.md) |
| `media/<run>/<attempt>/originals/<media id>.age` | One R2 original, encrypted on its own                                      |
| `backups/<run>/<attempt>/media-index.json.age`   | The media index of this backup (below)                                     |
| `backups/<run>/<attempt>/manifest.json.age`      | The manifest. It is written last, so a run without one is incomplete       |

The manifest (JSON, once decrypted) has:

- `id`, `attempt` and `createdAt`, and `kopje.version`, the Kopje version that made it;
- `schema.version` and `schema.migrations`, the Store's applied migrations (an import target must have the same);
- `dump` and `mediaIndex`: each object's key, its size and SHA-256 as stored (`size`, `sha256`) and before encryption
  (`plaintext`);
- `media`: the coverage counts, below;
- `recipients`: the public keys it was encrypted to.

The media index is complete, not incremental. It lists every original the dump references: completed local uploads,
whose original is at `originals/<media id>` in R2. Each entry is one of these:

- `copied`, with the object holding it, its size and SHA-256 before and after encryption, and the run that copied it.
  That may be an earlier run: an original is copied once per bucket and recipient set.
- `pending`: not copied yet. A backup copies at most 2,000 originals; the rest go into the next one.
- `absent`: not in R2 when the backup looked for it, for example because it was deleted after the dump.

### Media recovery guarantee

A complete backup restores exactly the originals its index marks `copied`, each verifiable against the index. The
index's digest is in the manifest. The manifest's `media` counts (`required`, `copied`, `pending`, `absent`) say how
much of the dump's media that is, and `kopje-admin backup-verify` reports every original that is missing. A backup can
be complete and still lack originals: `pending` ones are copied by later backups, and `absent` ones cannot be.

The served, re-encoded files (`files/` in R2) are not backed up. A restore puts the originals back, and
`kopje-admin media-rebuild` re-encodes them into the served files (restore step 6).

## How it runs

The 5-minute cron starts a backup at the first run on or after `BACKUP_HOUR_UTC`, once per UTC day, and only on a day
after the last successful backup's day. A clock that goes back never starts a second backup for a day that has one.
The cron also continues a backup in progress. Nothing runs while the env sets `MAINTENANCE`, or while an imported
Store is not published yet.

One invocation at a time holds the run. Its lease is kept in the Store and checked in the Store's transaction on every
save. Each invocation stops 13 minutes after it starts, leaving 2 minutes of the cron's 15-minute wall time. Every
request and its retries end in time for a last checkpoint.

1. **Dump.** The Store enters its dump freeze. It turns readonly, and inbound activities are spooled and replayed
   afterwards, so nothing is lost. The dump is read in 4 MiB chunks, encrypted as it streams, and uploaded in 8 MiB
   parts of one multipart upload. As soon as the last chunk has been read, one Store transaction checks that the
   freeze still holds, replaces the run's media membership with the originals the dump references, and ends the
   freeze, before the remaining parts are uploaded. If the freeze had already ended (its 3-minute lease ran out, so
   writes may have resumed), the dump fails as `dump-dump-lease-expired` and is taken again. On any failure the freeze
   is released first, before the upload is cleaned up, even if the start's answer was lost (the job aborts by its own
   id). If the Worker dies, the dump lease ends it. The whole dump is never held in memory.
2. **Media.** Each referenced original that this bucket does not hold yet is copied, and progress is saved after each
   one. When the invocation nears its deadline, or the next original would take it past its byte budget, it stops,
   and the next cron continues. Nothing is ever deleted from R2.
3. **Media index**, then **manifest**, then **retention**.

A backup that is interrupted resumes where it stopped. The one exception is an interrupted dump: age's stream state
cannot be saved, so its upload is aborted and the dump starts again. Each invocation first aborts the multipart uploads
under `backups/` that it can list, since no live invocation is writing them. A failure is recorded with a reason code
and retried after an hour. A run that dies three times in a row is recorded as `interrupted`.

A run is tied to the bucket settings (endpoint, bucket, region, prefix) and the recipients it started with. If either
changes, the run is abandoned and a new one starts. A copy of an original made under other settings counts as missing,
so a new bucket or a new key gets a full copy of the media.

**Fencing.** An invocation that loses the lease (it was too slow, or another one's clock ran ahead) can still finish a
request it already sent. That request only ever writes objects under its own attempt id. The backup the Store records
(`lastSuccess`, with the manifest's digest) is therefore never overwritten by a stale invocation. A stale invocation
can leave a second, self-consistent manifest for the same run, which retention treats as the same backup.

**Limits.** Each invocation encrypts at most 512 MiB, counted as plaintext bytes (the ciphertext is 16 bytes per
64 KiB larger). The budget keeps the work inside the cron's 30 seconds of Worker CPU; reading the dump costs the
Store's CPU, not the Worker's. In the Worker, age encryption plus both SHA-256 digests measured about 4 ms of CPU per
MiB on an Apple M4 Pro (Node.js 24; 512 MiB in 2.1 s). Encrypting media copies measured about 6 ms per MiB. Workers
CPUs are unmeasured; even four times slower, 512 MiB stays near 10 to 12 seconds.

- **Media** copying and the **media index** stop before the budget and continue at the next cron. An index too large
  for a whole invocation fails as `index-too-large`; that takes over a million originals.
- **The dump** cannot be split or resumed, so its plaintext must fit the budget: **the largest supported dump is
  512 MiB.** A larger one fails as `dump-too-large`, which `health` shows as the last failure. The instance keeps
  serving, and the freeze is released at once. A Kopje instance's dump is far smaller (the database size is in
  `kopje-admin capacity`). A larger dump needs a resumable dump format, which is not built.

The wall time is mostly upload: 11 minutes at 10 MB/s is about 6.5 GB. Serializing the job's state costs about 3 µs
per save, and the media index about 1 µs per original.

## Settings

Set the two credentials as secrets and the rest as variables (or as secrets; both work). Variables set in the
dashboard survive deploys (`keep_vars`).

```sh
wrangler secret put BACKUP_S3_ACCESS_KEY_ID
wrangler secret put BACKUP_S3_SECRET_ACCESS_KEY
```

| Name                          | Required | Default         | Meaning                                                                                                              |
| ----------------------------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_AGE_RECIPIENT`        | yes      |                 | Your age public key (`age1...`). Several keys may be given, separated by spaces                                      |
| `BACKUP_S3_ENDPOINT`          | yes      |                 | The S3 endpoint's https origin, without a path, for example `https://s3.eu-central-1.amazonaws.com`                  |
| `BACKUP_S3_BUCKET`            | yes      |                 | The bucket. Requests are path-style: `<endpoint>/<bucket>/<key>`                                                     |
| `BACKUP_S3_ACCESS_KEY_ID`     | yes      |                 | Secret. The access key id                                                                                            |
| `BACKUP_S3_SECRET_ACCESS_KEY` | yes      |                 | Secret. The secret access key                                                                                        |
| `BACKUP_S3_REGION`            | no       | `us-east-1`     | The signing region. It must match the bucket's region on AWS (for example `eu-central-1`); some providers use `auto` |
| `BACKUP_S3_PREFIX`            | no       | `kopje-backup/` | Every object the job writes, lists or deletes is under it. Must end with `/`                                         |
| `BACKUP_RETENTION`            | no       | `7`             | How many complete daily backups to keep (1-366)                                                                      |
| `BACKUP_HOUR_UTC`             | no       | `0`             | The UTC hour from which the day's backup may start (0-23)                                                            |
| `BACKUP_ENABLED`              | no       | `true`          | `false` turns the job off                                                                                            |

Create the key pair on a machine you trust, and keep the identity (the private key) offline, never in Cloudflare:

```sh
age-keygen -o kopje-backup-key.txt    # prints the public key: age1...
```

Losing the identity makes every backup unreadable. Keep two copies, or give a second recipient.

The settings are checked apart from the rest of the configuration. A mistake there stops only the backup, which
`health` reports as `invalid` with the setting's name. The instance keeps serving.

### Storage requirements

Any S3-compatible storage that supports SigV4, path-style requests, multipart uploads and ListObjectsV2. AWS S3,
Backblaze B2, Wasabi and MinIO are examples; only an in-memory test double has been exercised so far. In the bucket,
configure:

- **required:** a lifecycle rule that aborts incomplete multipart uploads after 1 day. The job aborts the uploads it
  can list, but listing them is optional (see below), and a dead invocation's upload is otherwise only cleaned up by
  this rule;
- **recommended:** object versioning or object lock on the prefix, with a retention longer than `BACKUP_RETENTION`
  days. The job's credentials can delete backups, so this is what protects them if the Worker or its secrets are
  compromised.

### Minimal credentials

The job writes objects under the prefix and deletes and aborts only under `backups/`. It never deletes `media/` and
never reads anything back. Give it its own key, not one that restores. For AWS:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Sid": "WriteBackupsAndMedia",
			"Effect": "Allow",
			"Action": "s3:PutObject",
			"Resource": "arn:aws:s3:::BUCKET/kopje-backup/*"
		},
		{
			"Sid": "PruneBackups",
			"Effect": "Allow",
			"Action": ["s3:DeleteObject", "s3:AbortMultipartUpload"],
			"Resource": "arn:aws:s3:::BUCKET/kopje-backup/backups/*"
		},
		{
			"Sid": "ListPrefix",
			"Effect": "Allow",
			"Action": "s3:ListBucket",
			"Resource": "arn:aws:s3:::BUCKET",
			"Condition": { "StringLike": { "s3:prefix": "kopje-backup/*" } }
		}
	]
}
```

`s3:ListBucketMultipartUploads` is optional. It does not support the `s3:prefix` condition, so granting it lets the
key list every upload in the bucket. Grant it only on a bucket dedicated to Kopje's backups; without it, the job logs
`kopje.backup.list_uploads_failed` and the lifecycle rule cleans up. On B2, use an application key limited to the
bucket and the name prefix.

Restoring uses `GetObject`, with credentials kept on your own machine.

## Retention

After each successful backup, the job lists `backups/` and keeps the newest `BACKUP_RETENTION` complete runs. A run is
complete when it has a manifest; runs are selected by manifest only. It deletes every run older than the oldest kept
one, complete or not. All of a run's manifests go first, so a half-deleted run never looks complete. The newest
complete backup is never deleted. Only the job's three object names under `backups/<run>/<attempt>/` are deleted.
Anything else in the bucket, `media/` included, is left alone, since the kept indexes refer to originals copied long
ago. A retention failure does not fail the backup. It is shown as `retentionFailure`, and the next backup's retention
finishes the job.

## Status

`kopje-admin health` (and `GET /admin/health`) shows `checks.backup`:

| Field                         | Meaning                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `state`                       | `disabled`, `not-configured`, `invalid`, `idle`, `pending` (a run waits) or `running`           |
| `lastSuccess`                 | The run id, time, manifest key, `manifestSha256` and media coverage of the last complete backup |
| `lastFailure`                 | The run id, time, stage and reason code of the last failure                                     |
| `inProgress`                  | The run in progress: its stage, uploaded dump parts and originals copied so far                 |
| `retryAt`, `retentionFailure` | When a failed run is tried again; the last retention failure                                    |

The check fails when the last failure is newer than the last success, or when the settings are invalid. "Not
configured" is only a warning. Reason codes name the step and status, for example `s3-upload-part-403`,
`s3-upload-part-timeout`, `dump-dump-in-progress`, `dump-dump-lease-expired`, `dump-too-large`, `index-too-large` or
`interrupted`. They never contain a message from the storage
provider, a URL or a secret. Workers Logs has `kopje.backup.*` events with the same codes.

**The public `/health` is aggregate operational health.** It answers `fail` while backups are failing, as it does for
other problems an operator must act on. Use it for alerting only. Do not use it to withdraw traffic from the instance
or to restart it: a failing backup does not stop the instance from serving.

## Restore

You need the identity file, `kopje-admin` (run outside the instance's repository as
[setup.md](setup.md#running-the-admin-cli) shows), `jq`, and read access to the bucket with your own credentials.
The steps authenticate each file before anything uses it. The manifest is checked against the digest your instance
recorded, and the dump and the media index against the manifest. Only then is any original downloaded, and local
paths are built only from validated ids. Work in a new, empty directory so nothing existing is overwritten.

1. **Choose and authenticate the manifest.** Take `lastSuccess.manifest` and `lastSuccess.manifestSha256` from
   `health`, or from the `kopje.backup.succeeded` entry in Workers Logs for an older backup. Download that object and
   compare its digest before decrypting it:

    Run every step below in one bash session started with `set -euo pipefail`, so any failed check stops the restore.

    ```sh
    set -euo pipefail
    mkdir restore-backup && cd restore-backup      # fails if it exists
    aws s3 cp "s3://BUCKET/<manifest key>" manifest.json.age
    # Exits non-zero, and stops the session, unless the digest equals the recorded manifestSha256.
    echo "<manifestSha256>  manifest.json.age" | shasum -a 256 -c -
    age -d -i ../kopje-backup-key.txt -o manifest.json manifest.json.age
    ```

    Anyone with your public key and write access to the bucket could write a manifest that decrypts. The recorded
    digest ties the manifest to what your instance wrote.

2. **Download, decrypt and verify the dump and the media index** the manifest names (`dump.key`, `mediaIndex.key`).
   Do this before any media step:

    ```sh
    aws s3 cp "s3://BUCKET/$(jq -r .dump.key manifest.json)" dump.kopje.age
    aws s3 cp "s3://BUCKET/$(jq -r .mediaIndex.key manifest.json)" media-index.json.age
    age -d -i ../kopje-backup-key.txt -o dump.kopje dump.kopje.age
    age -d -i ../kopje-backup-key.txt -o media-index.json media-index.json.age
    kopje-admin backup-verify manifest.json dump.kopje --encrypted dump.kopje.age --index media-index.json
    ```

    `backup-verify` stops at the first mismatch. It checks the index's size and digest against the manifest, then
    every entry: a source must be exactly `originals/<18-digit id>`, and a copied object must be named under the
    `media/` prefix of the run that copied it. An index that fails is never used.

    The command exits `0` when everything matches and `1` at the first mismatch. It exits `3` when every file matches
    but the backup lacks originals the dump references. Each missing original is listed as
    `missing: originals/<id> (pending|absent)`; see the media recovery guarantee above.

3. **Download and decrypt the originals** the verified index marks `copied`. Local paths come only from the validated
   18-digit id, into a new directory:

    ```sh
    mkdir media media/encrypted media/originals    # fails if they exist
    jq -r '.objects[] | select(.state == "copied") | .source' media-index.json |
    while read -r source; do
      id=${source#originals/}
      [[ "$source" == "originals/$id" && "$id" =~ ^[0-9]{18}$ ]] || { echo "unexpected: $source" >&2; exit 1; }
      key=$(jq -r --arg s "originals/$id" '.objects[] | select(.source == $s) | .key' media-index.json)
      aws s3 cp "s3://BUCKET/$key" "media/encrypted/$id.age"
      age -d -i ../kopje-backup-key.txt -o "media/originals/$id" "media/encrypted/$id.age"
    done
    kopje-admin backup-verify manifest.json --index media-index.json --media media
    ```

4. **Import** into an empty Store whose `kopje-admin catalog` shows the manifest's `schema.migrations`. Run the same
   Kopje version, or deploy it first, with `MAINTENANCE=full` before the instance is exposed, and keep it until you
   publish (step 7). Before the import begins, nothing else protects the empty Store: a single write, such as an app
   registration, makes it non-empty and the import is refused. Set the instance configuration with `kopje-admin config`
   (an import never carries it), then import:

    ```sh
    kopje-admin import dump.kopje
    ```

    The import checks the dump's own trailer again (table checksums, statement count and body SHA-256) and verifies
    the rows in the Store; see [dump-format.md](dump-format.md).

5. **Put the originals back** into the media bucket:

    ```sh
    bash -eu <<'EOF'   # bash whatever the shell; -e stops at the first put that fails
    shopt -s nullglob   # no originals: the loop runs zero times, and the count decides
    n=0
    for f in media/originals/*; do
      wrangler r2 object put "kopje-media/originals/$(basename "$f")" --file "$f" --remote </dev/null
      n=$((n + 1))
    done
    want=$(jq '[.objects[] | select(.state == "copied")] | length' media-index.json)
    [ "$n" -eq "$want" ] || { echo "put $n originals of $want" >&2; exit 1; }
    echo "put $n originals"
    EOF
    ```

    It runs in bash also when pasted into zsh, stops at the first `wrangler` that fails, and fails when the number put
    differs from the number the index marks `copied` (no originals passes only when none are expected); run it again until it prints `put <n> originals` (a put replaces the same key).

6. **Rebuild the served files** from the originals, through Access (the Store must have admin access; set it with
   `kopje-admin config` first if the restore began with the import token). It runs only while the Store refuses other
   writes, as it does until you publish, so nothing deletes media meanwhile. To rebuild later, on a published
   instance, run `kopje-admin maintenance on`, wait 20 minutes (the rebuild refuses earlier, `rebuild-settling`, so
   that nothing that may delete media is still running), rebuild, then `kopje-admin maintenance off`; the env
   `MAINTENANCE` alone is not enough, and must not change during the rebuild. One call runs at a time, and the Store
   neither publishes nor leaves maintenance while one runs:

    ```sh
    kopje-admin media-rebuild --dry-run   # what it would make, and the rows it cannot
    kopje-admin media-rebuild
    ```

    It goes through every local media row in bounded calls and, for each whose served files are missing, re-encodes
    its original as an upload is (metadata removed, long edge capped, a preview made), writes both files and records
    their real sizes. Rows whose files exist are skipped, so it can be run again at any time. Each rebuilt row counts
    two transformations against `IMAGES_MONTHLY_TRANSFORMS`. It exits 0 when every row is served, and 3 with the rows
    that need a decision: `original-missing` (the backup did not hold it: `pending` or `absent` in the index),
    `type-mismatch` (the original is not of the type the row's URLs name), `failed` (Images could not re-encode it), or
    a stop on the Images quota (9422) or the monthly budget: run it again once the allowance is back.

7. **Publish.** The imported Store stays readonly (it accepts no write and delivers nothing) until you publish it, once
   it looks right:

    ```sh
    kopje-admin publish --yes        # with --import-token while the Store has no admin access
    ```

    Then deploy with `MAINTENANCE=off`.

Restore drills into a scratch instance follow the same steps; a drill that is not meant to serve is never published.
