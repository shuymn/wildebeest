# Cutover runbook: from a legacy Wildebeest instance to Kopje

This runbook moves a legacy Wildebeest instance (Cloudflare Pages with Functions, a Queue consumer Worker, a Durable
Object Worker and a D1 database) to a Kopje instance on the same domain. It is written for any supported legacy
instance ([cutover.md](cutover.md#supported-legacy-instances): T1, this repository's Wildebeest line, and T2,
cloudflare/wildebeest) with one or several local users.

Every step that changes a route, a binding or a resource is something you do, by the command shown. No tool here acts
on its own, and none of them calls the Cloudflare API: they read files you saved and write files on your disk.

| Document                                         | What it covers                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [cutover.md](cutover.md)                         | `convert` and `verify-conversion`: what the conversion keeps, and how it is checked  |
| [dump-format.md](dump-format.md#import-protocol) | `import` into an empty Store, `IMPORT_TOKEN`, `import-reset`                         |
| [setup.md](setup.md)                             | Deploying Kopje, Access, the admin CLI (the `/setup` wizard itself is not used here) |
| [backup.md](backup.md)                           | The Store's daily backup (step 10)                                                   |
| [upgrade.md](upgrade.md#rolling-back)            | PITR bookmarks and restore, used for recovery after publication                      |

## The plan in one page

| Step | What                                                                    | Duration | Rollback                                               |
| ---- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------ |
| 1    | Stop the legacy deploy triggers; check for running jobs                 | 1 min    | Re-enable the triggers                                 |
| 2    | Attach a dead-letter queue to the legacy Queue                          | 1 min    | Leave it (harmless) or put the consumer back as it was |
| 3    | Replace every Pages route with the maintenance worker                   | 2 min    | Roll the Pages project back to the legacy deployment   |
| 4    | Drain the legacy Queue; reconcile successes, failures, DLQ              | 1–5 min  | As step 3                                              |
| 5    | Fingerprint the legacy D1 twice; both must match                        | 2 min    | As step 3                                              |
| 6    | Final export, convert, verify, import, verify                           | 4–8 min  | `kopje-admin import-reset`; as step 3                  |
| 7    | Put Kopje on the domain in full maintenance                             | 1–2 min  | Move the domain back to the Pages project; as step 3   |
| 8    | Readonly: smoke test, the owner signs in and checks                     | 3 min    | As step 7                                              |
| 9    | **Publish** (leave maintenance); spool replays; send and receive checks | 2 min    | **None: this is the point of no return**               |
| 10   | Enable the Store's daily backup and see one succeed                     | after    | –                                                      |

**Downtime** runs from step 3 (the legacy routes stop serving) to step 9 (Kopje serves). Expect 10–17 minutes. The
limit is 30 minutes; past 45 minutes, roll back (the rollback of the step you are in, then every earlier one). Inbox
deliveries are spooled to Kopje's Queue the whole time, so none is lost; reads and the API answer 503 with
`Retry-After`, which peers and clients retry.

**Point of no return.** Publishing (step 9) is final. Until then the cutover writes nothing to the legacy D1 (only the
legacy consumer finishes its own queue), so a rollback loses nothing the legacy instance had; inbox requests spooled
meanwhile wait in Kopje's Queue for the next attempt (step 3). After it, never go back to the
legacy setup: recover with the Store's point-in-time recovery, an external backup, or a fix forward
([upgrade.md](upgrade.md#a-version-that-changed-the-schema)).

**Retention.** Keep the legacy setup (Pages project, consumer, DO Worker, Queue, KV, D1) untouched and read-only for
14 days after publishing, as a reference. Delete nothing during that time, and nothing before a restore from a Store
dump has been rehearsed.

### Timing budget

Write the start time down at step 3, and the time at the end of every step. At each go/no-go point:

- under 30 minutes since step 3: continue;
- 30 to 45 minutes: continue only if the remaining steps are certain to finish before 45;
- 45 minutes or more: roll back (before step 9 only).

The rehearsal (below) measures steps 5 and 6 on the real data, which are the only ones whose duration depends on its
size. Plan the window with its numbers.

## Placeholders

| Placeholder      | What it is                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<domain>`       | The instance domain, the legacy `DOMAIN`, exactly as it is (Kopje keeps it)                                                                           |
| `<project>`      | The legacy Pages project                                                                                                                              |
| `<branch>`       | Its production branch                                                                                                                                 |
| `<legacy-db>`    | The D1 database bound to the project as `DATABASE` (production)                                                                                       |
| `<legacy-queue>` | The Queue bound as `QUEUE`; `<legacy-consumer>` the Worker that consumes it                                                                           |
| `<kopje-worker>` | The new Kopje Worker; `<kopje-queue>` its Queue                                                                                                       |
| `<admin-host>`   | A hostname of your zone for Kopje's admin API during the cutover, for example `kopje-admin.<zone>`                                                    |
| `<work>`         | A working directory on an encrypted disk. Exports and dumps hold everything, private messages and wrapped keys included: never put them anywhere else |

Run the cutover tools from a checkout of this repository at the Kopje release you deploy, after `pnpm install` and
`pnpm --filter kopje build`: `kopje-admin` below means `node packages/kopje/cli/kopje-admin.js`. They need Node.js 22
or later. `wrangler` is the Wrangler CLI logged in to the account (`wrangler whoami`).

## Before the cutover

These can be done any time before the window; none of them affects the legacy instance.

1. **Save the Pages project's configuration** and run the preflight. With an API token that can read Pages:

    ```sh
    curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/<project>" \
      > <work>/pages-project.json
    kopje-admin cutover-preflight <work>/pages-project.json --domain <domain>
    ```

    It lists the bindings (so `<legacy-db>` and `<legacy-queue>` are the bound ones, never guessed by name), the KEK
    secret names, and checks marked `pass`, `warn`, `fail` or `todo`. No check may be `fail`. Secret values are not in
    that answer and are never printed.

2. **Export once and run the preflight with it**, to learn the migration level and which KEK wraps the keys (the
   rehearsal export will do). Put the legacy KEK values in the environment as `userKEK` / `USER_KEY` (the legacy secret
   names) if you have them:

    ```sh
    kopje-admin cutover-preflight <work>/pages-project.json --domain <domain> --export <work>/export-r
    ```

    `kek-uniform` must pass. The KEK it names is the value Kopje's `USER_KEK` must have (the empty KEK means the legacy
    instance never set one; Kopje's health will warn about it, see the accepted risks in the threat model).

3. **Deploy Kopje** from the instance template ([deploy/README.md](../../../deploy/README.md)), with:
    - `MAINTENANCE=full` as a plain-text variable, before anything can reach it;
    - `USER_KEK` set to the KEK from step 2;
    - `IMPORT_TOKEN` set to a fresh random value of at least 32 characters (`openssl rand -base64 33`). It begins
      exactly one import into this empty Store; never set `SETUP_TOKEN` and never run `/setup`, which would create an
      account and make the Store non-empty;
    - a custom domain `<admin-host>` on the Worker, and an Access application for `<admin-host>/admin` with your admin
      policy and a service token for the CLI (as [setup.md](setup.md#before-you-start) step 5). Add `<domain>/admin`
      to the same application later, at step 7, so its AUD does not change.

    Then check it with the token: `KOPJE_ADMIN_URL=https://<admin-host> kopje-admin health --import-token` (with
    `KOPJE_IMPORT_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` set). The Store is empty and in bootstrap.

4. **Set the domain** on the empty Store and save its catalog:

    ```sh
    kopje-admin config --import-token domain=<domain>
    kopje-admin catalog --import-token > <work>/catalog.json
    ```

5. **Bind Kopje's Queue to the Pages project** as `KOPJE_QUEUE` (production environment: Settings, Bindings, Queue
   producer, or the API). It takes effect only for new deployments, so the legacy deployment does not see it. Save the
   project again and rerun the preflight with `--kopje-queue <kopje-queue>`: `spool-binding` must pass.

6. **Close the other Pages URLs.** Every deployment of a Pages project stays reachable at its own
   `<hash>.<project>.pages.dev` address, and preview branches at `<branch>.<project>.pages.dev`, each running its own
   legacy code with its own bindings; the preflight warns when previews bind the same D1. Enable the project's access
   policy for preview deployments (Settings, General, Access policy), then check that a deployment URL of the current
   legacy deployment asks for Access (`curl -sI https://<hash>.<project>.pages.dev/ap/users/<user>` answers a redirect
   to Access, not the actor). Delete preview deployments you do not need:
   `wrangler pages deployment list --project-name <project> --environment preview`, then
   `wrangler pages deployment delete <id> --project-name <project>`. Keep the latest production deployment: it is the
   rollback.

7. **Rehearse** (below) and plan the window with its timings.

## The cutover

Each step lists the command, the go/no-go check, the duration and the rollback. Stop at any failed check.

### 1. Stop the legacy deploy triggers (1 min)

Disable every workflow that deploys or touches the legacy instance, and pause Pages' own Git builds if the project has
them (the preflight's `git-deployments`):

```sh
gh workflow disable deploy.yml -R <owner>/<repo>
gh workflow disable backup.yml -R <owner>/<repo>     # if the instance has the legacy backup job
gh run list -R <owner>/<repo> --status in_progress
gh run list -R <owner>/<repo> --status queued
```

Pages Git builds: Settings, Builds, Branch control: disable automatic production and preview deployments.

- **Go:** no run in progress or queued; no build running in the Pages project.
- **Rollback:** `gh workflow enable` each workflow; re-enable automatic deployments.

### 2. Attach a dead-letter queue to the legacy Queue (1 min)

Without one, a message that exhausts its retries is dropped. Recreate the consumer with the settings it had (those
below are the legacy defaults; read yours in the dashboard first) and a DLQ:

```sh
wrangler queues create <legacy-queue>-dlq
wrangler queues consumer remove <legacy-queue> <legacy-consumer>
wrangler queues consumer add <legacy-queue> <legacy-consumer> \
  --batch-size 10 --batch-timeout 30 --message-retries 10 --dead-letter-queue <legacy-queue>-dlq
wrangler queues info <legacy-queue>
```

- **Go:** `queues info` shows the consumer with the DLQ. Messages stay in the Queue while the consumer is replaced.
- **Rollback:** none needed; to restore the exact previous state, add the consumer again without the DLQ.

### 3. Replace every Pages route with the maintenance worker (2 min)

Write the maintenance worker from the latest export (the rehearsal export is fine: only the local actors and their
keys are used, and those do not change), then deploy it as the production deployment:

```sh
kopje-admin maintenance-worker <work>/export-r --domain <domain> --out <work>/maintenance
wrangler pages deploy <work>/maintenance --project-name <project> --branch <branch> --no-bundle --commit-dirty=true
```

`maintenance-worker` refuses unless one KEK unwraps every local key and every actor document it renders publishes
exactly that actor's legacy public key. The worker it writes:

- serves the actor documents and WebFinger answers exactly as Kopje will serve them after the import (Kopje's own code
  rendered them; same URLs, same keys);
- spools every inbox POST, shared and personal, to `KOPJE_QUEUE` in Kopje's spool format, refusing what Kopje would
  refuse (404 for an unknown personal inbox, 415 for other media types, 413 over 1 MiB, 503 if it cannot spool);
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
  `pages.dev`; every older deployment URL asks for Access; Kopje's Queue receives spooled messages (dashboard, Queue
  metrics) once a peer delivers something.
- **Start the clock.**
- **Rollback:** in the dashboard, Deployments, the previous production deployment, Rollback. Inbox requests already
  spooled to Kopje's Queue stay there (Kopje holds them while in maintenance) and are applied at the next attempt; the
  legacy instance does not receive them.

### 4. Drain the legacy Queue and reconcile (1–5 min)

The legacy consumer now finishes what was queued before step 3: inbox activities (written to the legacy D1) and
deliveries. Nothing new arrives.

```sh
wrangler tail <legacy-consumer> --format json > <work>/drain.log   # in another terminal, until the backlog is 0
wrangler queues info <legacy-queue>
wrangler queues info <legacy-queue>-dlq
```

- **Go:** the legacy Queue's backlog is 0 (dashboard, Queue metrics: backlog); every message in the log ended (acked
  or retried to the end); the DLQ's count is known. A delivery in the DLQ is an outbound send a remote server refused
  ten times, as the legacy instance would have dropped it. An inbox message in the DLQ is an activity the legacy D1
  never got: write the count down and decide; it is not in the export.
- **Rollback:** as step 3.

### 5. Confirm that writes stopped (2 min)

Fingerprint the legacy D1 twice, at least a minute apart. The queries are read-only and their answers hold counts,
lengths and hashes only.

```sh
kopje-admin fingerprint schema-sql > <work>/schema.sql
wrangler d1 execute <legacy-db> --remote --json --command "$(cat <work>/schema.sql)" > <work>/schema.json
kopje-admin fingerprint sql <work>/schema.json > <work>/fingerprint.sql
wrangler d1 execute <legacy-db> --remote --json --command "$(cat <work>/fingerprint.sql)" > <work>/fp-1.json
sleep 60
wrangler d1 execute <legacy-db> --remote --json --command "$(cat <work>/fingerprint.sql)" > <work>/fp-2.json
kopje-admin fingerprint compare <work>/fp-1.json <work>/fp-2.json
```

- **Go:** `PASS`. A `FAIL` names the tables that changed: something still writes (a route, a job, the consumer).
  Find it, stop it, and fingerprint again.
- **Rollback:** as step 3.

The fingerprint sees any insert or delete, and any change to a value's length, its first, middle or last 16
characters, or the counts of 20 frequent characters. It is a check that writing stopped, not a content check; the
content is checked row by row in step 6.

### 6. Final export, convert, import, verify (4–8 min)

Export every table but the full-text index ([cutover.md](cutover.md#input-the-export)); list them from the schema
answer of step 5:

```sh
mkdir <work>/export
for t in $(jq -r '.[0].results[].t' <work>/schema.json | sort -u); do
  wrangler d1 export <legacy-db> --remote --table "$t" --output "<work>/export/$t.sql"
done
```

Convert, check, import, check again:

```sh
kopje-admin convert <work>/export --out <work>/out --base-time <now, ISO 8601 UTC> \
  --catalog <work>/catalog.json --domain <domain>
kopje-admin fingerprint compare <work>/fp-1.json <work>/fp-2.json --manifest <work>/out/manifest.json
kopje-admin verify-conversion <work>/export <work>/out/kopje.dump
kopje-admin import <work>/out/kopje.dump --import-token
kopje-admin config --import-token access_team_domain=<team>.cloudflareaccess.com access_admin_aud=<aud> \
  admin_email=<admin email> access_service_token_client_id=<client id> access_aud=<sign-in application AUD>
kopje-admin dump <work>/imported.dump
kopje-admin verify-conversion <work>/export <work>/imported.dump
wrangler secret delete IMPORT_TOKEN --name <kopje-worker>
```

- **Go:** `convert` exits 0 (a stop, exit 3, names its reason in the manifest; [cutover.md](cutover.md#steps));
  the fingerprint comparison with `--manifest` passes, so the export holds exactly the rows the D1 had when it was
  fingerprinted; both `verify-conversion` runs are `PASS`, the second one on the Store's own dump after the import.
  The verification computes its expectations from the legacy export by a separate code path and compares every
  record by hash: missing content, content rewritten to the same length, and any added, missing or changed record
  fail.
- `IMPORT_TOKEN` only begins an import into an empty Store without usable admin access; once the import is
  verified the Store is not empty, and once the Access values are set it is no longer in bootstrap, so the token opens
  nothing. Deleting the secret makes that final.
- **Rollback:** `kopje-admin import-reset <work>/out/kopje.dump --yes` (or `--import-token` while the token import is
  running), then as step 3.

### 7. Put Kopje on the domain in full maintenance (1–2 min)

Kopje still has `MAINTENANCE=full`. Move `<domain>` from the Pages project to the Worker:

1. Pages project: Custom domains, `<domain>`, Remove.
2. Kopje Worker: Settings, Domains and Routes, Add custom domain `<domain>`.
3. Add `<domain>/admin` to the Access application of step 3 of the preparation, and create the sign-in application
   for `<domain>/oauth/authorize` with the AUD you set as `access_aud` (if it is not there yet).

```sh
curl -sS -H 'accept: application/activity+json' https://<domain>/ap/users/<user> | cmp - <work>/actor-maintenance.json
curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/api/v1/timelines/public   # 503
```

- **Go:** the actor answers from Kopje with the same document as the maintenance snapshot; the API answers 503;
  inbox deliveries are spooled to the same Queue.
- **Rollback:** remove the custom domain from the Worker and add it back to the Pages project; then as step 3.

### 8. Readonly: smoke test and the owner's check (3 min)

Set `MAINTENANCE=readonly` on the Worker (Settings, Variables and Secrets). Reads and sign-ins work; writes answer 503.

```sh
kopje-admin health
curl -sS "https://<domain>/.well-known/webfinger?resource=acct:<user>@<domain>" | jq .subject
curl -sS https://<domain>/api/v1/instance | jq .uri
```

The owner (and every local user who can) signs in again at `https://<domain>`, checks the profile, the home timeline,
a few old posts, followers and following, and registers Web Push again in their client (push subscriptions are not
carried over). Then fingerprint the legacy D1 once more, as in step 5 (`fp-3.json`), and compare it with `fp-2.json`:
it must still pass, so nothing reached the legacy D1 after the export.

- **Go:** health has no failing check; sign-in works; the data looks right; Push registration succeeds;
  `fingerprint compare fp-2.json fp-3.json` passes.
- **Rollback:** as step 7.

### 9. Publish (2 min) — the point of no return

Record a PITR bookmark, then leave maintenance:

```sh
kopje-admin pitr bookmark > <work>/bookmark-before-publish.json
```

Set `MAINTENANCE=off` (or remove it). Spooled inbox requests are replayed by Kopje's Queue consumer, each verified
against the time it was spooled; ones held during maintenance come due within 30 minutes. Then:

- post a test status, and see it arrive at a test account you control on another server (sending);
- from that account, like the test status, and see the notification on Kopje, with its Web Push (receiving).

- **Go:** both arrive; Kopje's Queue backlog falls to 0 within 30 minutes; `kopje-admin deliveries` shows no growing
  backlog.
- **Rollback:** none. Recover forward: PITR to the bookmark ([upgrade.md](upgrade.md#a-version-that-changed-the-schema)),
  a backup, or a fix.

### 10. Daily backup (after)

Configure the Store's daily backup ([backup.md](backup.md)) and wait for the first run.

- **Done:** `kopje-admin health` shows `checks.backup.lastSuccess`.

Afterwards: re-enable nothing on the legacy side. Keep it read-only for 14 days, then remove it as decided separately.

## Rehearsal (stage R)

The rehearsal runs steps 5 and 6 against a copy, while the legacy instance keeps serving, and changes no route. It
measures how long they take on the real data and proves the conversion passes before the window is planned.

1. Deploy a second, temporary Kopje Worker (its own name, Queue and Store; `MAINTENANCE=full`; an `IMPORT_TOKEN`; an
   Access-protected admin hostname) as in the preparation, steps 3 and 4.
2. Time each command, as in steps 5 and 6, with `time`:
    - the schema query and one fingerprint query (on a live instance the two answers may differ; only the time matters);
    - the export of every table;
    - `convert`, `verify-conversion` on the dump, `import --import-token` into the temporary Store, `dump`, and
      `verify-conversion` on the Store's dump;
    - `maintenance-worker`, and the generated worker run locally with
      `wrangler pages dev <work>/maintenance` (a local server: request an actor and post to an inbox).
3. Write down the numbers: export bytes, the duration of each command, the import's chunk count, the Store's size
   (`kopje-admin capacity`). Downtime is about steps 3–4 plus these, plus steps 7–9 (5–7 minutes).
4. Delete the temporary Worker, its Queue and its Store (`wrangler delete <temporary worker>`), and the exports.

The rehearsal also confirms what only the real platform can show:

- that the fingerprint and schema queries run within D1's limits on the real database, and how long they take;
- the export's generated columns, `PRAGMA foreign_key_check` after the bridge, and the export of each table;
- the permissions the token needs (below);
- that the account can delete Pages deployments and that preview protection covers deployment URLs;
- how the Queue backlog is read (`wrangler queues info`, the dashboard), for steps 4 and 9.

## Permissions

| Step     | Cloudflare permission                                                                                                                                                                                                                            | Other                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Before   | Account: Cloudflare Pages Read (save the project); Pages Edit (bindings, preview protection, deleting previews); Workers Scripts Edit (deploy Kopje, secrets); Access: Apps and Policies Edit; Zone: Workers Routes or DNS Edit (`<admin-host>`) | –                                           |
| 1        | Cloudflare Pages Edit (only to pause Git builds)                                                                                                                                                                                                 | GitHub: Actions write                       |
| 2        | Queues Edit                                                                                                                                                                                                                                      | –                                           |
| 3        | Cloudflare Pages Edit                                                                                                                                                                                                                            | –                                           |
| 4        | Queues Read; Workers Tail Read                                                                                                                                                                                                                   | –                                           |
| 5, 6     | D1: the query and export endpoints (Edit may be required even for reads; the rehearsal confirms)                                                                                                                                                 | Kopje: Access service token, `IMPORT_TOKEN` |
| 6        | Workers Scripts Edit (delete `IMPORT_TOKEN`)                                                                                                                                                                                                     | –                                           |
| 7        | Cloudflare Pages Edit; Workers Scripts Edit; Zone: Workers Routes / DNS Edit; Access: Apps and Policies Edit                                                                                                                                     | –                                           |
| 8, 9, 10 | Workers Scripts Edit (variables and secrets)                                                                                                                                                                                                     | Backup storage (backup.md)                  |

## What the tools guarantee, and what they do not

- `cutover-preflight` reads the saved project file (and, with `--export`, the export) only. It prints binding names,
  resource identifiers and variable names, never a secret value and never instance data.
- `maintenance-worker` writes only `<out>/_worker.js`, refuses an existing file, and refuses keys that do not unwrap
  under one KEK or do not match the legacy public keys. The file holds the actor documents and WebFinger answers, which
  are public anyway. The worker's only write is the spool message (threat model: OPS-6, OPS-7).
- `fingerprint` writes SQL and compares answers; the answers carry counts, lengths and hashes only (DATA-16).
- None of them can see a route you did not close, a job you did not stop, or a message in a DLQ: those are the
  go/no-go checks of steps 1–5 and 8.
