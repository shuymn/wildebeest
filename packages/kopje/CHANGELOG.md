# Changelog

All notable changes to the `kopje` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semver](https://semver.org). Before 1.0, a minor version may make breaking changes.

Each version says whether it changes the Store's schema (adds migrations) and whether an instance must change its
`wrangler.jsonc` (a binding, a compatibility date or flag). See [docs/upgrade.md](docs/upgrade.md).

## [Unreleased]

### Added

- Blocks, mutes and domain blocks in the Mastodon API, as Mastodon 4.5 has them: `POST /api/v1/accounts/:id/block`,
  `/unblock`, `/mute` (`notifications`, default true, and `duration` in seconds, 0 for no expiry) and `/unmute`, which
  answer the Relationship; `GET /api/v1/blocks` and `GET /api/v1/mutes` (with `mute_expires_at`), paged by Link
  headers; and `GET`, `POST` and `DELETE /api/v1/domain_blocks` and `GET /api/v1/domain_blocks/preview`. Scopes are
  `read:blocks`, `write:blocks`, `read:mutes`, `write:mutes` or `follow`.
    - A block ends the follows between the two accounts both ways. A blocked remote account is sent an `Undo` of our
      follow, a `Reject` of its follow, and the `Block`; an unblock sends the `Block`'s `Undo`. A blocked account (or
      one on a blocked domain) is not mentioned in, or sent, the statuses you write after the block (deliveries already
      queued are sent as queued, as in Mastodon).
    - A mute is not federated. It expires after its duration: it stops applying at that time, whether or not it has
      been removed yet. `muting_expires_at` in relationships shows the expiry.
    - A domain block takes the domain as Mastodon normalizes it and refuses this instance's own domain. As in Mastodon
      4.5, it ends your follows to and from accounts on that domain (a `Reject` to each follower, an `Undo` of each of
      your follows). Kopje does this in the background in bounded batches until done (the Queue and the 5-minute cron
      continue it); meanwhile what you post is not delivered to followers there. Unblocking the domain stops the rest.
    - `GET /api/v1/domain_blocks/preview` needs `write:blocks` (or `write` or `follow`), as in Mastodon.

- Web Push, as Mastodon 4.5 offers it. `POST`, `GET`, `PUT` and `DELETE /api/v1/push/subscription` keep one
  subscription per access token, under the `push` scope, with Mastodon's alerts (per notification type) and policy
  (`all`, `followed`, `follower`, `none`) and `server_key` from `VAPID_JWK`. The endpoint must be a public https URL
  and the client keys valid, or the request answers 422. Each new notification is pushed to the recipient's
  subscriptions that want it, from the Queue consumer, with the retries of deliveries; right before each POST, the
  notification is checked again and the push dropped if it is gone or no longer shown. Pushes are encrypted as the
  subscription asks (`standard`: RFC 8291 aes128gcm; otherwise the aesgcm draft most clients use), signed with VAPID
  (RFC 8292), and carry Mastodon's payload, the subscription's access token included. A push service answering a 4xx
  other than 408 and 429 ends the subscription, as Mastodon 4.5 does. Revoking a token or suspending an account
  deletes its subscriptions. Without `VAPID_JWK`, the endpoints answer 404 and the instance advertises no key; Kopje
  never makes one.

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
  among up to 10,000 of the user's follows (at most 20 ids and 80 accounts each), without accounts the user blocks,
  mutes (while the mute lasts) or whose domain the user blocks.

- Empty answers, under the scopes Mastodon requires, for features Kopje has no data for yet: `GET /api/v1/filters`,
  `/api/v2/filters`, `/api/v1/followed_tags`, `/api/v1/featured_tags`, `/api/v1/accounts/:id/featured_tags`,
  `/api/v1/endorsements`, `/api/v1/announcements` (any user token), `/api/v1/trends` (and `/trends/tags`,
  `/trends/statuses`, `/trends/links`), `/api/v1/suggestions` and `/api/v2/suggestions`.

- `hide_collections`, Mastodon's setting to hide an account's network: `PATCH /api/v1/accounts/update_credentials` takes
  it, and the Account entity and the credential account's `source` show it (`null` for a remote account, whose setting
  Kopje does not learn). While it is on, the account's followers and following are listed to nobody but the account
  itself, familiar followers show none of its followers (to anyone, as Mastodon) and leave it out as a follower, and the
  ActivityPub followers and following collections show their size (`totalItems`) only and refuse a page (403), as
  Mastodon's do.

- The `profile` OAuth scope, as Mastodon 4.5 has it: an app may register and request it alone or with other scopes. A
  `profile` token reads `GET /api/v1/accounts/verify_credentials` (the same answer as with `read:accounts`) and no other
  route that requires a scope; `read` does not include `profile`.

### Changed

- An inbound `Announce` of a local status by an account its author blocks, or by an account on a domain its author
  blocks, is ignored, as an inbound `Like` (a favourite or a reaction) by a blocked account already was; a `Like` by an
  account on a blocked domain is now ignored too. A public or unlisted status is not visible to a remote account on a
  domain its author blocks, as in Mastodon 4.5's status policy. Mastodon stores such favourites and boosts and filters
  only their notifications.

- `GET /api/v1/accounts/:id/followers` and `/following` read an optional token (`read:accounts`), as Mastodon does,
  and list as Mastodon 4.5 lists for the viewer: nothing when the account is suspended, or, to anyone but the account
  itself, when it blocks the viewer or hides its network; and without the accounts the viewer blocks, mutes (while
  the mute lasts) or is blocked by. A suspended account stays in the lists, shown redacted. The ActivityPub followers
  and following collections of a suspended account answer 404, as its outbox does.

- Who an outbound activity goes to is decided by one rule, by what the activity does. Content (a new status, an edit,
  a boost) still goes to no account you block or whose domain you block, and to no unavailable account (suspended, or
  a remote account being deleted). The `Undo` of a boost now names and reaches the boosted status's author even when
  you block them or their domain, as every other `Delete` and `Undo` does. A profile change, and a `Delete` or `Undo`,
  now also reach a follower on a domain you have just blocked, until the domain block's cleanup has ended that follow,
  as Mastodon 4.5 sends them; new statuses still do not reach that follower.

- Home and mention notifications also leave out a status that mentions or replies to an account you block or mute
  (for mention notifications, a mute that hides notifications), as Mastodon filters them; so do post notifications
  of accounts you follow with `notify`, whenever home leaves the status out.

- A post notification (`notify` on a follow) is no longer created, shown or pushed for a post by an account you mute,
  even with a mute that keeps notifications, as Mastodon creates none: home leaves that post out.

- Home leaves out a reply whose conversation partner is unknown: a reply to a status the instance never stored, or one
  continuing such a reply, as Mastodon's home does. A reply to an account whose deletion has been processed counts as
  one, so removing that account no longer brings into home a reply that home left out. A reply whose parent is deleted
  keeps its partner and stays in home as before. Your own replies are shown as before. Such a reply also creates, lists
  and pushes no post notification (`notify` on a follow), as home leaves it out.

- The cutover converts a legacy domain block as Kopje's API stores one: lowercase, in punycode and without a trailing
  dot, the form domain blocks are matched in. Rows that become the same block are merged, and a value that is no
  domain name is dropped and counted (`domain_blocks:invalid-domain`), so the conversion stops on it until
  `--accept-deletions`.

- `verify-conversion` also compares hashtags, status language and edit time, actor type and discoverability, each
  local account's aliases and posting defaults (visibility, sensitivity, language), follow languages, the Like and
  Block records of favourites and blocks, and client websites.

- The cutover converts a status's language as Kopje reads one from a remote object: the primary subtag of the first
  language in `contentMap` (else `nameMap`, `summaryMap`), when it is two or three letters. It used to keep the whole
  tag, and only when `contentMap` had a single language.

- The cutover names hashtags as Kopje does: a received `Hashtag` tag loses only its one leading `#`, and a legacy
  `note_hashtags` value is kept whole, both then NFKC and lowercase. It used to drop a leading `#` or `＃` from either,
  so a tag named `＃Foo` became `foo` rather than `#foo`.

- The cutover carries a local account that never set `discoverable` as not discoverable, as legacy showed and published
  it, rather than as unset. A remote account that omits it stays unset, as Kopje stores a fetched actor.

- `VAPID_JWK` must hold the private key (`d`), not only the public point: a key without it now makes the instance
  answer 503 as misconfigured, as any invalid value does.

- Hashtag timelines and a tag's history read only the statuses that can appear on them: each hashtag records whether
  its status is public, and these reads go through an index of those hashtags, so their work no longer grows with the
  tag's unlisted, private, direct or limited statuses. A hashtag timeline also reads each requested tag in status id
  order from the page's cursor and stops once it has a page, so a page's work no longer grows with the tag's history.
  What they show is unchanged. The cutover writes the mark and `verify-conversion` compares it.

- The content of an account being deleted is hidden as soon as its deletion starts: from the transaction that accepts a
  remote account's `Delete`, its statuses, boosts, notifications and interactions are shown to nobody, it cannot be
  followed, mentioned, boosted or found, and the account itself is shown redacted (`suspended: true`), while its purge
  removes what it has in the background. Blocks and mutes of the account are removed last, so a post that mentions it
  stays filtered for whoever blocks or mutes it while that mention remains.

- A suspended account's rescue documents (its actor document and WebFinger answers, served while the Store refuses
  requests) are removed when the account is suspended: they answer 503 until a live request keeps the redacted
  document, which is then served.

### Fixed

- The cutover reads a legacy export that holds `d1_kv`, a table D1 now creates in a database by itself: the table list
  of the export (`kopje-admin fingerprint tables-sql`) leaves it out, as it leaves out `_cf_*`, and the conversion
  ignores it in an export that has it. Before, such an export was refused as a schema mismatch.

- A remote actor that deletes itself again, after its earlier deletion's 30-day record has expired and it was stored
  again, is purged to the end and its record renewed, also when the expired record has not been cleaned up yet.

- Home applies its rule to your own direct and limited statuses too. A converted Store can hold a legacy direct boost
  of yours, and home used to list it with its original even when you may no longer see the original (its author
  blocks you or is suspended, or it is private and you no longer follow its author) or you filter its author; such a
  boost is now left out, as your other boosts are.

### Instance changes

- Store schema: adds six migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0001_blocks_and_mutes`: `mutes.expires_at` with an index, and the `domain_block_cleanups` table. It is quick.
    - `0002_web_push`: the subscription's encoding and sealed token on `push_subscriptions`, and the
      `push_deliveries` table.
    - `0003_domain_block_form`: drops the trailing dot that earlier converters kept on a legacy domain block, so the
      block keeps applying now that blocks are compared as stored, and merges a row that then repeats a block of the
      same account. It is quick.
    - `0004_status_tags_public`: adds `status_tags.public`, marks the hashtags of public statuses, and indexes them.
      Its work grows linearly with the hashtags stored (one pass, with a lookup of each one's status); locally, 500,000
      hashtags took a few seconds.
    - `0005_hide_collections`: adds `local_accounts.hide_collections`, 0 for every account. It is quick.
    - `0006_account_deletion`: adds `accounts.deleted_at` with a partial index, and marks the account of a purge that
      is still running. Its work grows linearly with the accounts stored (one check and one index pass); locally,
      200,000 accounts took under a second.
- `wrangler.jsonc`: unchanged. Set the `VAPID_JWK` secret to turn Web Push on.

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
