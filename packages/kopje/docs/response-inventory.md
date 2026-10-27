# Response inventory

Every Store operation that returns presented statuses, accounts or notifications, with what bounds its answer
(RES-3 in `threat-model.md`). The owner of an answer's budget is the operation itself: the Worker serializes what the
operation returns and adds nothing to it.

Mechanisms:

- **Budget**: the answer's JSON is at most `ANSWER_BYTES` (8 MiB, `src/domain/answer-budget.ts`), containers
  included. Items are admitted whole in traversal order, each presented and measured when it is reached, its rows read
  in small chunks (statuses in chunks planned by the bound of their rows, "Heap at 8 MiB per answer" in
  `threat-model.md`; 2 notifications, one conversation or report, 50 accounts with their static images and the accounts
  they moved to, at most 6.77 MB read past the budget), the first whatever its size
  (`admit`, `presentStatusesWithin`, `presentAccountsWithin`, `admitAccounts`). An atomic item counts with everything
  it embeds: a notification with its account, status and report; a group with the accounts and statuses it adds; a
  conversation with its participants and last status; a report with its accounts and statuses.
- **Unit**: one presented unit, at most its maximum ("Maxima of presented units" in `threat-model.md`).
- **Count**: a fixed number of units whose maxima together stay within `ANSWER_BYTES`.

Continuations:

- **Id cursor**: a page cut by the budget is `Page.cut` and continues from its last admitted item in traversal order
  (`admittedPage`): newest first for `max_id` and `since_id`, oldest first for `min_id`. A candidate-window
  continuation (`docs/visibility.md`, "Read bounds") is kept only when no item was left out by bytes before it.
- **Discovery position**: grouped notifications continue from the last admitted group's discovery position (the
  notification the walk found it by), never from a group's member range; see "Notifications" below.
- **More**: the admin lists end a cut page at its last admitted item and set `more`, which links the next page.
- **Offset**: the answer holds fewer results. A client that advances its offset by the number received (Tusky,
  Ivory) continues after them. Mastodon's web client takes a short answer for the last one and shows no more. This
  happens only past 8 MiB, which realistic content does not reach.
- **None**: the answer has no paging; what is left out is a Kopje bound. Pinned statuses are one: a status-id cursor
  cannot follow pin order.

The raw presenters are module-private; [threat-model.md](threat-model.md), RES-3, states the enforced presenter
boundary.

## Statuses

| Operation                                                                   | Mechanism                                                                     | Continuation |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ |
| `homeTimeline`, `listTimeline`, `publicTimeline`, `tagTimeline`             | Budget                                                                        | Id cursor    |
| `accountStatuses`, `bookmarksList`, `favouritesList`                        | Budget                                                                        | Id cursor    |
| `accountStatuses` with `pinned=true`                                        | Budget: the pins that fit, in pin order                                       | None         |
| `statusQuotes`                                                              | Budget                                                                        | Id cursor    |
| `statusContext`                                                             | Budget: ancestors on half, nearest first; descendants on the rest, in order   | None         |
| `statusHistory`                                                             | Budget: newest revisions first, returned oldest first                         | None         |
| `getStatuses`                                                               | Budget: the ids past the first that does not fit are left out as unknown ones | None         |
| `search`                                                                    | Budget over accounts (the resolved account first), statuses and hashtags      | Offset       |
| `webProfilePage`                                                            | Page budget: the account, its pins, then its posts (below)                    | Id cursor    |
| `webFollowsPage`                                                            | Page budget: the account, then its members strictly (below)                   | Id cursor    |
| `webFeaturedPage`                                                           | Page budget: the account and its hashtags, then its endorsements strictly     | Id cursor    |
| `webStatusPage`                                                             | Page budget: the status and its parent link (below)                           |              |
| `webTagPage`                                                                | Page budget: the hashtag's name in the frame, then its posts (below)          | Id cursor    |
| `embeddedStatus`, `resolveSearch`, `resolveInteraction`                     | Unit                                                                          |              |
| `webSite`                                                                   | Unit: the domain and the documents' flags                                     |              |
| `webAbout`                                                                  | Unit: the site facts and the about page's settings                            |              |
| `webDocument`                                                               | Unit: the site facts and one stored document                                  |              |
| `getStatus`, `postStatus`, `editStatus`                                     | Unit                                                                          |              |
| `deleteStatus`                                                              | Unit: the status as it was; an original's job removes the rest in batches     |              |
| `postStatus` refused for unexpected mentions                                | Budget over its unexpected accounts, in mention order                         | None         |
| `favourite`, `unfavourite`, `reblog`, `unreblog`, `bookmark`, `unbookmark`  | Unit                                                                          |              |
| `pin`, `unpin`, `muteConversation`, `unmuteConversation`, `getPoll`, `vote` | Unit                                                                          |              |
| `listConversations`                                                         | Budget: whole conversations (12 participants each, cut in SQL)                | Id cursor    |
| `markConversation`                                                          | Unit (one conversation)                                                       |              |
| `adminReports`                                                              | Budget: whole reports; a report's statuses as below                           | More         |
| `adminReport`, `updateAdminReport`, `actOnReport`                           | Unit: a report's statuses in its order within 2 MiB, the first always         |              |

The public pages' reads (`src/domain/web-pages/`) share one page budget (`budget.ts`): `ANSWER_BYTES` less the answer's
frame (its shape with empty lists, the cursor or both paging ends at 19 digits (`LONGEST_PAGING`), the site facts and
one stub at its longest). The head comes first and is charged its measured bytes; a head that does not fit is refused. A
list's first item is admitted if it fits what the head leaves, or else becomes a stub (`{ id, url, acct, created_at }`,
a boost's by its original) that the frame reserved, and the list ends there with its continuation past the stub, so a
walk always advances. A stub's url and acct are within the link bounds (`LINK_URL_JSON_BYTES`, `LINK_ACCT_JSON_BYTES`)
and its time is re-serialized from the date it parses as; a field past them is left out. The stub is measured, and what
it takes past its reservation is charged too. The rest of the list is admitted strictly, never past what remains. Each
admitted reply reserves its parent link's entry at its longest (`PARENT_ENTRY_BYTES`); the links come from one batched
rule check after admission (`parents.ts`), bounded as a stub's, each entry measured and kept only within its
reservation, and what they do not use goes back to the budget. The Posts tab's first page admits the account's pins (at
most `PIN_LIMIT`) strictly before its list: the pins that fit, in pin order, and none after the first that does not; its
list's first item is then admitted or stubbed as above. The hashtag page's frame holds the normalized name itself,
within the bound of the hashtags Kopje lists (`withinTagNameBound`); a longer name is not found.
`test/status-bounds.test.ts` ("keeps the profile feed, the status page and the embed within ANSWER_BYTES") reads them
with every input at its cap. A follow list admits its members (at most `FOLLOWS_PAGE_SIZE`, 40) strictly after the
account, with no stub: the frame, the account and 40 members, each at the account maximum of "Maxima of presented
units", fit `ANSWER_BYTES`, so every page admits its first member and a page cut by bytes continues from its last. The
ceiling is that sum (`test/web-follow-lists.test.ts`, "fit a full page of members at the account maximum beside the
account"); a full page read through the Store RPC, its members at their profile caps but not every column at its bound,
is a measurement beside it. The Featured tab's head is the account and its featured hashtags, at most
`MAX_FEATURED_TAGS` (10, the first by id through `featured_tags_account_id`; a page reads no more rows than
that, whatever an import holds; each count and time read within its bound, RES-2); its endorsed
accounts (at most `ENDORSEMENTS_PAGE_SIZE`, 40) are admitted strictly after them, with no stub, by the same ceiling:
the frame, the account, ten hashtags at their derived maximum and 40 accounts at the account maximum fit `ANSWER_BYTES`
(`test/web-featured-page.test.ts`, "fits ten hashtags and a full page of accounts at their maxima beside the
account").

A report keeps all its statuses; the admin sees those that fit `REPORT_STATUS_BYTES` (2 MiB), the first whatever its
size (a first that uses it up ends them without reading the next), and a page of reports stops at `ADMIN_REPORT_STATUS_BUDGET` statuses, which bounds the statuses it reads. See
`src/domain/reports.ts` (`REPORT_STATUS_BYTES`, `ADMIN_REPORT_STATUS_BUDGET`, `adminReportStream`).

## Notifications

| Operation                                       | Mechanism                                                      | Continuation       |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------ |
| `listNotifications`                             | Budget: whole notifications                                    | Id cursor          |
| `getNotification`                               | Unit (one notification)                                        |                    |
| `listGroupedNotifications`                      | Budget: whole groups with the accounts and statuses they add   | Discovery position |
| `getNotificationGroup`                          | Unit (one group: 8 sample accounts and its status or report)   |                    |
| `notificationGroupAccounts`                     | Budget                                                         | Id cursor          |
| `listNotificationRequests`                      | Budget: whole requests with their sender and last status       | Id cursor          |
| `getNotificationRequest`                        | Unit (one request)                                             |                    |
| `claimPushes`, `confirmPush`                    | Count: 16 pushes, each one notification's title, body and icon |                    |
| Streaming events and catch-up (`stream-hub.ts`) | Unit per event; an event over 512 KiB is skipped whole         |                    |

Grouped notifications admit whole groups in discovery order; for the cut page's range and cursors, readmission (at
most four passes) and `partial_avatars` (partial accounts read from their own columns only), see `src/domain/notification-groups.ts` (`admitGroups`,
`listGroupedNotifications`, `MAX_READMISSIONS`). A group may appear again on the next page with its notifications
below the cursor. Unread counts and markers are not read by admission.

## Accounts

| Operation                                                                 | Mechanism                                | Continuation         |
| ------------------------------------------------------------------------- | ---------------------------------------- | -------------------- |
| `searchAccounts`                                                          | Budget (the resolved account first)      | Offset               |
| `listAccounts` and `listEndorsements` with `limit=0`, `familiarFollowers` | Budget                                   | Id cursor (`max_id`) |
| `getAccounts`                                                             | Count (40 accounts)                      |                      |
| `getAccount`, `lookupAccount`, `verifyCredentials`, `updateCredentials`   | Unit                                     |                      |
| `listAccounts`, `accountEndorsements`, `listEndorsements` (paged)         | Budget                                   | Id cursor            |
| `listFollows`, `listFollowRequests`, `interactors`                        | Budget                                   | Id cursor            |
| `listBlocks`, `listMutes`                                                 | Budget                                   | Id cursor            |
| `directory`                                                               | Budget                                   | Offset               |
| `suggestions` (v1 and v2, at most 40 accounts)                            | Budget                                   | Offset               |
| `adminAccounts`                                                           | Budget: accounts with their admin fields | More                 |
| `adminAccount`, `actOnAdminAccount`, `unsuspendAdminAccount`              | Unit                                     |                      |
| `createReport`                                                            | Unit                                     |                      |

## Instance

The public block list has no count cap; RES-3 bounds its response bytes.

| Operation            | Mechanism                                                                  | Continuation |
| -------------------- | -------------------------------------------------------------------------- | ------------ |
| `publicDomainBlocks` | Budget: whole blocks in domain order, read in chunks of 500 suspend blocks | None         |
| `instanceInfo`       | Unit: the contact account                                                  |              |

## Announcements

| Operation            | Mechanism                                                                                         | Continuation |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------ |
| `listAnnouncements`  | Count: 16 announcements (every published one), admitted within `ARRAY_ANSWER_BYTES` as a backstop | None         |
| `adminAnnouncements` | Count: 50 announcements, each its text and times                                                  | Id cursor    |
| Streaming events     | Unit per event (`announcement`, `announcement.reaction`, `announcement.delete`)                   |              |

The derived announcement maximum keeps all 16 published announcements within the budget; see
[Maxima of presented units](threat-model.md#maxima-of-presented-units-res-3).

## Hashtags

| Operation                                                                            | Mechanism                                                        | Continuation |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------ |
| `followedTags`                                                                       | Count: 200 hashtags (100 by default), each with a list's history | Id cursor    |
| `featuredTagSuggestions`                                                             | Count: 10 hashtags, each with a list's history                   | None         |
| `getTag`, `followTag`, `unfollowTag`, `featureTagOperation`, `unfeatureTagOperation` | Unit: one hashtag with its full history                          |              |

A list's history counts at most the newest 20 public entries per hashtag (`LISTED_HISTORY_ROWS`, MD-5 and the
Hashtags notes in docs/mastodon-deviations.md); v2 search's hashtags carry the same. A listed hashtag is within its
derived maximum, so a full page of 200 is within the budget (`test/tag-history-bounds.test.ts`).

## Trends

| Operation            | Mechanism                                                                        | Continuation                 |
| -------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| `trendingTags`       | Count: 20 hashtags, each with its trends history (200 entries)                   | Offset (`offset + limit`)    |
| `trendingStatuses`   | Budget: up to 40 statuses within `ARRAY_ANSWER_BYTES`, the first always admitted | Offset (`offset + consumed`) |
| `adminTrendTags`     | Count: 20 hashtags                                                               | Offset                       |
| `adminTrendStatuses` | Count: 40 statuses, each field through its bounded projection                    | Offset                       |

Public lists end at the top 200 currently allowed trends (MD-5). Access admin lists page through up to 250 stored
entries per table, allowed or not. Each unit is within its derived maximum (docs/threat-model.md
"Maxima of presented units"; `src/domain/trends.ts`, `test/trends-maxima.test.ts`).

## ActivityPub

These build activities and Notes from local statuses (`statusFacts`, `noteOf` in `src/domain/activities.ts`), not
through the API presenters. A local status's columns are within the bounds a local post takes and, for a converted
one, those the cutover's conversion applies (content and source within `STATUS_CONTENT_BYTES`).

| Operation                    | Mechanism                                                                                                                             | Continuation                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `localNote` (`getLocalNote`) | Unit: one Note                                                                                                                        |                                                                 |
| `outbox` (`getOutbox`)       | Bytes: at most 20 activities within `OUTBOX_BYTES` (`ANSWER_BYTES` less 64 KiB for the page around them), the first whatever its size | Id cursor: a page cut by bytes continues from its last activity |
| `featured` (`getFeatured`)   | Bytes: at most `PIN_LIMIT` (5) pins, their Notes within `OUTBOX_BYTES`, the first whatever its size; the pins past them by uri        | None                                                            |
| `collection`                 | Count: 40 actor URIs a page                                                                                                           | Page number                                                     |
| Create bodies                | Unit: one Note in each signed delivery body, sent whole                                                                               |                                                                 |
