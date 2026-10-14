# Changelog

All notable changes to the `kopje` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semver](https://semver.org). Before 1.0, a minor version may make breaking changes.

Each version says whether it changes the Store's schema (adds migrations) and whether an instance must change its
`wrangler.jsonc` (a binding, a compatibility date or flag). See [docs/upgrade.md](docs/upgrade.md).

## [Unreleased]

### Added

- Mastodon API endpoints that clients read at startup and that answered 404 before. `GET /api/v1/preferences` shows
  the account's posting defaults (visibility, sensitive, language) and Mastodon's defaults for the reading preferences
  (`reading:expand:media` `default`, `reading:expand:spoilers` false).

- `GET /api/v1/instance/rules` (the rules `/api/v2/instance` shows), `/api/v1/instance/peers` (the domains of known
  remote accounts, at most 10,000), `/api/v1/instance/extended_description` (none set) and `/api/v1/instance/languages`
  (ISO 639-1). `privacy_policy`, `terms_of_service`, `activity` and `domain_blocks` answer 404, as Mastodon does when
  none is configured or the feature is off.

- `GET /api/v1/tags/:id`: any valid hashtag, with seven days of history counted from public statuses.
  It needs no scope; `following` is false for a signed-in viewer, since tag follows do not exist yet.

- `GET /api/v1/accounts/familiar_followers`: for each requested account, the accounts the user follows that follow it
  among up to 10,000 of the user's follows (at most 20 ids and 80 accounts each), without accounts the user blocks
  or mutes.

- Empty answers, under the scopes Mastodon requires, for features Kopje has no data for yet: `GET /api/v1/filters`,
  `/api/v2/filters`, `/api/v1/followed_tags`, `/api/v1/featured_tags`, `/api/v1/accounts/:id/featured_tags`,
  `/api/v1/endorsements`, `/api/v1/announcements` (any user token), `/api/v1/trends` (and `/trends/tags`,
  `/trends/statuses`, `/trends/links`), `/api/v1/suggestions` and `/api/v2/suggestions`.

### Instance changes

- Store schema: unchanged (`0000_initial`).
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.3] - 2026-10-14

A third release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The cutover can move a legacy instance's images out of Cloudflare Images. `kopje-admin images-export` downloads the
  images the legacy data references under the operator's Images account, through the Images API with a token read
  from `CF_IMAGES_TOKEN`, or else from the delivery URLs, which give copies in the stored format that may be resized.
  It checks them as Kopje checks an upload and records them in `images.json`; a rerun downloads only what is new.
  `kopje-admin convert --images` then maps avatars, headers, attachments and earlier versions of edited statuses to
  local media rows, each with a file token and an original of its own (also when several show one image), drops
  legacy's default profile images so Kopje's defaults apply, and writes the originals for R2 under their media ids.
  `verify-conversion --images` checks the result independently. A missing image stops the conversion unless
  `--accept-missing-images` is given. The served files are made by `kopje-admin media-rebuild` (below). Without
  `--images`, the conversion is unchanged. See docs/cutover.md ("Media") and docs/cutover-runbook.md.

- `kopje-admin media-rebuild [--dry-run]` (`POST /admin/media/rebuild`, Access admin only) makes the served files of
  local media whose files are missing from their originals in R2: media restored from a backup, which holds only the
  originals, and images moved by the cutover. Each is re-encoded as an upload is, and its sizes in `meta` are corrected
  to the files made. Rows whose files exist are skipped, so it can be run again; it reports rows whose original is
  missing, whose type does not match their URLs, or that fail to re-encode, and stops on the Images quota or the
  monthly transformation budget (exit 3). It writes only while nothing can delete media: before publication, or once
  the Store's maintenance (`kopje-admin maintenance on`) has lasted 20 minutes (otherwise `rebuild-needs-readonly` or
  `rebuild-settling`, exit 3). One call runs at a time under a Store lease, during which imports, resets, publication,
  leaving maintenance, PITR restores and every media-deleting write are refused; after a PITR restore it waits for the
  settle period again. A restore or a cutover thus serves its images when published
  ([docs/backup.md](docs/backup.md), [docs/cutover-runbook.md](docs/cutover-runbook.md) step 8).

- Publication of a cutover converted with `--images` sends an `Update(Person)` to the followers of each local account
  whose avatar or header the conversion changed, so other servers show the new profile images before Cloudflare Images
  is retired. `convert --images` lists those accounts in the dump (the `kopje_state` row `profile_updates`), which
  `verify-conversion` checks; `kopje-admin publish` queues the Updates in its transaction, reports them as
  `profileUpdates`, and queues none when repeated; it is refused while a dump runs (`dump-in-progress`). The list
  holds at most 100 distinct accounts: more changed profiles stop the conversion (`profile-updates-over-limit`). A dump
  that declares fewer restorable `kopje_state` names, such as one from 0.1.0-rc.2, is still accepted
  ([docs/cutover.md](docs/cutover.md), "Media").

### Changed

- The setup guide and the instance template's README state that Kopje needs the Workers Paid plan: the Free plan's
  10 ms of CPU time and 50 subrequests per request are exceeded by signature checks on federated requests, the daily
  backup and media processing.

### Instance changes

- Store schema: unchanged (`0000_initial`).
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
