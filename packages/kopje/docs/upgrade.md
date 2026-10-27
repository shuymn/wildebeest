# Upgrading and rolling back a Kopje instance

An instance is a small repository made from the [instance template](../../../deploy/README.md): a `package.json` that
pins one `kopje` version, and a `wrangler.jsonc` that is the same for every install. Upgrading means deploying another
`kopje` version. The instance's data is in the Store (one SQLite-backed Durable Object), and the Store upgrades its own
schema the first time the new code runs.

Kopje follows [semver](https://semver.org). Each version has release notes in
[CHANGELOG.md](../CHANGELOG.md) and on the GitHub release. They say when a version changes the Store's schema, and when
the template's `wrangler.jsonc` must change (a new binding, a new compatibility date or flag). Before 1.0, a minor
version may break things; read the notes of every version you skip.

The instance's `wrangler.jsonc` is its own file: a version that changes the template's does not change it. Make the
same change on the pull request that updates `kopje`, before you merge it (step 3 below). In particular,
`compatibility_flags` must hold `global_fetch_strictly_public` as well as `nodejs_compat`, so that every outbound fetch
uses public routing, a host in the instance's own zone included (NET-1 in the
[threat model](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/threat-model.md)).
`kopje-admin health` fails its `runtime` check while the running Worker lacks it.

## How an update arrives

1. Renovate (with the template's `renovate.json`) or Dependabot opens a pull request that changes the `kopje` version in
   `package.json`. Renovate opens one pull request for the newest version and never merges it by itself.
2. Read the release notes. Check `kopje-admin health` (below): an instance that is already in maintenance, or has a
   backup dump in progress, upgrades later than you expect.
3. Merge the pull request. Workers Builds (or the GitHub Actions workflow) installs the new version and runs
   `wrangler deploy`. There is no separate migration step.

Without Renovate or Dependabot, change the version in `package.json` yourself, run `npm install` to update the
lockfile, and push.

## What happens on deploy

Every deployment gets a new Workers version id. The Worker passes it on every call to the Store, and the Store compares
it with its own (both are the same script, so after the deploy both run the new code).

- **While the deploy rolls out**, some requests can still reach the old code. A Store that sees a different version id
  refuses the call as `version-mismatch`: the Mastodon API and the web answer 503 for that moment, and activities that
  other servers deliver to the inbox are spooled and replayed later, so none is lost.
- **On the first call to the new code**, the Store checks its schema against the migrations the new version ships. If
  some are not applied, it schedules the upgrade at once and stays readonly until the upgrade is done: reads and
  sign-ins work, writes answer 503, and the inbox spools.
- **The upgrade** runs inside the Store, in three phases:
    1. it records the Store's current point-in-time-recovery bookmark (`lastBookmark` in `kopje-admin health`), before
       it changes anything;
    2. it applies each pending migration in its own transaction and records it by name and checksum;
    3. it verifies the result, and only then leaves readonly: the recorded migrations, and `PRAGMA foreign_key_check`
       over the whole Store. The whole-Store foreign-key scan is skipped only when the upgrade finds no earlier
       attempt marker and every pending migration is declared to preserve references and referenced keys. Resumed
       upgrades, retries, verification-only runs and upgrades without that guarantee scan the whole Store; on a large
       Store this dominates upgrade time.

    An upgrade that is interrupted resumes from where it stopped. An upgrade waits for a backup dump or an import that
    is running, and starts when it ends.

- **If a phase fails**, the Store stays readonly with a hold (`bookmark-failed`, `upgrade-failed` or `verify-failed`)
  and logs the reason (`kopje.store.upgrade.failed`; [observability.md](observability.md) says where to find it). The
  hold stays until the next deployment, or until you run `kopje-admin upgrade retry`. Nothing is lost while it holds:
  the inbox keeps spooling. Fix the cause (or roll back, below), then retry or deploy.
- **If the Store's schema has migrations the code does not know** (`schema-diverged`), for example after a rollback
  across a schema change, the Store stays readonly until the code and the schema match again.

Check the result with the admin CLI. [setup.md](setup.md#running-the-admin-cli) says how to run it: in the instance's
repository, `kopje-admin <command>` below is `npm run admin -- <command>`.

```sh
export KOPJE_ADMIN_URL=https://example.com CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...
kopje-admin version   # the Worker's build, the Store's build, and the newest expected and applied migration
kopje-admin health    # versionMatch, schema, readonly, hold, upgrading, lastBookmark
```

After a successful upgrade, `versionMatch` is true, `schema.status` is `current`, `readonly` is false, and
`lastBookmark` is the bookmark taken before the upgrade. **Write it down** before you do anything else: it is what a
rollback across this upgrade restores, and the next upgrade replaces it.

Some migrations rewrite stored values and keep no copy, such as `0048_stored_bounds` and `0049_instance_bounds`; the
release notes ([CHANGELOG.md](../CHANGELOG.md)) say which values each rewrites. A restore to this bookmark is how to
recover such a value.

## Rolling back

A rollback has two parts: the code (a Workers rollback) and, if the version changed the schema, the data (a
point-in-time restore of the Store to the bookmark taken before the upgrade).

### A version that did not change the schema

The release notes say so, and `kopje-admin version` shows the same newest migration before and after. Roll back the
code only:

- in the dashboard: Workers & Pages, your Worker, Deployments, then Rollback on the previous version; or
- `npx wrangler deployments list` and `npx wrangler rollback <version-id>`.

The Store runs the older code from then on, and its schema still matches. Then pin the older `kopje` version in
`package.json` (and close or postpone the update pull request), or the next build deploys the newer one again.

### A version that changed the schema

The older code cannot use the newer schema, so the data must go back too. The restore returns the Store to the moment
before the upgrade: **everything written after it is lost**. That includes posts, follows and settings changed since,
and activities other servers delivered and the instance accepted. Roll back this way only soon after an upgrade that
went wrong. If the upgrade succeeded and the new version only has a bug, prefer a fixed version.

You need the bookmark recorded before the upgrade (`lastBookmark`). Durable Objects keep point-in-time recovery for 30
days, so the bookmark must be younger than that.

1. **Roll back the code**, as above. The Store now reports `schema-diverged` and stays readonly.
2. **Set `MAINTENANCE=full`** on the Worker (dashboard: Settings, Variables and Secrets; as a plain-text variable).
   Set it after the rollback: a rollback restores the variables the old version had. The restore is refused without
   it, because it rewinds every flag inside the Store; the variable holds the instance from outside meanwhile.
3. **Restore the Store** to the bookmark:

    ```sh
    kopje-admin pitr restore <lastBookmark> --yes
    ```

    The Store restarts to apply it. The call answers `restoring`. A restore is refused while `media-rebuild` runs;
    after it, a media rebuild waits 20 minutes of maintenance again, and the remote media cache waits 20 minutes before
    it checks its files again ([backup.md](backup.md)).

4. **Check** with `kopje-admin health`: `schema.status` is `current`, and `versionMatch` is true.
5. **Remove `MAINTENANCE`** (or set it to `off`). The instance serves again; spooled inbox activities are replayed.
6. **Pin the older version** in `package.json`, as above.

To look up a bookmark for another time (within the 30 days), use `kopje-admin pitr bookmark --at <ISO 8601 time>`.
A bookmark from after the upgrade has the newer schema, and the older code cannot use it.

### If the admin CLI cannot reach the instance

`kopje-admin` goes through the `/admin` Access application. If Access is not usable, recreate the application (see
[setup.md](setup.md), "After setup"). The daily backup ([backup.md](backup.md)) is the last resort; restoring from it
loses everything since that backup.
