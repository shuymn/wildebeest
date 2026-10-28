# Releasing kopje

A tag `kopje-v<version>` on a commit of `main` releases the `kopje` npm package. The workflow
[`.github/workflows/release-kopje.yml`](../../.github/workflows/release-kopje.yml):

1. checks that the tag is `kopje-v<semver>` and points at a commit of `main`, and that `CHANGELOG.md` has a section
   `## [<version>]`, which becomes the release notes;
2. runs the kopje lint, type checks and tests unless CI (`.github/workflows/ci.yml`) passed on the tagged commit
   as a push to `main` (`scripts/kopje-main-ci.mjs`). That run compares the commit with the last `main` run that
   passed and runs the checks the difference can affect, so its success covers the whole tree. The check waits up to
   20 minutes for a run still queued or in progress, and 2 minutes for one not yet listed; when the run failed, was
   cancelled or never ran, it runs the lint, the type checks and every kopje suite itself;
3. packs the package with the tag's version (the repository keeps `0.0.0`) and checks it with
   `pnpm run check:kopje-package`: the packed manifest and files, the `deploy/` template's dry run against the tarball,
   the template running in workerd, and an npm install of the tarball (the `kopje-admin` bin and the types);
4. publishes that tarball to npm through trusted publishing, with provenance (the `npm` environment), by
   `scripts/kopje-publish.mjs`. A version with a pre-release part (`1.2.0-rc.1`) gets the dist-tag `next`, any other
   `latest`;
5. creates the GitHub release with the notes and the tarball (`scripts/kopje-github-release.mjs`). The notes start
   with a fixed line asking operators to read them and `docs/upgrade.md` before merging an update, because Dependabot
   shows them in the pull request that updates an instance.

The check of `main`'s run and the publish and release steps live in `scripts/kopje-release-lib.mjs`;
`pnpm run test:scripts` checks them offline, with npm and gh stubbed, in every pull request.

No npm token is stored anywhere: npm trusts this repository's workflow through OIDC.

## One-time setup

On npmjs.com, as an owner of the `kopje` package:

1. Open the package, Settings, Trusted Publisher, and add a GitHub Actions publisher:
    - organization or user: `shuymn`
    - repository: `kopje`
    - workflow filename: `release-kopje.yml`
    - environment: `npm`
    - allowed actions: also allow **`npm publish`** (direct publishing). A publisher created after 3 September 2026
      allows only `npm stage publish` unless you choose this, and the workflow runs `npm publish`.
2. Release within two days of adding it. A new trusted publisher must complete its first successful publish within 2
   days, or it expires and can no longer be used or edited; then delete it, add it again, and publish within 2 days.
   So add the publisher just before tagging the first release.
3. In the same settings, under Publishing access, choose "Require two-factor authentication and disallow tokens".
   Trusted publishing keeps working; tokens can no longer publish.

The publish needs npm 11.5.1 or later and Node.js 22.14.0 or later; the workflow uses Node.js 24 and checks the npm
version. npm adds provenance itself for a trusted publish from a public repository. See npm's
[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/) (allowed actions, the 2-day expiry,
the required versions and the publishing-access setting) and
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

On GitHub, in the repository settings:

1. Environments: create `npm`. Restrict its deployment branches and tags to the tag pattern `kopje-v*`, and add yourself
   as a required reviewer if each publish should wait for an approval.
2. Rules, Rulesets: add a tag ruleset for `kopje-v*` that restricts creation, update and deletion to you, so only you
   can start a release and a released tag cannot move.
3. Actions, General: the allowed actions must include `actions/checkout`, `actions/setup-node`,
   `actions/upload-artifact`, `actions/download-artifact` and `jdx/mise-action` (they are already used by the other
   workflows).

## Changelog entries

A pull request adds its notes under `## [Unreleased]` in `CHANGELOG.md`; a released section is not edited.

## Releasing a version

1. On a branch, move the `[Unreleased]` notes in `CHANGELOG.md` under `## [<version>] - <YYYY-MM-DD>`. Say whether the
   version adds Store migrations and whether instances must change `wrangler.jsonc`. If it adds migrations, measure
   them together in one upgrade, from the first file the previous release did not carry, and record the range and the
   time in the notes (the budget and the store: `test/bench/migration-cost.ts`). The measure is the "Migration
   bench" workflow (`.github/workflows/bench.yml`): a GitHub-hosted runner takes the range from the newest
   `kopje-v*` tag and reports the median of three runs, for every pull request that changes a migration and by hand
   (`gh workflow run bench.yml --ref <branch>`). It must pass before the branch merges: the upgrade's median
   must be within the budget. It also shows whether the upgrade checked foreign keys over the whole Store and an
   estimate of a marker-bearing retry's cost (which always checks the whole Store); the estimate warns past the
   budget but does not fail. A local run measures the same range, but only on an otherwise idle machine:

    ```sh
    KOPJE_BENCH_SCALE=1 KOPJE_BENCH_MIGRATION= KOPJE_BENCH_FROM=0049_instance_bounds pnpm --filter kopje bench:migration
    ```

    Replace `0049_instance_bounds` with the first migration absent from the previous release.

    Merge it.

2. Tag the merge commit on `main` and push the tag:

    ```sh
    git fetch origin main
    git tag -s kopje-v<version> origin/main -m "kopje <version>"
    git push origin kopje-v<version>
    ```

3. Watch the workflow. If it fails in the check job, nothing was published: fix the cause on `main`, delete the tag
   and tag again.
4. Update the template: bump `kopje` in `deploy/package.json` to the new version (Renovate opens this pull request as
   soon as the version is on npm, release candidates included), and, if the release notes say so, change
   `deploy/wrangler.jsonc` the same way. The template must name a published version: CI dry-runs it against the packed
   package, not against npm, so it passes even when the Deploy to Cloudflare button would fail to install. This step is
   what makes the button install the new version. To try the button from a branch before merging, open
   `https://deploy.workers.cloudflare.com/?url=https://github.com/shuymn/kopje/tree/<branch>/deploy`; the branch
   name must not contain `/`, or the button cannot tell it from the directory path.

### If the publish or release job fails

npm never replaces a published version, and a publish can succeed even when the job then fails (a timeout, a lost
connection). The publish script therefore looks the version up on npm first:

- not on npm: it publishes the tarball;
- on npm with the same integrity as the checked tarball: it publishes nothing and succeeds;
- on npm with another integrity: it fails. Release a new patch version instead.

So after a failed publish or release job, open the workflow run and choose **Re-run failed jobs**. The jobs use the
tarball the check job uploaded (kept for 7 days); the release job leaves an existing GitHub release as it is. Rerun
rather than delete and push the tag again: a new run packs a new tarball, and if it differs in any byte from the
published one, the publish job refuses it.

## After the first release

The first release also needs `deploy/package-lock.json`: after step 4, run `npm install --package-lock-only` in
`deploy/` and commit the lockfile, so every new instance and every Workers Builds run installs the same tree.

## Versions

Kopje follows semver. Before 1.0, a minor version may break instances and a patch version may not. A version that adds
Store migrations is at least a minor version, since a rollback across it needs a point-in-time restore
([docs/upgrade.md](docs/upgrade.md)).
