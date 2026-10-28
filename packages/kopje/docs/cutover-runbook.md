# Cutover runbook: from a legacy Wildebeest instance to Kopje

This runbook moves a legacy Wildebeest instance (Cloudflare Pages with Functions, a Queue consumer Worker, a Durable
Object Worker and a D1 database) to a Kopje instance on the same domain. It is written for any supported legacy
instance ([cutover.md](cutover.md#supported-legacy-instances): T1, shuymn's Wildebeest fork, and T2,
cloudflare/wildebeest) with one or several local users.

Every step that changes a route, a binding or a resource is something you do, by the command shown. No tool here acts
on its own, and the offline tools (`cutover-preflight`, `fingerprint`, `convert`, `verify-conversion`,
`maintenance-worker`) call no API: they read files you saved and write files on your disk. The `cutover` commands talk
to your Kopje Worker's admin API, like the other `kopje-admin` commands.

| Document                                         | What it covers                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [cutover.md](cutover.md)                         | `convert` and `verify-conversion`: what the conversion keeps, and how it is checked  |
| [dump-format.md](dump-format.md#import-protocol) | `import` into an empty Store, `IMPORT_TOKEN`, `import-reset`                         |
| [setup.md](setup.md)                             | Deploying Kopje, Access, the admin CLI (the `/setup` wizard itself is not used here) |
| [backup.md](backup.md)                           | The Store's daily backup (step 10)                                                   |
| [upgrade.md](upgrade.md#rolling-back)            | PITR bookmarks and restore, used for recovery after publication                      |

## The plan in one page

| Step | What                                                                                                 | Duration | Rollback                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| 1    | Stop the legacy deploy triggers and jobs; check for running ones                                     | 1 min    | Re-enable them                                                                           |
| 2    | Attach a dead-letter queue to the legacy Queue                                                       | 1 min    | Leave it                                                                                 |
| 3    | Replace every Pages route with the maintenance worker                                                | 2 min    | [Rollback A](#rollback-a-before-the-import-is-complete)                                  |
| 4    | Drain the legacy Queue, reconcile, then remove the legacy consumer                                   | 1–5 min  | Rollback A                                                                               |
| 5    | Export twice; the fingerprints must match                                                            | 2–3 min  | Rollback A                                                                               |
| 6    | Fetch new images; convert, verify, put the originals, import, verify; check the maintenance snapshot | 4–8 min  | Rollback A, or [B](#rollback-b-after-the-import-is-complete) once the import is complete |
| 7    | Put Kopje on the domain in full maintenance                                                          | 1–10 min | Rollback B                                                                               |
| 8    | Readonly: smoke test, the owner signs in and checks; fingerprint again                               | 3–5 min  | Rollback B                                                                               |
| 9    | **Publish**; the spool replays; send and receive checks                                              | 2 min    | **None: the point of no return**                                                         |
| 10   | Enable the Store's daily backup and see one succeed                                                  | after    | –                                                                                        |

### Timing budget

**Downtime** runs from step 3 (the legacy routes stop serving) to step 9 (Kopje serves). Inbox deliveries are spooled
the whole time, so none is lost; reads and the API answer 503 with `Retry-After: 600` throughout, from the maintenance
worker and then from Kopje.

The step durations above add up to 15–35 minutes for steps 3 to 9. The design's target of 10–17 minutes holds only
for a small database, a short legacy backlog and an instant domain move; the rehearsal measures steps 5 and 6 on the
real data, and step 7's allowance depends on how the domain moves (a Worker route is immediate; a custom domain waits
for its certificate). Plan the window with the rehearsal's numbers, and keep:

- the limit of 30 minutes since step 3: past it, continue only if what remains is certain to finish before 45;
- 45 minutes or more: roll back (before step 9 only).

Write the start time down at step 3 and the time at the end of every step.

A rollback is not part of this budget: its drain waits for the requests held during maintenance to come back from
Kopje's Queue (at most the 30-minute requeue delay after journaling starts), then hands them off one at a time, each
after the legacy consumer acknowledged the previous one.

**Point of no return.** Publishing (step 9) is final. A verified import leaves the Store unpublished: it then refuses
every write, whatever `MAINTENANCE` says, so nothing is written or delivered (no reply, no Accept, no replayed inbox
request) until you publish; reads and sign-ins work, for the checks of step 8. `kopje-admin publish --yes` ends that and
marks the Store published, after which it refuses the cutover reset, every rollback command and any import for good.
Publication is refused while a rollback is in progress (a drain runs, or the journal holds requests), and on a Store
that never had a verified import. The daily backup does not start before publication (step 10).
After publication, never go back to the legacy setup: recover with the Store's point-in-time recovery, an external
backup, or a fix forward ([upgrade.md](upgrade.md#a-version-that-changed-the-schema)).

**Retention.** Keep the legacy setup (Pages project, consumer, DO Worker, Queue, KV, D1) untouched and read-only for
14 days after publishing, as a reference. Delete nothing during that time, and nothing before a restore from a Store
dump has been rehearsed. Keep the images in Cloudflare Images for at least 30 days
([after the cutover](#after-the-cutover-retire-cloudflare-images)).

### The write barrier

Nothing may write the legacy D1 after the final export. That is enforced by closing every writer, not by the
fingerprint: the fingerprint (step 5, again at step 8) is a check on top of the barrier that shows nothing changed. The
preflight lists the writers it can see (`barrier`), and the steps close them:

| Writer                                                                       | Closed at                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Deploy and backup workflows, Pages Git builds, any other job bound to the D1 | Step 1                                                                            |
| Preview deployments, when the preview environment binds the same D1          | Before step 3: remove its `DATABASE` binding and delete the preview deployments   |
| The production deployment (custom domain, `pages.dev`)                       | Step 3: the maintenance worker replaces it                                        |
| Older deployments, reachable at their own `<hash>.<project>.pages.dev`       | Before step 3: protect them with the project's Access policy (or delete them)     |
| The legacy consumer                                                          | Step 4: removed from the Queue after it drained                                   |
| Any other Worker bound to the D1                                             | Step 1: find them in the dashboard (D1, the database, its bindings) and stop them |

An export is not a writer, but `wrangler d1 export` makes the D1 unavailable while it runs. Wrangler asks before it does,
and in a non-interactive shell (a script, the `export_d1` function below run from one, CI) it answers that prompt with
yes itself. Inside the window nothing uses the D1 any more, so that is harmless; an export taken while the legacy
instance still serves (preparation step 2, the rehearsal) makes its requests fail for the export's duration.

## Placeholders

| Placeholder      | What it is                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<domain>`       | The instance domain, the legacy `DOMAIN`, exactly as it is (Kopje keeps it)                                                                           |
| `<project>`      | The legacy Pages project; `<branch>` its production branch                                                                                            |
| `<legacy-db>`    | The D1 database bound to the project as `DATABASE` (production)                                                                                       |
| `<legacy-queue>` | The Queue bound as `QUEUE`; `<legacy-consumer>` the Worker that consumes it                                                                           |
| `<kopje-worker>` | The new Kopje Worker; `<kopje-queue>` its Queue and `<kopje-queue>-dlq` its dead-letter queue                                                         |
| `<admin-host>`   | A hostname of your zone for Kopje's admin API during the cutover, for example `kopje-admin.<zone>`                                                    |
| `<media-bucket>` | Kopje's R2 bucket for media, bound to the Worker as `MEDIA`                                                                                           |
| `<images-hash>`  | The legacy Cloudflare Images account hash: the path segment after `https://imagedelivery.net/` in the legacy instance's image URLs                    |
| `<account-id>`   | The Cloudflare account id (32 hex digits) that holds those images                                                                                     |
| `<work>`         | A working directory on an encrypted disk. Exports and dumps hold everything, private messages and wrapped keys included: never put them anywhere else |

`kopje-admin` is the CLI of the Kopje version you deploy: in its instance repository `npm run admin --`, or
`npm exec --package=kopje@<version> -- kopje-admin` ([setup.md](setup.md#running-the-admin-cli)); a checkout of this
repository at that release also works (`pnpm install`, `pnpm --filter kopje build`, then
`node packages/kopje/cli/kopje-admin.js`). It needs Node.js 22 or later. `wrangler` is the Wrangler CLI logged in to the
account (`wrangler whoami`).

**Exporting.** One command exports every table into one file, which the tools read as they read a directory of
per-table files. List the tables once, then export them all, `sqlite_sequence` (the notification counter) included:

```sh
kopje-admin fingerprint tables-sql > <work>/tables.sql
wrangler d1 execute <legacy-db> --remote --json --command "$(cat <work>/tables.sql)" > <work>/tables.json
export_d1() { # <dir>
  mkdir -p "$1"
  wrangler d1 export <legacy-db> --remote --output "$1/export.sql" \
    $(jq -r '.[0].results[].name | "--table " + .' <work>/tables.json) --table sqlite_sequence
}
```

If your D1 refuses to export `sqlite_sequence` with `--table`, read it and write the file instead:

```sh
wrangler d1 execute <legacy-db> --remote --json --command "$(kopje-admin fingerprint sequence-sql)" > <work>/seq.json
kopje-admin fingerprint sequence-file <work>/seq.json > "<dir>/sqlite_sequence.sql"
```

`kopje-admin fingerprint export <dir>` refuses an export whose notification counter is missing (`sequence-missing`).

`wrangler d1 export` asks whether to make the database unavailable during the export, and answers yes itself when it
does not run in a terminal (see [the write barrier](#the-write-barrier)). For `sqlite_sequence` it writes no
`CREATE TABLE` but a `DELETE FROM sqlite_sequence;` before the counter rows: the tools accept that statement as D1
writes it, so leave the file as it is.

## Before the cutover

None of this affects the legacy instance.

1. **Save the Pages project's configuration** and run the preflight. With an API token that can read Pages:

    ```sh
    curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/<project>" \
      > <work>/pages-project.json
    kopje-admin cutover-preflight <work>/pages-project.json --domain <domain>
    ```

    It lists the bindings (so `<legacy-db>` and `<legacy-queue>` are the bound ones, never guessed by name), the KEK
    secret names, the write barrier, and checks marked `pass`, `warn`, `fail` or `todo`. No check may be `fail`. Secret
    values are not in that answer and are never printed.

2. **Export once** (`export_d1 <work>/export-r`) **and run the preflight with it**, to learn the migration level and
   which KEK wraps the keys. Put the legacy KEK values in the environment as `userKEK` / `USER_KEY` (the legacy secret
   names) if you have them:

    ```sh
    kopje-admin cutover-preflight <work>/pages-project.json --domain <domain> --export <work>/export-r
    ```

    `kek-uniform` must pass. The KEK it names is the value Kopje's `USER_KEK` must have:
    - when it names `empty` for every local key, leave `USER_KEK` unset. `kopje-admin health` then warns
      `USER_KEK is empty`; that is expected. Do not copy a KEK from the legacy deployment's configuration because the
      deployment has one: a value the check does not name does not unwrap the keys, and every local key would fail;
    - when it names `userKEK` or `USER_KEY`, set `USER_KEK` to that secret's value.

    The keys move wrapped as they are (DATA-14). Under the empty KEK they are wrapped under a known value, so at rest
    they are as readable as the Store's data. After publication, move them to a new KEK with `kopje-admin keys rewrap`
    (see "Rotating the KEK" in [setup.md](setup.md#rotating-the-kek)). Do not set `USER_KEK` before then: changing it alone
    makes every key fail to unwrap until the rewrap has run.

3. **Deploy Kopje** from the instance template ([deploy/README.md](../../../deploy/README.md)), with:
    - `MAINTENANCE=full` as a plain-text variable, before anything can reach it;
    - `USER_KEK` as step 2 says: the KEK it names, or unset when it names `empty`;
    - `VAPID_JWK`, which Web Push needs: the legacy instance's own `VAPID_JWK` (the Pages variable of that name, which
      the preflight lists), not a new key. The legacy OAuth applications are carried over, and clients keep the
      `vapid_key` their registration answered (Elk caches it for a week, many apps for good), so they subscribe with
      the legacy key; a push signed with another key is refused by the push service, and Kopje then ends the
      subscription. Make a new key ([deploy/README.md](../../../deploy/README.md) shows how) only when the legacy
      instance has none. Subscriptions themselves are not carried over: clients register again at step 8;
    - `IMPORT_TOKEN` set to a fresh random value of at least 32 characters (`openssl rand -base64 33`). Never set
      `SETUP_TOKEN` and never run `/setup`, which would create an account and make the Store non-empty;
    - its Queue's dead-letter queue (`wrangler queues create <kopje-queue>-dlq`);
    - a custom domain `<admin-host>` on the Worker, and an Access application for `<admin-host>/admin` with your admin
      policy and a service token for the CLI (as [setup.md](setup.md#before-you-start) step 5). Add `<domain>/admin`
      to the same application later, at step 7, so its AUD does not change;
    - for a rollback: Queue producer bindings `LEGACY_QUEUE` to `<legacy-queue>` and `LEGACY_DLQ` to
      `<legacy-queue>-dlq` in the instance's `wrangler.jsonc`, and the legacy instance's `VAPID_JWK` as the secret
      `LEGACY_VAPID_JWK`. Only `kopje-admin cutover drain` uses them: it sends to `LEGACY_QUEUE`, and reads the backlog
      of both (a Queue binding is the only way a Worker reads a Queue's backlog; nothing is ever sent to `LEGACY_DLQ`).
      Also bind Kopje's own dead-letter queue as `KOPJE_DLQ`, read the same way by `kopje-admin cutover close`.

    Then check it with the token: `KOPJE_ADMIN_URL=https://<admin-host> kopje-admin health --import-token` (with
    `KOPJE_IMPORT_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` set). The Store is empty and in bootstrap.
    The catalog the conversion targets can be fetched now, with the token, before Access is configured:
    `kopje-admin catalog --import-token > <work>/catalog.json`.

4. **Configure the Store with the token, then retire the token.** Set the domain and the Access values while the Store
   is in bootstrap; this ends bootstrap, so from here on everything, the import and a rollback included, goes through
   Access, and the token opens nothing. The import and every rollback command then need the same authority, and no
   command gains authority it does not already have:

    ```sh
    kopje-admin config --import-token domain=<domain> access_team_domain=<team>.cloudflareaccess.com \
      access_admin_aud=<aud> admin_email=<admin email> access_service_token_client_id=<client id> \
      access_aud=<sign-in application AUD>
    kopje-admin health                     # through Access now
    kopje-admin catalog > <work>/catalog.json   # unless step 3 fetched it with the token
    wrangler secret delete IMPORT_TOKEN --name <kopje-worker>
    ```

5. **Bind Kopje's Queue to the Pages project** as `KOPJE_QUEUE` (production environment: Settings, Bindings, Queue
   producer, or the API). It takes effect only for new deployments. Optionally add a Rate Limiting binding
   `KOPJE_SPOOL_RATE_LIMIT` (per client IP), if the platform offers it to Pages; otherwise rely on a zone rate-limiting
   rule for `POST` to `*/inbox`. Save the project again and rerun the preflight with `--kopje-queue <kopje-queue>`:
   `spool-binding` must pass.

6. **Close the other Pages URLs** (the write barrier): remove the `DATABASE` binding from the preview environment if it
   binds the same D1, delete the preview deployments
   (`wrangler pages deployment list --project-name <project> --environment preview`, then
   `wrangler pages deployment delete <id> --project-name <project>`), and enable the project's Access policy for
   preview deployments (Settings, General), which also covers the `<hash>.<project>.pages.dev` address of every
   deployment. Check that the current deployment's own URL asks for Access
   (`curl -sI https://<hash>.<project>.pages.dev/ap/users/<user>` redirects to Access). Keep the latest production
   deployment: it is the rollback.

7. **Download the images** from Cloudflare Images, so the cutover moves them into Kopje's media
   ([cutover.md](cutover.md#what-the-conversion-does), "Media"). With an API token that can read Images (Account:
   Cloudflare Images Read) in the environment only, never on the command line:

    ```sh
    read -rs CF_IMAGES_TOKEN && export CF_IMAGES_TOKEN
    kopje-admin images-export <work>/export-r --images-account <images-hash> --out <work>/images \
      --account-id <account-id>
    ```

    Without `--account-id` and the token it downloads the delivery URLs the data names instead, which may be resized
    variants. It prints counts; `missing.total` must be 0, or each missing image accepted (the cutover then needs
    `--accept-missing-images`, and the references are left out). An interrupted run continues where it stopped when run
    again. `<work>/images` holds the originals, EXIF and location included: keep it with the exports. Step 6 runs it
    again on the final export, which downloads only images uploaded since.

8. **Rehearse** (below) and plan the window with its timings.

## The cutover

Each step lists the command, the go/no-go check, the duration and the rollback. Stop at any failed check.

### 1. Stop the legacy deploy triggers and jobs (1 min)

```sh
gh workflow disable deploy.yml -R <owner>/<repo>
gh workflow disable backup.yml -R <owner>/<repo>     # if the instance has the legacy backup job
gh run list -R <owner>/<repo> --status in_progress
gh run list -R <owner>/<repo> --status queued
```

Pause Pages Git builds if the project has them (Settings, Builds, Branch control). Stop any other writer the preflight
or the D1's bindings show.

- **Go:** no run in progress or queued; no build running; no other writer left.
- **Rollback:** `gh workflow enable` each workflow; re-enable automatic deployments.

### 2. Attach a dead-letter queue to the legacy Queue (1 min)

Without one, a message that exhausts its retries is dropped. Recreate the consumer with the settings it had (read
them in the dashboard first; these are the legacy defaults) and a DLQ:

```sh
wrangler queues create <legacy-queue>-dlq
wrangler queues consumer remove <legacy-queue> <legacy-consumer>
wrangler queues consumer add <legacy-queue> <legacy-consumer> \
  --batch-size 10 --batch-timeout 30 --message-retries 10 --dead-letter-queue <legacy-queue>-dlq
wrangler queues info <legacy-queue>
```

- **Go:** the consumer has the DLQ. Messages stay in the Queue while the consumer is replaced.
- **Rollback:** none needed.

### 3. Replace every Pages route with the maintenance worker (2 min)

Freeze account and profile changes from here until publication: tell the local users not to edit profiles, rotate
keys or sign up. Take a fresh export, write the maintenance worker from it, check it, and deploy it as the production
deployment. (If a full export is slow, the rows of `d1_migrations`, `actors`, `users` and `sqlite_sequence` are enough:
export those, and the other tables with `--no-data`, into the same directory.)

```sh
export_d1 <work>/export-m
kopje-admin maintenance-worker <work>/export-m --domain <domain> --out <work>/maintenance
kopje-admin maintenance-worker-check <work>/export-m --domain <domain> --worker <work>/maintenance
wrangler pages deploy <work>/maintenance --project-name <project> --branch <branch> --no-bundle --commit-dirty=true
```

`maintenance-worker` refuses unless one KEK unwraps every local key and every actor document it renders publishes
exactly that actor's legacy public key, and it reports digests of what it captured (`snapshotSha256`, `keysSha256`).
The worker it writes:

- serves the actor documents and WebFinger answers exactly as Kopje will serve them after the import (Kopje's own
  code rendered them; same URLs, keys and headers; WebFinger in any case; 404 for an unknown actor);
- spools every inbox POST, shared and personal, to `KOPJE_QUEUE` in Kopje's spool format, refusing what Kopje would
  refuse (404 for an unknown personal inbox, 415 for other media types, 413 over 1 MiB) and a request without an HTTP
  signature naming an https key (401); it answers 429 over the optional rate limit and 503 when it cannot spool or
  Kopje's Queue holds 10,000 messages or 256 MiB, or when that backlog cannot be read (it fails closed: on a runtime
  without Queue metrics it spools nothing, and the window relies on senders retrying, as with any outage; the
  rehearsal checks this);
- answers everything else with 503 and `Retry-After: 600`. It never reads or writes the legacy bindings.

Check, from outside:

```sh
curl -sS -H 'accept: application/activity+json' https://<domain>/ap/users/<user> > <work>/actor-maintenance.json
jq .publicKey.id <work>/actor-maintenance.json
curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/api/v1/timelines/public          # 503
curl -sS -o /dev/null -w '%{http_code}\n' https://<project>.pages.dev/api/v1/timelines/public  # 503
curl -sS -o /dev/null -w '%{http_code}\n' https://<hash>.<project>.pages.dev/                 # Access, not 200
```

- **Go:** the actor and WebFinger answer 200 with the expected key id; the API answers 503 on the domain and on
  `pages.dev`; older deployment URLs ask for Access; Kopje's Queue receives spooled messages once a peer delivers.
- **Start the clock.**
- **Monitoring until step 9:** Kopje's Queue backlog (dashboard, Queue metrics) and the maintenance worker's log
  (`wrangler pages deployment tail --project-name <project>`): `kopje.maintenance.backlog-full` and
  `kopje.maintenance.rate-limited` mean the spool is refusing requests; peers retry them later.
- **Rollback:** [Rollback A](#rollback-a-before-the-import-is-complete).

### 4. Drain the legacy Queue, reconcile, remove the legacy consumer (1–5 min)

The legacy consumer now finishes what was queued before step 3. Nothing new arrives.

```sh
wrangler tail <legacy-consumer> --format json > <work>/drain.log   # in another terminal, until the backlog is empty
wrangler queues info <legacy-queue>
wrangler queues info <legacy-queue>-dlq
wrangler queues consumer remove <legacy-queue> <legacy-consumer>   # once the backlog is empty
```

- **Go:** the legacy Queue's backlog is empty: 0 messages and 0 bytes (dashboard, Queue metrics; a retry waiting out its
  delay shows only in the bytes); every message in the log ended (acked or retried
  to the end); the DLQ's count is known; the consumer is removed. A delivery in the DLQ is an outbound send a remote
  server refused ten times, as the legacy instance would have dropped it. An inbox message in the DLQ is an activity
  the legacy D1 never got: write the count down and decide; it is not in the export.
- **Rollback:** Rollback A (it adds the consumer back).

### 5. Confirm that writes stopped (2–3 min)

Export twice, at least a minute apart, and compare the fingerprints. Every row of every table, `sqlite_sequence`
included, is hashed whole, so any change to any row shows; the output holds table names, counts and digests only.

```sh
export_d1 <work>/export-a
sleep 60
export_d1 <work>/export-b
kopje-admin fingerprint export <work>/export-a > <work>/fp-a.json
kopje-admin fingerprint export <work>/export-b > <work>/fp-b.json
kopje-admin fingerprint compare <work>/fp-a.json <work>/fp-b.json
```

- **Go:** `PASS`. `<work>/export-b` is the final export. A `FAIL` names the tables that changed: a writer is still
  open. Find it, close it, and export twice again.
- **Rollback:** Rollback A.

### 6. Convert, import, verify (4–8 min)

```sh
kopje-admin images-export <work>/export-b --images-account <images-hash> --out <work>/images --account-id <account-id>
kopje-admin convert <work>/export-b --out <work>/out --base-time <now, ISO 8601 UTC> \
  --catalog <work>/catalog.json --domain <domain> --images <work>/images
kopje-admin fingerprint compare <work>/fp-a.json <work>/fp-b.json --manifest <work>/out/manifest.json
kopje-admin verify-conversion <work>/export-b <work>/out/kopje.dump --images <work>/images
bash -eu <<'EOF'   # bash whatever the shell; -e stops at the first put that fails
shopt -s nullglob   # no originals: the loop runs zero times, and the count decides
n=0
for f in <work>/out/originals/*; do
  wrangler r2 object put "<media-bucket>/originals/$(basename "$f")" --file "$f" --remote </dev/null
  n=$((n + 1))
done
want=$(jq .images.originals <work>/out/manifest.json)
[ "$n" -eq "$want" ] || { echo "put $n originals of $want" >&2; exit 1; }
echo "put $n originals"
EOF
kopje-admin import <work>/out/kopje.dump
kopje-admin dump <work>/imported.dump
kopje-admin verify-conversion <work>/export-b <work>/imported.dump --images <work>/images
kopje-admin maintenance-worker-check <work>/export-b --domain <domain> --worker <work>/maintenance
```

- **Go:**
    - `images-export` exits 0, having downloaded only the images uploaded since the preparation (`downloaded`), or 3
      with only missing images you accepted in the preparation; pass `--accept-missing-images` to `convert` and both
      `verify-conversion` runs then;
    - `convert` exits 0 (a stop, exit 3, names its reason in the manifest; [cutover.md](cutover.md#steps)). A real
      export usually needs `--accept-deletions`, on `convert` and both `verify-conversion` runs, for rows legacy never
      showed ([cutover.md](cutover.md#what-the-conversion-does)). Do not pass it blindly: run without it first, read `conversion.dropped`
      in the manifest, and add it only when every code there is one cutover.md lists, with counts you expect;
    - the comparison with `--manifest` passes: the conversion read exactly the fingerprinted rows and notification
      counter (it refuses a file that is not a complete conversion manifest);
    - both `verify-conversion` runs are `PASS`, the second on the Store's own dump after the import. They compute their
      expectations from the export by a separate code path and compare every record by hash;
    - `maintenance-worker-check` says `current`: the deployed snapshot is what the final export holds. If it says
      `stale`, generate the worker from `<work>/export-b`, deploy it as in step 3, and continue.
- The import runs through Access (the token was retired in the preparation); an interrupted one is reset with
  `kopje-admin import-reset <work>/out/kopje.dump --yes`.
- The originals go to `originals/<media id>` in `<media-bucket>`, where Kopje keeps every original; nothing serves
  them. **Go:** the block prints `put <n> originals` with `n` equal to `images.originals` in the manifest. It stops at
  the first `wrangler` that fails, or when the number put differs from what the conversion wrote (no originals passes
  only when none were written); it runs in bash also when pasted into zsh. Run the whole block again
  (a put replaces the same key). Do not import before it passes: a row whose original is not in R2 has nothing to
  rebuild its files from (`media-rebuild` reports such rows as `original-missing`). The images' served files are made
  from these originals by `kopje-admin media-rebuild` in step 8; until then the moved avatars, headers and attachments
  answer 404. A rollback leaves the originals in the bucket; a later conversion with the same `images.json` and base time
  writes the same keys again.
- **Rollback:** before the import is verified, Rollback A; after, Rollback B.

### 7. Put Kopje on the domain in full maintenance (1–10 min)

Kopje still has `MAINTENANCE=full`. Move `<domain>` to the Worker, either:

- **a Worker route** `<domain>/*` on the zone (Settings, Domains and Routes, Add route), which keeps the existing DNS
  record and certificate and takes effect at once (the rehearsal confirms that the route takes precedence over the
  Pages custom domain); or
- **a custom domain swap**: remove `<domain>` from the Pages project's custom domains, then add it to the Worker as a
  custom domain, which waits for its certificate.

Then add `<domain>/admin` to the Access application of the preparation, and create the sign-in application for
`<domain>/oauth/authorize` with the AUD you set as `access_aud` (if it is not there yet).

```sh
curl -sS -H 'accept: application/activity+json' https://<domain>/ap/users/<user> | cmp - <work>/actor-maintenance.json
curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/api/v1/timelines/public   # 503, with Retry-After
```

- **Go:** the actor answers from Kopje with the same document as the maintenance snapshot; the API answers 503; inbox
  deliveries are spooled to the same Queue.
- **Rollback:** remove the route (or the Worker's custom domain, and add it back to the Pages project); then Rollback B.

### 8. Readonly: smoke test and the owner's check (3–5 min)

Set `MAINTENANCE=readonly` on the Worker (Settings, Variables and Secrets). Reads and sign-ins work; writes answer 503
(the unpublished Store refuses them anyway).

Make the served files of local media that has none yet, such as the images `convert --images` moved (their originals
went to R2 in step 6), so they are served at publication:

```sh
kopje-admin media-rebuild
```

It re-encodes each such original as an upload is, writes `files/<token>/{full,small}`, corrects the row's sizes in
`meta` (the conversion took them from the image header, which ignores EXIF rotation) and records its preview's blurhash;
rows whose files exist are skipped, so it can be run again. Its writes are the only ones the unpublished Store admits,
and only for the Access admin. It runs only while the Store refuses other writes, as here (an unpublished import needs
no wait), so nothing deletes media meanwhile, and one call at a time under a lease: while a call holds it the Store
refuses `import`, `import-reset`, `cutover reset`, `publish` and leaving maintenance (`rebuild-in-progress`; wait until
the command has finished, at most until the 10-minute lease expires). Do not change `MAINTENANCE` while it runs. Each
image counts three transformations against `IMAGES_MONTHLY_TRANSFORMS` (a custom emoji's two), and none against the
account shares. Because it changes `meta` and the blurhash, a dump taken after it differs from the conversion there:
step 6's `verify-conversion` runs before it.

```sh
kopje-admin health
curl -sS "https://<domain>/.well-known/webfinger?resource=acct:<user>@<domain>" | jq .subject
curl -sS https://<domain>/api/v1/instance | jq .uri
```

The owner (and every local user who can) signs in again at `https://<domain>`, checks the profile, the home timeline,
a few old posts, followers and following, and registers Web Push again (push subscriptions are not carried over). Then
take one more export and compare its fingerprint with `fp-b.json`: nothing may have reached the legacy D1 after the
final export.

```sh
export_d1 <work>/export-c
kopje-admin fingerprint export <work>/export-c > <work>/fp-c.json
kopje-admin fingerprint compare <work>/fp-b.json <work>/fp-c.json
```

- **Go:** `media-rebuild` exits 0 (every local image is served); health has no failing check; sign-in works; the data
  looks right, images included; Push registration succeeds; the fingerprints match. `media-rebuild` exits 3 with the
  rows that need a decision (`original-missing`, `type-mismatch`, `failed`) or when the Images quota or the monthly
  budget stopped it: publishing then leaves those images unserved (404) until it is run again and succeeds, a decision
  for the owner.
- **Rollback:** as step 7.

### 9. Publish (2 min) — the point of no return

```sh
kopje-admin pitr bookmark > <work>/bookmark-before-publish.json
kopje-admin publish --yes
```

With `--images`, publication also queues one `Update(Person)` for each local account whose avatar or header the
conversion changed, to its followers, so their servers show the new profile images (`profileUpdates` in the output
counts them; a repeated `publish` queues none). They are delivered once maintenance is off.

Set `MAINTENANCE=off` (or remove it). Spooled inbox requests are replayed by Kopje's Queue consumer, each verified
against the time it was spooled; ones held during maintenance come due within 30 minutes. Then:

- post a test status, and see it arrive at a test account you control on another server (sending);
- from that account, like the test status, and see the notification on Kopje, with its Web Push (receiving and Push
  delivery).

- **Go:** both arrive; Kopje's Queue backlog falls to 0 messages and 0 bytes within 30 minutes; its dead-letter queue stays empty;
  `kopje-admin deliveries` shows no growing backlog, and with `--images` the profile Updates leave it.
- **Rollback:** none. Recover forward: PITR to the bookmark ([upgrade.md](upgrade.md#a-version-that-changed-the-schema)),
  a backup, or a fix.

### 10. Daily backup (after)

Configure the Store's daily backup ([backup.md](backup.md)) and wait for the first run.

- **Done:** `kopje-admin health` shows `checks.backup.lastSuccess`.

Afterwards: re-enable nothing on the legacy side. Keep it read-only for 14 days, then remove it as decided separately.

## After the cutover: retire Cloudflare Images

The converted Store no longer names the legacy instance's Cloudflare Images, but other servers do: their copies of old
statuses keep the old `imagedelivery.net` URLs. Kopje does not send an `Update` for the old statuses (Mastodon would
mark every one of them as edited). Changed avatars and headers reach followers' servers at publication (step 9); a
server that follows no local account, or that has not processed its Update, shows the old profile images until it
fetches the actor again.

1. Once `media-rebuild` has run (step 8), check that the instance shows its avatars, headers and attachments
   from `https://<domain>/media/`.
2. Keep the images in Cloudflare Images for a grace period of at least 30 days after publishing, while remote servers
   still show recent statuses from their copies.
3. Then delete them, the image ids `<work>/images/images.json` lists (`DELETE /accounts/<account-id>/images/v1/<id>`
   with a token that can edit Images, or the dashboard), and delete the API tokens used for Images. **Accepted risk:**
   from then on, remote copies of old statuses show no images, and neither do profiles a server has not refetched.
4. Delete `<work>/images` with the exports: its originals keep EXIF and location data.

## Rolling back

Rolling back before step 9 returns the legacy instance to service with everything it had, plus every inbox request
accepted during the window, each once and in the order it arrived, before anything newer. Spooled requests are never
left in Kopje's Queue: the legacy instance gets them first, so an Undo or Delete it receives later applies on top of
them, and a later cutover cannot replay them. Everything below runs through Access (preparation, step 4).

`kopje-admin cutover drain --worker <work>/maintenance` hands the journal to the legacy Queue through an ordered lane:

- **Collection barrier.** Nothing is sent while Kopje's Queue holds any message: the requests held during maintenance
  come back after the requeue delay (at most 30 minutes after journaling starts) and enter the journal in spool order
  first. The Queue's message count leaves delayed messages out, so the Queue counts as empty only when its byte count
  is 0 too. The drain waits meanwhile, up to 45 minutes per run.
- **One at a time.** The next request goes only when the legacy Queue's backlog is empty (no message and no bytes,
  which a retry waiting out its delay still shows): the legacy consumer has
  acknowledged the previous one, retries included, so nothing overtakes a request it is still retrying. A request in
  the legacy dead-letter queue stops the drain (`legacy-dlq`) until you reconcile it: decide, redrive or purge the DLQ.
- **Verified, to a legacy account.** Each request is verified against the time it was spooled, by Kopje's rule, and goes
  to a legacy local account from the maintenance worker's snapshot, never one named only by the request. One that fails
  for good (`unverified`), or addresses no legacy account and no `--fallback <username>` is given (`noRecipient`), is
  kept: inspect with `kopje-admin sql "SELECT spool_id, spooled_at FROM inbound_spool"`, then
  `kopje-admin cutover discard-kept --yes` once decided.
- **As Kopje would read it.** A request without the ActivityStreams context, a string id, a type or an actor is kept
  (`unverified`): Kopje's inbox would ignore it, so the legacy instance does not get it either.
- **Fail closed.** A Queue backlog that cannot be read stops the drain (`metrics-unavailable`); a key that cannot be
  fetched now stops it (`key-unavailable`; run it again). The legacy Queue is read before its dead-letter queue.
- **One drain at a time.** A drain holds a lease for its round, and sends nothing once too little of it is left for a
  send to finish inside it (`lease-expiring`), however long an earlier step took. Every call of the round (a Queue
  reading, a Store call, a key fetch) is given up at the round's deadline, and the round then stops (`lease-expiring`).
  A send to the legacy Queue that does not finish in 10 seconds is given up (`legacy-queue-timeout`); after either, the
  lease is kept until it expires (5 minutes), so no other drain sends meanwhile; the request is sent again by a later
  round. A send given up this way may still reach the legacy Queue later, and the legacy consumer does not deduplicate:
  the legacy instance may then process a request twice, or out of order with the one after it.
- **At least once.** A request is marked as being sent before the send; a drain interrupted between the two sends it
  again, so the legacy instance may process it twice (a second Accept, a second notification).
- **Receipts.** A handed-off request leaves a receipt outside the Store's data, so no copy of it is journaled or
  replayed again, also after an import, a reset, or with `CUTOVER_ROLLBACK` removed. `kopje-admin cutover close --yes`
  removes the receipts once Kopje's Queue and its dead-letter queue are both empty, by message count and byte count (no
  copy is left to arrive or to be redriven), which ends the rollback.
- **Bounded.** The journal holds at most 10,000 requests and 128 MiB (lower with `CUTOVER_JOURNAL_MAX_ENTRIES` and
  `CUTOVER_JOURNAL_MAX_BYTES`); when full, requests stay in Kopje's Queue, whose backlog makes the maintenance worker
  refuse new ones (503). Kept requests count until discarded. If valid requests alone exceed the quota while the
  barrier waits for the rest, the drain stops with `journal-full`: raise `CUTOVER_JOURNAL_MAX_*` (up to those ceilings),
  or discard kept requests, and keep the spool rate limit on. If neither frees room (at the ceilings, with only valid
  requests), `kopje-admin cutover drain --worker <dir> --unordered --yes` sends the journal's head past the collection
  barrier, which lets the Queue's requests come in: those may then overtake an older request (ordinary delivery
  reordering, as between any two servers). It has effect only while the journal is full, and only after a drain
  stopped on `journal-full` with the journal unchanged since: a first `--unordered` drain stops and reports it too,
  and running the command again sends the head.

### Rollback A: before the import is complete

1. Keep the maintenance worker (or Kopje in maintenance) on the routes: requests keep being spooled.
2. If an import was begun: `kopje-admin import-reset <work>/out/kopje.dump --yes`. Nothing is journaled during an
   import; the requests wait in Kopje's Queue meanwhile.
3. On the Kopje Worker set `CUTOVER_ROLLBACK=journal` (Settings, Variables and Secrets).
4. Add the legacy consumer back, one invocation at a time:

    ```sh
    wrangler queues consumer add <legacy-queue> <legacy-consumer> --batch-size 10 --batch-timeout 30 \
      --message-retries 10 --dead-letter-queue <legacy-queue>-dlq --max-concurrency 1
    ```

5. Drain: `kopje-admin cutover drain --worker <work>/maintenance [--fallback <username>]`, until it exits 0.
6. Restore the legacy routes: the Pages project's previous production deployment (Deployments, Rollback); move the
   domain back if step 7 moved it. Then drain again: requests the maintenance worker spooled while the routes changed
   are collected first (the barrier) and handed off. Those and the legacy instance's first direct requests can
   interleave for the time the routes take to change, as deliveries from different servers always can.
7. `kopje-admin cutover status`: the journal holds nothing pending, being sent or kept, and Kopje's Queue backlog is 0 messages
   and 0 bytes (dashboard, Queue metrics).
8. Remove `CUTOVER_ROLLBACK` from the Kopje Worker; re-enable the legacy workflows and builds (step 1); restore the
   legacy consumer's concurrency (add it again without `--max-concurrency`).
9. `kopje-admin cutover close --yes`, which needs Kopje's Queue and its dead-letter queue empty. Before then the receipts drop any copy of a
   handed-off request that is still delivered; afterwards none can be left.

### Rollback B: after the import is complete

As Rollback A, without step 2, and before step 9:

```sh
kopje-admin cutover reset --yes   # needs MAINTENANCE=full and nothing pending, being sent or kept in the journal
```

The reset applies only to a verified import that is not published yet. It takes the Store back to empty, keeping its configuration (domain and Access), through the same bounded reset
an interrupted import uses; an interrupted reset is continued with `kopje-admin import-reset --yes`. The next attempt
imports through Access. The reset is refused once the Store is published (`published`), during an import
(`import-exists`: use `import-reset`) and while the journal holds requests (`journal-not-empty`).

## Kopje's dead-letter queue

A message that exhausts Kopje's Queue retries (100) goes to `<kopje-queue>-dlq` instead of being dropped: for example an
accepted inbox request whose sender stayed unreachable, or a requeue that failed. Watch its message count (dashboard,
Queues). To act on it:

1. **Inspect:** the dashboard lists its messages (Queues, `<kopje-queue>-dlq`, Messages). Spool messages are binary;
   their count and age are what matter.
2. **Reconcile:** find the cause in the Worker's logs (`kopje.spool.replay.failed`, `kopje.queue.unknown`) and fix it.
3. **Redrive:** consume the DLQ with the Kopje Worker until it is empty, then remove that consumer:

    ```sh
    wrangler queues consumer add <kopje-queue>-dlq <kopje-worker> --message-retries 100
    wrangler queues consumer remove <kopje-queue>-dlq <kopje-worker>
    ```

## Rehearsal (stage R)

The rehearsal runs steps 5 and 6 against a copy, while the legacy instance keeps serving, and changes no route. It
measures how long they take on the real data and proves the conversion passes before the window is planned.

1. Deploy a second, temporary Kopje Worker (its own name, Queue, dead-letter queue and Store; `MAINTENANCE=full`; an
   `IMPORT_TOKEN` for its configuration; an Access-protected admin hostname) as in the preparation, steps 3 and 4.
   The rehearsal needs Access as well as the token: with `--import-token` the CLI runs only `import`, `import-reset`,
   `config`, `health`, `version`, `catalog` and `publish`, so `capacity`, `dump` (and with it the second
   `verify-conversion`) and the rollback commands go through Access. Access cannot protect a `workers.dev` address,
   so give the temporary Worker a custom domain or a route on your zone for its admin hostname, with its own Access
   application, and configure the Store with `config --import-token` as in preparation step 4.
2. Time each command of steps 5 and 6 with `time`:
    - one export of every table (`export_d1`), and `fingerprint export` of it (on a live instance two fingerprints may
      differ; only the time matters);
    - `images-export` again on this export (only the images uploaded since), `convert` and `verify-conversion` with
      `--images`, putting the originals into the temporary Worker's media bucket, `import` into the temporary Store,
      `dump` (through Access), `verify-conversion` on the Store's dump, and `media-rebuild` (which spends three Images
      transformations per image; count them against the month's allowance before the window);
    - `maintenance-worker` and `maintenance-worker-check`, and the generated worker run locally with
      `wrangler pages dev <work>/maintenance` (request an actor and post a signed request to an inbox).
3. Exercise the rollback on the temporary Worker: `cutover reset --yes` after its import, and a drain into a test Queue
   and a test dead-letter queue bound as `LEGACY_QUEUE` and `LEGACY_DLQ`.
4. Write down the numbers: export bytes, the duration of each command, the import's chunk count, the Store's size
   (`kopje-admin capacity`). Downtime is about steps 3 and 4 plus these, plus steps 7 to 9.
5. Delete the temporary Worker, its Queues and its Store (`wrangler delete <temporary worker>`), and the exports.

The rehearsal also confirms what only the real platform can show:

- the export's duration, `--table sqlite_sequence`, its generated columns, and `PRAGMA foreign_key_check` after the
  bridge;
- the permissions the token needs (below);
- that preview protection covers deployment URLs, that a `KOPJE_QUEUE` binding added to the project reaches only new
  deployments, whether Pages offers a Rate Limiting binding, and that `--no-bundle` deploys the generated file as it is;
- that a Worker route on `<domain>/*` takes precedence over the Pages custom domain, or how long the custom domain's
  certificate takes;
- how the Queue backlog and DLQ counts are read (`wrangler queues info`, the dashboard);
- that the maintenance worker can read Kopje's Queue metrics on the legacy project: deploy it to a preview branch whose
  preview environment binds `KOPJE_QUEUE` to the temporary Worker's Queue, and post a request with a signature header
  to that preview URL. 202 means it spools; 503 with `kopje.spool.metrics-unavailable` in the log means it fails closed,
  so during the window inbox deliveries are refused and senders retry them. Remove the preview deployment and its
  binding afterwards (the write barrier);
- that `wrangler deploy` keeps a DLQ consumer added from the CLI, and that the Deploy button creates the DLQ.

Already established on the platform: a Queue's message count leaves delayed messages out (a request requeued with a
delay, a retry waiting out its delay) while its byte count includes them, so the collection barrier, the drain's checks
of the legacy Queue and its DLQ, and `kopje-admin cutover close` count a Queue as empty only when both are 0.
`wrangler queues info` shows no backlog figure: read the backlog, messages and bytes, on the dashboard (Queue metrics).

## Permissions

| Step     | Cloudflare permission                                                                                                                                                                                                                                                                                                 | Other                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Before   | Account: Cloudflare Pages Read (save the project), Pages Edit (bindings, preview protection, deleting previews); Workers Scripts Edit (deploy Kopje, secrets); Queues Edit (Kopje's DLQ); Access: Apps and Policies Edit; Zone: Workers Routes or DNS Edit (`<admin-host>`); Cloudflare Images Read (`images-export`) | –                           |
| 1        | Cloudflare Pages Edit (only to pause Git builds)                                                                                                                                                                                                                                                                      | GitHub: Actions write       |
| 2, 4     | Queues Edit; Workers Tail Read                                                                                                                                                                                                                                                                                        | –                           |
| 3        | Cloudflare Pages Edit                                                                                                                                                                                                                                                                                                 | –                           |
| 5, 6, 8  | D1: the query and export endpoints (Edit may be required even for reads; the rehearsal confirms)                                                                                                                                                                                                                      | Kopje: Access service token |
| 6        | Cloudflare Images Read (`images-export --account-id`); Workers R2 Storage Edit (putting the originals)                                                                                                                                                                                                                | –                           |
| 7        | Zone: Workers Routes Edit (a route) or Cloudflare Pages Edit, Workers Scripts Edit and DNS Edit (a custom domain); Access: Apps and Policies Edit                                                                                                                                                                     | –                           |
| After    | Cloudflare Images Edit (deleting the images after the grace period)                                                                                                                                                                                                                                                   | –                           |
| 8, 9, 10 | Workers Scripts Edit (variables and secrets)                                                                                                                                                                                                                                                                          | Backup storage (backup.md)  |
| Rollback | Workers Scripts Edit (`CUTOVER_ROLLBACK`); Queues Edit (the legacy consumer); Cloudflare Pages Edit (the previous deployment); Zone: Workers Routes Edit                                                                                                                                                              | Kopje: Access service token |

## What the tools guarantee, and what they do not

- `cutover-preflight` reads the saved project file (and, with `--export`, the export) only. It prints binding names,
  resource identifiers, variable names and the writers it sees, never a secret value and never instance data.
- `fingerprint` reads exports and compares fingerprints; they carry table names, counts and digests only (DATA-16).
- `maintenance-worker` writes only `<out>/_worker.js`, refuses an existing file, and refuses keys that do not unwrap
  under one KEK or do not match the legacy public keys. The file holds the actor documents and WebFinger answers, which
  are public anyway. The worker's only write is the spool message (OPS-6, OPS-7).
- The `cutover` commands reset the Store only before publication and only for an Access admin (OPS-8), and drain the
  journal only in spool order, verified, keeping what fails (OPS-9).
- None of them can see a writer outside the Pages project, a job you did not stop, or a message in a DLQ: those are the
  go/no-go checks of steps 1 to 5 and 8.
