# Visibility and audience

Who may see a status or an account, what a viewer filters out, who is notified and whom an author may address are
decided in one module: `src/domain/audience.ts`. It is plain SQL fragments, spliced into the queries that read and
write. No read path, notification path or delivery path keeps its own copy of a rule. The threat model states the
invariants (VIS-1 to VIS-15, NET-2, PUSH-3); this page describes how the code applies them.

## The viewer context

`ViewerContext { accountId: string | null; now: string }` is the viewer and the time a read is judged at. `accountId`
is null for an anonymous viewer or an app token. `now` is the request time as an ISO 8601 UTC string, the form
`mutes.expires_at` is stored in. Only the auth wrappers in `src/domain/auth.ts` build one:

- `userReadOperation`, `userWriteOperation` and the other guarded wrappers pass it to the operation after the
  credential is checked, in the same transaction;
- `optionalUserReadOperation` passes it for routes whose token is optional. The time is the credential's, or the
  request time in the input when the request has no token.

An operation binds the context's fields as parameters of its query and passes their placeholders to the fragments.
Every fragment that depends on the viewer's choices takes the viewer and the time together, so a rule that depends on
time (a mute's expiry) cannot be applied without it.

## The predicates

Fragments take SQL expressions: `x` is an account id, `s` the alias of a `statuses` row, `viewer` the viewer's
account id (NULL for anonymous) and `now` the context's time.

Accounts (always over an account id, never over a status or a follow row):

| Fragment                                                                   | Rule                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `availableSql(x)`, `availableLocalSql(l)`                                  | R1: the account is not a suspended local account. The second form takes a `local_accounts` row already joined.                                    |
| `blocksSql(owner, x)`, `domainBlocksSql(owner, x)`, `blockedSql(owner, x)` | `owner` blocks `x`, blocks its domain, or either.                                                                                                 |
| `inDomainSql(a, domain)`                                                   | The account row `a` lives on `domain`: its stored domain or the host of its actor id, exactly.                                                    |
| `filteredForSql(x, viewer, now)`                                           | R7: the viewer blocks `x`, mutes it while the mute applies, or blocks its domain. Nobody filters themselves; an anonymous viewer filters nothing. |
| `listedForSql(x, viewer, now)`                                             | R12: `x` may be listed among others (who favourited or boosted): available, not filtered, and not blocking the viewer.                            |
| `mentionableBySql(x, author)`                                              | R17: the author may mention or address `x`: available, and the author blocks neither it nor its domain.                                           |
| `followableBySql(x, viewer)`                                               | R21: the viewer may follow `x`: available, someone else, no block either way, no domain block by the viewer.                                      |

Statuses:

| Fragment                                           | Rule                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visibleSql(s, viewer)`, `canView(db, viewer, id)` | R2 (`StatusPolicy#show?`): an available author; the author sees all of their own; an author who blocks the viewer hides everything from them; public and unlisted are seen by everyone else, private by accepted followers and the mentioned, direct and limited by the mentioned only (silent mentions included). It has no time.          |
| `viewableSql(s, viewer)`                           | R3: visible, and so is a reblogged original.                                                                                                                                                                                                                                                                                                |
| `listableSql(s, viewer, now)`                      | R8 (`StatusFilter`): viewable, and the viewer filters neither the author nor a reblogged original's author. Feeds, context, bookmarks, favourites and search.                                                                                                                                                                               |
| `homeFilterSql(s, viewer, now)`                    | R9, what home hides for the viewer's choices (`FeedManager#filter_from_home`): what the list rule hides, and a status or boosted original that mentions (not silently) an account the viewer blocks or mutes. The viewer's own statuses pass. Home membership and the follow's options (boosts, replies, languages) stay in the home query. |

Notifications: `shownSql(r, type, from, status, now)` is R15, one rule for writing (`notify`), listing and reading
notifications, and for sending their pushes (`domain/push.ts`, judged again at the time of sending). The sender is not
the recipient, is available, is neither blocked (either way), muted with notifications nor domain-blocked by the
recipient, and the recipient may see the status. A reblog notification also needs the sender's boost to be visible to
the recipient. A mention is left out when its status mentions or replies to an account the recipient blocks or mutes
with notifications. A post notification (`status`) is shown only when `homeFilterSql` passes for its status, as
Mastodon's `FeedInsertWorker` notifies only of what home shows: so a sender the recipient mutes, with or without
notifications, sends none.

Visibility sets are generated from `isDistributable` and `requiresMention`: `DISTRIBUTABLE_SQL` (public, unlisted),
`REQUIRES_MENTION_SQL` (direct, limited) and `REACHES_FOLLOWERS_SQL` (public, unlisted, private, the list of the
partial index `statuses_feed`, which SQLite uses only for the same list). SQL elsewhere writes `visibility IN
${DISTRIBUTABLE_SQL}`, never the literals.

## The rules as the module implements them

| Rule                      | Where it is applied                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 available              | `availableSql` in every status and account rule below; the object endpoint, outbox and web pages (`availableLocalSql`); user counts.                                                                                            |
| R2, R3 show and view      | `visibleSql`, `viewableSql`, `canView`: single status, history, write responses, replies, favourites and boosts, inbound `Like`, search resolution, web pages.                                                                  |
| R4 servable               | `SERVABLE` in `activities.ts` (`DISTRIBUTABLE_SQL` and `availableLocalSql`); web pages use `visibleSql` with no viewer.                                                                                                         |
| R5 source                 | The author only (`statusSource`).                                                                                                                                                                                               |
| R6 history                | `canView`, with the audience frozen at write time (`editStatus`).                                                                                                                                                               |
| R7 filtered               | `filteredForSql`, inside `listableSql`, account statuses (boosted originals), familiar followers.                                                                                                                               |
| R8 listable               | `listableSql`: public, tag, bookmarks, favourites, context, status and hashtag search.                                                                                                                                          |
| R9 home                   | `homeFilterSql` in `homeTimeline`, with its membership and the follow's options.                                                                                                                                                |
| R10 public and tag feeds  | `publicConditions` in `timelines.ts` on `listableSql`.                                                                                                                                                                          |
| R11 account statuses      | `visibleSql`, `blocksSql` (the viewer blocks the account), and `visibleSql` with `filteredForSql` for a boosted original.                                                                                                       |
| R12 listed accounts       | `listedForSql` in `favourited_by` and `reblogged_by` (`DISTRIBUTABLE_SQL` boosts only).                                                                                                                                         |
| R14 account search        | `availableLocalSql` and `domainBlocksSql` in `findAccounts`; search resolution answers no account or status on a domain the viewer blocks.                                                                                      |
| R15 notifications         | `shownSql` in `notify`, `listNotifications`, `getNotification` and the push target.                                                                                                                                             |
| R16 push                  | `shownSql` and `pushWantedSql` at record, claim and confirm time.                                                                                                                                                               |
| R17 mentionable           | `mentionableBySql` in `resolveMentions`; an edit drops mentions the author now blocks (`blockedSql`).                                                                                                                           |
| R18 reblog, R19 favourite | `canView` and `blocksAuthor` (`blocksSql`) in `statuses.ts`.                                                                                                                                                                    |
| R20 reply                 | `canView` of the parent.                                                                                                                                                                                                        |
| R21 follow                | `followableBySql` for a local follow and for each follower a `Move` carries; an inbound `Follow` is ignored when the actor blocks the target (`blocksSql`) and rejected when the target blocks it or its domain (`blockedSql`). |
| R22 addressing            | `addressingOf` and `boostAnnounce` (`blockedSql`).                                                                                                                                                                              |
| R23 delivery targets      | `audienceTargets` in `deliveries.ts`: `domainBlocksSql` on followers, `blockedSql` on addressed accounts for content.                                                                                                           |

A domain block is stored normalized (lowercase, punycode, no trailing dot: `blockedDomain` in
`src/platform/domain-name.ts`, used by the API and by the cutover converter) and compared as it is with the account's
normalized domain and actor host, so each check is two seeks of the `(account_id, domain)` index, however many domains
the viewer blocks. A Store converted by an earlier release may hold a block with a trailing dot; migration
`0003_domain_block_form` removes it, merging a row that then repeats a block of the same account.

## The architecture test

`test/policy.test.ts` reads the source tree (as `test/layering.test.ts` does) and fails when SQL outside the policy
module:

- reads `blocks`, `mutes` or `domain_blocks` (`FROM` or `JOIN`), except in the modules that write them, each listed
  with its reason: `blocks.ts` (blocks, mutes, domain blocks and their cleanups) and `inbox.ts` (an inbound `Block`
  and its `Undo`, the expired mute sweep, a `Move` carrying blocks and mutes, an actor purge);
- judges suspension (`suspended_at IS [NOT] NULL`) or spells a set of visibilities (`IN ('public', ...`);
- inserts into `notifications` outside `notifications.ts`, or into `outbound_activities` or `deliveries` outside
  `deliveries.ts`;
- inserts into `status_mentions` outside its listed writers: `statuses.ts`, `remote-statuses.ts` and `inbox.ts`.

An allowed file that no longer matches fails the test too, so the list does not outlive its reason. The test also
checks the generated visibility sets and that `REACHES_FOLLOWERS_SQL` is the list of the `statuses_feed` index.

The fragments nest: Cloudflare's SQLite refuses an expression deeper than 100 levels, and each nested `EXISTS` and
each term of an `AND` chain adds to it. The deepest fragment, `shownSql`, compiles at a depth of about 76; keep the
deepest terms last in a chain and prefer `JOIN ... ON` to `WHERE` for a lookup inside a subquery.
