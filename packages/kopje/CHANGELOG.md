# Changelog

All notable changes to the `kopje` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semver](https://semver.org). Before 1.0, a minor version may make breaking changes.

Each version says whether it changes the Store's schema (adds migrations) and whether an instance must change its
`wrangler.jsonc` (a binding, a compatibility date or flag). See [docs/upgrade.md](docs/upgrade.md).

## [Unreleased]

### Added

- The admin can suspend a remote account through the Mastodon admin API (`POST /api/v1/admin/accounts/:id/action`
  with `type=suspend`, which used to answer 422) and lift that suspension (`POST /api/v1/admin/accounts/:id/unsuspend`,
  which used to answer 403), with Mastodon's answers and errors. From the moment the suspension is saved:
    - the account is shown to nobody: its posts, boosts, notifications and interactions are hidden everywhere, its
      profile is shown blank with `suspended: true` (in the admin entity too), it is listed under `status=suspended`
      and not `active`, and its follow requests are neither listed nor accepted;
    - nothing more is sent to it but withdrawals (deletions, undos, and the rejections below), including deliveries
      queued earlier, pushes caused by it, and follows of it by local users, which are kept but not sent;
    - activities from it are ignored, except its deletions, undos and rejections. Its profile and keys are no longer
      updated, except its inbox addresses, so the rejections reach it. A move of its followers that is under way
      stops;
    - its reports are resolved, and its follows of local users are ended in the background, each with a rejection
      sent to it (a pending request is removed without one), as Mastodon does.
  Lifting the suspension makes the account visible again; ended follows stay ended, and Kopje does not fetch the
  account again as Mastodon does. Unlike Mastodon, which still delivers to suspended accounts what was queued before,
  Kopje checks every delivery again right before sending it.

### Changed

- The follow request list leaves out unavailable requesters (suspended, or being deleted) and reads a bounded window
  of requests per page, as the other filtered lists do: it may return a short or empty page while its `next` link
  still leads on.
- One account has a known size. A remote bio is stored within 64 KiB as a JSON string, cut by sanitizing a shorter
  part of it, so it stays valid HTML; realistic bios (5,000 characters of Japanese with links render to about
  28 KB) are never cut. A remote profile URL (`url`, avatar, header) longer than 2,048 characters is ignored, as an
  invalid one is. Accounts stored before this version are read within the same bounds wherever they are shown,
  mentions included: a longer bio reads as empty, a longer URL as none and a display name past 2,048 characters is
  cut, until the account is fetched again. The admin account search matches display names without reading them. With the
  fields' 32 KiB, one account serializes to at most about 123 KB, so a page of 80 to about 10 MB.
- Pages of followers, following, follow requests, `favourited_by` and `reblogged_by` read the profiles of the
  accounts they show only, not of every candidate their read window considered.
- Answers that present many accounts at once stop at a response body of 8 MiB. A typical account takes about
  2 KiB, so 1,000 still fit whole. `GET /api/v1/lists/:id/accounts` and `GET /api/v1/endorsements` with `limit=0`
  answer up to that and, when they stop short, send a `Link` header whose `next` answers the rest. That link
  carries `max_id`, which these `limit=0` answers now honour, a deliberate deviation from Mastodon, which ignores
  `max_id` with `limit=0`. `GET /api/v1/accounts/familiar_followers` shares the 8 MiB among the requested accounts
  that have followers to show, giving to the others what one leaves unused, so the answer does not depend on the
  order asked and one with large followers does not crowd out the others; past its share, an account shows fewer
  followers.

### Instance changes

- Store schema: adds one migration, applied on the first request after the deploy; a rollback to an earlier version
  needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0045_remote_suspension`: lets the admin suspend remote accounts. It adds two account columns, builds two
      indexes over the accounts and one over the queued outbound activities (one pass over each), drops one index, and
      adds a table: on the benchmark store of 1,000,000 accounts and 500,000 outbound activities its upgrade took 7.1
      seconds (7.0 in two more runs), most of it the overhead of an upgrade on a store that size, which an upgrade
      applying several files pays once.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.14] - 2026-10-18

A fourteenth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The admin (the account whose email is the instance's admin email) is notified when another Kopje user files a
  report (`admin.report`, as on Mastodon), with the report attached, in the notification lists of the API v1 and v2,
  the streaming API and Web Push (the `admin.report` alert). As on Mastodon, only the first unresolved report of an
  account notifies; the admin's own reports notify nobody; notification policies never filter it.
    - Only the current admin sees these notifications: when the admin email changes, or no single active account
      matches it, they disappear from every list, count, stream and push, and come back if the admin does. A report
      deleted with its reported remote account takes its notification along.
    - Difference from Mastodon: reports from other servers are not received, so they notify nobody.
- `GET /admin/reports/<id>`, which clients open when the admin taps a report notification, redirects to the reported
  account's profile. It is behind the `/admin` Access application like the rest of `/admin`: anyone else is refused
  before the report is looked up, and an unknown report answers 404.

### Changed

- Content (posts, edits, boosts, likes, follows, profile updates) is checked right before it is sent, and what is
  sent is read at that moment: it is not sent to an inbox whose recipients are all deleted or being deleted by then;
  deletions and other withdrawals still go. A delivery queued before this version knows no recipients and is checked
  by its sender only. Each delivery costs one more call to the Store.
- Lists that hide some of their rows from the viewer (timelines, account statuses, bookmarks, favourites,
  notifications, followers and following, who favourited or boosted, notification requests, list members,
  endorsements, the profile page and the outbox) read a bounded window of rows per request, so a long run of hidden
  rows (from accounts being deleted, or blocked, muted or domain-blocked by the viewer) costs a request the same as a
  short one. Such a list may now return a short or empty page while its `next` link still leads on, as Mastodon's
  lists do where it filters after paginating; clients that follow `next` reach everything behind it. A post
  hidden by its own visibility never supplies an id, and the quotes list never shows the id of a quote the reader may
  not see (stricter than Mastodon, which pages every accepted quote); a post hidden only by availability or by the
  viewer's own blocks, mutes and domain blocks may supply the id a `next` or `prev` link pages from.
- An outbox's `totalItems` is the account's post count (`statuses_count`), as on Mastodon, instead of the number of
  posts the outbox serves.

### Fixed

- Suspending an account through the admin API leaves reports filed, reopened or edited after the suspension
  unresolved, whatever times the requests carried.
- A page of remote accounts no longer risks the isolate's 128 MB memory limit when their actor documents carry huge
  profile-field lists. Each account now reads at most 16 fields, cut to their shown length and to 32 KiB of JSON, and
  shows only the leading fields whose sanitized names and values fit 32 KiB once serialized, dropping the rest whole.
  An answer of N accounts thus carries at most N × 32 KiB of profile fields (a list's 1,000 members with `limit=0`:
  32 MiB; familiar followers of 20 accounts, up to 1,600 presentations: 50 MiB). Profiles within these bounds show the
  same fields as before; existing accounts are covered without a migration.

### Instance changes

- Store schema: adds five migrations, applied on the first request after the deploy; a rollback to an earlier version
  needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). Applied together in one upgrade, as
  an instance coming from rc.13 applies them, the five took 11.0 seconds on the benchmark store with favourites and
  boosts (on a heavily loaded machine), within the 20-second budget for a release.
    - `0040_report_notifications`: lets a notification name a report. It reads each stored notification once and no
      other table: on a benchmark store of 1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses and 2,000,000
      notifications its upgrade took 3.1 seconds (3.1 in a second run) in workerd's local Durable Object SQLite.
    - `0041_report_notifications_key`: lets each report keep its own notification, and processes all stored
      notifications. On the same benchmark store its upgrade took 5.0 seconds on an idle machine (5.0 in two more
      runs; up to 7.6 on a loaded one). An instance with millions of notifications should expect a pause of several
      seconds on the first request after the deploy.
    - `0042_report_action_fence`: lets a suspension tell which reports were changed after it. A suspension still
      resolving reports at the upgrade whose moderation log entry has already been pruned (the log keeps the newest
      10,000) resolves none of them: resolve them by hand in your admin client. Its work grows with the moderation log
      (at most 10,000 entries) and the suspensions still resolving reports, not with the number of reports. On the same
      benchmark store its upgrade took 3.1 seconds (3.1 in two more runs; 6.1 on a loaded machine), a pause of a few
      seconds on the first request after the deploy.
    - `0043_read_window_indexes`: indexes the following list, who favourited a post and who boosted it in their
      paging order. It builds three indexes and reads nothing else: on the same benchmark store with 2,000,000
      favourites and 200,000 boosts added, its upgrade took 8.1 seconds (8.2 and 8.6 in two more runs), of which about
      6 is the overhead of an upgrade on a store that size (0042, upgraded alone there, took 6.0 and 5.9); an upgrade
      that applies several files pays it once. Expect a pause of several seconds on the first request after the deploy.
    - `0044_delivery_provenance`: lets each delivery record the recipients behind it. It changes the schema only and
      reads no row, however many deliveries are queued. On the same benchmark store its upgrade took 5.9 seconds (5.9
      and 5.8 in two more runs), all of it the overhead of an upgrade on a store that size, which an upgrade applying
      several files pays once.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.13] - 2026-10-17

A thirteenth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Kopje users can quote posts as on Mastodon 4.5. `POST /api/v1/statuses` accepts `quoted_status_id` (also in scheduled
  posts' `params`): a public or unlisted post whose policy permits it, or the poster's own post unless direct. Other
  targets, including blocks by either party, return 404 (`The post you are trying to quote does not appear to exist.`)
  before any 422, as Mastodon does. Scheduled quotes are rechecked at publication and dropped if refused. Quoting
  one's own followers-only post makes the quote followers-only; a direct quote of another author's post must mention
  them (422 otherwise). Quote text may be empty.
    - A quote of a Kopje post is accepted at once, and its author is notified (`quote`). A quote of a remote post is
      `pending` until its author's server approves it, then `accepted`; a refusal makes it `rejected`, and a later
      withdrawal `revoked`. The quoted author always sees the quote.
    - The post's text starts with an `RE:` link to the quoted post (class `quote-inline`), unless the text already
      links it, so clients and servers without quote support show the link.
    - `quote_approval.current_user` reports `denied` when the viewer cannot quote (including blocks in either
      direction), `automatic` for their own posts, and otherwise the policy's answer.
    - Clients offer quoting: Elk (it reads `current_user`), and with API version 7 (below) Phanpy, Ice Cubes and the
      official iOS and Android apps, which also show quote-policy controls and the quotes list.
    - Authors of quotes are notified when a post they quoted is edited (`quoted_update`), at most 100 per edit, newest
      quotes first.
    - Limits: Misskey ignores updates of posts, so a Misskey server keeps the first version of a quote it received
      and never learns of its approval or withdrawal. A deletion of a remote quoted post is not passed on to the servers
      that received the quote (as for boosts). A quote request, or the update announcing an approval, that falls while
      the quoting account is suspended is not sent later.
- Remote posts' quote policies are read and stored when a post is first received and whenever it is updated. Remote
  posts Kopje already stored stay unquotable until this instance receives an update of the post carrying its quote
  policy. Opening or resolving them again does not refresh it, and some may stay unquotable for good. Nothing is
  backfilled.

### Changed

- `/api/v1/instance` and `/api/v2/instance` declare Mastodon 4.5: `version` 4.5.0 and `api_versions.mastodon` 7, so
  clients switch on quote posts. Phanpy then hides the `RE:` fallback line of quotes. `/api/v2/instance` gains
  `configuration.timelines_access`, which says that anyone may read the public, hashtag and link timelines, as before.
- If a post's earlier delivery to a server is still in flight, an edit sends that server the new version followed by
  the edit, so it ends with the edited version even if the earlier delivery fails.

### Instance changes

- Store schema: adds one migration, applied on the first request after the deploy; a rollback to an earlier version
  needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0039_quotes_local`: marks which quotes Kopje users wrote. It reads each stored quote once and no other table:
      on a benchmark store of 1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses and 200,000 quotes its upgrade
      took 2.6 seconds (2.6 and 4.1 in two more runs) in workerd's local Durable Object SQLite.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.12] - 2026-10-17

A twelfth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Clients are shown the quote posts Kopje stores and verifies, as Mastodon 4.5 shows them. A status carries `quote`
  and `quotes_count` (its accepted quotes). Phanpy, Elk, Ice Cubes and the official iOS and Android apps embed a quoted
  post whatever the server's API version; Phanpy also shows the `RE:` line below API version 7. None of them offers a
  quote button: Kopje declares API version 6, and `quote_approval` tells every viewer they may not quote (below). Tusky
  shows the `RE:` line. Remote posts keep their `quote-inline` class, so clients can hide that line.
    - `quote` is `{state, quoted_status}`: the quoted post, presented for the same viewer (its own favourite and other
      flags, filters, media and poll), whose own `quote` is `{state, quoted_status_id}`, one level deep. A boost carries
      its original's quote in `reblog`. `state` is one of Mastodon's nine: `pending`, `rejected`, `revoked` and
      `deleted` without a post; `unauthorized` when the viewer may not see the quoted post (a public quote of a
      followers-only post, for one); `blocked_domain`, `blocked_account` and `muted_account`, with the post, when the
      viewer blocks its author's domain, blocks its author or mutes it, in that order; `accepted` otherwise, and always
      for the quoted author. A legacy quote (Misskey's, Fedibird's) is not shown until it is accepted, as Mastodon's;
      a self-quote is accepted.
    - `DELETE /api/v1/statuses/:id` answers with the quoted post of a quote in any state, when the viewer may see it,
      for redrafting.
    - `GET /api/v1/statuses/:id/quotes` (a token with `read:statuses`; an app token is answered as an anonymous viewer,
      as Mastodon's) lists the posts that quote a post the viewer may see, by their accepted quotes, newest first;
      `limit` 20 by default, at most 40. The quoted author sees every quote they may see, also those of accounts they
      block or mute, as in Mastodon; anyone else not those. Where Kopje differs from Mastodon: the cursor (`max_id`,
      `since_id`, `min_id`) is the quoting post's id, not the quote's. Each page reads a window of `limit` quotes and
      leaves out those the viewer may not list, so a page may be short or empty while its `next` link still leads on,
      as on Mastodon.
- Users on Mastodon and other FEP-044f servers can quote Kopje posts that are public or unlisted, as each post's quote
  policy allows; quoters the author blocks, or who block the author, are refused. Kopje users still cannot post quotes
  themselves (`quote_approval.current_user` stays `denied`). Edits and deletions of a quoted post also reach the
  accounts that quoted it. Requests for private and direct posts are never answered, so an answer never reveals that
  one exists.
    - Kopje users are notified of new quotes (`quote`, filtered by notification policies like a mention, and available
      to push subscriptions), and always see quotes of their own posts.
    - The quoted author can revoke a quote with `POST /api/v1/statuses/:id/quotes/:quoting_status_id/revoke`
      (`write:statuses`; Android's "Remove quote", Phanpy's revoke): 404 for a post the caller may not see or a quote
      that is not of it, 403 for someone else's post, otherwise 200 with the quoting post (a stand-in showing only its
      id, address, time, author and visibility when its author blocks the caller). The quoter's server and everyone
      who received the post are told; a revoked approval never becomes valid again.
    - Limits, as on Mastodon: a quoter whose quote was revoked can ask again and is accepted again while the policy
      allows it (a narrower policy or a block stops that). Where Kopje differs: a revoke also rejects each request it
      answered for the quote, so a Mastodon server that processes the withdrawal before an earlier approval still ends
      with the quote removed; one that processes an approval and a rejection at the same moment can still keep it.
- Quote policies, as Mastodon 4.5 has them: who may quote a post. Posts publish their policy to other servers, and
  Kopje's answers to quote requests follow it.
    - `POST /api/v1/statuses` takes `quote_approval_policy`: `public`, `followers` or `nobody`; none (or a blank one)
      is the account's default; any other value is answered 422 `Record invalid`, as Mastodon. A private or direct
      post always gets `nobody`. A scheduled post keeps the policy it was sent with, or the account's default when it
      was scheduled, in its `params` (`quote_approval_policy`), and is published with it.
    - `PUT /api/v1/statuses/:id` takes `quote_approval_policy` only when it is sent, as Mastodon 4.5.5. Where Kopje
      differs: a change of the policy alone is not an edit (no history entry, no `edited_at`).
    - `PUT` and `PATCH /api/v1/statuses/:id/interaction_policy` (`write:statuses`) change the policy of one's own post
      (none sent is the account's default) and answer with the post: 404 for a post the caller may not see, 403 for
      someone else's, then 422 for another value. The official Android app's "Change quote policy" uses it. A change
      is sent to other servers as an update of the post; quotes already accepted stay, as on Mastodon.
    - `source[quote_policy]` on `PATCH /api/v1/accounts/update_credentials` sets the account's default (`public`
      until changed; another value is refused with 422), shown in `source` of `verify_credentials` and as
      `posting:default:quote_policy` in `GET /api/v1/preferences`, as the official iOS app's default quote policy
      setting uses it.
    - Every status carries `quote_approval`: the `automatic` and `manual` flags of its policy (`public`, `followers`,
      `following`, `unsupported_policy`, in Mastodon's order; a boost shows its original's), and `current_user`, which
      is `denied` for every viewer while Kopje cannot post quotes itself. Posts written before the quote policies
      existed have `nobody`, and so does every remote post: Kopje does not read other servers' policies.

### Changed

- An edited post reaches a server that has never been sent it as the new version followed by the edit (one extra
  delivery to that server, the first time only), so a server that fetched the post on its own (to boost or quote it)
  also ends with the edited version.

### Instance changes

- Store schema: adds three migrations, applied on the first request after the deploy; a rollback to an earlier version
  needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0036_quotes_list`: adds the index the quotes list reads (each status's accepted quotes in quoting-post order). It
      reads the quotes once and no other table: on a benchmark store of 1,000,000 accounts, 3,000,000 follows,
      2,000,000 statuses and 200,000 quotes its upgrade took 2.4 seconds (2.3 in a second run) in workerd's local Durable Object SQLite.
    - `0037_quote_policy`: adds each status's quote policy (every stored post gets `nobody`) and each local account's
      default (`public`). It changes the schema alone, reading and rewriting no status: on the same benchmark store its
      upgrade took 2.3 seconds (3.2 in a second run) in workerd's local Durable Object SQLite.
    - `0038_quote_requests`: adds the approvals of quotes of local posts and the record of answered quote requests.
      It reads each stored quote once and no other table: on the same benchmark store its upgrade took 2.5 seconds
      (2.6 in a second run) in workerd's local Durable Object SQLite.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.11] - 2026-10-17

An eleventh release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The streaming API's `list` stream (`read` or `read:statuses`, with `list` naming one of the account's lists) carries
  the list's timeline: `update` and `status.update` when a status enters it or one in it is edited (as
  `GET /api/v1/timelines/list/:id` would show it at its place), and `delete` when a status or boost it held is deleted.
  The stream is echoed as `["list", "<id>"]`. A missing `list` answers `Missing list name parameter`, another
  account's list `Not authorized to stream this list` (401), as Mastodon; a value that is not a list id answers
  `Invalid parameter` (400).
- The `direct` stream (`read` or `read:statuses`) carries `conversation` whenever one of the account's conversations
  changes (a new status, read or unread, its last status deleted), as the conversation list presents it. Deleting a
  conversation sends nothing, as in Mastodon. Where Kopje differs: after a burst (accepting a request that adds many
  conversations at once) only the 20 newest changes are sent; the conversation list shows the rest.
- `notifications_merged` (payload `"1"`) is sent on `user` (with `read` or `read:notifications`) and
  `user:notification` when the account's last pending accepted notification request has had its notifications
  unfiltered, or a dismiss replaces it, as Mastodon's. Where Kopje differs: nothing is sent when the sender's purge
  cancels the job.
- The `public`, `public:local`, `public:remote`, `public:media`, `public:local:media` and `public:remote:media` streams,
  and `hashtag` and `hashtag:local` (with `tag`), carry `update` and `status.update` (`read` or `read:statuses`) when a
  public status that is not a boost is posted or edited, as `GET /api/v1/timelines/public` (with `local`, `remote` and
  `only_media`) or `GET /api/v1/timelines/tag/:tag` (with `local`) would show it at its place, presented as REST
  presents it to the account, with its matching filters in `filtered`. As Mastodon's: `public*` leaves out replies to
  others and the hashtag streams keep them; a status whose author the account blocks, mutes or domain-blocks, whose
  author blocks the account, or that mentions an account the account blocks or mutes, is not sent; a post published
  more than 6 hours before it arrived is not sent as `update`; and `delete` (the id) is sent for a public status, never
  a boost, on the streams it would have reached: its local or remote stream, the media streams if it had media, and
  the hashtag streams of its hashtags (`hashtag:local` for a local status).
    - The `tag` is echoed as the client sent it (`["hashtag", "#Cats"]`) and matched as Kopje normalizes hashtags, so
      `#Cats` and `cats` are one subscription. A missing `tag` answers `Missing tag name parameter`; one over 256
      bytes, as sent or normalized, answers `Invalid parameter` (400).
    - Where Kopje differs from Mastodon: an account the status's author blocks is sent no `delete` of it; there are no
      chosen languages or feed access settings to apply, and no silenced accounts.
    - Every stream Mastodon's streaming server knows is now served. Only other names (Ice Cubes' `local`, for one)
      answer `{"error":"Unknown stream type","status":400}`; announcements and server-sent events are still not
      served.
- Quote posts received from other servers are stored and verified, as Mastodon 4.5 does (FEP-044f). Nothing shows them
  yet: the API, the web pages and the notifications are unchanged, and a quote is still seen as its `RE:` link.
    - A post that quotes another (Mastodon's `quote`, or Misskey's and Fedibird's `_misskey_quote`, `quoteUrl` and
      `quoteUri`) keeps its quote, with every path that stores a post: delivered, boosted, found by search or fetched
      as a pin. A quote of a deleted post (a `Tombstone`) is kept as deleted. A quoted post embedded by its own author
      is taken as embedded, so a followers-only self-quote its server serves to nobody is still verified.
    - A quote is accepted when it quotes its own author's post, or when the quoted author's approval (the stamp, a
      `QuoteAuthorization` fetched from its own server) names exactly that quote of exactly that post. Other quotes stay
      pending, as Mastodon keeps them; one whose stamp is gone is rejected. Verification fetches the quoted post and its
      author when Kopje does not have them, runs in the background rounds the delivery asks for (seconds later, or at
      the next cron run), signed by a local recipient or follower when there is one, and is retried five times over
      about 15 hours; a verification that needs more fetches than a round allows goes on in the next round from where
      it stopped. A post first stored only as the target of a quote is verified like any other once it is delivered,
      boosted, searched for or pinned for itself.
    - The quoted author's `Delete` of a stamp revokes the quotes of their posts approved by it, for good; nobody else's
      `Delete` of the same address revokes anything of theirs. The same `Delete` relayed by
      another server (the quoting server forwards it) is applied when it carries the author's own signature (a Linked
      Data Signature or an FEP-8b32 proof); without one, Kopje only checks the stamp again.
    - Kopje's own posts now say that nobody but their author may quote them (`interactionPolicy.canQuote`), as Mastodon
      already assumes of a post without a policy.

- The admin API's accounts are served to the admin: the role's `manage_users` is granted with local suspension
  (below), so `GET /api/v1/admin/accounts`, `GET /api/v2/admin/accounts` and `GET /api/v1/admin/accounts/:id`, and
  `POST .../enable`, `unsilence`, `unsensitive`, `approve` and `reject`, as described for 0.1.0-rc.10, now answer the
  admin; everyone else is still answered 403. `GET /api/v1/accounts/verify_credentials` shows the admin's role with
  the permissions served (`1040`: manage_reports and manage_users).
- Local suspension through the admin API: `POST /api/v1/admin/accounts/:id/action` with `type` `suspend` suspends a
  local account, and `none` resolves the report named by `report_id`, if any; the answer is `{}`.
  `POST /api/v1/admin/accounts/:id/unsuspend` lifts a local suspension and returns the account.
    - A suspended account is unavailable at once: hidden as before, and every access token, web session, unused
      authorization code and push subscription it had is refused from that moment, also after it is unsuspended, so
      the user signs in again, which works as soon as it is unsuspended. This needs no clock: each credential carries
      the account's credential epoch, which a suspension moves. Its tokens are deleted afterwards, in the background.
    - Its unresolved reports filed before the suspension are resolved, in the background, unless the admin changed one
      since, even in the suspension's own millisecond; a report filed later stays open.
    - Other servers are sent an `Update` of its actor, redacted and marked `suspended`, and on unsuspension one of the
      full actor, as Mastodon sends them: to its remote followers, the remote accounts its posts of the two days
      before the suspension mention, and those it followed or asked to follow in those days. The audience is gathered
      in the background, in bounded rounds, so the `Update` leaves within minutes rather than at once.
    - While suspended, the account's posts, boosts and other activities still waiting for delivery are dropped when
      the queue reaches them, which it does within moments; only its retractions (deletes, undos) and the
      suspension's `Update` go out. A delivery already in flight when the suspension commits may still be sent.
    - Where Kopje differs from Mastodon: `disable`, `sensitive` and `silence` are answered 422
      `Validation failed: Type is not included in the list`, as an unknown type is (Kopje has none of these states);
      `suspend` of a remote account is answered 422 for now; `text` and `warning_preset_id` are accepted and dropped
      (Kopje keeps no warnings and sends no email); no action may target the admin's own account (403), as Mastodon
      refuses the Owner acting on the Owner; report resolution and the `Update`s finish in background rounds; and the
      `Update`s' recent mentions and follows count at most 2,000 inboxes each that no earlier source of the same
      `Update` reached, where Mastodon counts each source's own distinct inboxes.
- `POST /admin/accounts/unsuspend` and `kopje-admin account unsuspend <username>` (Access only) unsuspend a local
  account as the admin API does, logged with the Access identity. It recovers a suspended admin, whom no admin can
  unsuspend.

### Fixed

- The streaming API no longer sends a status (`update`) or an edit (`status.update`) over and over, with turns that
  never end, when it reaches more listeners than one turn of the fan-out serves (a status in the home timelines of more
  than 64 listening accounts, for one): the turn that went on with the event's remaining listeners moved its position
  back to where it resumed, so the next turn sent them the event again. Each listener now receives it once. A
  notification, which has one recipient, was not affected.

### Instance changes

- Store schema: adds four migrations, applied in order on the first request after the deploy; a rollback to an
  earlier version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0032_streaming_lists`: rebuilds the streaming journal (at most a 4,096-id span of rows) to admit conversation
      events, adds a column of the streaming position, lets a list subscription journal statuses and edits (the
      journal's triggers recreated), adds the per-account conversation mark table (left out of dumps and backups, as the
      other streaming tables are), a `stream_seq` column on conversations with a constant default and an index on it,
      and recreates the trigger that moves a conversation's last status back so it also takes the owner's next change
      sequence. It reads each conversation once, for the index, and the journal's rows; nothing else: on a benchmark
      store of 1,000,000 accounts, 3,000,000 follows and 2,000,000 statuses its upgrade took 2.3 seconds in workerd's
      local Durable Object SQLite.
    - `0033_quotes`: adds the empty `quotes` and `quote_revocations` tables, their indexes and the triggers that keep
      the new `statuses.quotes_count`. The column has a constant default and no constraint, so stored statuses are
      neither read nor rewritten; nothing is backfilled (stored posts keep their quote properties in `raw`), so the
      migration's work does not grow with the instance: on the same benchmark store its upgrade took 2.2 seconds.
    - `0034_admin_suspension`: adds the credential epoch columns to the local accounts and the OAuth tokens, and the
      empty tables of the moderation jobs and their staged audience. The columns have a constant default, so it reads
      no row: on the same benchmark store its upgrade took 2.2 seconds (2.7 in a second run).
    - `0035_streaming_public`: lets a `public*` or hashtag subscription journal public statuses that are not boosts,
      and their edits (the journal's status triggers recreated), and adds the table of a deleted public status's
      streaming tombstone (left out of dumps and backups, as the other streaming tables are). It creates a table and
      triggers and reads no row: on the same benchmark store its upgrade, with the kernel's bookmark and schema
      verification, took 2.2 seconds.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.10] - 2026-10-16

A tenth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The streaming API's `user` stream (`read` or `read:statuses`) carries the home timeline, as Mastodon 4.5's does:
  `update` when a status or boost enters it (the account's own included), `status.update` when a status in it is
  edited, and `delete` (the id) when a status or boost the account could see is deleted or unboosted. Each status is the
  one `GET /api/v1/timelines/home` would show at its place, presented as REST presents it to the account.
    - An edit of a post that mentions the account (one whose mention notification its list shows) is also sent as
      `status.update` on `user` when the token has `read` or `read:notifications`, and on `user:notification`, as
      Mastodon sends edits to the accounts a post mentioned.
    - As Mastodon, a post published more than 6 hours before it arrived (a remote post fetched late) is not sent as
      `update`.
    - `public*`, `hashtag*`, `list` and `direct` still answer `{"error":"Unknown stream type","status":400}`.
    - Where Kopje differs from Mastodon: at most 40 boosts of a deleted status are deleted on each account's stream,
      those by the account and by accounts it follows; nothing is sent when an account is purged; and a post of a
      followed hashtag is sent even when a page of home read from the top would leave it out behind 40 or more newer
      posts the account's home hides (`max_id` paging shows it at its place).
- The Mastodon admin API's 63 routes (`/api/v1/admin/*` and `GET /api/v2/admin/accounts`) are routed, each with its
  admin scope and an optional token, as Mastodon's. None is served yet: each answers as Mastodon answers a caller whose
  role lacks the route's permission.
    - `GET /api/v1/admin/trends/tags`, `/links` and `/statuses` answer `[]`, as the public trends do.
    - `GET`, `PUT`, `PATCH` and `DELETE` of one domain block, domain allow, IP block, email domain block or canonical
      email block answer 404 `Record not found`: Kopje stores none.
    - Every other route answers 403 `This action is not allowed`, to everyone, the admin included.
    - A token sent must be valid, or the answer is 401. It must cover the route's scope, or the answer is 403
      `This action is outside the authorized scopes`. An app token is let through, as by Mastodon.
    - The admin these routes will serve is the one local account whose email equals `admin_email`, compared trimmed
      and lowercased. There is none when `admin_email` is unset or empty, when no local account matches, when the match
      is suspended, or when two accounts match; nothing is picked then. The match is read in each request, so existing
      tokens follow a change of `admin_email` at once. `/setup` after bootstrap uses the same match.
    - `GET /admin/health` (Access only) shows `oauthAdmin`: `status` (`ok`, `unset`, `none`, `suspended` or
      `ambiguous`) and the matched `username`.
- The admin API's reports are served to that admin (the role's `manage_reports`), as Mastodon 4.5 serves them:
  `GET /api/v1/admin/reports` and `GET`, `PUT` and `PATCH /api/v1/admin/reports/:id`, and `POST .../assign_to_self`,
  `unassign`, `resolve` and `reopen`. Everyone else is still answered 403, a missing report included.
    - The list shows the unresolved reports, or with `resolved` (whatever its value, as Mastodon) the resolved ones,
      by `account_id` (the reporter) and `target_account_id`, newest first, with `Link` headers. It holds 100 reports
      by default and at most 200, and stops early, offering the next page, once its reports name 100 statuses.
    - A report shows its reporter, reported account, assignee and resolver as admin accounts (a local account's email
      and role; for a remote account the fields of a missing user are null), its rules, and the statuses it names
      that its reporter may still see; Mastodon shows them all.
    - `PUT` and `PATCH` change `category` and `rule_ids` with Mastodon's validations and messages; an unknown
      category is answered 422 where Mastodon fails.
    - The reporter's report shows `action_taken` once it is resolved.
    - `GET /api/v1/accounts/verify_credentials` shows the admin's role as `Owner` (id 3) with the permissions
      served (`16`); every other account keeps the default role.
- The admin API's accounts, for the admin once Kopje grants the role `manage_users`, which it does with local
  suspension (until then these routes still answer 403 to everyone, the admin included): `GET /api/v1/admin/accounts`,
  `GET /api/v2/admin/accounts` and `GET /api/v1/admin/accounts/:id`, and `POST .../enable`, `unsilence`,
  `unsensitive`, `approve` and `reject`.
    - The lists take Mastodon's filters: v1's names and defaults (active local accounts unless `remote` or a state is
      sent; the last state sent wins; `staff`), and v2's `origin`, `status`, `permissions=staff` and `role_ids`
      (one or many), with `username` (a prefix, a leading `@` dropped), `display_name` (a prefix), `email` (a
      prefix), `by_domain` (which replaces the origin, v1's default included, as in Mastodon), `ip` and
      `invited_by`. An unknown `origin` or `status` is answered 400 `Unknown origin: x` or
      `Unknown status: x`. Newest first, with `Link` headers; 100 accounts by default and at most 200.
    - Unlike Mastodon, v2 reads the v1 names Fedilab sends it (`local`, `remote`, the five states, `staff`) when no
      v2 filter name is sent: exactly one of `local` and `remote` gives the origin, exactly one state gives the
      status, so Fedilab's "all" lists every account.
    - No account is pending, disabled, silenced or sensitized, and no IP or invite is recorded: those filters, and
      roles other than Owner (`3`) and the default role (`-99`), list nothing. An account being deleted is listed as
      suspended, as its entity shows it.
    - A username, display name or domain search reads at most 2,000 accounts: a broader one is answered 422
      `search term too broad; add a filter or a longer prefix`, where Mastodon pages through it. A domain with more
      than 2,000 known accounts needs a username prefix too. Prefixes are literal (Mastodon reads `_` and `%` in them
      as wildcards) and compare letters case-insensitively in ASCII only.
    - `enable`, `unsilence` and `unsensitive` change nothing, log the action and return the account (`enable` needs a
      local account); `approve` and `reject` are answered 403, as Mastodon answers them for an approved user.
- The moderation log: every admin write through the admin API, and every account repair through `/admin`, is
  recorded with who made it (the admin's account and client, or the Access identity), in the write's transaction.
  It keeps the newest 10,000 entries. `GET /admin/moderation-log` and `kopje-admin moderation-log` show it, to
  Access only. Dumps and backups carry it; the cutover has none to carry.
- `POST /admin/accounts/email` and `kopje-admin account set-email <username> <email>` (Access only) set a local
  account's email, refusing one another local account has after trimming and lowercasing. It repairs a missing or
  ambiguous admin match.

### Instance changes

- Store schema: adds four migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0028_streaming_home`: adds the triggers that journal a status inserted while an account subscribes to `user`,
      and an edit while one subscribes to `user` or `user:notification`, the empty `stream_delete_viewers` table (a
      delete's capture), a column of the streaming position and an index of the subscription registry. The registry
      and the position hold only the open sockets' rows (every socket closes on the deploy), so its work does not grow
      with the Store. The new table is left out of dumps and backups, as the other streaming tables are.
    - `0029_admin_reports`: adds the reports' moderation columns (when resolved and by whom, the assignee, the time of
      the last change) and their indexes, replacing two, and the moderation log table. It reads only the reports: on a
      benchmark store of 1,000,000 accounts, 3,000,000 follows, 2,000,000 statuses and 10,000 reports its upgrade took
      2.3 seconds in workerd's local Durable Object SQLite.
    - `0030_admin_accounts`: adds an index of the accounts' lowercased display names, for the admin's display name
      search. It reads only the accounts: on the same benchmark store its upgrade took 2.8 seconds.
    - `0031_admin_accounts_available`: adds an index of the accounts whose deletion has not started, by id, so the
      admin's list of active accounts skips none awaiting their purge. It reads only the accounts: on the same
      benchmark store its upgrade took 2.8 seconds.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.9] - 2026-10-16

A ninth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- A remote account's pinned posts, featured hashtags and hidden network, learned as Mastodon 4.5 learns them:
  `GET /api/v1/accounts/:id/statuses?pinned=true` and `GET /api/v1/accounts/:id/featured_tags` now show a remote
  account's, and its `hide_collections` is shown and hides its followers and following lists as a local account's
  setting does.
    - Kopje reads the account's `featured` and `featuredTags` collections, and whether its `followers` or `following`
      collection hides its items, each time it stores the account's profile, in the background rounds a few minutes
      apart at most. A pinned post it does not have is fetched, signed by a local follower of the account if it has
      one. An `Add` or `Remove` of a post or a hashtag to the account's own featured collection (or of a hashtag to its
      featuredTags collection) changes one pin or featured hashtag at once.
    - Pins and featured hashtags are shown by the same rules as a local account's: a followers-only pin only to the
      account's followers, nothing of an account that blocks you. A featured hashtag counts, when it is shown, the
      account's public and unlisted posts with it among the newest 200 Kopje has of it.
    - A sync reads the featured collection, the followers and following collections, and the featuredTags collection
      as three parts, each applied as soon as it is read; a round reads the parts not read yet, so one cut short by the
      fetch budget is read in the next round. The pinned posts Kopje does not have are fetched in later rounds, as many
      as each round's fetch budget allows, and one that cannot be fetched is dropped. A collection that cannot be read
      for now (a timeout, a 5xx) is read again later, at most three times in a row without progress, and leaves what
      was learned as it was meanwhile; the pending pinned posts are fetched even then. A profile update while a sync
      runs is read again afterwards, with its own three tries.
    - Where Kopje differs from Mastodon: an account keeps at most 20 pins and 10 featured hashtags (Mastodon keeps any
      number for a remote account), from the first 20 items of its featured collection and the first three pages of its
      featuredTags collection; a collection is read only on the account's own server, and a pin only when it is the
      account's own post there; a followers or following collection that cannot be read for now hides nothing unless the
      other one hides its items (Mastodon takes it as hidden); a featured hashtag of a remote account counts its posts
      among the newest 200 Kopje has of it (Mastodon counts them all and keeps the count); a newly learned pin is
      ordered as the collection lists it (the first is the newest); and a remote account's featured hashtag links to
      `/@username@domain/tagged/:tag`, which leads to its profile on its server (Mastodon's link,
      `/@username/tagged/:tag`, names a local account of the same username).
- The streaming API's WebSocket, as Mastodon 4.5's streaming server serves it, for the notifications: clients open
  `wss://<domain>/api/v1/streaming` (any path below it is taken too) with the token as the subprotocol (echoed, as
  masto.js needs) or in the `Authorization` header, then send
  `{"type":"subscribe","stream":"user:notification"}` (or `user`, or `?stream=` on connect). `user:notification`
  (`read` or `read:notifications`) and `user` (`read` or `read:statuses`, with notifications only if the token also has
  `read:notifications`) carry `notification` events: each new notification the recipient's list shows, as REST
  presents it, and not one their notification policy filtered, as Mastodon. Other streams (`public*`, `hashtag*`,
  `list`, `direct`, and a name Mastodon does not know) answer `{"error":"Unknown stream type","status":400}`, and
  `user` carries no `update`, `status.update` or `delete` yet. `GET /api/v1/streaming/health` answers `OK`. SSE is not
  served (a request that is not an upgrade answers 404); no surveyed client uses it.
    - Delivery is at most once and live, with no replay: a client reads REST again after a gap, as with Mastodon.
    - A socket closes when its token is revoked, its web session signed out or its account suspended (at the next
      write), and when the token expires (within 5 minutes); every socket closes on each deploy, as Durable Objects
      drop WebSockets then, and clients reconnect.
    - Limits: 16 sockets per account (429 `Too many connections`), 256 per instance (503), 16 subscriptions per
      socket (`Too many subscriptions`), and incoming messages of text only (1003), at most 4 KiB and 120 a minute
      (1008).
    - Where Kopje differs from Mastodon: there is no protocol ping every 30 seconds (hibernated sockets are answered by
      the platform without waking the Store); the message rate counts every message a socket sends; and the token is
      not taken from an `access_token` query parameter, which would reach the platform's request logs (masto.js and
      Ice Cubes send it as the subprotocol), so a request with only that answers 401 `Missing access token`.

### Instance changes

- Store schema: adds two migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0025_remote_collections`: lets `status_pins` and `featured_tags` hold any account's rows (each table is rebuilt
      and its rows copied), adds `accounts.hide_collections`, and adds the empty `collection_syncs` and
      `collection_pins_pending` tables. Only local accounts have pins and featured hashtags until then, at most five and
      ten each, so its work grows with the local accounts alone (about four rows read per pin or featured hashtag). The
      new column has no default and no constraint, so the remote accounts and their statuses are neither read nor
      rewritten.
    - `0026_streaming`: adds the streaming API's registry of subscriptions, journal of events and position, and a
      trigger that journals a new unfiltered notification while its recipient has a subscription. It only creates
      empty tables (and the position's row) and the trigger, so its work does not grow with the Store. The three
      tables are left out of dumps and backups: they describe one object's open sockets.
- `wrangler.jsonc`: unchanged. The sockets live in the Store, which already exists, so no Durable Object migration
  (and no rollback barrier) is added.

## [0.1.0-rc.8] - 2026-10-16

An eighth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- oEmbed, as Mastodon 4.5 has it: `GET /api/oembed?url=` (no token) answers a `rich` embed of a status, with
  `author_name`, `author_url`, `provider_name`, `provider_url`, `cache_age` (a day), `width` (`maxwidth`, 400 by
  default) and `height` (`maxheight`, else null), and HTML that links to the status and loads `/assets/embed.js`. The
  script replaces the link with an iframe of the status's embed page, `/@username/:id/embed`, sized to the post. A
  status can be embedded exactly when its page shows it: a public or unlisted post, not a boost, of a local account that
  is not suspended; anything else, and any URL that is not a status page or object URI of this instance, answers 404.
  The embed page is the one page other sites may frame; every other page still refuses framing.
    - Where Kopje differs from Mastodon: the URL must name the status's author (`/@alice/:id` of another account's
      status answers 404, as its page does), and `/@alice@this.domain/:id` and the object URI (`/ap/o/...`) are taken;
      the HTML says "View on Kopje" without Mastodon's logo; the script is at `/assets/embed.js` (Mastodon:
      `/embed.js`) and frames only the `blockquote` embeds (not the older `iframe` ones).
- The follow limit of Mastodon 4.5 (`FollowLimitValidator`, at its defaults): `POST /api/v1/accounts/:id/follow` refuses
  a new follow or follow request with 422 and `Validation failed: You cannot follow more than 7500 people` once the
  account follows 7,500 accounts, or, past that, 1.1 times its followers (rounded). Pending requests do not count;
  changing an existing follow's options, authorizing a request (locally or by a remote `Accept`) and a `Move`'s
  follower transfer are not limited, as in Mastodon. It is an admission rule on the account's own follows, not a
  bound on what a home timeline reads.
    - Where Kopje differs from Mastodon: the limit and ratio are fixed (Mastodon reads `MAX_FOLLOWS_THRESHOLD` and
      `MAX_FOLLOWS_RATIO`).
- Attribution domains, as Mastodon 4.5 has them: `PATCH /api/v1/accounts/update_credentials` takes
  `attribution_domains[]` (the websites allowed to credit the account as the author of their articles), normalized as
  Mastodon does (surrounding whitespace and an `http://`, `https://` or `*.` prefix removed, blanks and duplicates
  dropped) and validated with its messages (each a domain name, at most 100). The credential account shows them in
  `source.attribution_domains` (`[]` when none), and the actor document publishes them as `attributionDomains` when
  there is one, which reaches other servers with the account's Update.
- An about page at `/about`: the server's title (else its domain), description, rules and contact address, as the
  instance endpoints give them. `/api/v2/instance` names it as `configuration.urls.about`, and the instance actor's
  `url` already pointed there.

### Changed

- A full Tag (`/api/v1/tags/:id` and its `follow`, `unfollow`, `feature` and `unfeature`, `/api/v1/followed_tags`,
  `/api/v1/featured_tags/suggestions` and the hashtags of `/api/v2/search`) has Mastodon's `id` (sent since 4.3.1).
  Kopje has no table of hashtags, so the id is derived from the normalized name (its 64-bit FNV-1a hash cut to 63
  bits, in decimal): the same on every endpoint and instance. No route takes it back; `/api/v1/tags/:id` still takes
  the name, as in Mastodon.
- Instance rules have Mastodon's `hint` and `translations` on every endpoint that shows them (`/api/v1/instance`,
  `/api/v2/instance`, `/api/v1/instance/rules`): the hint is the `hint` of a rule given as an object in the `rules`
  setting (else `""`), and `translations` is `{}`, since Kopje stores none. The about page shows the hint under its
  rule.
- `/api/v1/instance` and `/api/v2/instance` declare Mastodon `4.4.0` (was `4.0.2`), and `/api/v2/instance` adds
  `api_versions: { "mastodon": 6 }`, the number Mastodon 4.4 sends. Clients choose APIs by these numbers, and every
  API they switch on up to 6 is now served: grouped notifications (`/api/v2/notifications`), the notification policy,
  the link timeline, `delete_media`, the `blur` filter action, featured hashtags and OAuth PKCE. With this, Phanpy,
  Ice Cubes, Moshidon and the official iOS and Android apps use grouped notifications, Phanpy and Tusky offer the `blur`
  filter action, the official Android app signs in with PKCE, and the official iOS app shows an account's featured
  tab. Kopje stays below 7 (Mastodon 4.5) because 7 tells clients that quote posts are served, and they are not yet.
    - The official iOS app also shows a default quote policy in its privacy settings at 6. Kopje ignores it: no one can
      quote a Kopje post whatever it says.
    - `/api/v2/instance` has Mastodon 4.4's other fields with Kopje's values: `icon` (none), `configuration.urls`
      `about` (the about page), `status`, `privacy_policy` and `terms_of_service` (null),
      `configuration.accounts.max_pinned_statuses` (5), `configuration.media_attachments.description_limit` (1500),
      `configuration.limited_federation` (false), and `registrations.reason_required` (false), `min_age` and `url`
      (null).

### Fixed

- Authorizing a local account's follow request counts the follow in that account's `following_count` at once (it was
  counted only at the account's next follow change).

### Instance changes

- Store schema: adds one migration, applied on the first request after the deploy; a rollback to an earlier version
  needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0024_attribution_domains`: adds `local_accounts.attribution_domains`, an empty list for every account. Adding a
      column with a constant default reads no row, so its work does not grow with the Store.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.7] - 2026-10-16

A seventh release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The notification policy and notification requests, as Mastodon 4.5 has them: `GET`, `PATCH` and `PUT` of
  `/api/v1/notifications/policy` (`filter_not_following`, `filter_not_followers`, `filter_new_accounts`,
  `filter_private_mentions`, each true for filter and false for accept) and `/api/v2/notifications/policy`
  (`for_not_following`, `for_not_followers`, `for_new_accounts`, `for_private_mentions`, `for_limited_accounts`, each
  `accept`, `filter` or `drop`), with the `summary` of pending requests; `GET /api/v1/notifications/requests` (40 by
  default, at most 80, with Link headers), `GET /api/v1/notifications/requests/:id`,
  `POST /api/v1/notifications/requests/:id/accept` and `/dismiss`, the bulk `POST /api/v1/notifications/requests/accept`
  and `/dismiss` (`id[]`), and `GET /api/v1/notifications/requests/merged`. Scopes are `read:notifications` and
  `write:notifications` (or `read` and `write`).
    - A notification from an account you do not follow, from one that has not followed you for three days, from an
      account younger than 30 days you do not follow, or a private mention from an account you do not follow that
      answers none of your private mentions of it, is accepted, filtered or dropped as your policy chooses. Mentions,
      favourites, boosts, follows and follow requests are filtered or dropped; posts, edits and poll ends never are.
      By default, as on Mastodon, private mentions are filtered and the rest accepted.
    - A dropped notification is not written. A filtered one is written but left out of the notifications, the grouped
      notifications and both unread counts unless you ask with `include_filtered=true` (or, in v1, `account_id`); it is
      not pushed, joins no group, and a private mention does not reach your conversations. A filtered mention opens or
      updates a request for its sender, which counts up to 100 of them.
    - Blocking an account deletes its request and the permission you gave it by accepting one.
    - Accepting a request lets its sender through from then on, shows the sender's filtered notifications, and adds
      the private mentions among them to your conversations. Dismissing one deletes the sender's filtered notifications.
      Both happen in the request for up to 2,000 of the sender's notifications and in the background rounds for the
      rest; `merged` answers false until an accepted request's notifications are all shown.
    - Where Kopje differs from Mastodon: Kopje has no silenced accounts, so `for_limited_accounts` is kept but never
      matches, and no staff role that bypasses blocks, so no sender is exempt as staff; a follow counts from when it was
      requested, not when it was accepted; a request's count is kept as its mentions arrive, so deleting one of them
      does not lower it and the request stays until it is answered; the summary looks at 100 requests at most (Mastodon
      names that limit, but its query counts all of them); a v2 value other than `accept`, `filter`, `drop` or 0 to 2
      answers 422 (`'x' is not a valid for_not_following`) and changes nothing, where Mastodon answers 500; a v1 form
      value of `false` or `0` accepts, where Mastodon filters for any value sent; a domain block keeps the permissions of accepted requests from accounts there (Mastodon's
      AfterBlockDomainFromAccountService deletes them), so after an unblock those senders pass your policy again; the bulk
      forms take at most 100 ids
      (more answer 422); and `merged` reflects the work an accepted request has left, which Kopje runs in rounds a few
      minutes apart rather than at once. As on Mastodon, the bulk dismiss deletes the requests alone and leaves their
      filtered notifications, and `GET /api/v1/notifications/:id` and `GET /api/v2/notifications/ungrouped-:id` show a
      filtered notification.
- Reports, as Mastodon 4.5 has them: `POST /api/v1/reports` (`account_id`, `comment`, `category`, `rule_ids[]`,
  `status_ids[]`, `forward`, `forward_to_domains[]`), under the `write:reports` scope (or `write`), answered as Mastodon's
  Report entity. The report is stored for the instance's moderation; nothing else shows it yet.
    - The reported account must be available, and each reported status one of its statuses you may see on its profile
      (a private one only if you follow it, a direct one only if it mentions you); anything else answers 404, as on
      Mastodon. Blocking the account does not stop you from naming its statuses.
    - `rule_ids` make the category `violation` and must name rules of `GET /api/v1/instance/rules`, each once; a
      comment is at most 1,000 characters. Errors answer 422 in Mastodon's words.
    - With `forward` true, a report of a remote account is sent as a `Flag` from the instance actor (it does not name
      you) to the account's server when its domain is in `forward_to_domains` (by default its own; `forwarded` says
      whether it was), and to the servers of the accounts the reported posts reply to on the listed domains. It carries
      your comment and the addresses of the account and the reported posts.
    - A report stays when a reported post is deleted, naming it by its id; it goes with the reported account when a
      remote account is deleted.
    - Where Kopje differs from Mastodon: nobody is notified of a new report, as Kopje has no admin notification (no
      staff notification or email); Kopje has no admin view of reports yet; a report names at most 100 posts and 100
      forward domains (more answer 422, where Mastodon sets no limit); an unknown category answers 422
      (`Category is not included in the list`), where Mastodon answers 500; the `Flag` goes to a server's shared inbox
      when the account has one (as Kopje sends every activity without `to`), where Mastodon sends it to the reported
      account's personal inbox; its id is `https://<domain>/actor#reports/<uuid>`; and the application a report was made
      with is not kept.
- Mastodon 4.5's remaining small endpoints, under Mastodon's scopes, answered as Mastodon answers when the feature has
  nothing to show or is not configured: `GET /api/v1/annual_reports` (none),
  `GET /api/v1/instance/translation_languages` (`{}`), `GET /api/v1/emails/check_confirmation` (`true`) and
  `DELETE /api/v1/suggestions/:id` (`{}`); 404 for
  `GET /api/v1/timelines/link`, `GET /api/v1/annual_reports/:id`, `POST /api/v1/annual_reports/:id/read`,
  `POST /api/v1/announcements/:id/dismiss`, announcement reactions, `GET /api/v1/instance/terms_of_service/:date`,
  `POST /api/v1/statuses/:id/translate` and `GET /api/v1_alpha/async_refreshes/:id`; and 403 for
  `POST /api/v1/emails/confirmations`. `GET /api/v1/peers/search` finds up to 10 known peers by domain prefix, and
  `PATCH /api/v1/push/subscription` updates as `PUT` does.
- The profile directory, `GET /api/v1/directory`, as Mastodon 4.5 has it (token optional, any scope): the discoverable
  accounts, the most recently active first (`order=active`, the default; accounts that have not posted come last) or
  the newest first (`order=new`), all of them or the local ones (`local=true`), 40 by default and at most 80 by `limit`,
  from `offset`. A local account is listed when its owner made it discoverable, a remote account when its actor says
  `discoverable: true`. Suspended accounts and accounts being deleted are never listed, and a signed-in viewer is not
  shown the accounts they block or mute, those on domains they block, nor those that block them. An answer without a
  token may be cached for 15 seconds, as Mastodon's.
    - Where Kopje differs from Mastodon: an offset above 400 answers no accounts, and a page looks at most twice offset
      plus limit accounts of the directory, so when more than half of them are hidden from you (accounts you block or
      mute, say), that page comes back shorter; `order=active` goes by an account's newest public, unlisted or private
      post or boost as stored, the one its `last_status_at` shows, so the account moves back when that post is deleted,
      and accounts that have not posted are ordered newest first (Mastodon leaves their order open); an unknown `order`
      reads as `active` (Mastodon fails); Kopje has no silenced accounts, and it does not record that an account moved, so a moved
      account stays listed while its actor says it is discoverable.

### Changed

- Hashtags are normalized as Mastodon 4.5 normalizes them (HashtagNormalizer): NFKC, lowercase, Latin letters with
  diacritics folded to ASCII by Mastodon's table, and the characters a hashtag cannot hold dropped. `#Café`, `#cafe`
  and `#CAFÉ` are one hashtag, as on Mastodon, wherever a hashtag is named: in a posted or received status (a received
  `Hashtag` loses every `#` with the rest), on hashtag timelines, in home through a followed hashtag, in search, on
  the tagged profile page, and among featured hashtags, so featuring `blahaj` after `BLÅHAJ` is refused as taken.
  A hashtag in status text that leaves nothing once normalized (a lone combining mark) stays text, and hashtag search
  drops the spaces of its query rather than finding nothing. The cutover and `verify-conversion` name hashtags the same
  way. Stored names are renormalized by the migration below.
- Clearing notifications (`POST /api/v1/notifications/clear` and `/api/v2/notifications/clear`) and dismissing a group
  (`POST /api/v2/notifications/:group_key/dismiss`) answer as before, and what they remove is gone at once from the
  lists, a notification by id, the grouped notifications, both unread counts and the pushes waiting; the request
  deletes up to 2,000 notifications and the background rounds delete the rest, so however many notifications others
  sent, one request's work is bounded. A notification that arrives afterwards shows as usual.

### Instance changes

- Store schema: adds five migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0019_tag_normalization`: renames the stored hashtags (`status_tags`, `tag_follows`, `featured_tags`) to
      Mastodon's normalization. Names that become one are merged: a status keeps one row of the hashtag, an account
      keeps its earliest follow and its earliest featured hashtag (with its spelling), and the featured hashtags left
      are recounted from the account's statuses; a featured hashtag merged away sends no `Remove`, since Mastodon
      servers already hold the names as one featured hashtag. A name that leaves nothing is deleted. A stored name
      made from a word-final capital sigma keeps its `ς` (Mastodon would store `σ`), since the stored name cannot tell
      it from a typed `ς`. It reads each table once to find the names with a character other than `a`–`z`, `0`–`9`
      and `_`, walks each such distinct name's characters, and rewrites the rows of the renamed names through indexes,
      so its work grows linearly with the hashtag rows stored.
    - `0020_notification_policies`: adds `notifications.filtered` (every stored notification stays shown), the
      partial index of unfiltered notifications the lists read, and the tables of notification policies, permissions,
      requests and their background work. Adding the column reads no row; building the index reads each stored
      notification once and writes an entry for each, so its work grows linearly with the notifications stored.
    - `0021_directory`: adds `accounts.last_status_id` (each account's newest public, unlisted or private status, kept
      by triggers as statuses are stored, deleted or hidden), fills it with one lookup per account through an index, and
      indexes the discoverable accounts by the directory's two orders. Its work grows linearly with the accounts
      stored, whatever the statuses.
    - `0022_reports`: adds the table of reports. It only creates an empty table and its indexes, so its work does not
      grow with the Store.
    - `0023_notification_clears`: adds the empty tables of cleared notifications and dismissed notification groups
      waiting to be deleted. It reads no row.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.6] - 2026-10-16

A sixth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- `GET` and `POST /oauth/userinfo`, as Mastodon 4.5 has it: for a token with the `profile` scope, the OpenID Connect
  claims of its account (`iss`, `sub`, `name`, `preferred_username`, `profile`, `picture`). A token without `profile`
  is refused with 403, an app token with 422.
- `GET /.well-known/oauth-authorization-server` (RFC 8414), as Mastodon 4.5 has it: the OAuth endpoints, including
  `userinfo_endpoint` and Mastodon's `app_registration_endpoint`, the scopes, and the supported response types and
  modes, grant types, client authentication methods and PKCE methods.
- Filters, as Mastodon 4.5 has them: `/api/v2/filters` with keywords (`keywords_attributes`, `_destroy`) and statuses,
  `/api/v2/filters/:id/keywords`, `/api/v2/filters/keywords/:id`, `/api/v2/filters/:id/statuses` and
  `/api/v2/filters/statuses/:id`, and the v1 `/api/v1/filters` over the same filters. Every status shown to you carries
  in `filtered` your active filters that match it, whatever their context and action, and your client hides or warns by
  context, as with Mastodon. An account has at most 50 filters, a filter 20 keywords and 200 statuses. A status is
  matched on the beginning of its text: at most 10,000 characters each, and a response's statuses share 400,000 (short
  ones whole, long ones on an equal share), so a page is matched in full but a keyword deep in a long status of a very
  large thread may be missed (filtered statuses always match). Keywords match case-insensitively by simple Unicode case
  folding; the multi-character folds Mastodon also applies (ß and ss, İ and i̇) do not match. Deleting a v1 filter also
  deletes its filter when that leaves it with no keyword and no status.
- Conversations in the Mastodon API, as Mastodon 4.5 has them: `GET /api/v1/conversations` (paged by the last status
  with Link headers, 20 by default and at most 40), `DELETE /api/v1/conversations/:id` and
  `POST /api/v1/conversations/:id/read` and `/unread`. Scopes are `read:statuses` and `write:conversations` (or `read`
  and `write`); another account's conversation answers 404.
    - Your direct statuses, and the direct statuses you are notified of as a mention, are grouped by thread and by the
      other accounts in them. A received status that names its conversation, as Mastodon's do, joins that thread even
      when it arrives before the status it replies to. A new status from someone else marks the conversation unread; your own does not.
    - Deleting a status takes it out of its conversations; a conversation with none left goes. Deleting a
      conversation keeps its statuses, and a later one makes a new conversation. Blocking an account ends your
      conversations with it.
    - A conversation's last status is shown only while you may still see it (its author is not suspended and does not
      block you); otherwise it is `null`.
    - The conversations of the direct statuses already stored are made when the instance upgrades, and the cutover
      makes them of the statuses it carries.
- Timeline markers in the Mastodon API, as Mastodon 4.5 has them: `GET /api/v1/markers` (`timeline[]`: `home`,
  `notifications`; other names are ignored) and `POST /api/v1/markers` (`home[last_read_id]`,
  `notifications[last_read_id]`), each marker with its `last_read_id`, `version` and `updated_at`. Scopes are
  `read:statuses` and `write:statuses` (or `read` and `write`). An update that changes a marker counts a version; the
  same value changes nothing. `last_read_id` is kept as sent, up to 255 characters; a blank one answers 422 with
  Mastodon's message. Updates are applied one at a time, so two at once both succeed instead of one answering 409.
- Scheduled statuses, as Mastodon 4.5 has them: `POST /api/v1/statuses` with `scheduled_at` answers a
  `ScheduledStatus`, checked as a post is, at least 5 minutes ahead, at most 300 per account and 25 per day (a time
  not in the future posts at once). `GET /api/v1/scheduled_statuses` lists them, and `GET`, `PUT`, `PATCH` and
  `DELETE` on `/api/v1/scheduled_statuses/:id` show, move and delete one. The cron publishes each when it is due
  (within its 5-minute schedule) as an ordinary post, and drops one that no longer passes (the status it replies to is
  gone, or its account is suspended); one that fails with an error is retried four times over about five hours, then
  dropped. An `Idempotency-Key` that scheduled a status answers with it on a repeat, with or without `scheduled_at`.
  Media attached to a scheduled status is kept until it is published or deleted.
- Polls, as Mastodon 4.5 has them: `POST /api/v1/statuses` takes `poll[options][]`, `poll[expires_in]`,
  `poll[multiple]` and `poll[hide_totals]` (2 to 4 choices of at most 50 characters, 5 minutes to a month, refused
  with media), and every status shows its `Poll`. `GET /api/v1/polls/:id` shows a poll to whoever may see its status,
  and `POST /api/v1/polls/:id/votes` (`choices[]`) votes, with Mastodon's validation and messages; a voter who blocks
  the author is refused. `hide_totals` hides the counts from everyone until the poll ends, and who voted is never
  shown. Editing a status's poll moves its end, and changed choices drop the votes cast; an edit without a poll
  removes it. A scheduled status keeps its poll and creates it on publication. When a poll ends, its local author and
  local voters are notified (`poll`, with Web Push), by the cron within its 5-minute schedule.
    - Over ActivityPub, a poll is a `Question` in its Create, Update and served object; votes in a local poll update
      it with an Update about 3 minutes after the first new vote (one for all, and one when it ends), and a vote in a
      remote poll goes to its author as Mastodon's vote Note. A received `Question` is stored with its poll, an
      Update refreshes its counts and end, and a received vote counts in a local poll once, from an account that may
      see it, and is never stored as a status.
    - Where Kopje differs from Mastodon: a poll's id is its status's id; a voter who blocks the author's domain is
      refused, since the vote could not be delivered; a remote poll keeps at most 100 choices of 1,000 code units, and a
      choice cut to that length cannot be voted for; any Note naming a choice in reply to a local poll is treated as a
      vote, never as a status; a local poll's `Question` says `closed` once the cron has ended it, within 5 minutes of
      its end; and the Update of counts reaches remote voters only for a public or unlisted status.
- `PATCH /api/v1/media/:id`, the same update as `PUT`, and `DELETE /api/v1/media/:id`, as Mastodon 4.5 has them (scope
  `write:media`): your own media only, else 404. Media a status uses, or a scheduled status holds, answers 422 with
  Mastodon's message, and so does an image the cutover kept unattached (one only earlier versions of a status show, or
  one legacy kept); otherwise the media is deleted with its files and the answer is `{}`.
- `DELETE /api/v1/profile/avatar` and `DELETE /api/v1/profile/header`, as Mastodon 4.5 has them (scope
  `write:accounts`): the account shows the default image again, the removed image's files are deleted, followers'
  servers receive the profile `Update`, and the answer is your `CredentialAccount`.
- Followed hashtags, as Mastodon 4.5 has them: `POST /api/v1/tags/:id/follow` and `/unfollow` (scope
  `write:follows`), and `GET /api/v1/followed_tags` (scope `read:follows`; newest follow first, 100 by default and at
  most 200, with Link headers). A name that is not a hashtag answers 404; any other name may be followed, used or not.
  Home also shows the public statuses, not boosts, with a hashtag you follow, from anyone, unless you block or mute
  their author or an account they mention, block their author's domain, or their author blocks you. The Tag entity
  shows `following` and `featuring` to a signed-in user wherever it appears, search's hashtags included.
    - Where Kopje differs from Mastodon: an account follows at most 100 hashtags; home shows a followed hashtag's
      statuses posted before the follow too (home is read, not filled as statuses arrive), and they leave it at once
      on an unfollow; the followed hashtags and the suggestions below show each hashtag with an empty `history`, as
      search's do; and home looks at most two pages (at least 40) of a followed hashtag's newest statuses for a page, so
      when most of them are hidden from you (say, a blocked account's), that page shows fewer of the hashtag's
      statuses.
- Featured hashtags, as Mastodon 4.5 has them: `GET` and `POST /api/v1/featured_tags`,
  `DELETE /api/v1/featured_tags/:id`, `GET /api/v1/featured_tags/suggestions` (the hashtags of your newest 1,000
  statuses you do not feature yet, the most used first), `POST /api/v1/tags/:id/feature` and `/unfeature` (scopes
  `read:accounts` and `write:accounts`), and `GET /api/v1/accounts/:id/featured_tags`, public, empty for a suspended
  account. An account features at most 10 hashtags, with Mastodon's validation and messages. Each shows the number of
  your public and unlisted statuses with it and the date of the newest, kept as you post, edit and delete. Its `url`,
  `/@username/tagged/:tag`, is your public profile page with only your posts with the hashtag.
    - Over ActivityPub, the actor publishes `featuredTags` (its featured hashtags as `Hashtag`s) and `featured` (its
      pinned statuses, below), and featuring or unfeaturing a hashtag sends your followers Mastodon's `Add` or
      `Remove` of the `Hashtag`; before an account's first one, its followers are sent the actor again, as servers that
      stored it earlier know no `featured` collection to add to. Kopje does not read the featured hashtags of remote
      accounts.
    - Where Kopje differs from Mastodon: an edit that adds a hashtag to an older status keeps the newest date rather
      than taking the older status's.
- The remaining account endpoints of Mastodon 4.5:
    - Private notes: `POST /api/v1/accounts/:id/note` (`comment`, at most 2,000 characters; a blank one deletes the
      note) answers the Relationship. Every Relationship now carries your note on the account in `note`; nobody else
      is shown it.
    - Endorsements: `POST /api/v1/accounts/:id/endorse` and `/unendorse` (also as `/pin` and `/unpin`), which answer
      the Relationship, now with a real `endorsed`; `GET /api/v1/endorsements` (yours, 40 by default and at most 80
      with Link headers, or all at once with `limit=0`, up to 1,000), which no longer answers empty; and
      `GET /api/v1/accounts/:id/endorsements` (anyone's, to anyone). You can endorse only an account you follow (else
      422 with Mastodon's message), and the endorsement goes when the follow ends, however it ends. Suspended accounts
      and accounts being deleted are not listed. Endorsements are not federated, as in Mastodon 4.5.
    - `POST /api/v1/accounts/:id/remove_from_followers` ends the account's follow of you: a remote follower is sent a
      `Reject`, as when a block ends its follow. A pending request is left alone.
    - `GET /api/v1/accounts?id[]=` shows up to 40 accounts at once, as `GET /api/v1/accounts/:id` shows each; more
      answer 422.
    - `GET /api/v1/accounts/:id/identity_proofs` answers `[]`, as Mastodon's deprecated endpoint does.
    - `POST /api/v1/accounts` (registration) answers as Mastodon does with registrations closed: 403 `Forbidden` for an
      app token with `write:accounts`, after Mastodon's token checks. Kopje has no open registration.
- The remaining status actions of Mastodon 4.5:
    - Pins: `POST /api/v1/statuses/:id/pin` and `/unpin` (scope `write:accounts`), which answer the status. You can pin
      up to 5 of your own statuses, not boosts or direct statuses; anything else answers 422 with Mastodon's messages,
      and pinning a status again answers 422 `Duplicate record`. Your statuses now carry a real `pinned`, and
      `GET /api/v1/accounts/:id/statuses?pinned=true` lists an account's pins, newest pin first, to whoever may see
      each. Your actor publishes its `featured` collection of pins (the post of a public or unlisted one, the address
      of any other), and your followers' servers are sent an `Add` or `Remove` when you pin or unpin; before an
      account's first one, pin or featured hashtag, its followers are sent the actor again. A later `Add` or `Remove` of
      the same status replaces an earlier one still waiting or given up. Deleting a pinned status unpins it.
    - Conversation mutes: `POST /api/v1/statuses/:id/mute` and `/unmute` (scope `write:mutes`) mute the conversation
      of a status you may see, and every status of it then shows `muted: true` to you. While it is muted, nothing in
      it notifies you (mentions, favourites, boosts, poll ends, edits), and its direct statuses no longer reach your
      conversations; notifications you already had stay.
    - `GET /api/v1/statuses?id[]=` shows up to 20 statuses at once, those you may see and have not filtered out by a
      block, mute or domain block, each as `GET /api/v1/statuses/:id` shows it, in the order asked; more answer 422.
    - `PATCH /api/v1/statuses/:id` edits a status, as `PUT` does.
- Grouped notifications, as Mastodon 4.5 has them: `GET /api/v2/notifications` answers `accounts`, `statuses` and
  `notification_groups` (with `types[]`, `exclude_types[]`, `grouped_types[]`, `expand_accounts=partial_avatars` and
  paging with Link headers, 40 groups by default and at most 80), `GET /api/v2/notifications/:group_key` shows one
  group, `GET /api/v2/notifications/:group_key/accounts` lists its accounts, and
  `POST /api/v2/notifications/:group_key/dismiss` and `POST /api/v2/notifications/clear` delete. Favourites and
  boosts of the same status, and follows, group by the hour, joining a group of the same kind from up to 11 hours
  before; v1 notifications show their `group_key` too. Scopes are `read:notifications` and `write:notifications` (or
  `read` and `write`).
    - A group counts and shows only the notifications you are shown in v1: a notification from an account you have
      since blocked or muted, or about a status you may no longer see, is left out.
    - Each group on a page counts and samples its notifications up to the page's newest, those below the page
      included, as Mastodon does.
    - Where Kopje differs from Mastodon: a group counts at most 400 notifications, and a page reads at most 2,000
      notifications, skipping those of the groups it has found, so a page ends early, with the groups found and a `next`
      link that goes on from there, only when its walk meets more than that of the groups it found (in practice a status
      favourited by thousands within a few hours). A dismissed group is not remembered, so a later notification within
      its hours starts a new one. Dismissing a group and clearing hide its notifications, or all of them, from every
      read at once; the request deletes up to 2,000 of them and the background rounds delete the rest.
    - Notifications stored before the upgrade stay ungrouped, each a group of its own, as Mastodon left those it
      stored before it grouped them.
- `GET /api/v1/notifications/unread_count` and `GET /api/v2/notifications/unread_count`, as Mastodon 4.5 has them: the
  notifications (v1) or groups (v2) newer than your notifications marker, up to `limit` (100 by default, at most 1,000),
  with the same filters as the lists.

### Changed

- A missing, unknown or expired bearer token is refused with a `WWW-Authenticate: Bearer` challenge
  (`error="invalid_token"`), as Mastodon refuses it.
- The public timeline, account statuses, notifications, favourites and bookmarks read a bounded number of rows for a
  page anywhere in the history, and home and list timelines no longer read the statuses of followed accounts they
  hide entirely. Home reads only the mentions of you in direct and limited statuses by accounts you follow, not every
  mention of you, and the statuses of an account that blocks you, that you block, or that is suspended or being deleted
  are no longer read to show its empty profile.
- A page of a list's members (`GET /api/v1/lists/:id/accounts` with `max_id` or `min_id`) is read from its cursor, not
  from the newest member.

### Fixed

- Media an edit removes from a status stays with the status, as with Mastodon, so the status's edit history still
  shows it: it is no longer deleted a day after the edit. The status no longer shows it, and it cannot be attached to
  another status or a scheduled status; a later edit of the same status can attach it again, and it is deleted with
  the status (at once with `delete_media`, otherwise after the grace period, as the status's other media). An image
  that only earlier versions of a converted status show now belongs to that status too, so it is no longer offered as
  an unattached upload, and goes with the status.

### Instance changes

- Store schema: adds eleven migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0008_status_mentions_requires_mention`: adds `status_mentions.requires_mention` and `status_mentions.author_id`,
      marks the mentions in direct and limited statuses with their status's author, and indexes them by recipient and
      author. Its work grows linearly with the mentions stored (one pass, with a lookup of each one's status); locally,
      200,000 mentions took under a second.
    - `0009_conversations`: adds `statuses.thread` (the thread a status belongs to, given to each status stored, from
      the start of each reply chain down, and to each new one by a trigger), the `conversations` and
      `conversation_statuses` tables, the trigger that takes a deleted status out of its conversations, and the
      conversations of the direct statuses stored. It rewrites every status once (its thread) and reads each a few
      times, so its work grows linearly with the statuses stored; locally, 500,000 statuses, 50,000 of them direct in
      two long reply chains, took about 1.2 seconds.
    - `0010_markers`: adds the `markers` table. It is quick.
    - `0011_scheduled_statuses`: adds the `scheduled_statuses` table and `media_attachments.scheduled_status_id`, with
      their indexes. Its work grows linearly with the media stored (one pass to add the column and one to build its
      partial index).
    - `0012_filters`: adds the `filters`, `filter_keywords` and `filter_statuses` tables, empty. Its work does not grow
      with the Store.
    - `0013_polls`: adds the `polls` and `poll_votes` tables, with their indexes, and `status_edits.poll_options`. It is
      quick.
    - `0014_account_notes_and_pins`: adds the `account_notes` and `account_pins` tables, empty, and the trigger that
      deletes an endorsement with its follow. Its work does not grow with the Store.
    - `0015_media_shown`: adds `media_attachments.shown`, rebuilds the index `media_attachments_status` with it, and
      gives back to its status, not shown, each kept upload that earlier versions of exactly one status of its author
      name (an image the cutover kept for earlier versions, or media an edit detached that is more than an hour from
      its sweep); other uploads stay as they are. Its work grows linearly with the media and the edits stored (one pass
      over the media for the column and one for the index, and one over the edits' media, grouped by id, with a
      lookup of each named upload).
    - `0016_tags`: adds the `tag_follows` and `featured_tags` tables, empty, and `local_accounts.featured_announced`.
      It is quick.
    - `0017_notification_groups`: adds `notifications.group_key`, empty for the notifications stored, and its partial
      index by recipient and group. It reads each notification once to build the index, so its work grows linearly
      with the notifications stored.
    - `0018_status_pins_and_conversation_mutes`: adds the `status_pins` and `conversation_mutes` tables, empty. Its
      work does not grow with the Store.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.5] - 2026-10-15

A fifth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- `kopje-admin keys rewrap` moves the private keys of local accounts and the instance actor from the KEK in
  `USER_KEK_PREVIOUS` (unset reads as the empty KEK) to `USER_KEK`, keeping the same key pairs. Keys already under
  `USER_KEK` are skipped, so it can run again; a key neither KEK unwraps is reported and left unchanged. See "Rotating
  the KEK" in docs/setup.md.

### Changed

- Home and list timelines read a bounded number of rows per page.

### Instance changes

- Store schema: unchanged.
- `wrangler.jsonc`: unchanged. `USER_KEK_PREVIOUS` is a new optional secret, set only while rotating the KEK.

## [0.1.0-rc.4] - 2026-10-15

A fourth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Lists in the Mastodon API, as Mastodon 4.5 has them: `GET` and `POST /api/v1/lists`, `GET`, `PUT`, `PATCH` and
  `DELETE /api/v1/lists/:id` (`title`, at most 256 characters; `replies_policy` `followed`, `list` or `none`, `list` by
  default; `exclusive`), at most 50 lists per account; `GET`, `POST` and `DELETE /api/v1/lists/:id/accounts`
  (`account_ids[]`; the members paged by Link headers, 40 by default and at most 80, or all at once with `limit=0`, up
  to 1,000); `GET /api/v1/accounts/:id/lists`; and `GET /api/v1/timelines/list/:id`. Scopes are `read:lists` and
  `write:lists` (or `read` and `write`). Errors answer as Mastodon's do (422 with its validation messages, 404 for an
  unknown account or a list of someone else's).
    - A list holds you and accounts you follow or have asked to follow; anyone else is refused. An account whose
      request is pending is listed but adds nothing to the timeline until you are accepted.
    - The list timeline has the public, unlisted and private statuses and boosts of its members, filtered as home
      filters them (blocks, mutes, domain blocks, a follow's boosts and languages), with the list's `replies_policy`
      deciding which replies to others are shown. Like home, it is worked out when read, so it also shows what members
      posted before they were added.
    - An exclusive list keeps its members' statuses and boosts out of home. Post notifications (`notify` on a follow)
      are still sent for them, as in Mastodon.
    - When your follow of a member ends (you unfollow it, either of you blocks the other, a domain block's cleanup
      reaches it, it rejects or removes your follow, or its account is deleted), it leaves your lists, and following it
      again does not bring it back. When an account you follow moves, its new account takes its place in your lists.

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

- The cutover leaves out a legacy list member that is neither the list's owner nor an account the owner follows or has
  asked to follow, counted (`list_accounts:not-followed-left-out`): legacy kept members whatever the follows, while a
  list in Kopje, as in Mastodon, holds an account only while you follow it. `verify-conversion` expects the same.

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

- A `Move` whose new account a follower may not follow (the follower blocks it, or its domain) leaves that follower's
  follow of the old account, and the old account in the follower's lists, as they are, as in Mastodon. Before, the old
  follow was ended anyway.

- The cutover reads a legacy export that holds `d1_kv`, a table D1 now creates in a database by itself: the table list
  of the export (`kopje-admin fingerprint tables-sql`) leaves it out, as it leaves out `_cf_*`, and the fingerprint and
  the conversion ignore both in an export that has them. Before, such an export was refused as a schema mismatch.

- A remote actor that deletes itself again, after its earlier deletion's 30-day record has expired and it was stored
  again, is purged to the end and its record renewed, also when the expired record has not been cleaned up yet.

- Home applies its rule to your own direct and limited statuses too. A converted Store can hold a legacy direct boost
  of yours, and home used to list it with its original even when you may no longer see the original (its author
  blocks you or is suspended, or it is private and you no longer follow its author) or you filter its author; such a
  boost is now left out, as your other boosts are.

### Instance changes

- Store schema: adds seven migrations, applied in order on the first request after the deploy; a rollback to an earlier
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
    - `0007_list_members`: removes the list members whose list's owner neither is nor follows them (a Store converted
      by an earlier release keeps them), and adds the trigger that removes a member with the follow. Its work grows
      linearly with the list members stored (one check of each); it is quick.
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
