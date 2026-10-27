# Changelog

All notable changes to the `kopje` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semver](https://semver.org). Before 1.0, a minor version may make breaking changes.

Each version says whether it changes the Store's schema (adds migrations) and whether an instance must change its
`wrangler.jsonc` (a binding, a compatibility date or flag). See [docs/upgrade.md](docs/upgrade.md).

## [Unreleased]

### Added

- Status pages have Boosts, Favourites and Quotes tabs beside Replies (`/@user/:id/reblogs`, `/favourites`,
  `/quotes`), each named by its count, and the post's counts link to the tabs
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md); VIS-4 in [docs/threat-model.md](docs/threat-model.md)).
  No migration; `wrangler.jsonc`: unchanged.
- Profiles have a Follow button and status pages an "Open on your server" button: each opens a dialog with a form for
  the viewer's server and the handle or post URL to paste into its search. The form leads to a page here
  (`/@user/interact`, `/@user/:id/interact`) that links to that server's `/authorize_interaction` with the account's
  or post's URI; it never redirects, fetches or stores anything, and accepts the server only as a domain name
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Remote interaction; WEB-2 and WEB-4 in
  [docs/threat-model.md](docs/threat-model.md)). Status pages also offer the post's embed code in a dialog, and name
  the post's oEmbed with a discovery link in the head, as Mastodon's do. On the pages that load the script, a copy
  button beside the handle, the URL and the embed code copies it; without script the text is selected by hand. No
  migration; `wrangler.jsonc`: unchanged.
- Status pages (`/@user/:id`) show the thread: the post's ancestors above it, and a Replies tab below it with its
  direct replies, oldest first and paged both ways; each links to its own page or, from another server, to its origin
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md); VIS-4 and RES-7 in
  [docs/threat-model.md](docs/threat-model.md)). Migration `0082_public_replies`; `wrangler.jsonc`: unchanged.
- An edited post's page has its edit history: the post's "Edited" opens a dialog listing the versions newest first,
  each labelled Current, Edited or Original and dated, with its own content warning, sensitive media and poll choices.
  The dialog opens and closes without script (Esc, its close button or a click outside close it). When older versions
  do not fit the page, the dialog says how many are not shown. The embed shows no history. No migration;
  `wrangler.jsonc`: unchanged.
- Accounts besides the admin's are made by invitation (MD-1): `kopje-admin invitation add <email> <username>`
  (Access only, logged; `invitation` lists, `invitation remove <email>` withdraws) invites an email, and that
  identity's first sign-in through Access makes its account. `POST /api/v1/accounts` stays 403, and passing Access
  alone makes no account ([docs/setup.md](docs/setup.md), "Adding accounts"; threat model AUTH-9). Invitations are
  data: a dump carries them. Migration `0081_account_invitations`; `wrangler.jsonc`: unchanged.
- Remote custom emoji are served from the instance too (`/media/r/<token>/<file>`), each kept per domain and URL:
  the cron fetches an emoji a remote status, its edit or an account names, keeps it only as recognized PNG, GIF or
  WebP below 256 KiB, and shows a still remuxed from an animated one as `static_url`. Only the first 16 emoji of a
  status, an account or a moved-to account show the cached copy; the others keep their remote URLs, so a page stays
  within the Store's memory bound. An emoji is deleted 90 days after the last post or profile that names it, and once
  a domain block covers its domain, when the cron's walk over the cache reaches it. Existing accounts and the remote
  statuses that arrived in the last `MEDIA_CACHE_RETENTION_DAYS` are covered by the backfill
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Custom emoji). No migration; `wrangler.jsonc`:
  unchanged.
- Remote posts' attachments are served from the instance too (`/media/r/<token>/<file>`): the cron fetches the file
  and the icon of each attachment of a remote post that arrived within `MEDIA_CACHE_RETENTION_DAYS` (default 14; 0
  keeps every one), and a status shows them as `url` and `preview_url`, its remote URLs staying in `remote_url` and
  `preview_remote_url`. Images below 16 MiB are cached with their metadata stripped (an animated one with a still);
  video and audio below 40 MiB with a declared length are streamed to the bucket as served, one at a time beside the
  profile images and emoji; Ogg, HEIC and QuickTime keep their remote URLs. A copy is deleted once stored longer than
  the retention, and with its attachment, its post or its account. `MEDIA_CACHE_RETENTION_DAYS` now takes effect; the
  backfill covers the remote attachments within it ([docs/mastodon-deviations.md](docs/mastodon-deviations.md),
  Media). No migration; `wrangler.jsonc`: unchanged.
- Instance domain blocks take `reject_media` through `POST /api/v1/admin/domain_blocks` and its update, which
  answered 422 for it: nothing of an account a block with it rules (its profile images, its attachments) or of the
  emoji named for its domains is cached, so they keep their remote URLs, and the copies already cached are deleted
  when the cron's walk over the cache reaches them. As with Mastodon, the longest matching block decides, so a nearer
  block without `reject_media` keeps its subdomains cached, and the public block list does not show a block that only
  rejects media ([docs/visibility.md](docs/visibility.md), "Instance domain blocks";
  [docs/mastodon-deviations.md](docs/mastodon-deviations.md), Media). No migration; `wrangler.jsonc`: unchanged.
- Profiles have a Featured tab (`/@user/featured`): the account's featured hashtags, at most ten, each linking to its
  hashtag page with its count of posts, and the accounts it endorses, 40 at a time and paged both ways ("Previous" by
  `min_id`, "Next" by `max_id`), as the API lists them to anyone. A page with a cursor is marked `noindex, follow`.
  The page is HTML only. Breaking: a featured hashtag's count that is not an integer from 0 to 2^53−1 (only an import
  stores one) is presented as 0, as account counts are, by `GET /api/v1/featured_tags`,
  `GET /api/v1/accounts/:id/featured_tags` and the page alike, and `GET /api/v1/featured_tags` ranks by that count; a
  stored time is read only up to its date. Migration `0078_featured_tags_order` indexes featured hashtags by account
  and id (reads every featured hashtag once); `wrangler.jsonc`: unchanged.
- A remote author's `Delete` of its own public or unlisted post, carrying the author's proof (an RsaSignature2017
  signature or an FEP-8b32 proof) that verifies, is forwarded as received by each local account that boosted the post
  (at most 16; a direct or limited boost, which only converted data holds, forwards nothing), to that account's
  followers and to the servers its boost reached, signed by that account, before the boost's `Undo`; a body over
  64 KiB is not forwarded. The post is hidden as soon as the `Delete` is received, before
  its removal starts ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Forwarded deletes). No migration;
  `wrangler.jsonc`: unchanged.
- `/@user/followers` and `/@user/following` list the account's followers and the accounts it follows, newest follow
  first, 40 at a time, paged both ways, and the profile's counts link to them; an account that hides its network
  shows only its counts there. The settings page has a "Hide who you follow and who follows you" checkbox
  (`hide_collections`). No migration; `wrangler.jsonc`: unchanged.
- `/tags/:name` is a page of the hashtag's local public posts, replies included and boosts not, as an anonymous
  visitor sees them, newest first and paged both ways ("Older posts" by `max_id`, "Newer posts" by `min_id`). Any
  spelling of a name serves the page of its normalized name, named as canonical; a page with a cursor is marked
  `noindex, follow`. A name that is not a hashtag answers the ordinary 404 page. The page is HTML only, with no
  ActivityPub collection or RSS feed. No migration; `wrangler.jsonc`: unchanged.
- Profiles have tabs: Posts (`/@user`), Posts and replies (`/@user/with_replies`) and Media (`/@user/media`), each a
  full page that pages both ways ("Older posts" by `max_id`, "Newer posts" by `min_id`). The Posts tab now also lists
  the account's boosts whose original an anonymous visitor may see, labelled with the booster's name, and its first
  page shows the account's pinned posts first, labelled "Pinned" (they stay in the list too). Posts and replies lists
  replies and no boosts, Media the posts with media, and `/@user/tagged/:tag` now includes replies. A page with a
  cursor is marked `noindex, follow` and names its first page as canonical. No migration; `wrangler.jsonc`: unchanged.
- Profile tabs, status pages and hashtag pages show each post's time in the viewer's time zone, shortened by its
  distance from now: the time alone today ("18:30"), the date and time within 24 hours ("Dec 31, 23:59"), the date
  alone this year ("Oct 20"), and the date with its year before that ("Oct 20, 2025"). Screen readers read the full
  form, for example "Oct 24, 2026, 08:30 GMT+9", and hovering shows it; the status page always shows it for its own
  post and the edit history for each version, and a poll's end keeps its time ("Oct 30, 21:00"). Without script, and
  on every page that loads none, such as embeds, times stay in full and in UTC; the privacy policy's "Last updated"
  and the settings page's authorized apps show only the UTC date ("Oct 1, 2026"), as Mastodon's policy page does. The
  pages load one small deferred script for it, cached for a year like the stylesheet
  ([docs/web-pages.md](docs/web-pages.md)); their CSP allows only that script (WEB-2 in
  [docs/threat-model.md](docs/threat-model.md)), and every other page stays script-free. No migration;
  `wrangler.jsonc`: unchanged.
- `GET /api/v1/instance/activity` answers Mastodon's 12 weeks (`week`, `statuses`, `logins`, `registrations`, each a
  string) instead of 404, by default, as Mastodon's `activity_api_enabled` does: the local public and unlisted
  statuses and boosts created, the distinct local accounts with a login (an authenticated request, or the setup) and
  the accounts set up, per 6 UTC days, counted from the upgrade on (earlier weeks read 0; imports and restores count
  nothing). The answer is the same for every caller, kept for its UTC day, with Mastodon's `Cache-Control`. To turn it
  off, run `kopje-admin instance activity_api_enabled=false` (or `POST /admin/instance`); it then answers an empty
  404. Counts and logins are kept for today, the 184 days before it and tomorrow; the 5-minute cron deletes the
  others, at most 500 rows of each table a run, so an imported backlog takes several runs
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Instance and apps;
  [docs/setup.md](docs/setup.md)).
- Remote accounts' avatars and headers are served from the instance (`/media/r/<token>/<file>`) instead of their
  servers: the 5-minute cron fetches each one through the media sink (https only, at most 3 redirects, 30 seconds),
  keeps it only as recognized JPEG, PNG, GIF or WebP below 2 MiB with its metadata stripped, and stores it
  with a still for an animated one in the media bucket under `remote/`. `avatar_static` and `header_static` show the
  still. Until a file is cached, and when it cannot be, the remote URL is shown as before. Existing remote accounts are
  cached newest first by a backfill; a new avatar or header URL is cached again, and a suspended, blocked or deleted
  account's files are deleted. New optional variables: `REMOTE_MEDIA_CACHE_BYTES` (default 4 GiB) caps the cache's
  bytes in R2, the oldest files deleted to stay below it (0 turns caching off; a positive value below 256 MiB is a
  configuration error, which makes requests answer 503 until it is fixed), and `MEDIA_CACHE_RETENTION_DAYS` (default 14)
  is how long cached remote attachments will be kept (none are cached yet). The cache is not backed up or dumped: a
  restored or imported Store caches again, and the cron deletes the files under `remote/` it does not know a day after
  their upload ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Profile credentials;
  [docs/setup.md](docs/setup.md); [docs/backup.md](docs/backup.md); [docs/observability.md](docs/observability.md)).
  Migration 0077; `wrangler.jsonc`: unchanged.
- `/authorize_interaction`, where another server's follow button sends a person with an account here, and WebFinger
  names it for every account as Mastodon does (`http://ostatus.org/schema/1.0/subscribe`, with the template
  `https://<domain>/authorize_interaction?uri={uri}`). The page shows a form prefilled with `uri`; its look-up, a POST
  checked like every web form, signs the browser in first if needed and comes back to the form, fetches the account
  or post as search with `resolve=true` does, and shows it as an anonymous visitor would, with a Follow button.
  This instance's own accounts and posts are found by address, profile URL or permalink. Following tells apart a
  follow that took effect, a request sent, one already pending, one refused and an account not found, names the
  account, and wakes delivery at once ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Remote
  interaction).
- Status pages, profile tabs, hashtag pages and embeds show a post's media by type: video, gifv (looping and muted,
  with controls, never playing by itself) and audio play in the page, loading nothing until played, beside images, and
  a file of another type is a link. A video's poster is its own preview only. They show a post's poll (each choice's
  share as text and a bar, how many took part and when it ends; with "hide totals" no share until it has ended; no
  voting), its quoted post nested when an anonymous visitor may see it, or else the quote's state, and custom emoji in
  names, profile fields, content warnings, content and poll choices, up to 64 images a field and 512 a page. The CSP
  of the public pages and the embed adds `media-src 'self' https:`; other pages' is unchanged (WEB-2 in
  [docs/threat-model.md](docs/threat-model.md)). A status page's description holds at most 200 characters of its
  content warning. The public pages read at most 1 MiB of posts or accounts a page, so a page of very large posts
  shows fewer of them (or one as a link) and links on to the rest; the API's pages are unchanged. No migration;
  `wrangler.jsonc`: unchanged.

### Changed

- The web pages share one spacing and type system: a spacing scale and a type scale, spacing given by each container
  rather than by margins, and one box for every button and link button. Every page's heading sits above its cards;
  settings and /setup lay out each section and step as a heading above its card, and /setup lists its steps with
  their status at the top. A poll's choice is one outlined row whether its counts are shown or hidden; shown, the
  share fills the row behind its text and is written at its end ([docs/web-pages.md](docs/web-pages.md), UI rules). No
  migration; `wrangler.jsonc`: unchanged.
- The web pages follow one set of UI rules ([docs/web-pages.md](docs/web-pages.md), UI rules): one alert for every
  result, with a refused field's error in place of its hint; pagers that show only the pages offered and name what they
  page ("Newer accounts", "Earlier replies", shortened on a phone); a back link above the page's card; the profile card
  with its Follow on every profile tab, the Featured tab included; the look-up result's Follow beside the author; one
  primary button a page, in amber with dark text in both schemes; lowercase counts, each linking to its tab on a post of
  this server; hashtags written with their `#`; names with their custom emoji in dialog and page headings; and meta
  lines whose separators never start or end a line. The status page's "Open on your server" and "Embed" are in a "Share"
  menu; the handoff page's link reads "Continue", with the whole host below it; a post too large to show is a slim row;
  error pages offer Retry; the OAuth consent page and settings' authorized apps group the permissions in plain language,
  and the consent page warns of admin ones; a described attachment has an "ALT" badge that shows its description, and a
  missing description shows no marker; a copy button shows its result by its icon, without moving the dialog; custom
  emoji scale with their text; every dialog closes on an outside click, and one opened from the "Share" menu returns
  focus to "Share"; the handoff page names its target (the account, or the post's author and the start of its text)
  above "Continue"; text in an unknown language, a post's without one and an account's name and bio, no longer takes the
  page's English; and the policies and the about page, on their pages and in `/api/v1/instance/*` as Mastodon's do, keep
  the operator's headings. The consent page warns of admin permissions in red and keeps the scopes' own names behind
  "Technical scopes"; copy fields have short names with their instruction below; an open poll with hidden counts says
  when results appear; a post too large to show says so; the about page names the contact account, links the contact
  email and shows the Kopje version; and settings' checkboxes are named in plain words. No migration; `wrangler.jsonc`:
  unchanged.
- Keyword filters set how much of an answer's text they match from a length stored with each status when it is
  written, so presenting an answer no longer reads every candidate's text first. A status stored before the upgrade,
  converted or imported counts at an upper bound of its text until it is written again, so a keyword deep in a long
  status of a very large answer may be missed sooner than before
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Filters). The shared 400,000 code units now hold for an
  answer whatever the stored lengths say. Migration `0079_filter_text_units`; `wrangler.jsonc`: unchanged.
- Inbound jobs (an actor's purge, a `Move`, a status's removal) are isolated from each other: each batch runs in its
  own savepoint, and a batch that fails, or that leaves work without moving anything, is recorded on its job, which
  runs again after 5, 10, 20, 40 and 80 minutes and parks after its 6th such batch instead of holding back every job
  behind it; a request whose first batch fails still commits the activity. Logged as `kopje.jobs.item.failed` and
  `kopje.jobs.item.parked`. A parked job keeps its status hidden or its actor's tombstone, except a deletion job that
  arrives already parked (an import's) naming a status never hidden: no round selects it, so the status stays shown
  until a delivery of its `Delete` hides it, or `kopje-admin jobs retry` makes the job runnable and the next round
  hides it. `kopje-admin jobs retry` (`POST /admin/jobs/retry`) makes every failing job fresh again
  ([docs/threat-model.md](docs/threat-model.md), RES-5). A remote boost that another status boosts is hidden at its `Delete` or `Undo` and removed by a delete job,
  never at once. Migration `0080_inbound_job_attempts` adds the retry columns and two indexes to `inbound_jobs` (reads
  every job once); `wrangler.jsonc`: unchanged.
- Every other job family is isolated the same way: a stamp revocation's, a domain block cleanup's, a notification
  request job's, a clear's or group dismissal's and a local or remote moderation job's batch runs in its own
  savepoint, and one that fails is recorded on its row, backs off and parks after its 6th failure, while the next item
  runs; a request whose first batch fails (blocking a domain, answering notification requests, clearing
  notifications or dismissing a group, a stamp's `Delete`) still commits. A new decision makes a parked job fresh (the
  admin suspending the account again, a domain block's transition into or out of suspend, a clear or dismissal
  reaching newer notifications). A round of stamp revocations runs at most 100 batches. An unlock acceptance whose
  authorization fails passes over the request, which stays pending for the account to answer, and logs
  `kopje.jobs.step.failed`. `kopje-admin jobs retry` now resets every family's failing jobs
  ([docs/threat-model.md](docs/threat-model.md), RES-5). Migration `0084_family_job_attempts` adds the retry columns and
  two indexes to each of these job tables (reads each once); `wrangler.jsonc`: unchanged.
- Breaking: restore refuses a dump holding a boost of a boost (a status boosting a status that is itself a boost),
  which no Kopje writer makes and which the deletion jobs cannot remove; a Store restored earlier with one parks the
  job that meets it ([docs/dump-format.md](docs/dump-format.md), "Bounded work"). No migration; `wrangler.jsonc`:
  unchanged.
- A page, context, search, history or lookup reads its statuses in chunks of at most 416 KiB of row heap (was 448
  KiB): the bound now counts each remote author's and moved-to account's cached profile images and each row's cached
  emoji, and the smaller chunk keeps the Store's peak within half its memory
  ([docs/threat-model.md](docs/threat-model.md), RES-3). No migration; `wrangler.jsonc`: unchanged.
- The public pages (`/about`, the documents, profiles, `/@user/tagged/:tag`, status pages and embeds) each make one
  Store call instead of two: the page's read also reads the instance's domain and documents, in the same snapshot.
  Every public page, its 404 and 410 pages, and the sign-in and settings pages now link the terms of service and the
  privacy policy in the footer when they exist, not only `/about`. A profile's reply-to lines link a parent that an
  anonymous viewer may see. A page whose first post is too large to show beside the profile shows a row linking it
  instead, and its next page starts after it. A full page of posts links older posts even when none remain.
- `/` redirects to `/about` (302, kept 60 s), so oEmbed's `provider_url` opens a page.
- A path shaped like a public page that no page serves (`/@user/...`, `/tags/...`) answers the ordinary 404 page,
  the same bytes as a hidden or missing post or account, instead of a plain-text `Not Found`. A status id is digits (at
  most 19) or a legacy id; anything else there is that 404.
- The web stylesheet is served minified, its comments and whitespace removed (about a third smaller); its rules are
  unchanged. No migration; `wrangler.jsonc`: unchanged.
- HTML pages send `Link: </assets/kopje.<hash>.css>; rel=preload; as=style`, naming the stylesheet the page links, so
  a browser, or Early Hints where the zone enables it, fetches it sooner. No migration; `wrangler.jsonc`: unchanged.
- The OAuth consent page, its out-of-band code page and its messages (`/oauth/authorize`) use the web pages' layout
  and stylesheet, without the site's header links: the consent page lists the app's website as text, the account and
  each requested scope, and the code sits in a field that wraps. They send the web UI's private headers, whose CSP has
  no script source and no `'unsafe-inline'` (WEB-2 in [docs/threat-model.md](docs/threat-model.md)). The fields the
  form posts, every check and every status code are unchanged. No migration; `wrangler.jsonc`: unchanged.
- A browser asking for a page gets an HTML page instead of the API's error answer: a `GET` or `HEAD` of a page
  (the public pages, `/`, `/login`, `/auth/callback`, `/settings`, `/setup`, `/authorize_interaction` and
  `/oauth/authorize`) that fails gets a 503 page, with the same `Retry-After`, while the Store is unavailable or the
  instance is in maintenance, and a 500 page for an unexpected error; one of a path no route serves outside the
  document namespaces (`/api`, `/admin`, the OAuth endpoints, ActivityPub's `/ap`, `/actor`, `/inbox`, `/users` and
  `/emojis`, `/nodeinfo`, `/.well-known`, `/media`, `/assets`, `/health`) gets the ordinary 404 page instead of a
  plain-text `Not Found`. The page is chosen when the `Accept` names no ActivityPub type and gives
  `text/html; charset=utf-8` a higher q than the error answer's own type, read as RFC 9110 §12.5.1 reads it
  (`src/app/negotiation.ts`); a tie or a missing `Accept` keeps the error answer. Both answers of a negotiated request
  carry `Vary: Accept`, with their bodies and statuses unchanged. These pages read nothing of the Store. Every other
  answer is unchanged. No migration; `wrangler.jsonc`: unchanged.
- Breaking: the web UI's sign-in asks for `write:follows` as well, for following from `/authorize_interaction`. A web
  session signed in before the upgrade keeps its scopes and is sent to sign in again when it looks up or follows
  there, which replaces it; until then settings keep working with it.

### Fixed

- `GET /api/v1/statuses/:id/reblogged_by` leaves out a public or unlisted boost whose removal is under way
  (withdrawn), as Mastodon lists kept boosts only: it listed the booster until the boost was deleted, and its `Link`
  header could name the boost's id. Such a boost is no longer a candidate of the page's window. Migration
  `0083_kept_boosts`; `wrangler.jsonc`: unchanged.
- A status id cursor (`max_id`, `min_id`, `since_id`) of more than 18 digits reads as above every id, as its number
  is: `max_id` now keeps the status with the largest id (it was read as that id, and left it out) and `min_id` holds
  nothing. No migration; `wrangler.jsonc`: unchanged.
- The instance actor's outbox, `/actor/outbox`, which the `/actor` document names, is served instead of answering
  404: an empty `OrderedCollection` (`totalItems` 0) with a first page that lists nothing, served as the users'
  outboxes are ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Outboxes). No migration;
  `wrangler.jsonc`: unchanged.
- A family of background jobs that keeps failing no longer stops the others. A jobs round now has seven error
  boundaries: five Store calls (the inbound purges, Moves and deletes with the quote stamp revocations, the domain
  block cleanups, the notification request jobs, the moderation jobs, the unlock acceptances), then the collection
  syncs and the quote verifications. A failure is logged as `kopje.jobs.family.failed` with the family's name, and
  the round goes on with the next family; the deliveries the Store calls recorded are rung before the syncs and
  verifications fetch anything. A job that keeps failing still holds back the jobs behind it in its own family. A jobs
  Queue message is only a nudge and is no longer retried, and a Queue batch runs one jobs round however many jobs
  messages and replayed inbox requests it holds ([docs/threat-model.md](docs/threat-model.md), RES-5). Breaking: the
  `kopje.jobs.failed` log event is gone; query `kopje.jobs.family.failed` instead
  ([docs/observability.md](docs/observability.md)). No migration; `wrangler.jsonc`: unchanged.
- The web pages (the public pages, the embed, settings, sign-in messages, `/setup` and the OAuth consent page) start
  with `<!DOCTYPE html>`, so browsers render them in standards mode instead of quirks mode.
- The pager's "Newer posts" or "Older posts" when not offered keeps WCAG AA text contrast: muted text and a dashed
  border instead of a faded button.
- A remote account that follows again no longer receives an earlier `Accept` or `Reject` that was already attempted:
  the new `Follow` deletes every earlier answer of the pair that is not being sent at that moment, whether it is
  waiting for a retry, given up or retried by an operator. A `Follow` admitted within the pair's bounds removes the
  given-up ones at once, so they stop counting toward the bounds; a history already over a bound (an imported store)
  is still answered 503 until the sweep or the 30-day retention clears it. An answer being sent at that moment keeps
  its place ahead of the new one when both go to the same server origin; it is deleted instead of being sent unless
  its sending was already confirmed, and instead of being retried or given up after it fails. So is an `Accept` that
  a block withdrew while it was being sent. Each such answer caught, and each one delivered after it was superseded,
  is logged as `kopje.delivery.stale_follow_answer` with its type and step only
  ([docs/observability.md](docs/observability.md)). No migration; `wrangler.jsonc`: unchanged.
- An older copy of a remote actor's document no longer replaces a newer one. An inbox activity that took several Store
  rounds stored the document it fetched in every round, so an `Update(Person)` committed between two rounds, a key
  rotation included, was undone and the rotated-out key trusted again for a day; a document fetched before another
  store committed (while a `Move` target, a WebFinger lookup or a later round was awaited) overwrote it the same way.
  Every store of a remote actor's document now issues a new revision, and the inbox sender (in every round, and its
  routing while it is suspended), a relayed `Delete`'s actor, a `Move` target, search resolution (which fetches a URL's
  actor document again after reading the revision) and the refresh of a stale boosted or quoted author store their
  document only while the revision they read before fetching it still holds; so a `Move` is no longer undone by such a
  refresh either. Breaking: an `Update(Person)` or a `Move` that lost such a race answers 503 having written nothing,
  and a sender's retry is judged afresh; another activity, a stale-author refresh and a search use the stored
  account ([docs/threat-model.md](docs/threat-model.md), ID-1;
  [docs/mastodon-deviations.md](docs/mastodon-deviations.md), Accounts). Migration 0073; `wrangler.jsonc`: unchanged.
- The removal of a remote status after its author's `Delete`, and a remote account's purge, stay within their
  per-batch row budget when a notification of the status still has pushes waiting (up to 1,000 on one notification)
  or the status has more hashtags than one batch can take off the tag index; neither recounts the boosted status for
  each of its boosts any more. Once the status is hidden (or its author's purge has started), a local user's unreblog
  of it and `DELETE` of their boost of it answer 404 and change nothing: before, an unboost could record a second
  `Undo` of the boost and drop the receipts its first `Undo` still had to reach. While its hashtags are still being
  taken off the index, the status is no candidate of a followed hashtag's home stream, so no home page or `Link`
  names it. The status's accepted quote leaves the quoted status's quotes list and `quotes_count` as soon as the
  `Delete` arrives, also for an imported quote. The delivery rounds are asked for as soon as a job round writes more
  targets of an earlier `Undo`, rather than at the next cron. No migration; `wrangler.jsonc`: unchanged.
- `DELETE /api/v1/statuses/:id` of an original no longer deletes the status and everything that names it in the
  request, which a status with many mentions, hashtags, favourites, notifications, boosts, quotes or receivers could
  take past the request's limits. The request answers as before (the status with its source), records the `Delete`,
  hides the status from everyone, its author included (a second `DELETE`, an edit, its source, a favourite, a boost,
  a reply, a quote, a vote or a pin of it answer 404), and removes at once what only it shows: its card, trend row and
  review, its author's pin, its poll's rounds, its own quote (a pending one too: a late `Accept` of it applies
  nothing), its first 100 hashtags from the tag index, the media in the answer, and one from its author's
  `statuses_count` and its parent's `replies_count`. A job then removes the rest in batches of at most 500 rows,
  continued by the Queue and by cron: it writes the `Delete`'s targets while what they are read from is still there
  (every mention, the remote boosters, quoters, parent author and voters of a public or unlisted status, the
  receipts and the earlier deliveries; an inbox an `Update` alone was delivered to meanwhile is kept as a receipt),
  withdraws its local boosts, recounts its author's featured hashtags and detaches the media an edit dropped, with
  the deadline the request gave. Until the job ends, filters and conversations still name the status's id, showing
  nothing of it, as for any status the viewer may not see. Breaking: the `Delete`'s stored audience names the status
  instead of its accounts, and an imported status whose uri or author's actor id is past its stored bound records no
  `Delete` ([docs/threat-model.md](docs/threat-model.md), VIS-1, VIS-3, RES-6). The account's last status, moved back
  when its status is hidden or deleted, is read through its index however stale the statistics. Migration 0074;
  `wrangler.jsonc`: unchanged.
- An unboost (`POST /api/v1/statuses/:id/unreblog`, and `DELETE /api/v1/statuses/:id` of a boost) no longer writes
  its `Undo`'s targets, deletes the boost's receipts and recounts its booster's and its original's counts in the
  request, which a boost delivered to many servers could take past the request's limits. The request answers as
  before (unreblog: the original with `reblogged: false` and one less in `reblogs_count`; the `DELETE`: the boost),
  records the `Undo`, hides the boost from everyone, its booster included, takes one off its booster's
  `statuses_count` and its original's `reblogs_count`, and deletes its reblog notification with that notification's
  pushes, at most 1,329 rows in all. The status-delete job then writes the `Undo`'s targets while the receipts are
  kept (the receipts, the followers at that time and every earlier delivery of the `Announce`) and deletes the
  receipts and the boost in batches of at most 500 rows; the unreblog asks for the job's round. The booster may boost
  the original again at once, and a retried unreblog or `DELETE` by the id of a boost withdrawn since answers 404 and
  changes nothing, as do an unfavourite and an unbookmark by that id. Breaking: the `Undo` is sent once the job has
  written its targets, behind earlier jobs, and a follower who leaves before then without any delivery evidence of
  the boost is not reached ([docs/threat-model.md](docs/threat-model.md), VIS-3, RES-6, ID-7). Migration 0075;
  `wrangler.jsonc`: unchanged.
- A local account's profile link check no longer checks the same values again and again without reaching the last
  one. A round that ran out of its time (four slow links can take longer than it) re-armed the check with its attempts
  reset, and the next claim spent its time on the same slow links that had not verified. A value checked and not
  verified is now recorded until the next save, so a later claim checks only the values left, and a save's values are
  all checked within four claims, at least five minutes apart, while the Store answers each claim in time (a claim
  answered too late leaves its values for the next one); a save clears the record, so every value it keeps that is
  not verified is checked again, as in Mastodon. A record also drops values the fields no longer hold, and writes
  what it keeps in canonical form, so an imported row cannot keep a value from being recorded
  ([docs/threat-model.md](docs/threat-model.md), RES-6; [docs/mastodon-deviations.md](docs/mastodon-deviations.md),
  Profile credentials). Migration 0076; `wrangler.jsonc`: unchanged.
- `kopje-admin verify-conversion` counts the notifications a remote account owns, which the conversion drops, as
  `notifications:owner-remote` in `dropped`, and fails on them unless `--accept-deletions` is given, as the conversion
  does ([docs/cutover.md](docs/cutover.md)). No migration; `wrangler.jsonc`: unchanged.
- The media sweep deletes its rows, and schedules the tombstone of an upload that never completed, with the time taken
  after the R2 delete of their objects, not before it, so a slow delete no longer makes that tombstone fall due early.
  No migration; `wrangler.jsonc`: unchanged.

### Instance changes

- Store schema: adds thirteen migrations (0072 to 0084), applied on the first request after the deploy; a rollback to
  an earlier version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). The times below
  are of each file on the representative store defined in `test/bench/migration-cost.ts`, in workerd's local Durable
  Object SQLite. A dump whose rows are past these bounds is refused on import.
    - `0072_activity_tracking`: the empty `activity_counts` and `activity_logins` with their CHECKs, and triggers that
      hold `activity_api_enabled` to `true` or `false` (an existing row holding anything else is deleted, so it reads
      as on). It creates tables, so the upgrade checks every reference of the Store; of the existing tables it reads
      one `instance_settings` key, and it rewrites no row. 5,889 ms in one local run of the migration bench, the
      Store-wide foreign-key check included.
    - `0073_actor_document_revision`: `accounts.document_revision` (an integer from 0 to 2^53 - 1, 0 on every existing
      row), added with a constant default and no CHECK, so it reads and rewrites no row, and triggers that hold it to
      that bound. 26 ms for this file in one local run of the migration bench, the Store's foreign-key check skipped as
      declared.
    - `0074_last_status_lookup`: the triggers that keep `accounts.last_status_id` recreated with the same effect, their
      lookup pinned to `statuses_feed`; it reads and rewrites no row. 50 ms for this file in one local run of the
      migration bench, the Store's foreign-key check skipped as declared.
    - `0075_boost_withdrawal`: `statuses_reblog` rebuilt without its uniqueness, so a withdrawn boost can wait for its
      job beside a new boost of the same original, and `statuses_account_reblogs` replaced by the unique
      `statuses_account_reblogs_kept` over the boosts not withdrawn. Each index is built by a scan of `statuses`; no
      row is rewritten. It drops a unique index, so the upgrade checks every reference of the Store: 7,483 ms for this
      file in one local run of the migration bench.
    - `0076_field_link_checks`: `local_accounts.unverified_links` (NULL on every existing row, or the values checked
      and not verified since the last save), added with no default or CHECK, so it reads and rewrites no row, and
      triggers that hold it to its stored bound. 5 and 6 ms for this file in two local runs of the migration bench,
      the Store's foreign-key check skipped as declared.
    - `0077_remote_media`: the empty `remote_media`, `remote_media_objects` and `remote_media_usage` (its one row at
      zero) with their indexes and the triggers that hold every column to its stored bound. It creates tables, so the
      upgrade checks every reference of the Store; it reads and rewrites no existing row. 6,408 ms in one local run of
      the migration bench, the Store-wide foreign-key check included.
    - `0078_featured_tags_order`: the index `featured_tags_account_id` on `featured_tags (account_id, id)`, built by
      one scan of `featured_tags`; it rewrites no row. 28 to 31 ms for this file in three local runs of the migration
      bench (100,000 featured hashtags), the Store's foreign-key check skipped as declared.
    - `0079_filter_text_units`: `statuses.filter_text_units` (NULL on every existing row, or the length of the
      status's filter text as its writer measured it), added with no default or CHECK, so it reads and rewrites no
      row, and triggers that hold it to its stored bound and clear it when the status's text changes without a new
      measure. 5 ms for this file in two local runs of the migration bench, the Store's foreign-key check skipped as
      declared.
    - `0080_inbound_job_attempts`: `inbound_jobs.attempts` and `due_at` (0 and NULL on every existing row: every job
      fresh), their CHECKs holding each row to one retry state, and the indexes `inbound_jobs_fresh` and
      `inbound_jobs_failing`; it reads every job and rewrites none. 17 to 18 ms for this file in two local runs of the
      migration bench (10,000 jobs), the Store's foreign-key check skipped as declared.
    - `0081_account_invitations`: the empty `account_invitations` with its CHECKs, its email and username unique
      ignoring ASCII case, a cap of 10 rows and a trigger that refuses any change of a row; it reads and rewrites no
      row. It creates a table, so the upgrade checks every reference of the Store: 6,039 to 7,746 ms for this file
      in four local runs of the migration bench, at load averages of about 7 to 27.
    - `0082_public_replies`: the index `statuses_public_replies` on `statuses (in_reply_to_id, id)` over the public and
      unlisted replies that are not withdrawn, built by one scan of `statuses`; it rewrites no row. 1,532 ms for this
      file in one local run of the migration bench (2,000,000 statuses, 1,000,000 of them replies), the Store's
      foreign-key check skipped as declared.
    - `0083_kept_boosts`: replaces the index `statuses_reblogged_by` on `statuses (reblog_of_id, id)` with the same
      over the public and unlisted boosts that are not withdrawn, rebuilt by one scan of `statuses`; it rewrites no
      row. It drops an index, so the upgrade checks every reference of the Store: 7,004 ms for this file in one local
      run of the migration bench (2,000,000 statuses, 200,000 of them boosts), at a load average of about 3.5.
    - `0084_family_job_attempts`: `attempts` and `due_at` (0 and NULL on every existing row: every job fresh) with
      their CHECKs, and a `_fresh` and a `_failing` index, on `quote_revocations`, `domain_block_cleanups`,
      `notification_request_jobs`, `notification_clears`, `notification_dismissals`, `moderation_jobs` and
      `remote_moderation_jobs`; it reads each of those tables, and rewrites the values earlier builds stored through
      JavaScript numbers into what they meant (a notification request job's cursor becomes inclusive; a REAL follow
      bound, a numeric follower or severing cursor become the INTEGER those builds resumed at). 56 to 111 ms for this
      file in four local runs of the migration bench with those values seeded, the Store's foreign-key check skipped as
      declared.
- `wrangler.jsonc`: no change.

## [0.1.0-rc.23] - 2026-10-24

A twenty-third release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Link trends (`GET /api/v1/trends/links`, and the OAuth admin's `GET /api/v1/admin/trends/links`), as Mastodon
  works them out: every 5 minutes the cron's trends round counts the accounts that posted or boosted a link (its card's
  URL after redirects) in the newest 4,000 public posts since yesterday, scores the links with 5 or more today against
  yesterday, and keeps 200 allowed and 50 for review. A link is listed with the card of its newest appropriate public
  copy (an article link with a title, a description, a provider name, a stored image and a supported language) and
  its seven-day `history`, the `Accept-Language` language first. Nothing is listed until reviewed: a link is allowed by
  its own review, else by its publisher's (the longest reviewed suffix of its domain); `trendable_by_default` does not
  apply, as in Mastodon ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), MD-5).
- The link timeline (`GET /api/v1/timelines/link?url=`), as Mastodon's: the public posts, not boosts, by discoverable
  authors who have not moved, whose card has a link that is listed and allowed now, newest first under the viewer's
  blocks, mutes and domain blocks, paged by `max_id`, `since_id` and `min_id` (20 by default, at most 40; `limit=0`
  answers `[]`), with next and prev links on every page that shows a post. Any other link, and every link while
  trends are off, answers 404 ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), MD-5).
- The Access admin reviews links and publishers: `GET /admin/trends/links`, `GET /admin/trends/publishers`,
  `POST /admin/trends/links/approve|reject` (`{url, publisher?}`; with `publisher`, the publisher that decides the
  link, dropping the link's own decision) and `POST /admin/trends/publishers/approve|reject` (`{domain}`), and
  `kopje-admin trends links|publishers`, `trends approve-link|reject-link <url> [--publisher]` and
  `trends approve-publisher|reject-publisher <domain>`, each logged (`PreviewCard`, `PreviewCardProvider`).
  `kopje-admin trends` with no kind lists links too.
- A local upload's `blurhash`, avatars and headers included: computed from a third Images output, the raw RGBA
  pixels of its preview's own input and transformation, read within the preview's checked size, and shown by the
  `MediaAttachment` entity. A Note's `Document` carries it, with Mastodon's `toot:blurhash` context term, when the
  attachment has one. When the RGBA output fails, is not of the preview's size, or is given up (5 seconds after it
  starts, or a minute before the upload's deadline), the upload is still accepted, without a blurhash (Mastodon fails
  it), and `kopje.media.no_blurhash` is logged; a 9422 from it alone answers 200. `kopje-admin media-rebuild` computes
  one for each row it makes again, keeping the stored one when the RGBA output fails; a 9422 from it stops the run
  after that row. Uploads stored by an earlier release keep none ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Media).

### Changed

- A card image's blurhash is computed from a second Images output of the same fetched image and transformation, as
  raw RGBA pixels, instead of decoding the stored WebP in the Worker: the Worker decodes no image, and the package
  ships no WebP decoder and no `.wasm` file in `dist/`. Each image now charges `IMAGES_CARD_MONTHLY_TRANSFORMS` up to
  twice, once right before each output (Images may bill the two as one transformation), so the same share stores at
  most half as many images with a blurhash. When the RGBA output fails, is not of the image's size, or the share runs
  out between the two outputs, the image is still stored, without a blurhash; a claim given up at its deadline or one
  whose fence was lost is not stored, as before ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Link
  previews).
- Breaking for the Store RPC: `recordCard`'s card fields carry the link type (`linkType`) and the final URL
  (`finalUrl`), and `trendsRound` answers `links` beside `tags` and `statuses`.
- The trends round's row-heap cap is 33,855,900 bytes (was 8,222,200): it holds the link part's reads too.
- An upload, avatar or header now charges three transformations to `IMAGES_MONTHLY_TRANSFORMS` and to the account's
  share (the full image, the preview and the preview's RGBA, which Images may bill as one with the preview, so the
  count is a ceiling), instead of two; `kopje-admin media-rebuild` charges a rebuilt row three, to
  `IMAGES_MONTHLY_TRANSFORMS` only. A custom emoji, and a rebuilt emoji's row, still charge two. At the defaults, 4,000
  transformations cover 1,333 uploads a month and an account's share 133.

### Instance changes

- Store schema: adds one migration (0071), applied on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). On the representative
  store defined in `test/bench/migration-cost.ts`, migration 0071 took 11.3–11.9 seconds (median 11,812 ms) in three
  runs of the migration bench workflow on a 4-CPU GitHub-hosted runner, in workerd's local Durable Object SQLite, the
  Store-wide foreign-key check included. It creates tables, so the upgrade checks every reference of the Store; it
  rewrites no row. A dump whose rows are past these bounds is refused on import.
    - `0071_link_trends`: three columns on `status_cards` (the link type, the final URL and whether the card is a
      public status's), defaulted so no existing card trends, the table's two triggers recreated over every column
      with the rule that only an attached card with a final URL under a public status is public; two partial indexes
      (the public cards by final URL, the public boosts by original), each built by reading `status_cards` or
      `statuses` once; and the empty `trend_links`, `link_trend_reviews` and `link_provider_reviews` with their
      triggers.
- `wrangler.jsonc`: no change. No new outbound request: a link's card and image are the ones already fetched. To keep
  storing as many card images a month as before, double `IMAGES_CARD_MONTHLY_TRANSFORMS`; to keep as many uploads,
  raise `IMAGES_MONTHLY_TRANSFORMS` by half. Keep the two together within what the account's Images allowance covers
  ([docs/setup.md](docs/setup.md), Before you start).

## [0.1.0-rc.22] - 2026-10-23

A twenty-second release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Account `fields[].verified_at` for remote accounts: when a remote actor's document is stored, the first 4 of its
  shown fields whose value is a single link (`<a href="X">X</a>`, Mastodon's markup with its spans included) to an
  `https` URL are checked by the same round of the 5-minute cron as local accounts, after them: verified when the page
  links back to the account's profile URL (or its actor id) with rel `me`, or its first rel=me link redirects there. A
  verified field shows its time and its value as a shortened link. A time is kept while the link and the profile URL
  stay; an unverified link is checked again at a later store at most once a day; a pending check expires after a day.
  Accounts stored before the upgrade are checked at their next store
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Accounts).
- Status cards from oEmbed and `twitter:player`, as Mastodon makes them: a page's oEmbed endpoint (a JSON
  `<link>`) is tried before its OpenGraph fields, and a host's endpoint is cached for a day; a card now has a `type`
  (`link`, `photo` or `video`), `width` and `height`, and a video's `html` is an iframe of the embed's src in a fixed,
  sandboxed template (never the provider's markup). `embed_url` stays `''`. At most two GET chains a card (up to
  eight HTTP GETs, redirects included), through the same sink as pages
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Link previews).
- Status card images: a card's `image`, `blurhash` and `image_description`, as Mastodon shows them. The image
  (`og:image`, an oEmbed card's `thumbnail_url`, a photo's `url`; `https` only) is fetched by a new round of the
  5-minute cron, at most 3 a round, re-encoded once by Images to a still WebP resized to fit a box aimed at 230,400
  pixels (an output of at most 262,144 pixels and 512 KiB is accepted, as Images may round an edge up), stored in
  the media bucket and served from the instance's own `/media/…/full.webp`; the blurhash is computed in the Worker.
  A stored image is reused for 14 days by other cards of the same image URL and kept while any card names it. Off by
  default: set `IMAGES_CARD_MONTHLY_TRANSFORMS` to the transformations card images may start each month
  ([docs/setup.md](docs/setup.md), Before you start;
  [docs/mastodon-deviations.md](docs/mastodon-deviations.md), Link previews).
- `kopje.store.unavailable`: an HTTP request that met a Store unable to serve it (an upgrade, a hold, an import and
  so on) is logged with the reason, except maintenance the instance's `MAINTENANCE` setting turned on.
- [docs/observability.md](docs/observability.md): where an instance's logs are, the events to act on, what Workers
  Logs costs and what it records, and when and how to turn invocation logs or traces on, with what they then disclose.

### Changed

- The public web pages (profiles, posts, the about page, the privacy policy and terms of service, the embed and the
  error pages) and the settings page have a new look: colours follow the system's light or dark setting, a header
  names the server and links its about page, and a footer links the about page (and, on it, the documents). Times show
  in UTC with their zone; counts and dates are formatted for English. Pages keep working without script and send the
  same headers as before. The stylesheet is now served at `/assets/kopje.<hash>.css` and cached for a year;
  `/assets/kopje.css` stays for one more release for pages cached before an upgrade.
- Failure events are now logged at the `error` level, among them `kopje.store.upgrade.failed`, Store import and
  backup failures, which were logged at `info`: an operator filtering on the level sees them. A bound or degraded mode
  hit as designed stays at `warn`.
- The Store's per-status event for a scheduled status that failed to publish is renamed from
  `kopje.scheduled.publish_failed` to `kopje.scheduled.status.failed`, with `recorded` saying whether the failure was
  recorded for a retry. `kopje.scheduled.publish_failed` now only counts a round's failures. Update saved queries.
- Log events carry less request-derived text: `kopje.admin.error` logs the method, route template and error class
  instead of the path and message, `kopje.store.import.chunk-failed` the refusal code instead of the message,
  `kopje.snapshot.save-failed` and `kopje.store.snapshot.unreadable` the key's kind (`path` or `webfinger`) instead of
  the key, and `kopje.media.transform_failed` no longer passes on the image service's message.
- A boost or quote of a status by a remote account Kopje stored more than a day ago now refetches that account first,
  as Mastodon does, so its avatar, header, name and audience are current. What a failed refetch stores is in
  [docs/mastodon-deviations.md](docs/mastodon-deviations.md), Accounts.
- Profile link verification admits every hop's domain policy as a Store write, before and after its DNS check (as
  link cards do), so no redirect, DNS check or request starts once the Store enters maintenance; a value whose policy
  read fails is checked again after the claim's hold instead of counting as not verified.
- The link card round fetches 3 cards at a time (was 2), within the same minute.
- Breaking for the Store RPC: a `claimCards` claim carries its host's cached oEmbed template (`oembed`), and
  `recordCard`'s card fields carry the type, the dimensions and the embed, with an optional `endpoint` to cache.
- Breaking for the Store RPC: `recordCard`'s card fields carry the image's source URL (`imageUrl`) and alt text
  (`imageDescription`), and the reservation of an upload or emoji answers `retry` (503, `upload-retry` for emoji)
  when its file token is held by another owner of the media bucket's keys (in practice never).
- Breaking for the Store RPC: `cardHopRefused` is renamed `webHopRefused` and serves both rounds; a claim of
  `claimFieldLinks` names its target (`local` or `remote`) and the instance origin, and reports the remote checks it
  expired.
- An inbound activity that needs a remote fetch (an unknown or stale key, an actor's update, an object given by id, a
  boost of an unknown status) makes fewer sequential Store calls: the Store answer that decides the fetch (the inbox's
  first read, or the answer that asks for a document) carries the signing key, still wrapped, and the domain policy's
  verdict for the fetch's first request. Redirect hops and later requests still ask the Store; an activity that
  fetches nothing is handed no key.
- Breaking for the Store RPC: `signingKey` and `followerKey` are replaced by `fetchSigner`; `inboxGate` takes `now`
  and `fetches` and answers `prefetch`; a `receiveActivity` need carries `prefetch`. While a deploy reaches the Store,
  a Store of the previous build refuses the Worker's calls at admission as a version mismatch, and the inbox spools
  the request (or replay requeues it); a missing `fetchSigner` that slips past is a narrower fallback, failing the
  fetch as one that may pass (503, so the sender retries).

### Instance changes

- Store schema: adds three migrations (0068–0070), applied on the first request after the deploy; a rollback to an
  earlier version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). On the
  representative store defined in `test/bench/migration-cost.ts`, migrations 0068–0070 together took 12.4–12.6 seconds
  (median 12,456 ms) in three runs of the migration bench workflow on a 4-CPU GitHub-hosted runner, in workerd's local
  Durable Object SQLite, the Store-wide foreign-key check included. Each creates a table, so the upgrade checks every
  reference of the Store; none rewrites a row. A dump whose rows are past these bounds is refused on import.
    - `0068_remote_field_verification`: an empty `remote_field_links` table (one row per remote account with a link
      to check) with two indexes and the triggers that bound it.
    - `0069_card_embeds`: six columns on `status_cards` (the card's type and dimensions, a video's iframe src and
      dimensions), defaulted so every existing card stays a link, the table's two triggers recreated over every
      column, and an empty `card_oembed_endpoints` table (one row per host with a cached oEmbed endpoint) with its
      expiry index and the triggers that bound it.
    - `0070_card_images`: three columns on `status_cards` (the image's source URL and id and its alt text), defaulted
      so every existing card has no image, an index of the image link, the table's two triggers recreated over every
      column, and an empty `card_images` table (one row per image source URL, pending or stored) with six indexes and
      the triggers that bound it; `card_images` is not in a dump.
- New variable `IMAGES_CARD_MONTHLY_TRANSFORMS` (default 0: no card image is fetched). With it set, the cron makes
  outbound requests to card image URLs (at most 3 GETs a tick, 864 a day, each up to 4 HTTP requests with its
  redirects) through the same sink as pages, makes up to 3 Images transformations a tick within the monthly ceiling,
  and writes the images to the media bucket (`files/<token>/full`). Keep it and `IMAGES_MONTHLY_TRANSFORMS` within the
  account's Images allowance together ([docs/setup.md](docs/setup.md)).
- The cron makes outbound requests to the oEmbed endpoints the pages of status links declare (at most one more GET
  chain a card, up to four HTTP GETs with its redirects; at most 3,456 chains and 13,824 GETs a day in all), through
  the same sink as the pages.
- The cron makes outbound requests to the sites remote accounts' profile fields link to (at most 4 values a tick,
  shared with local accounts' links), through the same sink as local profile link verification.
- `wrangler.jsonc`: `observability` is now an explicit block that keeps Kopje's own log events, turns the platform's
  invocation logs off, asks the platform to remove query strings from request URLs in logs and traces
  (`redact_query_string`; verified for incoming query strings in stored invocation logs) and leaves traces off.
  Invocation logs record request headers verbatim, such as a streaming client's subprotocol, which can carry its
  access token. Apply this change unless you have accepted the invocation-log opt-in risks in
  [docs/observability.md](docs/observability.md): replace the block with `{ "enabled": true,
  "redact_query_string": true, "logs": { "enabled": true, "invocation_logs": false, "head_sampling_rate": 1 },
  "traces": { "enabled": false, "head_sampling_rate": 1 } }` and redeploy; until then the instance keeps storing
  invocation logs, query strings and request headers included. Request status stays visible in the Worker's metrics
  and in `wrangler tail`; [docs/observability.md](docs/observability.md) says when turning invocation logs or traces
  on is reasonable.

## [0.1.0-rc.21] - 2026-10-23

A twenty-first release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Account `fields[].verified_at` for local accounts: after a profile save (`update_credentials` or the settings page),
  a job round of the 5-minute cron checks each `https` field value and records when the page it names links back to
  `https://<domain>/@<username>` with an `<a>` or `<link>` whose rel has the token `me` (in any letter case), or when
  the first such link redirects there; the time shows in account entities and in `source.fields`, as Mastodon's
  `DateTime#xmlschema(3)` writes it. A save that changes a value drops its time; one that keeps it (a field renamed
  or moved) keeps it. Checks of an account are at least 5 minutes apart, and a value checked and not verified is
  checked again only after the next save. Remote accounts' fields keep `verified_at: null`
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Profile credentials).
- Status `card` (link previews): the first link of a public or unlisted original (a local post or text edit,
  a remote status's creation or significant update) is fetched by a round of the 5-minute cron, at most 6 a round, and
  its title, description, author, provider, language and publication time are kept with the status (OpenGraph,
  JSON-LD and the page title, as Mastodon's `LinkDetailsExtractor` reads them). Only `https` links on the default port
  are fetched, hosts the domain policy refuses never; private, direct and limited statuses get no card, where
  Mastodon fetches every visibility. A status that links a URL another status fetched within 14 days copies its card.
  The card is shown on the status and in a boost's `reblog`, as type `link` with no image, its title cut to 512
  JSON-escaped bytes, its description to 1,024 and its author and provider names to 512; a quoted status shows none
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Link previews).

### Changed

- A local account's fields, wherever they are shown (account entities, `source.fields`, the actor document), are,
  among its first 4 stored entries, those whose name and value are strings of at most 255 code points; a stored value
  past 16 KiB of JSON, or one that does not parse, shows no fields instead of failing the request. Only converted or imported rows
  can hold anything else ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Accounts).
- An inbox POST makes one Store read before its activity is applied, instead of separate sequential calls for the
  domain, write admission, the inbox owner, the actor's domain block and the stored key. The shared and personal
  inboxes answer as before: 404 for an inbox of nobody, then 503 before setup, then 202 spooled while the Store
  refuses writes. One difference: when that read fails transiently, the request is spooled at once (202, replayed
  later with every check), where before a failed owner check let it through to the next calls. A replay makes the
  same read after the hand-off check.
- Breaking for the Store RPC: `inboxWritable` and `inboundDomainBlocked` are removed and `inboxGate` added. The Worker
  and the Store deploy as one build; while a deploy reaches the Store, an inbox request that meets a Store of the
  previous build is spooled (or requeued on replay) as for any version mismatch.

### Instance changes

- Store schema: adds two migrations (0066, 0067), applied on the first request after the deploy; a rollback to an
  earlier version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). On the
  representative store defined in `test/bench/migration-cost.ts`, migrations 0066–0067 together took 8.0–8.3 seconds
  in three runs of the migration bench workflow on a 4-CPU GitHub-hosted runner, in workerd's local Durable Object
  SQLite; most of it is the Store-wide foreign-key check that 0067's new table requires.
    - `0066_field_verification`: five `local_accounts` columns (when a check is due, its claim and the verified
      values) with the CHECKs and triggers that bound them; each of its four ALTERs with a CHECK scans the local
      accounts and no other row, and no account has a check due. A dump whose values are past these bounds is refused on import.
    - `0067_status_cards`: an empty `status_cards` table (one row per status: its link, its claim and its card) with
      four indexes and the triggers that bound it; it reads no row, and since it creates a table the upgrade checks
      every reference of the Store. A dump whose rows are past these bounds is refused on import.
- The cron makes outbound requests to the sites public and unlisted statuses link to (at most 6 pages a tick), through
  the same sink as profile link verification.
- `wrangler.jsonc`: the Queue consumer sets `"max_batch_timeout": 1`, so a batch waits at most 1 second to fill
  instead of the platform's default 5, and a delivery round or a spool replay is handed over sooner. Optional: add
  the key to your existing `queues.consumers[]` entry (keep its queue name) and redeploy; without it the instance keeps
  the longer wait. Smaller batches can mean somewhat more consumer invocations and Store calls.

## [0.1.0-rc.20] - 2026-10-22

A twentieth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Notification `filtered`: `true` on a notification the recipient's policy filtered, as `GET /api/v1/notifications`
  (with `include_filtered` or `account_id`) and `GET /api/v1/notifications/:id` show it; absent otherwise. Grouped
  notifications, notification requests and the streaming `notification` event never carry it, as in Mastodon.
- Status `application`: a local status shows the app it was posted through (`name`, and `website` or null when blank),
  to every viewer and wherever statuses are shown, streaming included; a scheduled status is published through the
  app it was scheduled through. A local boost, a status posted before this version and one whose app was removed show
  `application: null`; a remote status has no key. An edit keeps the status's app, and edit history shows none. A name
  or website past its presented bound (an app registered earlier, or imported) shows `application: null` or
  `website: null` ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Posting).

### Changed

- Breaking: Kopje's Worker config enables the compatibility flag `global_fetch_strictly_public`, so every outbound
  fetch uses public routing (NET-1 in [docs/threat-model.md](docs/threat-model.md)); an instance must add it to its
  `wrangler.jsonc` (Instance changes). The health report (`kopje-admin health`, `GET /admin/health`) gains a `runtime`
  check that fails, with the fix, while the running Worker lacks the flag, and the public `/health` then answers 503.
- Breaking: `POST /api/v1/apps` refuses a `client_name` longer than 60 characters (counted in code points), Mastodon's
  limit; it allowed 255 UTF-16 code units. Apps already registered keep their name.
- Breaking: `POST /api/v1/apps` refuses a `website` holding any of C0 controls (U+0000–U+001F), the space, DEL (U+007F),
  C1 controls (U+0080–U+009F), the other whitespace JavaScript's `\s` matches (Unicode spaces, line terminators,
  U+FEFF), and `"` `'` `<` `>` `\` `^` `` ` `` `{` `|` `}`, or longer than 2,000 UTF-8 bytes (`Website is invalid`),
  after trimming surrounding whitespace.
- A scheduled status's `params.application_id` is the client_id of the app it was scheduled through (it was always
  null).
- The statuses of a page (timelines, contexts, search, histories and lookups) are hydrated in chunks planned to at most
  448 KiB of row heap (was 704 KiB); chunking does not change the answer, and a single status is read whole whatever
  its size. Each attachment's added `remote_url`, `preview_remote_url` and `blurhash` take part of the existing answer
  budget, so an answer of very large statuses may admit fewer of them; the next page continues after the last one
  shown.
- Breaking: following or featuring a hashtag whose name, normalized, is past 256 code points or 1,024 UTF-8 bytes
  answers 422 (`Name is too long (maximum is 256 characters)`), and so does featuring one whose spelling is; Mastodon
  sets no such bound. `POST /api/v1/tags/:id/follow` and `/feature` and `POST /api/v1/featured_tags` refuse it even
  when the account already holds the name (an import's), and a remote account's featured hashtag past it is not
  learned. Unfollowing, unfeaturing and deleting such a row still work, and a restored dump keeps it.
- Breaking: the hashtag lists (`GET /api/v1/followed_tags`, `featured_tags/suggestions`, the featured hashtags of
  `GET /api/v1/featured_tags` and `/api/v1/accounts/:id/featured_tags`, and the actor's `featuredTags` collection)
  leave out a stored name past that bound, with a NUL, or whose bytes are not well-formed UTF-8 (an import's). A page
  of followed hashtags that leaves names out still links the next page by the follows it read.
- Breaking: `POST /api/v1/admin/measures` answers 422 (`measure <key> is not served`) to the OAuth admin for
  `active_users`, `interactions`, `tag_accounts`, `tag_uses`, `tag_servers` and `instance_statuses`, the whole
  request; they were left out of the answer ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), MD-2). Only
  unknown keys are left out.
- Breaking: a measure key that reads its object (`instance_*`, `tag_*`) without one answers 400, and an invalid
  `start_at` or `end_at` 422, to every caller, in Mastodon's order; only `instance_follows` did. `new_users`,
  `opened_reports` and `resolved_reports` without both dates answer 422 (Mastodon answers 500). A `start_at` or
  `end_at` whose date, as written or as a UTC instant, is before 1583-01-01 or after 9998-12-31 answers 422
  (`Invalid date supplied`).
- Breaking: with `include_subdomains`, the series of `instance_follows` counts the domain itself only, as Mastodon
  4.5.11 does; its total still counts the subdomains. Its walk counts every follow edge of the local accounts,
  pending requests included, toward the 20,000 cap, so a store with many pending requests answers 422 sooner.

### Fixed

- MediaAttachment `remote_url` and `preview_remote_url`: a remote attachment shows its URL and its icon (null without
  one); a local one shows null, as in Mastodon. A status's edit history shows them as recorded with each version.
- MediaAttachment `blurhash`: a remote attachment shows the BlurHash it was sent with when it has at most 5 by 5
  components and the length they give (Mastodon's rule), else null; one stored before this version shows null until
  its next accepted explicit `Update`, and a local upload shows null
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Media). `text_url` stays null (MD-6).
- An attachment URL, live or in edit history, shows null unless, as stored and decoded, it is within 2,048 UTF-8 bytes,
  well-formed and free of NUL, other C0 controls and DEL, and, normalized, an http(s) URL within 2,048 bytes; edit
  history showed recorded URLs unchecked, and a control in a path or query was shown percent-encoded.
- An attachment whose stored meta is not an object of dimensions (an imported `null`, say) is shown without its sizes;
  the status read failed before.
- A remote `Update` that changes only an attachment's icon records an edit, as Mastodon does; one that changes only its
  BlurHash records none.
- Account `followers_count`, `following_count` and `statuses_count` of a remote account are the `totalItems` of its
  followers, following and outbox collections, read by its background collection sync after each stored actor
  document, as Mastodon reads them; they were always 0, and follow suggestions and account search rank remote accounts
  by that follower count. The sync also fetches the outbox, and the followers collection even when the following
  collection hides its items. A collection without a count, on another origin, gone or unreadable keeps the count; one
  that may be read later is read again. A fraction is cut, a negative count is 0, and one past 2^53−1 or not a number
  is not taken. The three documents are read with at most one redirect and 512 KiB each, so they fit one round's
  fetch budget; one past either is unreadable: it gives no count, and a following or followers collection past them
  hides the account's network (one past 1 MiB already did). An existing remote account shows 0 until its document is
  stored again ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Accounts).
- A stored count that is not an integer from 0 to 2^53−1 (an imported row) shows as 0 wherever accounts are shown,
  ranked or counted (the outbox's `totalItems`, the instance's status count).
- Tag `history` in v2 search hashtags, `GET /api/v1/followed_tags` and `GET /api/v1/featured_tags/suggestions`
  shows seven days, today (UTC) first, as `GET /api/v1/tags/:id` does; it was `[]`, on which Mastodon's web client
  fails: it reads the first day unguarded (v4.5.11 `components/hashtag.tsx:91` for search,
  `features/followed_tags/index.tsx:45` for followed hashtags). It counts public originals of available authors, the
  same for every viewer. A list counts at most the hashtag's newest 20 public posts of the seven days (the trends lists
  200), so it can count fewer than `GET /api/v1/tags/:id` ([docs/mastodon-deviations.md](docs/mastodon-deviations.md),
  Hashtags).
- `POST /api/v1/admin/measures` serves `new_users`, `opened_reports` and `resolved_reports` (with `previous_total`),
  `instance_accounts`, `instance_followers`, `instance_reports` and `instance_media_attachments` (always 0 bytes, as
  Kopje stores no remote media files) besides `instance_follows`, each computed once per request however often it is
  named. Each walks at most 20,000 rows and, for `instance_accounts` with `include_subdomains`, 10,000 known domains,
  and answers 422 past them or for a stored time not in Kopje's ISO form, never an undercount; a request of all eight
  reads at most 700,000 rows with 1,000 local accounts. The totals' windows read the dates as written, offsets kept,
  and the series' axis the instants to the microsecond, as Mastodon does
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Admin measures).
- The `instance_follows` walk can no longer read every follow before its cap: SQLite could build a Bloom filter over
  the whole table when its statistics were older than the Store's growth.

### Instance changes

- Store schema: adds two migrations (0064 and 0065), applied on the first request after the deploy; a rollback to an
  earlier version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). On the
  representative store defined in `test/bench/migration-cost.ts`, migrations 0064–0065 together took 9–10 milliseconds
  in three runs of the migration bench workflow on a 4-CPU GitHub-hosted runner, in workerd's local Durable Object
  SQLite; neither reads a row, so the Store-wide foreign-key check is skipped.
    - `0064_status_applications`: `statuses.application_id`, with the triggers that bound it; it reads no row, and
      existing statuses read as posted through no app. A dump whose `application_id` is past its bound is refused on
      import.
    - `0065_media_blurhash`: `media_attachments.blurhash`, with the triggers that bound it; it reads no row, and
      existing media have no BlurHash. A dump whose `blurhash` is past its bound is refused on import.
- Breaking: `wrangler.jsonc`: add `global_fetch_strictly_public` to `compatibility_flags`, as in the template
  (`"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]`); every instance must make this change.
  With it, every outbound fetch uses public routing, so a request to a host in the instance's own zone goes through
  Cloudflare like one from the Internet instead of straight to the zone's origin ([docs/upgrade.md](docs/upgrade.md)).

## [0.1.0-rc.19] - 2026-10-22

A nineteenth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- `indexable` is stored, federated (`toot:indexable`) and shown: `PATCH /api/v1/accounts/update_credentials` and the
  settings page set it, remote actors' value is read, and Account `indexable`, CredentialAccount `source.indexable` and
  `source.discoverable` present it. It changes no search result. A remote account reads false until it is fetched
  again.
- The `contact_username` instance setting (`kopje-admin instance contact_username=…`): the address of an account Kopje
  knows, shown as `contact_account` on `/api/v1/instance` and `contact.account` on `/api/v2/instance`.
- `usage.users.active_month` on `/api/v2/instance` counts the available local accounts with an authenticated request
  in the last 28 UTC days, today included; each account's day is recorded at most once a day.
- Account and CredentialAccount `uri` (the actor id), and for local accounts `roles` (the OAuth admin's Owner role) and
  `noindex` (always false).
- Account `moved`: the account a remote account moved to, set by its actor document's `movedTo` naming an account
  Kopje knows and by a verified `Move`, and cleared by a document without one. It is shown one level deep, without
  note or fields ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Accounts).
- `GET /oauth/token/info` and `POST /oauth/introspect` (RFC 7662), as Doorkeeper answers them
  ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), OAuth).
- `POST /api/v1/admin/accounts/:account_id/action` with type `none` warns a local account: it stores the warning, with
  `text` and the named report's `status_ids`, logs it, and writes the account a `moderation_warning` notification
  (Notification and NotificationGroup `moderation_warning`) unless `send_email_notification` is false. No email is
  sent ([docs/mastodon-deviations.md](docs/mastodon-deviations.md), Admin account actions).

### Changed

- Breaking: `/oauth/authorize` refuses an unsupported `response_mode` with `unsupported_response_mode`.
- Newly started Store upgrades can skip the full foreign-key scan when all pending migrations preserve references and
  referenced keys. Resumed upgrades and retries still scan the Store; see [the upgrade guide](docs/upgrade.md).
- Breaking: avatar and header uploads from the settings page take files under 8 MB (JPEG, PNG, GIF or WebP); AVIF
  and files from 8 MB to 16 MB are refused.
- Breaking: for repeated parts of a file parameter the last one is read, as Rails does: on `POST /api/v{1,2}/media`
  a text part followed by a file now uploads, and a file followed by a text part now answers 422.
- Breaking: JSON requests exceeding 10,000 generated parameter paths or the 2,097,152 UTF-16 code-unit flattening
  budget answer 413; nesting beyond 32 levels answers 400.
- Breaking: notifications read `types` and `exclude_types` only as `types[]` and `exclude_types[]`; a value sent
  without `[]` is ignored, as Mastodon ignores it.
- Account `avatar_static` and `header_static` are a still image for an uploaded avatar or header whose served file is
  animated; images uploaded before this change, and remote accounts' images, keep the image as their static.
- The `preview_url` of a newly uploaded or rebuilt animated image, status media included, is a still image.
- Hashtag search avoids repeated status-table scans with stale Store statistics.
- Request reads and background and moderation work stay index-driven when the Store's statistics are stale: status
  presentation, context, conversations, search, tags, filters, relationships, mentions, media, login, outbound reach,
  delivery checks and receipts, inbound Flags, follow answers, purges, poll sweeps, domain restoration and report
  resolution.

### Fixed

- `POST /api/v1/apps` includes `scopes`, `redirect_uris` and `client_secret_expires_at`.
- `GET /api/v1/apps/verify_credentials` includes `id`, `scopes`, `redirect_uris` and `redirect_uri`: the
  application's, not the token's.
- The instance thumbnail is served (`/assets/thumbnail.png`), and `thumbnail` on `/api/v1/instance` is its URL.
- `languages` on `/api/v1/instance` and `/api/v2/instance` is `["en"]`.
- `GET /api/v1/preferences` includes `reading:autoplay:gifs` (false).
- A suspension resolves every report it froze when report ids pass 2^53 (imported ids): its bound and cursor are
  kept as decimal ids, so none is skipped or left out.
- `PATCH /api/v1/accounts/update_credentials` sets `avatar` and `header` from multipart files (under 8 MB each; JPEG,
  PNG, GIF or WebP), all or nothing with the other fields and with one profile Update to other servers. A file
  parameter sent as text answers 400.
- An empty JSON object for `fields_attributes` clears the profile fields, and `POST /api/v1/markers` with
  `{"home":{}}` saves the marker.
- Unlocking an account accepts pending follow requests asynchronously and sends the Accepts. Relocking stops
  acceptance; unavailable or blocked requesters remain pending.
- `POST /api/v1/statuses` and `PUT /api/v1/statuses/:id` answer 422 `Media … not found or already attached to another
  post` for a `media_ids[]` entry that is unknown, another account's, attached to another post or held by a scheduled
  post, instead of leaving it out. A scheduled post whose media is gone when it is due is dropped.
- `POST /api/v1/statuses` reads `allowed_mentions[]`: a post that would mention an account not listed answers 422
  with `unexpected_accounts`. A scheduled post is checked when it is published and dropped if it would; its
  `params.allowed_mentions` shows the list.
- Notifications (`/api/v1/notifications`, `/api/v2/notifications` and both `unread_count`): `types[]=` with an empty
  value matches no type instead of all.
- The public and hashtag timelines with `local=true&remote=true` answer local and remote posts.
- An `Idempotency-Key` is kept for one hour after the post it made; reused later, it posts anew.
- `GET /api/v2/search` reads `exclude_unreviewed` (hashtags the admin reviewed, and the exact match). With
  `resolve=true&following=true`, a resolved account the viewer does not follow is left out.
- `GET /api/v1/accounts/relationships` reads `with_suspended`: unavailable accounts (suspended, being deleted, or on a
  suspended domain) are left out unless it is true.
- `GET /api/v1/accounts/search` reads `resolve`: a `user@domain` query at offset 0 is looked up through WebFinger and
  the account found is shown first, as on `/api/v2/search`; with `following=true`, only when followed. When the lookup
  fails or cannot be stored, or the Worker is in readonly maintenance, the answer comes from local data. `limit=0`
  answers an empty list.
- `GET /api/v2/search` with `resolve=true` and a `user@domain` query checks the token again after the lookup, so a
  token that expired during it answers 401.
- `thumbnail` on `POST /api/v1/media`, `POST /api/v2/media` and `PUT`/`PATCH /api/v1/media/:id`, and
  `media_attributes[][thumbnail]` on `PUT`/`PATCH /api/v1/statuses/:id`, answer 422
  `Validation failed: Thumbnail must be blank`, as Mastodon does for images. `PUT`/`PATCH /api/v1/media/:id` takes a
  multipart body of at most 1 MiB plus 16 KiB.
- `POST /api/v1/admin/accounts/:account_id/action` answers 404 for any non-blank `warning_preset_id` (Kopje has no
  presets) and 422 for a `text` past 10,000 UTF-8 bytes or with a NUL, before any change.

### Instance changes

- Store schema: adds six migrations (0058–0063), applied on the first request after the deploy; a rollback to an
  earlier version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). On the
  representative store defined in `test/bench/migration-cost.ts`, migrations 0058–0063 together took 18.3–19.0 seconds (median 18.5)
  in three runs of the migration bench workflow on a 4-CPU GitHub-hosted runner, in workerd's local Durable Object
  SQLite with the whole Store's foreign keys verified, within the 20-second upgrade budget.
    - `0058_profile_credentials`: `accounts.indexable` and the unlock acceptance cursor, with the triggers that bound
      them; it reads the local accounts once and no other row.
    - `0059_contact_and_activity`: `local_accounts.active_on` (the day of an account's last authenticated request,
      counted as `usage.users.active_month`) and the triggers bounding the `contact_username` setting; a stored
      `contact_username` past that bound is deleted, and none is rewritten.
    - `0060_account_moves`: `accounts.moved_to_account_id` with its triggers and a partial index; every existing row
      reads as not moved.
    - `0061_account_static_images`: `accounts.avatar_static_url` and `accounts.header_static_url` with their
      triggers; every existing row reads as having its image as its static image, and no row is read.
    - `0062_account_warnings`: the empty `account_warnings` table with its index and triggers, and
      `notifications.account_warning_id` with a partial index; no existing row is changed.
    - `0063_account_warning_notifications_key`: rebuilds `notifications_natural` with the warning, over every
      notification; no row is changed.
  A dump past the new bounds is refused ([docs/dump-format.md](docs/dump-format.md)).
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.18] - 2026-10-20

An eighteenth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The instance's documents and public block list, as Mastodon 4.5 serves them:
    - `GET /api/v1/instance/privacy_policy` and `GET /api/v1/instance/terms_of_service` (and `/:date`) serve the
      privacy policy and the terms of service, and `GET /api/v1/instance/extended_description` the extended
      description, each sanitized as remote HTML is. The terms of service are one current version with its effective
      date (`effective` once the date has passed, `succeeded_by` always null). A converted document's `updated_at` is
      null until it is edited.
    - `/api/v2/instance` names `configuration.urls.privacy_policy` and `terms_of_service` while they are set.
    - The web pages `/privacy-policy`, `/terms-of-service` and `/terms-of-service/:date`; `/about` shows the extended
      description and links to them.
    - `GET /api/v1/instance/domain_blocks` lists the suspend blocks by `show_domain_blocks` and their public comments
      by `show_domain_blocks_rationale` (`disabled`, `users` or `all`; unset is `disabled`), obfuscated where a block
      says so, with the SHA-256 of each domain.
- Access admins can edit public instance settings with `kopje-admin instance` or `GET`/`POST /admin/instance`.
  Changes are logged without their values. Set these settings after publishing a cutover import; see
  [Instance details](docs/setup.md#instance-details).
- Follow suggestions (`GET /api/v1/suggestions` and `/api/v2/suggestions`, which used to answer `[]`): the accounts
  the people you follow follow, Mastodon's "friends of friends", ranked by how many of them follow each account, then
  by follower count (fewest first), then newest first. Only accounts that chose to be discoverable are suggested, never
  one you follow or requested to follow, block, mute, or block the domain of, one that blocks you, or an unavailable
  one; a follow only counts when you are shown that account's following list. Mastodon's other sources (accounts the
  admin features, trending accounts, similar profiles) are not offered. v2 shows each with
  `"sources": ["friends_of_friends"]`.
    - The ranking reads bounded windows (your 1,000 newest follows, each one's 100 newest follows, 10,000 in all), so
      it is an approximation of Mastodon's: a follow outside them does not count.
    - Kopje does not learn a remote account's follower count, so it ranks one as having none: at equal counts, remote
      accounts come before local ones.
    - At most 40 accounts are suggested; an offset of 40 or more answers `[]`, where Mastodon answers 500. There is no
      15-minute cache: the list is worked out on each request, so an offset is stable only while follows, blocks,
      mutes and dismissals stay the same.
- Dismissing a suggestion (`DELETE /api/v1/suggestions/:id`) is stored, and the account is not suggested again; it
  still answers `{}` whatever the id.
- Remote custom emoji, as Mastodon 4.5 shows them: the `Emoji` tags of a remote status (a Note, a Question, a converted
  object) and of a remote account are kept, and `emojis` (which used to be `[]`) lists the ones its texts reference on
  statuses, polls (those its choices reference), edit history versions and accounts. Each object keeps what it tagged:
  an account's are replaced by every refresh and `Update`, a status's by every newer `Update` (a change of emoji alone
  adds no history entry). A boost shows none of its own and a suspended account none. `static_url` is the same as
  `url`, and images are linked, never fetched. 64 tags are read per object, and a snapshot keeps the emoji that fit
  its bounds ([docs/dump-format.md](docs/dump-format.md); 40 typical ones per status and 20 per account fit), dropping
  the rest from the first that does not fit. A reference is any shortcode between two colons, so `:aa:bb:` shows both where Mastodon shows neither.
- Local custom emoji:
    - The Access admin adds, changes, disables and enables them with `kopje-admin emoji` (`GET`/`POST /admin/emojis`,
      `POST /admin/emojis/:id`), each logged in the moderation log. An image is a PNG, GIF or WebP below 256 KiB of at
      most 1024x1024 pixels, re-encoded (GIF and WebP as WebP), and refused when the re-encoded image is 256 KiB or
      more (what Mastodon downloads); it costs two Images transformations and belongs to the OAuth admin (refused with
      `no-oauth-admin` when there is none). A shortcode is 2 to 128 ASCII letters, digits and underscores, one enabled
      emoji each, at most 1,000 enabled; a category is up to 64 characters. `--replace` disables the enabled emoji of
      the shortcode in the same step. Emoji are never deleted: a disabled one keeps its files, its place in backups and
      in every post and profile that used it.
    - `GET /api/v1/custom_emojis` (which answered `[]`) lists the enabled emoji shown in the picker, in shortcode
      order, with `category` when there is one.
    - A post, a scheduled post when it is published, an edit and a profile save keep the enabled local emoji their texts
      reference (unlisted ones too) in `emojis`, as remote emoji are kept; earlier posts keep what they showed after a
      disable or a replace.
    - Notes, the actor and its `Update` carry the `Emoji` tags of those emoji (with `toot:Emoji` in the context), and
      `GET /emojis/:id` serves any local emoji's `Emoji` object, disabled ones included. A disable, an enable or a
      replace delivers nothing; peers keep emoji by shortcode, so a replaced image can change what they show on earlier
      posts (the accepted risks in [docs/threat-model.md](docs/threat-model.md)).
    - `kopje-admin media-rebuild` holds an emoji's image to the same limits and reports one past them (`failed` with
      `emoji-input`, `emoji-output`, `emoji-too-large` or `emoji-actual`), writing and deleting nothing for it.
- Reports from other servers: an inbound `Flag` (what Mastodon sends when a user forwards a report, and Misskey when a
  moderator forwards one) files a report of each local account it names, and of a remote one only with a named status
  of it that replies to a local account, as Mastodon does. Its reporter is the remote actor, its category `other`; the
  named statuses it may attach and what the admin is shown: R34 and R37 in [docs/visibility.md](docs/visibility.md).
  The OAuth admin is notified (`admin.report`) as for a local report.
    - Its bounds (101 objects, ids within 4,096 JSON-escaped UTF-8 bytes and a comment of at most 5,000 code points,
      100 unresolved reports per remote actor) and where it differs from Mastodon (a redelivery or a Flag whose id is
      not on its actor's server files nothing): ID-6, ID-7, RES-7 and the accepted risks in
      [docs/threat-model.md](docs/threat-model.md).
- Announcements, as Mastodon 4.5 serves them:
    - `GET /api/v1/announcements` (which answered `[]`) lists the published ones, oldest first, with `read`, the
      mentions of known accounts, the hashtags, the enabled local emoji the text references and the reactions.
      `with_dismissed` is ignored, as Mastodon ignores it.
    - `POST /api/v1/announcements/:id/dismiss` marks one read, and `PUT`/`DELETE
      /api/v1/announcements/:id/reactions/:name` (which answered 404) adds or removes a reaction: a Unicode emoji or
      an enabled local custom emoji, at most 8 different ones, with Mastodon's errors.
    - The `user` stream carries `announcement`, `announcement.reaction` and `announcement.delete`.
    - The Access admin writes them with `kopje-admin announcement` (`GET`/`POST /admin/announcements`, `POST
      /admin/announcements/:id`, `…/publish`, `…/unpublish`, `…/delete`), each write logged in the moderation log
      (a delete keeps the text's first 200 characters). The text is plain text of at most 10,000 bytes, linked when
      shown.
    - Scheduled ones are published by the cron within 5 minutes, and ended ones are taken down there, with no event.
    - Where they differ from Mastodon: MD-4 in [docs/mastodon-deviations.md](docs/mastodon-deviations.md).
- Trends, as Mastodon 4.5 works them out: `GET /api/v1/trends/tags` (and `/api/v1/trends`) and
  `GET /api/v1/trends/statuses`, which answered `[]`, list the trending hashtags and posts, worked out every 5 minutes
  from stored posts with Mastodon's scores and thresholds. Nothing trends until the Access admin approves it
  (`kopje-admin trends`, logged) unless `trendable_by_default=true`, and `trends=false` turns trends off
  ([docs/setup.md](docs/setup.md#instance-details)). Which posts may trend, and for whom:
  [docs/visibility.md](docs/visibility.md) (R41). Link trends are not implemented, and where trends differ from
  Mastodon: MD-5 in [docs/mastodon-deviations.md](docs/mastodon-deviations.md). The Mastodon admin API's trends lists
  answer the public trends; its approve and reject answer 403.

### Changed

- `GET /api/v1/trends`, `/trends/tags`, `/trends/statuses` and `/trends/links` read the token a request sends, so an
  invalid one answers 401, as Mastodon's do; without a token they may be cached for 15 seconds.
- Answers of the instance endpoints Kopje did not serve change shape, as Mastodon's: an unset privacy policy or terms
  of service answers 404 `{"error":"Not Found"}` (a `/terms-of-service/:date` other than the stored date still
  answers `Record not found`), and `GET /api/v1/instance/activity` and a hidden block list answer 404 with an empty
  body. The activity stays unserved: its weekly logins count requests Kopje does not record.
- `GET /api/v1/instance/domain_blocks` now reads the token: a suspended user's is refused with 403 `Your login is
  currently disabled` whatever the settings; any other invalid token reads as anonymous.
- The upgrade (migration `0049_instance_bounds`) rewrites instance settings past their bounds and keeps no copy: a
  title is cut at 1,024 and a description at 200 code points; a contact address past 254 bytes, rules past 65,536
  bytes or not a JSON array, and an extended description, privacy policy or terms of service past 50,000 bytes are
  removed, as is any of these that is blank (only spaces, tabs, line feeds, vertical tabs, form feeds and carriage
  returns). From then on the Store refuses such a value. To recover one, restore the point-in-time bookmark taken
  before the upgrade ([docs/upgrade.md](docs/upgrade.md)), or run the conversion again for a converted one.
- `kopje-admin convert` stores the legacy settings as the Worker stores them: a blank one, or a document that
  sanitizes to no text, is dropped, and one past its bound is cut or dropped and stops the conversion unless
  `--accept-truncation` is given (the counts: [docs/cutover.md](docs/cutover.md), "What the conversion does").
  `verify-conversion` expects the same, and fails when a dropped setting is in the dump.
- A Follow whose pair has more than 32 answers still waiting is answered 503, writing nothing, until they settle; a
  server whose own retries run out meanwhile needs its user to follow again.
- A given-up answer to a Follow that a later activity superseded is deleted by the next delivery sweep instead of
  after 30 days, and no longer shows in `kopje-admin deliveries`: nothing could send it again.
- A Like id is held once in the instance (a Like under an id any favourite already holds is ignored), and a new one
  longer than 4,096 bytes (JSON-escaped UTF-8) is not stored: such a Like is ignored. An id stored before the upgrade
  keeps working whatever its length.
- An untyped Undo (an id alone) that matches nothing stored is answered 503 when the actor's retractions are at their
  cap (10,000), where it was answered 202 and not recorded: it may undo a Like or boost still on its way.
- An Undo of a Like naming a status that is not a local one, and that no stored favourite matches, records nothing:
  servers also send the Undos of reactions to other servers' posts to the reactor's followers, and these took the
  actor's retraction allowance.
- An instance domain block's `reject_reports` is enforced: a Flag from a server it covers files nothing (it was stored
  but never applied). A nearer block without it, a `noop` included, exempts its subdomains, as on Mastodon.
- A local suspension's `Update` (and the unsuspension's) also reaches the servers of the accounts that reported the
  suspended account, as Mastodon's reach includes reporters.

### Fixed

- A remote account that follows again (after its Undo, a block and unblock, a rejected request, or a remote
  suspension and unsuspension) no longer receives the earlier answers (`Accept`, `Reject`) still waiting for it in
  the delivery queue: only the new Follow's answer, or the owner's decision on a request, is sent (NET-2 in
  [docs/threat-model.md](docs/threat-model.md)). An answer a delivery attempt has already taken is still sent, so the
  two sides can disagree until the follower follows again (see the accepted risks there).
- Replacing a reaction with an Undo and a new Like now preserves the correct favourite in either delivery order. A
  favourite may hold four outstanding Like ids; another Like returns 503 until an Undo or retirement of a tracked id
  received at least seven days earlier makes room. Converted favourites and retained pre-upgrade ids have the
  compatibility limits described under ID-7 in [the threat model](docs/threat-model.md).
- `EmojiReaction` is read as a Like, as `Like` and `EmojiReact` are, and an Undo of one removes it.

### Instance changes

- Store schema: adds nine migrations (0049–0057), applied on the first request after the deploy; a rollback to an
  earlier version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). On the
  representative store defined in `test/bench/migration-cost.ts`, migrations 0049–0057 together took 10.7–11.1
  seconds in three runs of the migration bench workflow on a 4-CPU GitHub-hosted runner, in workerd's local Durable
  Object SQLite, within the 20-second upgrade budget; on slower runners of the same size, 0049–0056 took up to 17.2
  seconds.
    - `0049_instance_bounds`: rewrites instance settings past their bounds (above), adds the triggers that refuse
      them, and indexes the suspend blocks by domain.
    - `0050_follow_recommendation_mutes`: the table of dismissed suggestions; it reads no existing row.
    - `0051_follow_answer_pairs`: records the remote follower of each follow answer and whether a delivery was ever
      claimed; every existing delivery of a follow answer counts as claimed, so none of them is cancelled.
    - `0052_favourite_likes`: a remote favourite's Like ids are rows of the new `favourite_likes` table, and its
      `favourites.uri` holds only the id it kept from before the upgrade, until that id's Undo. It adds the empty
      table with its indexes and triggers, and an index of the favourites by stored Like id; no existing row is
      changed. A dump past the new table's bounds is refused ([docs/dump-format.md](docs/dump-format.md)).
    - `0053_custom_emoji_snapshots`: `statuses.emojis`, `status_edits.emojis` and `accounts.emojis` hold the custom
      emoji snapshots, bounded by triggers; they read as none on every existing row, and no row is read or changed.
      A dump past their bounds is refused, and `verify-conversion` fails on a converted row holding one, reporting
      `emojis` counts by table ([docs/dump-format.md](docs/dump-format.md), [docs/cutover.md](docs/cutover.md)).
    - `0054_remote_reports`: rebuilds `reports` so that a report's reporter may be any account; a report id is never
      given twice and stays within 18 digits; one report per Flag id and reported account; the comment, uri and
      `status_ids` have stored bounds ([docs/dump-format.md](docs/dump-format.md)), and a dump past them is refused.
      Every report, notification, push and id is kept. It fails before writing anything on the conditions its
      [header](migrations/0054_remote_reports.sql) names; a stored report past the new bounds (none of Kopje's writers
      makes one) leaves the Store held until it is fixed and retried (`kopje-admin upgrade retry`,
      [docs/upgrade.md](docs/upgrade.md)).
    - `0055_local_custom_emojis`: the empty `custom_emojis` table with its index and triggers; it reads no existing
      row. A dump whose emoji image is not a kept local PNG or WebP upload within the recorded 1024-pixel edges, or
      with more than 1,000 enabled emoji, is refused ([docs/dump-format.md](docs/dump-format.md)), and
      `verify-conversion` fails on any `custom_emojis` row, counted in `emojis`.
    - `0056_announcements`: the empty `announcements`, `announcement_reactions` and `announcement_dismissals` tables
      with their indexes and triggers; the streaming journal (`stream_events`) is rebuilt to admit the announcement
      events, with its rows, ids, triggers and index kept. A dump past the new bounds is refused
      ([docs/dump-format.md](docs/dump-format.md)).
    - `0057_trends`: five empty tables (trend scores and the admin's reviews) with their indexes and triggers, and
      triggers bounding the `trends` and `trendable_by_default` settings; it reads no existing row. A dump past the
      new bounds is refused ([docs/dump-format.md](docs/dump-format.md)).
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.17] - 2026-10-19

A seventeenth release candidate of the first release, published under the npm dist-tag `next`.

### Changed

- A boost no longer shows a quote, attachments, mentions, hashtags or a poll of its own (a converted row could attach
  them to the boost): as on Mastodon, a reblog's `quote` and `poll` are null and its `media_attachments`, `mentions` and
  `tags` are empty, and its original's are shown inside `reblog`.
- A page of 40 statuses now takes about a dozen queries instead of about two hundred, and grouped notifications and
  admin reports batch their status reads too. Answers stay the same, except that the dropped quote of a boost above
  can change which other statuses' text a keyword filter matches, as the answer's text allowance is shared. A batch
  whose rows pass its memory bound is read again one status at a time and logs `kopje.presenter.row-cap-exceeded`
  with the status ids: the bound misses a row cost, so report it.
- Incoming text has U+0000 removed, and a lone surrogate (half of a character outside the Basic Multilingual Plane)
  becomes U+FFFD, one character where a read showed three: display names, bios, status content, content warnings,
  source text and media descriptions, from remote servers and from the API alike. Display names are cut at 2,048 and
  media descriptions at 10,000 code points, as Mastodon counts them, where they were cut by UTF-16 code units.
- A post whose text is only U+0000 is refused as blank, as an edit is.
- The upgrade (migration `0048_stored_bounds`) rewrites stored values past their bounds to what the API already
  shows, and keeps no copy:
    - content, source text and bios past their JSON bounds become empty; content warnings are cut to 2,730 code
      points, display names to 2,048 and media descriptions to 10,000;
    - profile, status and media URLs past their bounds become null (a media URL becomes empty), as does a media meta
      past 1,024 bytes;
    - the content, content warning and poll choices of earlier versions change the same way.

  From then on the Store refuses a write of such a value. A local status stored past a bound now shows the same value
  in its ActivityPub Note as in the API. To recover a rewritten value, restore the point-in-time bookmark taken before
  the upgrade (it restores the whole database, within the last 30 days; see [docs/upgrade.md](docs/upgrade.md)); for
  a remote row, re-derive it from its stored `raw` document (refetching does not restore content); for a converted
  row, run the conversion again from the legacy export.
- `kopje-admin convert` stores display names, profile, status and media URLs, media descriptions and the attachments
  of earlier versions as the Worker stores them, which is what the API already showed: a URL past its bound becomes
  empty (null for a profile or status URL), a long text is cut, and U+0000 is removed from text. Each change is
  counted among the normalized values as `stored:<table>.<column>`; `edits:media-field-over-bound` is now
  `stored:status_edits.media_json`. Verification expects the same values.

### Fixed

- NodeInfo, the other `/.well-known` documents and local actor documents can be read by browser clients on other
  origins (GET, and its preflight), as Mastodon allows. Elk's NodeInfo request no longer fails with a CORS error. The
  profile page stays closed to other origins as HTML.

### Instance changes

- Store schema: adds one migration, applied on the first request after the deploy; a rollback to an earlier version
  needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0048_stored_bounds`: rewrites stored values past their bounds (above) and adds the triggers that refuse them.
      On a benchmark store of 1,000,000 accounts, 2,000,000 statuses, 500,000 media attachments and 100,000 earlier
      versions, the whole upgrade (a check of the media attachments, one rewrite scan of each of the four tables and
      the foreign-key check of the whole Store) took 7.4 to 8.0 seconds in three runs in workerd's local Durable
      Object SQLite. The upgrade fails, and the Store stays readonly and unchanged, with
      `CHECK constraint failed: tokened_media_url_within_2048_bytes` if the URL of an uploaded media file passes 2,048
      bytes, which Kopje never builds: report it.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.16] - 2026-10-18

A sixteenth release candidate of the first release, published under the npm dist-tag `next`.

### Changed

- Answers that present statuses stop at a response body of 8 MiB, a whole status at a time; realistic content does
  not come near it (a page of 40 long posts with polls and described attachments takes under a quarter of it):
    - a timeline, account statuses, bookmarks, favourites or quotes page that reaches it stops early and offers its
      `next` link (`prev` for `min_id`), which continues after the last status shown; the profile web page likewise.
      Pinned statuses (`pinned=true`) answer with no paging links at all, cut or not (`limit` still caps them, and
      `max_id` and `min_id` still bound them by status id); one that reaches it shows the pins that fit, in pin order;
    - a thread's context shows the nearest ancestors, within half of it, and the first descendants in the rest, and
      an edit history shows the newest versions, oldest first, as Mastodon orders them;
    - `GET /api/v1/statuses?id[]=` leaves out the ids past it, as it leaves out unknown ones;
    - search (`/api/v2/search`, and `/api/v1/accounts/search`) counts its accounts, statuses and hashtags, and the
      account `resolve=true` found, in one answer, and returns fewer results when it reaches it. A client that
      advances its `offset` by the number received continues after them; Mastodon's web client takes the short answer
      for the last one.
- Notifications, conversations, reports and the remaining lists of accounts stop at the same 8 MiB, a whole item at a
  time (a notification with its account and status, a group with the accounts and statuses it adds, a conversation, a
  report):
    - notifications (`/api/v1/notifications`), notification requests, conversations, blocks, mutes, followers,
      following, follow requests, `favourited_by`, `reblogged_by`, list members and endorsements stop early and offer
      their `next` link (`prev` for `min_id`), which continues after the last item shown;
    - grouped notifications (`/api/v2/notifications`) stop after the last group that fits, in the order the page found
      them: `next` and `prev`, and each group's `page_min_id` and `page_max_id`, are those of the groups shown, and a
      group may appear again on the next page with its older notifications. Unread counts and markers do not change;
    - the admin's report and account lists stop at a whole report or account and offer the next page. A report shows
      its statuses in order while they fit 2 MiB, the first always, so a report naming very large statuses shows fewer
      of them than it holds (the report keeps them all); its detail and action answers show it the same way;
    - the profile directory returns fewer accounts, as search does; a client that advances its `offset` by the number
      received continues after them.
- An outbox page holds its activities within the same bound, newest first, and continues after the last one shown.
  The featured collection shows its pinned Notes within it, and any pin past it by its uri. A Note shows the hashtags,
  mentions and attachments the API shows for the same status.
- The cutover's conversion stops on a local status that addresses more than 1,000 accounts, naming it
  (`statuses:local-addressing-over-bound:<object id>`), rather than drop any recipient: its Create would not fit an
  outbox page. A post's 500 characters name at most about 170.

### Instance changes

- Store schema: unchanged.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.15] - 2026-10-18

A fifteenth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The admin can suspend a remote account through the Mastodon admin API (`POST /api/v1/admin/accounts/:id/action`
  with `type=suspend`, which used to answer 422) and lift that suspension (`POST /api/v1/admin/accounts/:id/unsuspend`,
  which used to answer 403), with Mastodon's answers and errors. Lifting the suspension makes the account visible
  again; ended follows stay ended, and Kopje does not fetch the account again as Mastodon does. Unlike Mastodon, which
  still delivers to suspended accounts what was queued before, Kopje checks every delivery again right before sending
  it. From the moment the suspension is saved:
    - the account is shown to nobody: its posts, boosts, notifications and interactions are hidden everywhere, its
      profile is shown blank with `suspended: true` (in the admin entity too), it is listed under `status=suspended`
      and not `active`, and its follow requests are neither listed nor accepted;
    - nothing more is sent to it but withdrawals (deletions, undos, and the rejections below), including deliveries
      queued earlier, pushes caused by it, and follows of it by local users, which are kept but not sent;
    - activities from it are ignored, except its deletions, undos and rejections. Its profile and keys stay frozen;
      only its inbox addresses can change, so the rejections reach it. An ongoing move of its followers stops;
    - its reports are resolved, and its follows of local users are ended in the background, each with a rejection
      sent to it (a pending request is removed without one), as Mastodon does.
- The admin can block domains through the Mastodon admin API (`/api/v1/admin/domain_blocks`: list, show, create,
  update and delete, as Fedilab and Fediblockhole call them), with Mastodon's entity, paging and errors, including
  Mastodon's refusal of a block that is already there or no stricter than the one ruling its domain. A block of
  severity `suspend` covers the domain and its subdomains (a more specific `noop` block exempts its own): from the
  moment it is saved, their accounts are treated as suspended (shown to nobody, sent nothing but withdrawals, their
  activities ignored but deletions, undos and rejections, and nothing fetched from them), and in the background they
  are marked suspended and their follows with local users are ended both ways, as Mastodon does. Deleting the block
  makes them visible again; ended follows stay ended. A `noop` block stores its flags and comments. Every change is
  written to the moderation log (`kopje-admin moderation-log`). Differences from Mastodon:
    - severity `silence` is not built, and answers 422; as it is Mastodon's default, so does a create without a
      severity;
    - `reject_media=true` answers 422 (Kopje keeps no copies of remote media to reject); `reject_reports` and
      `obfuscate` are stored but change nothing yet;
    - a domain of more than 8 labels, and a comment longer than 1,000 characters, answer 422, as does, like on
      Mastodon, a domain of 256 characters or more or with a label longer than 63;
    - while the background work of a block or unblock runs, the admin account lists `status=active` and
      `status=suspended` answer 503 with `Retry-After` ("moderation in progress, try again") instead of a page that
      could be wrong; searches by name or domain still answer;
    - lifting the suspension (`POST /api/v1/admin/accounts/:id/unsuspend`) of an account that only a domain block
      holds answers 403: delete or lower the block instead. An account suspended on its own and covered by a block
      answers 200 and stays suspended by the block (`suspended: true`) until the block goes.
- The measure `instance_follows` (`POST /api/v1/admin/measures`), which Fediblockhole checks before a block stricter
  than silence: the number of accepted follows by local users of the domain's accounts (with `include_subdomains`, of
  its subdomains' too), and a per-day series between `start_at` and `end_at`. Other measure keys are left out of the
  answer, as Mastodon leaves out keys it does not know. With its default `max_followed_severity` (silence),
  Fediblockhole lowers a block of a domain that local users follow to `silence`, which Kopje refuses with 422. For a
  new block, Fediblockhole logs that error and goes on with the next one; for a block it raises (an update), it stops
  the whole run with an error, leaving the rest of its list unpushed. A domain with only pending follow requests is
  blocked as asked. Differences from Mastodon:
    - a follow is counted in the series on the day it was requested, not accepted;
    - the series has at most 366 points, a request names at most 16 measure keys, and the count walks at most 20,000
      follows by local users in all; beyond any of these, the answer is 422, never a partial count. An instance whose
      users follow more than 20,000 accounts in all cannot use the measure, and Fediblockhole then stops its whole run
      with an error at the first block stricter than silence.

### Changed

- The admin's role (`role.permissions` in the credential account) is now 1080: it adds manage_federation (domain
  blocks; domain allows answer an empty list to the admin and refuse a create, as there is no limited federation
  mode) and view_dashboard (the measure above; dimensions and retention answer an empty list). Measures, dimensions
  and retention used to answer 403 to everyone.
- The follow request list leaves out unavailable requesters (suspended, or being deleted) and reads a bounded window
  of requests per page, as the other filtered lists do: it may return a short or empty page while its `next` link
  still leads on.
- One account's size is bounded. A remote bio is stored within 64 KiB as a JSON string, cut by sanitizing a shorter part
  of it so it stays valid HTML (realistic bios take at most about 28 KB), and a remote profile URL (`url`, avatar,
  header) longer than 2,048 characters is ignored, as an invalid one is. Accounts already stored are shown within the
  same bounds wherever they appear, mentions included: a longer bio as empty, a longer URL as none, the display name cut
  at 2,048 characters and the username at 255, until the account is fetched again. One account then serializes to at
  most about 123 KB (RES-3 in [docs/threat-model.md](docs/threat-model.md)).
- Pages of followers, following, follow requests, `favourited_by` and `reblogged_by` read only the profiles of the
  accounts they return.
- Answers that present many accounts at once (list members and endorsements with `limit=0`, familiar followers) stop at
  a response body of 8 MiB; 1,000 typical accounts, about 2 KiB each, still fit whole. A `limit=0` answer that stops
  short sends a `Link` header whose `next` answers the rest through `max_id`, which these answers honour, a deliberate
  deviation from Mastodon, which ignores `max_id` with `limit=0`. Familiar followers share the 8 MiB among the requested
  accounts that have followers to show, so one with large followers does not crowd out the others, and the answer does
  not depend on their order.
- One status's size is bounded. A remote status's content is stored within 128 KiB as a JSON string, cut by sanitizing a
  shorter part of it so it stays valid HTML (realistic posts at Misskey's, Pleroma's, Akkoma's and GoToSocial's limits
  take at most about 35 KB), its content warning within 16 KiB, cut at a character, and a media URL or preview longer
  than 2,048 characters is ignored, as an invalid one is. A remote status whose id is longer than 4,096 bytes is not
  stored, and an actor whose id is longer than 2,048 bytes as a serialized URL is not either. A local post or edit whose
  rendered text passes these bounds, which only hundreds of mentions of accounts with long profile URLs reach, is
  refused as too long. Statuses already stored are shown within the same bounds wherever they appear, edit history (each
  earlier attachment included), `/source` and a redacted quote included: content or source text past the bound as empty
  (the status keeps its link to the original), a content warning cut, at most 4 attachments with longer URLs as none and
  descriptions cut at 10,000 characters, and an actor or status URI past its bound as empty. The largest presented
  shapes are listed in RES-3 of [docs/threat-model.md](docs/threat-model.md).
- A status presents at most 70 hashtags, the first by name, of the up to 100 it stores, and its content links every one.
  A conversation presents at most 12 participants, the first in stored order. Mastodon presents all of them. Reading a
  status costs no more for the mentions and hashtags it stores beyond those it presents, or for hidden attachments. A
  hashtag longer than 256 characters is recorded but not presented, so a post whose such hashtag sorts before more than
  70 others presents 69.
- A presented profile or attachment URL stays within 2,048 characters once normalized or derived: an account's profile
  URL falls back from its stored URL to one derived from its actor id or from this instance, and is empty when none
  fits.
- A remote account's username follows Mastodon's remote format; a stored one outside it (converted at a cutover), or
  holding a NUL, is shown cut at 42 characters.
- `kopje-admin convert` and `verify-conversion` apply the same bounds to status content, content warnings and source
  text, of current and earlier versions, counting each cut as a truncation that `--accept-truncation` accepts. They
  refuse a remote actor id longer than 2,048 bytes as written or as a serialized URL, a status or boost URI longer than
  4,096 bytes, and a remote username outside Mastodon's remote format, and the conversion counts an earlier version's
  attachment that is shown cut (`edits:media-field-over-bound`).

### Instance changes

- Store schema: adds three migrations, applied on the first request after the deploy; a rollback to an earlier version
  needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md). Applied together in one upgrade, as
  an instance coming from rc.14 applies them, the three took 8.2 seconds on the benchmark store (on a loaded machine),
  within the 20-second budget for a release.
    - `0045_remote_suspension`: lets the admin suspend remote accounts. It adds two account columns, builds two
      indexes over the accounts and one over the queued outbound activities (one pass over each), drops one index, and
      adds a table: on the benchmark store of 1,000,000 accounts and 500,000 outbound activities its upgrade took 7.1
      seconds (7.0 in two more runs), most of it the overhead of an upgrade on a store that size, which an upgrade
      applying several files pays once.
    - `0046_instance_domain_blocks`: the table of instance domain blocks. It adds an empty
      table and reads nothing: on the same benchmark store its upgrade took 5.9 seconds (6.0 and 6.4 in two
      more runs), the overhead of an upgrade on a store that size.
    - `0047_status_mentions_shown`: an index of the mentions a status shows, so a status read takes them without
      passing the silent ones. It builds a partial index in one pass over the mentions: on the same benchmark store,
      with 2,000,000 mentions, its upgrade took 7.1 seconds (7.2 in another run, and 9.7 in a first run on a loaded
      machine).
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
