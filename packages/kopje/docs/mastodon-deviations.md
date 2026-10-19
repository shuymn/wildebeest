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

- **MD-1: Registration through the API is closed.** `POST /api/v1/accounts` answers 403 as Mastodon does when an
  administrator closes registrations, so the sign-up parameters are never read; `POST /api/v1/emails/confirmations`
  refuses for the same reason, since no user signed up through an app. Accounts are made by signing in through
  Cloudflare Access, not by sign-up. Mastodon offers this as an instance setting.
  Decided by the coordinator with the account endpoints (2026-10-15); recorded here 2026-10-20.
