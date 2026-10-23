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

A cap that drops protocol-visible data (a field, an item or part of a value Mastodon presents or federates) is a
behaviour change: check what Mastodon does first, and cap only within it or as a departure decided here. A code comment
calling a difference deliberate is not a decision. To accept a departure, add an entry here with the reason and who
decided it, and change the exceptions that cite the gap.

A pull request that fixes a gap removes the exceptions that cite it. When Kopje follows a newer Mastodon release,
regenerate the fixtures with `scripts/mastodon-scopes.mjs`, review each new exception, and review the behaviour by
reading Mastodon's source: a parameter that is read and then dropped, or a wrong value, does not show in the checks.

## Departures

- **MD-1: Registration through the API is closed.** `POST /api/v1/accounts` answers 403, as Mastodon does with
  registrations closed, and `POST /api/v1/emails/confirmations` refuses, since no user signs up through an app. Accounts
  are made by signing in through Cloudflare Access. Decided by the coordinator, 2026-10-15.
- **MD-2: Admin operations withheld from Mastodon's API.** Domain allows, IP, email domain and canonical email
  blocks, link publishers and admin tags answer 403 or 404, as Mastodon answers a role without the permission;
  dimensions and retention answer `[]` to the OAuth admin and 403 to everyone else. Kopje has no sign-ups, recorded IPs
  or allowlist mode. Trends review through the Mastodon admin API (approve, reject) answers 403; the Access admin
  reviews trends (`kopje-admin trends`). Decided by the coordinator, 2026-10-16. Of the measures
  (`POST /api/v1/admin/measures`), `active_users` (Kopje keeps only each account's last active day), `interactions`
  (no count of replies, boosts, follows, votes and favourites by day survives their undo), `tag_accounts`, `tag_uses`
  and `tag_servers` (no hashtag history over an arbitrary range, and a hashtag's API id names no stored row) and
  `instance_statuses` (a server's statuses stay stored while their deletion runs) answer 422
  `measure <key> is not served` to the OAuth admin, the whole request; Mastodon's 400 for a missing object and 422 for
  an invalid date come first, to every caller. Decided by the orchestrator, 2026-10-22.
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
- **MD-5: Trends are worked out from Kopje's stored statuses.** Every 5 minutes Kopje counts
  again from the newest 4,000 public originals with ids from yesterday 00:00 UTC on, classified by publication day
  (Mastodon counts on receipt); at most 100 hashtags per post and 8,000 in all are read, and the 400 hashtags with the
  most accounts today are scored. Only the 400 posts of that window with the most boosts and favourites (counted up to
  10,000,000) are scored. A post published earlier but given a later id, or the reverse, is counted only within that
  window. The next scoring round excludes deleted posts and unavailable authors; status lists apply R41 on every read.
  At most 200 allowed hashtags and 200 allowed posts are kept, with 50 of each awaiting review, and 3 posts per author;
  the lists end at the top 200 allowed now, and an offset of 200 or more answers `[]`. A trending hashtag's `history`
  follows the Hashtags rules below (the trends lists' cap is 200), and a hashtag whose stored name is not in its own
  normalized form (an imported one) never trends. Reviews are made by the Access admin, take effect at once and send
  no e-mail. While trends are off, public lists are empty; the next cron round clears stored trends and leaves the
  Access admin lists empty too. Posts are ordered by the `Accept-Language` language among ISO 639-1 codes (no user
  locale, chosen languages or `lang`). `limit=0` answers `[]` without a Link, and a page cut by the 8 MiB budget
  continues after its last post. Links are counted from the same window by publication day: its public originals
  with a public card, and at most 4,000 public boosts of them from yesterday 00:00 UTC, at most 100 per post (boosts
  of older posts are not counted); the 400 links with the most accounts today are scored. A link is its card's URL
  after redirects: no canonical URL is read, a final URL the stored URL rule refuses leaves the card out of trends,
  and cards fetched before migration 0071, and copies made from them within the 14-day reuse, never trend. A link
  trends while one of its 8 newest public cards is appropriate for trends (Mastodon's
  `PreviewCard#appropriate_for_trends?`: an article link with a title, a description, a provider name and an image,
  here a stored one, in a supported language, on a public original); the newest such card whose title, description
  and provider name present as text is the one shown, and a link none of whose cards presents is not listed. Its
  `history` counts at most its 200 newest public posts of the 7 days and 200 of their boosts (20 per post), so it may
  undercount. The hashtags' rules above apply to links too: 200 allowed and 50 awaiting review are kept, an offset of
  200 or more answers `[]`, `limit=0` answers `[]` without a Link, links are ordered by `Accept-Language`, reviews
  are the Access admin's (a link's own, else its publisher's by the longest reviewed domain suffix; no
  `trendable_by_default`, as Mastodon) and take effect at once, and no e-mail is sent. `GET /api/v1/timelines/link`
  is not implemented and answers 404 as Mastodon does for a link that is not trending. Decided by the owner
  (delegated), 2026-10-20; the link rules by the orchestrator, 2026-10-24.
- **MD-6: Media have no short link.** MediaAttachment `text_url` is always null. Mastodon shows it only for a local
  attachment with a shortcode, and has assigned no shortcode to new media since v3.5.0, so only its older local media
  show one; Kopje assigns none and serves no short link route. Decided by the orchestrator, 2026-10-22.

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
- A local animated WebP stays animated in `avatar` and `header`, where Mastodon flattens it to one frame. An APNG is
  served as a still PNG, as Images makes animated output only as GIF or WebP.
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
- Field verification (`fields[].verified_at`, local accounts only) runs in the 5-minute cron's round after a save,
  not at once as Mastodon queues it, one account per round, and checks of an account are at least 5 minutes apart: a
  save during a check waits for its end. A check that ran and did not verify a value is retried only after the next
  save, as in Mastodon; one whose round died is retried once after 5 minutes. A suspension drops a pending check; a
  request already under way for it may still be sent, and records nothing.
- A value is checked only when it is printable ASCII of at most 255 bytes, `https` with no userinfo, the default port
  (or `:443`), a host of lowercase letters, digits, `_` and `-` labels of at most 63 characters, and a path with no `%`
  and no dot segment (Mastodon's `verifiable?` also accepts other ports, percent-encoded paths, IPv6 literals and
  more: `test/field-verification.test.ts` lists them). Redirects and the HEAD probe use the default port only; literal
  IPs, local and single-label names, and hosts the instance's domain policy refuses are never contacted.
- Only a 200 `text/html` or `application/xhtml+xml` page whose Content-Encoding is absent, `identity`, `gzip` or `br`
  is read, exactly its first 1 MiB after decoding (Mastodon reads to the end of the chunk that crosses 1 MiB), decoded
  by its BOM, its Content-Type charset, a meta prescan, then UTF-8. No rel=me is found after a `<noscript>`,
  `<select>`, `<svg>` or `<math>` start tag, or at or after an `<a>` or `<link>` whose rel passes 2,048 characters,
  and none in a page with `<frameset`; the first rel=me is not HEADed when its href is relative or passes 2,048
  characters.
- Converted or imported fields past 16 KiB of JSON or 4 entries are never verified.
- Remote accounts' fields are checked in the same 5-minute round, after local accounts, not after Mastodon's random
  0–599 s delay; at most one claim per account per 5 minutes. Only the first 4 shown fields whose value is a link are
  tracked and shown verified, of the 16 shown (Mastodon checks up to 50). A field is a candidate only when the actor's
  `attachment` is an array and its `type` exactly `PropertyValue` (Mastodon's `property_values`), and its original
  value, of at most 2,047 bytes with no NUL, is one lowercase `<a>` with double-quoted, distinct attributes separated by
  HTML whitespace, text and `<span>`s of text only, no character reference but `&amp;`, whose href (at most 1,016 bytes
  of printable ASCII, none of `` "<>\^`{|} ``) equals its text and passes the local rule above
  (`test/field-verification.test.ts` lists what Mastodon accepts beyond this).
- A remote verified time is kept while the href and the link back stay, where Mastodon re-verifies at every processing
  of the account (so a revoked rel=me goes unnoticed until the href or the profile URL changes); an unverified link is
  checked again at a store at most once a day; a pending check expires after a day; accounts stored before the
  upgrade are checked at their next store. For an account that is not suspended, Mastodon's `only_key` refresh (a key
  refetch) replaces its fields, dropping their times, and schedules no check; Kopje has no such refresh, every store
  of the document arms its links as above. A suspended account's document updates its inboxes only, in Kopje and in
  Mastodon alike, so its fields and their times stay as they were.
- The link back is the stored, WHATWG-serialized profile URL when it is on the actor id's host (else the actor id), and
  is compared with rel=me hrefs lowercasing ASCII only, where Mastodon compares the document's raw string with Ruby's
  Unicode `downcase`; so Kopje's verified set is not a strict subset of Mastodon's (a profile URL written
  `https://actor.example` matches a backlink to `https://actor.example/`).
- A verified remote value shows the shortened link Kopje writes for local text: 30 characters shown, where Mastodon
  shows 31 when the hidden rest would be one character, and `rel="nofollow noopener noreferrer"` without
  `translate="no"`.

Link previews (a status's `card`, Mastodon's `FetchLinkCardService`):

- `embed_url` is always `''` (a privacy choice: it names a third-party media URL, which Mastodon's web client never
  reads).
- `authors[].account` is always null, where Mastodon shows the account a page's `fediverse:creator` names when that
  account's attribution domains cover the page's host. An Account in every status's card would take the status lists
  past their answer budgets (RES-3), and Kopje stores neither the handle nor remote accounts' attribution domains.
  Clients lose only the card's link to the author's profile. Decided by the owner, 2026-10-23.
- A quoted status (a status's `quote.quoted_status`) shows no card, where Mastodon's `ShallowStatusSerializer` shows
  it, so a status with its quote stays within the answer budgets (RES-3); the quoted status's own read shows it.
- Only public and unlisted originals get a card, a privacy choice: Mastodon fetches the link of every visibility,
  which tells the linked site that the instance holds the post. A status with a shown attachment or any quote, a boost,
  and one whose author is unavailable get none.
- A remote status's link is the first of its first 16 anchors that is not a hashtag's (`rel` holding `tag`), a
  microformats one (`class` holding `u-url` or `h-card`), a mentioned account's URL, relative, of another scheme or the
  instance's own (by host and non-default port); anchors inside the elements the sanitizer drops whole are not seen. A
  local status's is the first `http(s)` link of its text that is not the instance's. That link is final: when it is
  `http`, has a port, names an IP literal or a local name, passes 2,048 characters, holds a character outside printable
  ASCII or one of `` "<>\^`{|} ``, or does not parse, there is no card (Mastodon fetches `http` links and other ports).
  Hosts the domain policy refuses are never contacted, after any redirect either.
- Fetched by a round of the 5-minute cron, at most 6 a round (3 at a time), not within a minute as Mastodon queues
  them; a link still unfetched a day after its post is dropped. A claim the round could not run (its budget, its
  deadline, a policy read that failed) is tried again; one that never finished is retried once, then dropped.
- Read through the web-page sink (NET-3): `Accept-Language: en, *;q=0.5`, exactly the first 1 MiB of a 200
  `text/html` or `application/xhtml+xml` page (Mastodon reads to the end of the chunk that crosses it). The scan keeps
  at most 128 metas and 4 JSON-LD scripts of 32,768 characters each, values of at most 2,048 characters, and the first
  HTML `<title>` anywhere (Mastodon reads head's). No canonical URL.
- oEmbed, as Mastodon tries it before OpenGraph, in at most two GET chains a claim (up to eight HTTP GETs, each chain
  at most 3 redirects): a page then the endpoint it declares, or a host's cached endpoint then the page for OpenGraph
  only. Mastodon fetches the cached endpoint again after it fails (a reused service object); Kopje never fetches a
  further endpoint there, even another one the page declares.
- A card from a host's cached endpoint is kept without fetching the page. Mastodon fetches the page after a cached
  endpoint succeeds too (its `unless html.nil?` runs first), so a transport failure of that page throws away its cached
  result there and gives no card.
- Discovery reads JSON endpoints only (`application/json+oembed` or `text/json+oembed`; no XML), among the page's first
  64 `<link>` elements. An `http` endpoint is upgraded to `https` as Mastodon does; one of another scheme, with a port,
  an IP literal or a local name is not tried (the page's OpenGraph is the card), where Mastodon tries it.
- An endpoint's answer is read whole within 64 KiB (Mastodon: 1 MiB; a longer one is no card), as UTF-8 by
  `JSON.parse` in place of Oj, within 10,000 values and 32 levels (past them, OpenGraph); a `version` of the number `1`
  passes as `1.0` does (`JSON.parse` cannot tell them apart). The User-Agent is the cards' own, with " Bot".
- A `type` that is not a string, and a `title`, `author_name` or `provider_name` that is not one, are no card and `''`
  where Rails would cast them; an oEmbed card with a blank title falls back to OpenGraph, where Mastodon saves it. A
  `twitter:player` page with a blank title is no card, where Mastodon saves one with its html.
- `width` and `height` (oEmbed's top-level ones, OpenGraph's `twitter:player:width` and `:height`) are a JSON integer
  or a string of one to five digits within 0 to 65,535, else 0, where Rails casts more forms and has no ceiling.
- A video's `html` is Kopje's fixed template, the twitter:player iframe as Mastodon's serializer sanitizes it
  (`allowfullscreen`, `scrolling` and `frameborder` forced, the sandbox added, a width or height omitted when the
  iframe has none or one past the same rule), from the src alone: an oEmbed `html` must hold exactly one iframe and no
  other `audio`, `video` or `source` (text around it is dropped; htmlparser2 reads it, not Nokogiri), and its src, like
  a player's, must be an absolute `http(s)` URL of at most 512 bytes (and 512 once `&` is escaped) without a refused
  character. A video without such an iframe is a `link` card with the same fields.
- A card's image (`og:image`, an oEmbed `link` or `video` card's `thumbnail_url`, a `photo` card's `url`) is fetched
  only from an `https` URL that passes the same URL rules as the link (Mastodon fetches `http` too), with a final
  `200` only (Mastodon reads any `2xx`); `image_description` is `og:image:alt` (`''` for oEmbed), shown with or without
  an image. Images are off by default and fetched by a round of the 5-minute cron, at most 3 a round, one at a time;
  the month's starts are capped by `IMAGES_CARD_MONTHLY_TRANSFORMS` (attempts, not stored images: each image charges
  one before its WebP and one before the RGBA its blurhash is computed from, which Images may bill as one
  transformation; a start whose output is refused still counts).
- The image is read below 8 MiB (as Mastodon), of JPEG, PNG, GIF or WebP by its signature (AVIF is refused), within
  16,777,216 pixels (921,600 for a GIF; Mastodon allows 33,177,600) and 65,535 pixels an edge, then re-encoded once by
  Images to a still WebP without any metadata, ICC profile included, of at most 512 KiB (a larger output is no image).
  Mastodon keeps a small image that is not a GIF as fetched, resizes a larger one in its own format keeping the ICC
  profile, and turns a GIF into JPEG.
- An image of more than 230,400 pixels is resized to fit `floor(sqrt(230400 × W / H))` by `floor(sqrt(230400 × H /
  W))`: Mastodon rounds, so Kopje's box is at most one pixel smaller an edge (1,200 × 500 asks for 743 × 309, where
  Mastodon's 744 × 310 is 230,640 pixels). A `link` card with an image takes the image's size, as Mastodon's does.
- The blurhash (4 × 4 components, alpha dropped) is computed from the image fitted within 100 pixels by area
  averaging, where vips resamples; when Images' RGBA output of it fails or is not of the image's size, or the month's
  share ran out between its two outputs, the card keeps its image without a blurhash (null), where Mastodon drops the
  image or fails the job; a claim given up at its deadline or one whose fence was lost is not stored.
- A stored image is reused by another card of the same image URL within 14 days of being stored, then fetched again
  (close to Mastodon, which downloads it again whenever it processes the card after 14 days); it is kept while any
  card names it. A card copied from another status whose image failed is fetched again (Mastodon's `missing_image?`).
- The endpoint cache holds at most 2,048 hosts (a new host past them is not cached), for 24 hours from when the page
  declared it; a failed cached endpoint does not renew it.
- JSON-LD shapes Mastodon fails on or reads oddly (an `@type` that is an array, a number in the root array, a string
  author read as a substring) are skipped; a value that is not a string reads as absent; times are read as ISO 8601
  only, an offset past 23 hours or 59 minutes refused. The texts' second decoding follows HTMLEntities (a numeric
  reference to its code point, a double-escaped NUL then removed), but keeps a reference to a surrogate or past
  U+10FFFF as written, where Mastodon raises, and reads names by the HTML5 table. The texts are cut to their bounds,
  Kopje's own (Mastodon bounds only the url): a title of 512 JSON-escaped UTF-8 bytes, a description of 1,024, an
  author or provider name of 512 each; an author or provider URL past 1,024 bytes or with a refused character is
  dropped (`''`).
- A failure attaches nothing, where Mastodon may attach an older card of a redirect's or canonical URL.
- Each status keeps its own copy: a status that links a URL another status fetched within 14 days copies that card
  without a request, but a later fetch does not update earlier copies, and an edit that keeps the URL fetches it again
  unless another status holds a fresh copy. A local edit resets the card only when the text changes, a remote update
  only when it is significant; a change of the quote alone resets nothing.

Accounts (the `Account` and credential account entities):

- A local account's fields (in the `Account`, `source.fields` and the actor's attachments) are, among its first 4
  stored entries, those that are a name and a value of strings within 255 code points each, in their order; a stored
  value past 16 KiB of JSON, or one that is not a JSON array, shows none. Mastodon presents every stored field.
  Kopje's own writer stores at most 4 within those limits, so only a converted or imported row can differ.
- `noindex` is `false` for every local account, Mastodon's default: no setting stores it, and the profile and status
  pages do not ask search engines to skip them. A remote account shows none, as in Mastodon.
- `roles` of a local account is the OAuth admin's Owner role (`id`, `name` and `color`) while that account is
  available, otherwise `[]`: Kopje has no other role to highlight. A remote account shows none, as in Mastodon.
- `uri` is `''` for an imported actor id whose JSON passes 2,048 bytes; ingestion stores none.
- A remote account its `Delete` removes stays stored, unavailable (R1 in `docs/visibility.md`), while its purge runs;
  Mastodon destroys it after purging its content in the Delete handler (`app/services/delete_account_service.rb`).
- `moved` is the latest of two writes: every stored actor document sets it from its `movedTo` or clears it, and a
  verified `Move` sets it when Kopje first processes it; a replay of a known `Move` writes nothing. A `movedTo` naming
  an account Kopje does not know reads as none: it is not fetched (Mastodon fetches it,
  `process_account_service.rb:310-314`). Mastodon processes a `Move` once per source account for 7 days
  (`move.rb:38`), Kopje once per activity id while its job is kept (30 days). Mastodon refreshes a profile on a
  signature only when the stored key fails (`signature_verification.rb:59`), and that refresh may fetch the key alone,
  which leaves `movedTo` as it was (`process_account_service.rb:103`); Kopje stores every fresh document it fetches,
  its `movedTo` included. A local account never has one: Kopje sends no `Move`. Followers move only on a verified
  `Move` whose target lists the source.
- The account `moved` nests is a bounded projection, not the full account: its identity, counts, flags and images,
  `note` `''` and `fields` `[]`, the display name cut at 100 code points, URLs and `uri` read as unset past 512 bytes,
  and only the emojis its display name references within 2,048 bytes of JSON; it never shows a `moved` of its own,
  as in Mastodon. A target whose domain passes 253 bytes, or an id that names no account, shows no `moved`. Mastodon's
  web client stores a nested account as the target's own entity (`actions/importer/index.js:39-40`, which
  `reducers/accounts.ts` replaces), so it shows the target with an empty bio and no fields until it fetches the target
  again, and each later import of the source does so again.
- A remote account's `followers_count`, `following_count` and `statuses_count` are the `totalItems` of its followers,
  following and outbox collections, as `ProcessAccountService#set_fetchable_attributes!` sets them
  (`process_account_service.rb:162-164`), but read by the background collection sync that each stored actor document
  asks for (`src/federation/collections.ts`), not while the document is stored: an account shows 0 until its first
  sync, and an account stored by an earlier release shows 0 until its document is stored again. Mastodon also moves
  the counts by its own deliveries between refreshes (`status.rb:480-493`, `follow.rb:62-70`); Kopje recounts local
  accounts only, so a remote account keeps the reported counts until the next refresh. A collection that may be read
  later (a timeout, a 5xx, the round's budget) is read again in a later round, where Mastodon keeps the count; one on
  another origin than the actor's is not read. A count is taken from a JSON number only, its integer part, a negative
  one as 0 (`AccountStat` shows `max(value, 0)`); one past 2^53−1 is not taken, where Mastodon's `bigint` column takes
  up to 2^63−1 (and a larger value raises, unverified). A document past the network part's caps (threat-model.md
  RES-6, `NETWORK_CAPS`) is unreadable, as Mastodon reads a collection it cannot fetch: no count, and a following or
  followers collection past them hides the network. Mastodon also refreshes a remote account in the background a week
  after its last fetch, up to six hours later, when a `Create` or `Update` of it arrives (`account.rb:69-70,258-261`;
  `create.rb:5`); Kopje refreshes only when it stores the actor's document, and before storing a status it fetched by a
  stale account (below). Mastodon signs the count fetches as `Account.representative` (`json_ld_helper.rb:232-235`);
  Kopje signs them as its other collection fetches (DATA-7: a local follower's key, else the instance actor's).
- Before storing a status it fetched by another account than the activity's sender (the original of a boost, a quoted
  status), Kopje refetches that account when its document was stored at least a day ago, as
  `FetchRemoteStatusService#account_from_uri` refetches a `possibly_stale?` account
  (`fetch_remote_status_service.rb:67-71`, `account.rb:71,254-256`). An account the instance suspended or a domain block
  covers is not refetched (R38), and its status is refused as in Mastodon (`:44`). The refetch does not look the account
  up by WebFinger. An account whose refetch answers 404 or 410 has no new status stored, as in Mastodon; a 404 or 410
  that arrives after another request's failed refetch of the same account is not applied. Where any other failure would
  make Mastodon store nothing or retry the job, Kopje stores the status under the stored account and tries that account
  again only a day later. A sender's own statuses are stored under the sender, as fresh as its key (24 hours, ID-1). The
  pinned statuses a collection sync fetches use the stored account however long ago the sync was asked for, where
  Mastodon checks the account when it fetches them. Search always fetches the account.

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
  rendered consent form answers them: the form carries no mode. A decision posted directly with `fragment` or
  `form_post` is also answered in the query, where Doorkeeper would honour the mode, as Mastodon does when it skips the
  consent page (Kopje never skips it). A blank mode (Rails' `blank?`) reads as `query`; any other value answers
  `unsupported_response_mode`. The metadata's `response_modes_supported` lists `query` only; Mastodon's lists `query`,
  `fragment` and `form_post` (`app/presenters/oauth_metadata_presenter.rb`, the modes Doorkeeper 5.8.2 registers in
  `lib/doorkeeper/grant_flow.rb`).
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

Hashtags (the `Tag` entity):

- `history` is counted again on every read from the stored statuses: public originals, by the UTC day of their
  publication (Mastodon counts a status on the day it receives it), with `accounts` exact (Mastodon's is a HyperLogLog
  estimate). A deleted status and the statuses of an unavailable author leave the counts (Mastodon never decrements
  them, and leaves out silenced accounts; Kopje has no silencing); an edit counts under its current hashtags (Mastodon
  counts a status at posting only); there is no `usable` flag, so every hashtag is counted. The counts are the same
  for every viewer, whatever they block or mute.
- `GET /api/v1/tags/:id` and the writes on one hashtag count every public status of the 7 days. The lists count at
  most the hashtag's newest public entries of the 7 days, taken before the rule above: 20 in v2 search hashtags,
  `followed_tags` and `featured_tags/suggestions`, 200 in the trends lists (MD-5). Newer public boosts and statuses of
  unavailable authors take those places, so a list can count fewer than the single hashtag does.
- A hashtag name, normalized, is at most 256 code points and 1,024 UTF-8 bytes to be followed or featured (and a
  featured hashtag's spelling too), the bound a status's hashtags are read by; past it the write answers 422 `Name is
  too long (maximum is 256 characters)`, even for a name the account already holds (an import's), and a remote
  account's featured hashtag past it is not learned. Mastodon validates only the name's format (`Tag`'s
  `HASHTAG_NAME_RE`). Every hashtag list (followed, suggestions, featured, the actor's `featuredTags`, trends) leaves
  out a stored name past the bound, with a NUL, or whose bytes are not well-formed UTF-8; a page of followed hashtags
  still pages by the follows it read. v2 search leaves out only names past the bound, before its page, and shows a
  malformed name decoded (U+FFFD for a stray byte), identified by its stored bytes, so it pages by offset with no
  repeat or gap.

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
  Mastodon, while Kopje's is hidden only while the suspension lasts; a target suspended at the action and unsuspended
  before that worker runs is notified in Mastodon, never in Kopje.
- A warning's `appeal` is always `null`: there are no disputes, through which Mastodon files appeals.
- A warning's `status_ids` is `null` when the named report's stored `status_ids` are not a list of at most 100 18-digit
  ids (only a restored report can hold that); the action still succeeds.
- Mastodon keeps a strike for `suspend`, for a remote target and with the notification off; Kopje keeps none of them.
  Mastodon's API never shows the last two, and a suspension's only when the target is unsuspended before
  `LocalNotificationWorker` runs.
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

Admin measures (`POST /api/v1/admin/measures`; the keys not served are MD-2):

- `instance_media_attachments` is always 0 bytes (`human_value` `0 Bytes`): Kopje stores no file of a remote
  attachment, only its URL.
- An absent or empty `domain` counts 0; Mastodon's total then counts the local accounts.
- `include_subdomains` is read as a boolean: empty, `0`, `f`, `false` and `off` (any case) are false; Mastodon takes
  any value sent as true, `"false"` included. The series counts the domain itself only, as 4.5.11 does.
- `new_users`, `opened_reports` and `resolved_reports` without both dates answer 422; Mastodon answers 500.
- `start_at` and `end_at` are read as ISO 8601 only, and only when both the date written and the UTC instant lie
  from 1583-01-01 to 9998-12-31; any other value answers 422 `Invalid date supplied`, to every caller, as an
  unreadable date does. The bound keeps every date of the answer in four-digit years. Mastodon reads any date
  `DateTime.parse` reads.
- The previous window (`previous_total`) can still reach before the Gregorian reform. Kopje counts it in the proleptic
  Gregorian calendar, while Ruby's `Date` is Julian before 1582-10-15, so `previous_total` can differ there: for the
  period 1583-01-01 to 1584-01-01, Kopje's previous window starts on 1582-01-01 and Mastodon's on 1581-12-22. The
  axis, `total` and the series are not affected.
- A measure past the bounds of its walk or its request ([docs/visibility.md](visibility.md), the admin measures)
  answers 422 and no count, never an undercount, where Mastodon sets no bound; pending requests and accounts being
  deleted count toward the walk's. So does a stored time that is not the ISO form Kopje writes (an import's).
- `instance_follows` and `instance_followers` date an accepted request by the request; Mastodon by its acceptance.
- Each request reads the Store; Mastodon caches each measure for 5 minutes.

Media (the `MediaAttachment` entity):

- A local upload's `blurhash` is null: Kopje computes no BlurHash for uploads, where Mastodon computes one for every
  local image and video.
- A remote attachment's `blurhash` is the value it was sent with when it is base83 with at most 5 by 5 components and
  the length they give, as Mastodon's `supported_blurhash?`; Kopje checks the whole string, where Mastodon's character
  check is line-anchored and keeps a valid first line followed by anything. Mastodon reassigns it, none included, on
  each accepted explicit `Update` (an Update whose version is missing or not newer may refresh only a poll, which
  leaves it as it was); an attachment stored by an earlier release shows null until its next accepted explicit
  `Update`.
- A remote attachment's `url` and `preview_url` are its remote URLs (`remote_url` and `preview_remote_url`, or `url`
  when it has no icon): Kopje fetches no remote media, where Mastodon shows its own copy or its media proxy.
- Edit history shows each version's attachments as recorded then, its URLs and `blurhash` included; Mastodon shows the
  current attachment's for every version. A version recorded by an earlier release, or converted from an earlier
  installation, shows `remote_url`, `preview_remote_url` and `blurhash` null; the current attachments of a converted
  remote status derive their remote URLs.

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
- Every local status shows the app it was posted through, as Mastodon does at its default `show_application`; Kopje
  has no such setting. The app is shown within Kopje's presentation bounds (threat-model.md RES-3, the presented
  status), judged on the stored value as decoded: a name past them shows `application: null`, and a website past
  them or not an http(s) URL with a host shows `website: null`. These can hide a value registration accepted (a
  website of 2,000 characters that are not ASCII, say).
- An app website holding any of C0 controls (U+0000–U+001F), the space, DEL (U+007F), C1 controls (U+0080–U+009F), the
  other whitespace JavaScript's `\s` matches (Unicode spaces, line terminators, U+FEFF), and `"` `'` `<` `>` `\` `^`
  `` ` `` `{` `|` `}` is refused at registration (`Website is invalid`) and not shown on a status (`website: null`):
  these are the characters that end or split an HTML attribute or a URL in common parsers. Registration trims
  surrounding whitespace before it validates, so only inner whitespace is refused there. Mastodon's UrlValidator
  (`Addressable::URI.parse`, an http(s) scheme and a host) may accept some of them.
- Kopje removes an app itself (an unused app after a day, or one registration evicts): its statuses then show
  `application: null`. Mastodon removes an app only when its owner deletes it. A scheduled status whose app is gone by
  its publication is published, showing `application: null`; Mastodon drops it.
