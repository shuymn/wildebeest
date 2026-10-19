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
  blocks, trends review and link publishers, admin tags, dimensions and retention answer 403 or 404, as Mastodon
  answers a role without the permission. Kopje has no sign-ups, recorded IPs, allowlist mode or trends data. Decided
  by the coordinator, 2026-10-16.
- **MD-3: Features not built yet answer as Mastodon with the feature off.** Trends (and the admin trends lists), the
  link timeline, announcements, annual reports, translation, async refreshes and the admin domain allows list answer
  empty or 404 until the feature is built; the backlog tracks them. Decided by the coordinator, 2026-10-20.
