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
- **MD-2: Admin features with nothing to act on are not served.** Domain allows, IP, email domain and canonical email
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
  window. Deleted posts and suspended accounts stop counting at once. At most 200 allowed hashtags and 200 allowed posts
  are kept, with 50 of each awaiting review, and 3 posts per author; the lists end at the top 200 allowed now, and an
  offset of 200 or more answers `[]`. A trending hashtag's `history` counts at most its newest 200 public posts of the 7
  days, and a hashtag whose stored name is not well-formed UTF-8 or not in its own normalized form (an imported one)
  never trends. Reviews are made by the Access admin, take effect at once and send no e-mail; while trends are off
  nothing is scored and the admin lists are empty. Posts are ordered by the `Accept-Language` language among ISO 639-1
  codes (no user locale, chosen languages or `lang`). `limit=0` answers `[]` without a Link, and a page cut by the 8 MiB
  budget continues after its last post. Link trends, `GET /api/v1/timelines/link` and the admin link lists are not
  implemented: Kopje fetches no link previews, so they answer `[]` or 404 as Mastodon does with no trending link.
  Decided by the owner (delegated), 2026-10-20.

## Differences the checks cannot see

Profile credentials (`PATCH /api/v1/accounts/update_credentials`, the settings page):

- `avatar` and `header` are multipart files only: a data URI or any other non-empty text value answers 400 (Paperclip
  has no handler for it); an empty value reads as absent. Each file must be under 8 MB (8,388,608 bytes is refused)
  and JPEG, PNG, GIF or WebP by its signature; AVIF is refused. The multipart body may be 17,858,560 bytes (1 MiB of
  text plus two files and their part headers), its text at most 1 MiB in UTF-8 bytes.
- Images are not cropped to 400×400 or capped at 1500×500; an image past 16,777,216 pixels answers 422 (Mastodon keeps
  the account unchanged and answers 200).
- `avatar_static` and `header_static` equal `avatar` and `header`, animated images included: no still rendition is
  made yet.
- `indexable` is stored, shown and federated, but changes no search result: status search reads the viewer's own posts and
  interactions, or one account's posts the viewer may see, never a public index.
- Unlocking accepts the pending follow requests in job rounds after the response, at most 20 per round (the 5-minute
  cron resumes them); relocking stops it. Requests from an unavailable requester, or one the account or its blocked
  domains cover, stay pending.
- While a media rebuild holds its lease, a profile edit answers 503, since replacing an image dooms the upload behind
  it.

Request parameters:

- Of repeated parts of a declared file parameter (`avatar`, `header`, `file`), text or file, the last is the one read,
  as Rails assigns them; on `/api/v{1,2}/media` a file followed by a string answers 422 `File can't be blank`, where
  Mastodon answers 400.
- A query value of a declared file parameter is read only when the body has none (Rails lets the query win).
- A multipart part with an empty filename is read as a text value, as workerd's parser reads it (Rack drops it as an
  empty file field): empty, it reads as absent; with bytes, a profile image answers 400.
- A JSON body that flattens to more than 10,000 keys (object members; a list's values are not counted), or to keys of
  more than 2,097,152 UTF-16 code units together, answers 413; one nested more than 32 levels answers 400 (Rack's `param_depth_limit`).
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
