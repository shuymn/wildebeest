# Response inventory

Every Store operation that returns presented statuses, accounts or notifications, with what bounds its answer
(RES-3 in `threat-model.md`). The owner of an answer's budget is the operation itself: the Worker serializes what the
operation returns and adds nothing to it.

Mechanisms:

- **Budget**: the answer's JSON is at most `ANSWER_BYTES` (8 MiB, `src/domain/answer-budget.ts`), containers
  included. Items are admitted whole in traversal order, each presented and measured when it is reached, its rows read
  in small chunks (2 statuses), the first whatever its size (`admit`, `presentStatusesWithin`, `presentAccountsWithin`).
- **Unit**: one presented unit, at most its maximum ("Maxima of presented units" in `threat-model.md`).
- **Count**: a fixed number of units whose maxima together stay within `ANSWER_BYTES`.
- **Count only**: bounded by a count of units, not by bytes. These are the answers RB2 budgets.

Continuations:

- **Id cursor**: a page cut by the budget is `Page.cut` and continues from its last admitted item in traversal order
  (`admittedPage`): newest first for `max_id` and `since_id`, oldest first for `min_id`. A candidate-window
  continuation (`docs/visibility.md`, "Read bounds") is kept only when no item was left out by bytes before it.
- **Offset**: the answer holds fewer results. A client that advances its offset by the number received (Tusky,
  Ivory) continues after them. Mastodon's web client takes a short answer for the last one and shows no more. This
  happens only past 8 MiB, which realistic content does not reach.
- **None**: the answer has no paging; what is left out is a Kopje bound.

The exemption column names the module whose import of a raw presenter (`presentStatuses`, `presentAccountsById`,
`presentAccount`) the source guard allows until the answer is budgeted (`test-node/raw-presenters.test.ts` checks the
two lists agree).

## Statuses

| Operation                                                                   | Mechanism                                                                     | Continuation | PR   | Exemption                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------ | ---- | ----------------------------- |
| `homeTimeline`, `listTimeline`, `publicTimeline`, `tagTimeline`             | Budget                                                                        | Id cursor    | RB1b |                               |
| `accountStatuses`, `bookmarksList`, `favouritesList`                        | Budget                                                                        | Id cursor    | RB1b |                               |
| `accountStatuses` with `pinned=true`                                        | Budget: the pins that fit, in pin order                                       | None         | RB1b |                               |
| `statusQuotes`                                                              | Budget                                                                        | Id cursor    | RB1b |                               |
| `statusContext`                                                             | Budget: ancestors on half, nearest first; descendants on the rest, in order   | None         | RB1b |                               |
| `statusHistory`                                                             | Budget: newest revisions first, returned oldest first                         | None         | RB1b |                               |
| `getStatuses`                                                               | Budget: the ids past the first that does not fit are left out as unknown ones | None         | RB1b |                               |
| `search`                                                                    | Budget over accounts (the resolved account first), statuses and hashtags      | Offset       | RB1b |                               |
| `profilePage`                                                               | Budget shared by the account and its statuses                                 | Id cursor    | RB1b |                               |
| `statusPage`, `embeddedStatus`, `resolveSearch`                             | Unit                                                                          |              | RB1b |                               |
| `getStatus`, `createStatus`, `postStatus`, `editStatus`, `deleteStatus`     | Unit                                                                          |              | RB1a |                               |
| `favourite`, `unfavourite`, `reblog`, `unreblog`, `bookmark`, `unbookmark`  | Unit                                                                          |              | RB1a |                               |
| `pin`, `unpin`, `muteConversation`, `unmuteConversation`, `getPoll`, `vote` | Unit                                                                          |              | RB1a |                               |
| `listConversations`                                                         | Count only (a page; 12 participants each)                                     | Id cursor    | RB2  | `src/domain/conversations.ts` |
| `adminReports`, `adminReport`, `updateAdminReport`, `actOnReport`           | Count only (a report's statuses)                                              | Id cursor    | RB2  | `src/domain/reports.ts`       |

## Notifications

| Operation                                                                       | Mechanism                                    | Continuation | PR  | Exemption                             |
| ------------------------------------------------------------------------------- | -------------------------------------------- | ------------ | --- | ------------------------------------- |
| `listNotifications`, `getNotification`                                          | Count only                                   | Id cursor    | RB2 | `src/domain/notifications.ts`         |
| `listGroupedNotifications`, `getNotificationGroup`, `notificationGroupAccounts` | Count only (8 sample accounts)               | Id cursor    | RB2 | `src/domain/notification-groups.ts`   |
| `listNotificationRequests`, `getNotificationRequest`                            | Count only                                   | Id cursor    | RB2 | `src/domain/notification-requests.ts` |
| `claimPushes`                                                                   | Unit (one notification)                      |              | RB2 |                                       |
| Streaming events and catch-up (`stream-hub.ts`)                                 | Unit; an event over 512 KiB is skipped whole |              | RB2 |                                       |

## Accounts

| Operation                                                                     | Mechanism                                     | Continuation         | PR    | Exemption                      |
| ----------------------------------------------------------------------------- | --------------------------------------------- | -------------------- | ----- | ------------------------------ |
| `searchAccounts`                                                              | Budget                                        | Offset               | RB1b  |                                |
| `listAccounts` and `listEndorsements` with `limit=0`, `familiarFollowers`     | Budget                                        | Id cursor (`max_id`) | #1114 |                                |
| `getAccounts`                                                                 | Count (40 accounts)                           |                      | #1114 |                                |
| `getAccount`, `lookupAccount`, `verifyCredentials`, `updateCredentials`       | Unit                                          |                      | #1114 |                                |
| `accountEndorsements`, `listFollows`, `listFollowRequests`, `interactors`     | Count only (80 accounts)                      | Id cursor            | RB2   |                                |
| `listBlocks`, `listMutes`                                                     | Count only (80 accounts)                      | Id cursor            | RB2   | `src/domain/blocks.ts`         |
| `directory`                                                                   | Count only (80 accounts)                      | Offset               | RB2   | `src/domain/directory.ts`      |
| `adminAccounts`, `adminAccount`, `actOnAdminAccount`, `unsuspendAdminAccount` | Count only (accounts with their admin fields) | Id cursor            | RB2   | `src/domain/admin-accounts.ts` |
| `createReport`                                                                | Unit                                          |                      | RB2   |                                |

The status presenter itself (`src/domain/status-presenter.ts`) imports `presentAccountsById` to hydrate the accounts
of the ids it is given: a page for `presentStatuses` until RB2 removes it, then one chunk.

## ActivityPub

`localNote`, `outbox`, `featured` and `collection` build Notes from local statuses (`statusFacts`, `noteOf`), not
through the API presenters. RB2 inventories them and counts the Note bytes of outbox pages.
