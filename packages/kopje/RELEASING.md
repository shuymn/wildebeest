# Releasing kopje

A tag `kopje-v<version>` on a commit of `main` releases the `kopje` npm package. The workflow
[`.github/workflows/release-kopje.yml`](../../.github/workflows/release-kopje.yml):

1. checks that the tag is `kopje-v<semver>` and points at a commit of `main`, and that `CHANGELOG.md` has a section
   `## [<version>]`, which becomes the release notes;
2. runs the kopje lint, type checks and tests;
3. sets the version from the tag in the package it packs (the repository keeps `0.0.0`), builds the bundle, packs it, and
   dry-runs the `deploy/` template against that tarball (`pnpm run check:kopje-package`);
4. publishes that tarball to npm through trusted publishing, with provenance (the `npm` environment). A version with a
   pre-release part (`1.2.0-rc.1`) gets the dist-tag `next`, any other `latest`;
5. creates the GitHub release with the notes and the tarball.

No npm token is stored anywhere: npm trusts this repository's workflow through OIDC.

## One-time setup

On npmjs.com, as an owner of the `kopje` package:

1. Open the package, Settings, Trusted Publisher, and add a GitHub Actions publisher:
    - organization or user: `shuymn`
    - repository: `wildebeest`
    - workflow filename: `release-kopje.yml`
    - environment: `npm`
2. In the same settings, under Publishing access, choose "Require two-factor authentication and disallow tokens". Trusted
   publishing keeps working; tokens can no longer publish.

On GitHub, in the repository settings:

1. Environments: create `npm`. Restrict its deployment branches and tags to the tag pattern `kopje-v*`, and add yourself
   as a required reviewer if each publish should wait for an approval.
2. Rules, Rulesets: add a tag ruleset for `kopje-v*` that restricts creation, update and deletion to you, so only you
   can start a release and a released tag cannot move.
3. Actions, General: the allowed actions must include `actions/checkout`, `actions/setup-node`,
   `actions/upload-artifact`, `actions/download-artifact` and `pnpm/action-setup` (they are already used by the other
   workflows).

## Releasing a version

1. On a branch, move the `[Unreleased]` notes in `CHANGELOG.md` under `## [<version>] - <YYYY-MM-DD>`. Say whether the
   version adds Store migrations and whether instances must change `wrangler.jsonc`. Merge it.
2. Tag the merge commit on `main` and push the tag:

    ```sh
    git fetch origin main
    git tag -s kopje-v<version> origin/main -m "kopje <version>"
    git push origin kopje-v<version>
    ```

3. Watch the workflow. If it fails before publishing, fix the cause on `main`, delete the tag and tag again. Once a
   version is on npm it cannot be published again: release a new patch version instead.
4. Update the template: bump `kopje` in `deploy/package.json` to the new version (Renovate opens this pull request after
   its minimum release age), and, if the release notes say so, change `deploy/wrangler.jsonc` the same way. CI dry-runs
   the template against the packed package, not against npm, so this step is what makes the Deploy to Cloudflare button
   install the new version.

The first release also needs `deploy/package-lock.json`: after step 4, run `npm install --package-lock-only` in
`deploy/` and commit the lockfile, so every new instance and every Workers Builds run installs the same tree.

## Versions

Kopje follows semver. Before 1.0, a minor version may break instances and a patch version may not. A version that adds
Store migrations is at least a minor version, since a rollback across it needs a point-in-time restore
([docs/upgrade.md](docs/upgrade.md)).
