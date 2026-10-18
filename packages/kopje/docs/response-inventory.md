# Response inventory

Every Store operation that returns presented statuses, accounts or notifications, with what bounds its answer
(RES-3 in `threat-model.md`). The owner of an answer's budget is the operation itself: the Worker serializes what the
operation returns and adds nothing to it.

Mechanisms:

- **Budget**: the answer's JSON is at most `ANSWER_BYTES` (8 MiB, `src/domain/answer-budget.ts`), containers
  included. Items are admitted whole in traversal order, each presented and measured when it is reached, its rows read
  in small chunks (2 statuses, 2 notifications, one conversation or report, 50 accounts), the first whatever its size
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

The raw presenters (`present` and `hydrate` in status-presenter.ts, `presentAccountsById` and `presentAccount` in
accounts.ts) are not exported, so no operation uses them directly; the exported paths present one unit or admit within
a budget.

## Statuses

| Operation                                                                   | Mechanism                                                                     | Continuation | PR   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ | ---- |
| `homeTimeline`, `listTimeline`, `publicTimeline`, `tagTimeline`             | Budget                                                                        | Id cursor    | RB1b |
| `accountStatuses`, `bookmarksList`, `favouritesList`                        | Budget                                                                        | Id cursor    | RB1b |
| `accountStatuses` with `pinned=true`                                        | Budget: the pins that fit, in pin order                                       | None         | RB1b |
| `statusQuotes`                                                              | Budget                                                                        | Id cursor    | RB1b |
| `statusContext`                                                             | Budget: ancestors on half, nearest first; descendants on the rest, in order   | None         | RB1b |
| `statusHistory`                                                             | Budget: newest revisions first, returned oldest first                         | None         | RB1b |
| `getStatuses`                                                               | Budget: the ids past the first that does not fit are left out as unknown ones | None         | RB1b |
| `search`                                                                    | Budget over accounts (the resolved account first), statuses and hashtags      | Offset       | RB1b |
| `profilePage`                                                               | Budget shared by the account and its statuses                                 | Id cursor    | RB1b |
| `statusPage`, `embeddedStatus`, `resolveSearch`                             | Unit                                                                          |              | RB1b |
| `getStatus`, `createStatus`, `postStatus`, `editStatus`, `deleteStatus`     | Unit                                                                          |              | RB1a |
| `favourite`, `unfavourite`, `reblog`, `unreblog`, `bookmark`, `unbookmark`  | Unit                                                                          |              | RB1a |
| `pin`, `unpin`, `muteConversation`, `unmuteConversation`, `getPoll`, `vote` | Unit                                                                          |              | RB1a |
| `listConversations`                                                         | Budget: whole conversations (12 participants each, cut in SQL)                | Id cursor    | RB2  |
| `markConversation`                                                          | Unit (one conversation)                                                       |              | RB2  |
| `adminReports`                                                              | Budget: whole reports; a report's statuses as below                           | More         | RB2  |
| `adminReport`, `updateAdminReport`, `actOnReport`                           | Unit: a report's statuses in its order within 2 MiB, the first always         |              | RB2  |

A report's statuses are admitted in the order the report shows them while their JSON fits `REPORT_STATUS_BYTES`
(2 MiB, `src/domain/reports.ts`), the first whatever its size; a first status that uses up the allowance ends them
without reading the next. The admin then sees a projection of the report: fewer
statuses than it holds when they pass the allowance; the report itself keeps them all. A page of reports also stops
at `ADMIN_REPORT_STATUS_BUDGET` statuses, which bounds the statuses it reads.

## Notifications

| Operation                                       | Mechanism                                                      | Continuation       | PR  |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------ | --- |
| `listNotifications`                             | Budget: whole notifications                                    | Id cursor          | RB2 |
| `getNotification`                               | Unit (one notification)                                        |                    | RB2 |
| `listGroupedNotifications`                      | Budget: whole groups with the accounts and statuses they add   | Discovery position | RB2 |
| `getNotificationGroup`                          | Unit (one group: 8 sample accounts and its status or report)   |                    | RB2 |
| `notificationGroupAccounts`                     | Budget                                                         | Id cursor          | RB2 |
| `listNotificationRequests`                      | Budget: whole requests with their sender and last status       | Id cursor          | RB2 |
| `getNotificationRequest`                        | Unit (one request)                                             |                    | RB2 |
| `claimPushes`, `confirmPush`                    | Count: 16 pushes, each one notification's title, body and icon |                    | RB2 |
| Streaming events and catch-up (`stream-hub.ts`) | Unit per event; an event over 512 KiB is skipped whole         |                    | RB2 |

Grouped notifications walk the notifications as before (`GROUP_WALK`), then admit the groups in the order the walk
found them, each counting what it adds to the answer: its entity, its status unless an admitted group shows it, and
its sample accounts unless shown (with `partial_avatars`, the first sample as an account, which moves an account
shown as partial to the accounts, and the others as partial accounts read from their own columns only). Cut by
bytes, the page is the admitted groups as if the walk had found those alone: its range, which `membersOf` and the
`page_min_id` and `page_max_id` fields read, and its `next` and `prev` cursors are those of the groups kept, and a
walk's continuation past a group left out is dropped. The kept groups are admitted again over that range, since
sampling below a lower upper end can show larger accounts, and the last are dropped the same way: at most four passes
in all, the first, two more over the kept groups, and then the first group alone, over its own range. A
group may appear again on the next page with its notifications below the cursor. Unread counts and markers are not
read by admission.

## Accounts

| Operation                                                                 | Mechanism                                | Continuation         | PR    |
| ------------------------------------------------------------------------- | ---------------------------------------- | -------------------- | ----- |
| `searchAccounts`                                                          | Budget                                   | Offset               | RB1b  |
| `listAccounts` and `listEndorsements` with `limit=0`, `familiarFollowers` | Budget                                   | Id cursor (`max_id`) | #1114 |
| `getAccounts`                                                             | Count (40 accounts)                      |                      | #1114 |
| `getAccount`, `lookupAccount`, `verifyCredentials`, `updateCredentials`   | Unit                                     |                      | #1114 |
| `listAccounts`, `accountEndorsements`, `listEndorsements` (paged)         | Budget                                   | Id cursor            | RB2   |
| `listFollows`, `listFollowRequests`, `interactors`                        | Budget                                   | Id cursor            | RB2   |
| `listBlocks`, `listMutes`                                                 | Budget                                   | Id cursor            | RB2   |
| `directory`                                                               | Budget                                   | Offset               | RB2   |
| `adminAccounts`                                                           | Budget: accounts with their admin fields | More                 | RB2   |
| `adminAccount`, `actOnAdminAccount`, `unsuspendAdminAccount`              | Unit                                     |                      | RB2   |
| `createReport`                                                            | Unit                                     |                      | RB2   |

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
