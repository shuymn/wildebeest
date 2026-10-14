# Changelog

All notable changes to the `kopje` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semver](https://semver.org). Before 1.0, a minor version may make breaking changes.

Each version says whether it changes the Store's schema (adds migrations) and whether an instance must change its
`wrangler.jsonc` (a binding, a compatibility date or flag). See [docs/upgrade.md](docs/upgrade.md).

## [Unreleased]

### Added

- `kopje-admin media-rebuild [--dry-run]` (`POST /admin/media/rebuild`, Access admin only) makes the served files of
  local media whose files are missing from their originals in R2: media restored from a backup, which holds only the
  originals, and images moved by the cutover. Each is re-encoded as an upload is, and its sizes in `meta` are corrected
  to the files made. Rows whose files exist are skipped, so it can be run again; it reports rows whose original is
  missing, whose type does not match their URLs, or that fail to re-encode, and stops on the Images quota or the
  monthly transformation budget (exit 3). Its writes are admitted in readonly maintenance and before publication, so
  a restore or a cutover serves its images when published ([docs/backup.md](docs/backup.md),
  [docs/cutover-runbook.md](docs/cutover-runbook.md) step 8).

### Instance changes

- Store schema: unchanged.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.2] - 2026-10-14

A second release candidate of the first release, published under the npm dist-tag `next`.

### Fixed

- The cutover tools read a real D1 export: `convert`, `verify-conversion` and `fingerprint export` accept the
  `DELETE FROM sqlite_sequence` line that `wrangler d1 export` writes, match columns by name (a legacy database may
  have re-added a column in another position, nullable), drop the notifications legacy created for the author of a
  remote post and never showed (`--accept-deletions`), read outbox rows written before legacy migration 0016 as
  targets, and replace lone surrogates in carried text, counting each.

- `kopje-admin import` bounds each call by what it writes, so a real-sized import no longer stops on the Durable
  Object CPU limit: a chunk holds at most 2,000 statements in 4 MiB, and link statements are applied during verify in
  bounded steps. An interrupted import saved by an earlier version cannot be resumed (`import-chunks-outdated`): run
  `import-reset` and import again.

- An activity without addressing (a Follow, Accept, Reject, Like or their Undo) now goes to the recipient's shared
  inbox when it has one, and to its personal inbox only otherwise. Some servers accept such activities at a personal
  inbox but never process them, so a follow could stay pending. If the shared inbox answers 404, 405 or 410 (some
  servers advertise one they have disabled), the activity is sent to the recipient's personal inbox on the same
  server instead. An addressed activity that reaches a recipient without naming it still goes to that recipient's
  personal inbox.

- The cutover rollback no longer reads a Queue holding only delayed messages as empty: Queues leaves a delayed message
  out of the backlog's message count, so `kopje-admin cutover drain` and `kopje-admin cutover close` now count a Queue
  as empty only when its message count and byte count are both 0, and fail closed on a malformed reading. Before, a
  drain could finish while an older request was still delayed in Kopje's Queue, and `cutover close` could remove the
  handoff receipts while a delayed copy of a handed-off request remained.

### Instance changes

- Store schema: unchanged (`0000_initial`).
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.1] - 2026-10-13

A release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The first release: the Mastodon API, ActivityPub federation, media, search, the `/setup` wizard, the daily
  encrypted backup and the `kopje-admin` CLI.
- The instance template (`deploy/` in the repository), with the Deploy to Cloudflare button.
- The cutover from a legacy Wildebeest instance: `convert`, `verify-conversion`, `cutover-preflight`, `fingerprint`,
  `maintenance-worker`, `maintenance-worker-check` and `cutover` in `kopje-admin`, and
  [docs/cutover-runbook.md](docs/cutover-runbook.md).

### Instance changes

- Store schema: `0000_initial`.
- `wrangler.jsonc`: as in the template, compatibility date `2026-10-11`. Tested with wrangler 4.149.0. The Queue
  consumer has a dead-letter queue (`dead_letter_queue`), which must exist before the deploy.
