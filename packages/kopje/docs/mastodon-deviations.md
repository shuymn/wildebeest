# Accepted departures from Mastodon

Kopje follows the Mastodon API as Mastodon v4.5.11 serves it. The conformance checks compare it with Mastodon's
source: the routes and their access (`test/mastodon-access.test.ts`), the request parameters each route reads
(`test/mastodon-params.test.ts`), and the fields of the main entities (`test-node/mastodon-entities.test.ts`).

A difference those checks find is either a gap, tracked by an issue until it is fixed, or a departure that has been
decided. This page lists the decided ones. Each has an id (`MD-n`) that the checks' exceptions cite as
`{ status: 'accepted', deviation: 'MD-n' }`; every entry here is cited by at least one exception, and every id cited is
defined here once (`test-node/docs-ids.test.ts`, `test-node/mastodon-entities.test.ts`).

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
