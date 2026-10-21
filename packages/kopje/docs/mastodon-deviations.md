# Accepted departures from Mastodon

Kopje follows the Mastodon API as Mastodon v4.5.11 serves it. The conformance checks compare it with Mastodon's
source: the routes and their access (`test/mastodon-access.test.ts`), the request parameters each route reads
(`test/mastodon-params.test.ts`), and the fields of the main entities (`test-node/mastodon-entities.test.ts`).

A difference those checks find is either a gap, tracked by an issue until it is fixed, or a departure that has been
decided. This page lists the decided ones. Each has an id (`MD-n`) that the checks' exceptions cite as
`{ status: 'accepted', deviation: 'MD-n' }`; every entry here is cited by at least one exception, and every id cited is
defined here once (`test-node/docs-ids.test.ts`, `test-node/mastodon-entities.test.ts`).

Behaviour the checks cannot see (how a value is judged, rather than whether a parameter or field is read) is listed
without ids under [Differences the checks cannot see](#differences-the-checks-cannot-see).

A code comment calling a difference deliberate is not a decision. To accept a departure, add an entry here with the
reason and who decided it, and change the exceptions that cite the gap.

## Departures

- **MD-1: Registration through the API is closed.** `POST /api/v1/accounts` answers 403, as Mastodon does with
  registrations closed, and `POST /api/v1/emails/confirmations` refuses, since no user signs up through an app. Accounts
  are made by signing in through Cloudflare Access. Decided by the coordinator, 2026-10-15.
- **MD-2: Admin operations withheld from Mastodon's API.** Domain allows, IP, email domain and canonical email
  blocks, link publishers, admin tags, dimensions and retention answer 403 or 404, as Mastodon answers a role without
  the permission. Kopje has no sign-ups, recorded IPs or allowlist mode. Trends review through the Mastodon admin API
  (approve, reject) answers 403; the Access admin reviews trends (`kopje-admin trends`). Decided by the coordinator,
  2026-10-16.
- **MD-3: Features not built yet answer as Mastodon with the feature off.** Annual reports, translation, async
  refreshes and the admin domain allows list answer empty or 404 until the feature is built; the backlog tracks them.
  Decided by the coordinator, 2026-10-20.
- **MD-4: Announcements differ in what they embed and when they change.** `statuses` is always `[]`: Mastodon embeds
  the statuses the text links, each up to a whole quote, in a list with no paging; the links stay in `content`. At most
  16 mentions (of available accounts, among the first 64 references) and 16 hashtags are listed; `content` links every
  hashtag. A text whose rendering passes 64 KiB of JSON is refused when written, and one that passes it later (a
  mentioned account's URL grew) is shown escaped with no link. A scheduled announcement is published by the 5-minute
  cron within 5 minutes after `scheduled_at`, with `published_at` = `scheduled_at`. At most 16 are published or
  scheduled and 1,000 kept. Reactions are grouped by name (Mastodon groups by name and emoji), and a Unicode reaction is
  any fully qualified RGI emoji or its unqualified form, a superset of Mastodon's emoji map. Decided by the owner,
  2026-10-20.
- **MD-5: Trends are worked out from Kopje's stored statuses, and links do not trend.** Every 5 minutes Kopje counts
  again from the newest 4,000 public originals with ids from yesterday 00:00 UTC on, classified by publication day
  (Mastodon counts on receipt); at most 100 hashtags per post and 8,000 in all are read, and the 400 hashtags with the
  most accounts today are scored. Only the 400 posts of that window with the most boosts and favourites (counted up to
  10,000,000) are scored. A post published earlier but given a later id, or the reverse, is counted only within that
  window. The next scoring round excludes deleted posts and unavailable authors; status lists apply R41 on every read.
  At most 200 allowed hashtags and 200 allowed posts are kept, with 50 of each awaiting review, and 3 posts per author;
  the lists end at the top 200 allowed now, and an offset of 200 or more answers `[]`. A trending hashtag's `history`
  counts at most its newest 200 public posts of the 7 days, and a hashtag whose stored name is not well-formed UTF-8 or
  not in its own normalized form (an imported one) never trends. Reviews are made by the Access admin, take effect at
  once and send no e-mail. While trends are off, public lists are empty; the next cron round clears stored trends and
  leaves the Access admin lists empty too. Posts are ordered by the `Accept-Language` language among ISO 639-1 codes (no
  user locale, chosen languages or `lang`). `limit=0` answers `[]` without a Link, and a page cut by the 8 MiB budget
  continues after its last post. Link trends, `GET /api/v1/timelines/link` and the admin link lists are not implemented:
  Kopje fetches no link previews, so they answer `[]` or 404 as Mastodon does with no trending link. Decided by the
  owner (delegated), 2026-10-20.

## Differences the checks cannot see

Profile credentials (`PATCH /api/v1/accounts/update_credentials`, the settings page):

- `avatar` and `header` are multipart files only: a data URI or any other non-empty text value answers 400 (Paperclip
  has no handler for it); an empty value reads as absent. Each file must be under 8 MB (8,388,608 bytes is refused)
  and JPEG, PNG, GIF or WebP by its signature; AVIF is refused. The multipart body may be 17,858,560 bytes (1 MiB of
  text plus two files and their part headers), its text at most 1 MiB in UTF-8 bytes.
- Images are not cropped to 400×400 or capped at 1500×500; an image past 16,777,216 pixels answers 422 (Mastodon keeps
  the account unchanged and answers 200).
- For an uploaded image whose served file is animated, `avatar_static` and `header_static` are a still of at most
  640 px on the long edge (the upload's preview); Mastodon's is 400×400 or the header's own size, and only for a GIF.
  Otherwise they equal `avatar` and `header`.
- A local animated WebP stays animated in `avatar` and `header`, where Mastodon flattens it to one frame. An APNG stays
  animated only as far as Images keeps its frames, which the release check records (`docs/setup.md`).
- A remote account's `avatar_static` and `header_static` equal its linked image; Mastodon makes a still for a GIF or an
  image it converts.
- Images uploaded before still renditions were made keep `avatar_static` and `header_static` equal to the image until
  they are replaced.
- The `preview_url` of an animated upload (status media included) is a still.
- `indexable` is stored, shown and federated, but changes no search result: status search reads the viewer's own posts and
  interactions, or one account's posts the viewer may see, never a public index.
- Unlocking accepts the pending follow requests in job rounds after the response, at most 20 per round (the 5-minute
  cron resumes them); relocking stops it. Requests from an unavailable requester, or one the account or its blocked
  domains cover, stay pending.
- While a media rebuild holds its lease, a profile edit answers 503, since replacing an image dooms the upload behind
  it.

Accounts (the `Account` and credential account entities):

- `noindex` is `false` for every local account, Mastodon's default: no setting stores it, and the profile and status
  pages do not ask search engines to skip them. A remote account shows none, as in Mastodon.
- `roles` of a local account is the OAuth admin's Owner role (`id`, `name` and `color`) while that account is
  available, otherwise `[]`: Kopje has no other role to highlight. A remote account shows none, as in Mastodon.
- `uri` is `''` for an imported actor id whose JSON passes 2,048 bytes; ingestion stores none.
- `moved` is the latest of two writes: every stored actor document sets it from its `movedTo` or clears it, and a
  verified `Move` sets it when Kopje first processes it; a replay of a known `Move` writes nothing. A `movedTo` naming
  an account Kopje does not know reads as none: it is not fetched (Mastodon fetches it,
  `process_account_service.rb:310-314`). Mastodon processes a `Move` once per source account for 7 days
  (`move.rb:38`), Kopje once per activity id while its job is kept (30 days). Mastodon refreshes a profile on a
  signature only when the stored key fails (`signature_verification.rb:59`), and that refresh may fetch the key alone,
  which leaves `movedTo` as it was (`process_account_service.rb:103`); Kopje stores every fresh document it fetches,
  its `movedTo` included. A local account never has one: Kopje sends no `Move`. Followers move as before, only on a
  verified `Move` whose target lists the source.
- The account `moved` nests is a bounded projection, not the full account: its identity, counts, flags and images,
  `note` `''` and `fields` `[]`, the display name cut at 100 code points, URLs and `uri` read as unset past 512 bytes,
  and only the emojis its display name references within 2,048 bytes of JSON; it never shows a `moved` of its own,
  as in Mastodon. A target whose domain passes 253 bytes, or an id that names no account, shows no `moved`. Mastodon's
  web client stores a nested account as the target's own entity (`actions/importer/index.js:39-40`, which
  `reducers/accounts.ts` replaces), so it shows the target with an empty bio and no fields until it fetches the target
  again, and each later import of the source does so again.

Instance and apps (`/api/v1/apps`, `/api/v{1,2}/instance`, `/api/v1/preferences`):

- An application's `id` is its `client_id`, Kopje's only stable key of an application; the `client_id` is a public
  identifier (RFC 6749 §2.2).
- `usage.users.active_month` counts the available local accounts with an authenticated API or web request on one of the
  last 28 UTC days, today included. Each account's day is recorded at most once a day, after the response, and a
  request made while a dump holds the Store may go unrecorded. Mastodon counts logins over the 28 days before today,
  suspended users included.
- `thumbnail` is always Kopje's default image; there is no upload.
- `languages` is `["en"]`, the web UI's language.
- The reading preferences, `reading:autoplay:gifs` included, are Mastodon's defaults; no setting stores them.
- `contact_username` and `contact_email` can each be removed alone (Mastodon's admin form requires both).

OAuth (`/oauth/authorize`, `/oauth/token/info`, `/oauth/introspect`):

- `response_mode` `query`, `fragment` and `form_post` are accepted and every answer goes in the query, as Mastodon's
  rendered consent form answers them: the form carries no mode, and Mastodon honours the other modes only when it
  skips the consent page, which Kopje never does. A decision posted directly with `fragment` or `form_post` is also
  answered in the query, where Doorkeeper would honour the mode. A blank mode reads as `query`; any other value answers
  `unsupported_response_mode`. The metadata lists `query` only.
- `lang` has no effect: the consent page is English only.
- Tokens are read from the `Authorization` header only, never from the `access_token` or `bearer_token` parameters.
  Introspection reads its parameters from the body only: a `token`, `client_id` or `client_secret` in the query is
  absent.
- `token/info` `resource_owner_id` is the account id, a string (Mastodon: the integer user id).
- A suspended account's token is invalid at `token/info` and inactive at introspection; Mastodon shows it.
- Introspection ignores `token_type_hint`: Kopje has no refresh tokens, and every token is looked up as an access
  token. Doorkeeper with `token_type_hint=refresh_token` looks up refresh tokens and answers an access token inactive.
- Introspection with a bearer token: a revoked target of the same client answers 401 `invalid_token`, because Kopje
  deletes revoked tokens (Mastodon: `active: false`). A suspended or stale-epoch caller is refused with
  `invalid_token`, and an authorization code presented as the caller is `invalid_token` where Doorkeeper finds no
  caller (400). `invalid_client` carries Kopje's Basic challenge and text, as at `/oauth/token`.

Search (`/api/v2/search`, `/api/v1/accounts/search`):

- With `resolve=true`, an `acct:user@domain` query is resolved as `user@domain` is; Mastodon's `MENTION_RE` gate
  (`account_search_service.rb`, `username_complete?`) does not take the `acct:` form.

Admin account actions (`POST /api/v1/admin/accounts/:account_id/action`):

- No email is sent: Kopje has no mailer. `send_email_notification` decides only whether a local target is warned (a
  `moderation_warning` notification), read as Rails casts it: absent is true; empty, JSON `null` and `0`, `f`, `F`,
  `false`, `FALSE`, `off`, `OFF` are false; anything else (`False` and `Off` included) is true.
- `text` is at most 10,000 UTF-8 bytes with no NUL (422 `Validation failed: Text must be at most 10,000 UTF-8 bytes
with no NUL`, before any write); Mastodon has no bound, and a NUL is its 500.
- Kopje has no warning presets, so any non-blank `warning_preset_id` answers 404 `Record not found` with no effect, as
  an unknown one does in Mastodon.
- Whether the target is notified is judged in the action's own transaction; Mastodon judges it when its
  `LocalNotificationWorker` runs. A target suspended between the action and that worker gets no notification in
  Mastodon, while Kopje's is hidden only while the suspension lasts; a target unsuspended in that window is notified
  in Mastodon of a warning given while suspended, which Kopje did not notify.
- A warning's `appeal` is always `null`: there are no disputes, through which Mastodon files appeals.
- A warning's `status_ids` is `null` when the named report's stored `status_ids` are not a list of at most 100 18-digit
  ids (only a restored report can hold that); the action still succeeds.
- Mastodon keeps a strike for `suspend`, for a remote target and with the notification off; Kopje keeps none of them.
  Its API shows none of the last two, and a suspension's only when the target is unsuspended before Mastodon's
  `LocalNotificationWorker` runs (it then notifies the warning); Kopje judges the target in the action's transaction,
  where a `suspend` warns nobody.
- The push title of a `moderation_warning` is the account's name; Mastodon's English locale has no subject for it.

Request parameters:

- Of repeated parts of a declared file parameter (`avatar`, `header`, `file`, `thumbnail`), text or file, the last is
  the one read, as Rails assigns them; on `/api/v{1,2}/media` a file followed by a string answers 422 `File can't be
  blank`, where Mastodon answers 400.
- A query value of a declared file parameter is read only when the body has none (Rails lets the query win).
- Kopje media are images, so `thumbnail` (on `/api/v{1,2}/media` and `/api/v1/media/:id`) and
  `media_attributes[][thumbnail]` (on a status edit) answer 422 `Validation failed: Thumbnail must be blank`, as
  Mastodon validates an image's thumbnail. Any file part or non-empty text is a thumbnail; empty text or JSON `null`
  is none. Text that is not a data URI answers 422, where Mastodon answers 500. The check runs before the file is
  processed on an upload, before the media lookup on `/api/v1/media/:id`, and on an edit before the status and
  `media_ids` are looked up, for any entry with an `id` (Mastodon reads only entries for the post's media). Mastodon
  may report other validation errors first or alongside it. On `/api/v1/media/:id`, a multipart body larger than
  1 MiB plus 16 KiB answers 413.
- A multipart part with an empty filename is read as a text value, as workerd's parser reads it (Rack drops it as an
  empty file field): empty, it reads as absent; with bytes, a profile image answers 400.
- A JSON body exceeding 10,000 generated parameter paths (object members, array objects and empty arrays; scalar
  array items do not count), or the 2,097,152 UTF-16 code-unit flattening budget, answers 413; nesting beyond 32
  levels answers 400 (Rack's `param_depth_limit`).
- An empty JSON object counts as sent: `{"fields_attributes":{}}` clears the fields and `{"home":{}}` saves the home
  marker, as in Mastodon; `{"poll":{}}` is still no poll.

Posting (`POST` and `PUT /api/v1/statuses`):

- A form's empty `media_ids[]=` reads as no media, the same as JSON `[]` (which removes an edit's media); Mastodon
  answers 422 `Media 0 not found or already attached to another post` for the form's.
- Media a scheduled status holds cannot be attached by another post (422, not found); Mastodon attaches it, and the
  scheduled post is then lost when it is published.
- An upload is processed before its answer, so no media id is ever still processing: an unfinished upload reads as
  not found (no `not_ready`).
- Text length, the poll, `scheduled_at` and the visibility are checked before the media ids and `allowed_mentions`;
  Mastodon checks the media first.
- `allowed_mentions[]` is compared with the mentions Kopje writes: accounts it already knows (nothing is fetched), not
  blocked by the author and not suspended. `unexpected_accounts` lists the accounts that fit the 8 MiB answer, in
  mention order. A scheduled post's parameters, the list included, must fit 128 KiB of JSON (`Record invalid`); the
  list is checked when the post is published, and a post it refuses is dropped, as in Mastodon. Numbers sent in a JSON
  list are kept as strings in `params.allowed_mentions` (Mastodon keeps the JSON types).
- An `Idempotency-Key` lasts one hour after the status or scheduled status it made; a scheduled post published within
  that hour keeps it until one hour after its publication. A repeated key answers the scheduled status it made
  (Mastodon answers 404 for an immediate repeat), and a key whose status was deleted posts anew (Mastodon answers 404
  within the hour).
