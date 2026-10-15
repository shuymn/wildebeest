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

| Fragment                                                                   | Rule                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `availableSql(x)`, `availableLocalSql(l)`                                  | R1: the account is not a suspended local account. The second form takes a `local_accounts` row already joined.                                                                                        |
| `blocksSql(owner, x)`, `domainBlocksSql(owner, x)`, `blockedSql(owner, x)` | `owner` blocks `x`, blocks its domain, or either.                                                                                                                                                     |
| `inDomainSql(a, domain)`                                                   | The account row `a` lives on `domain`: its stored domain or the host of its actor id, exactly.                                                                                                        |
| `filteredForSql(x, viewer, now)`                                           | R7: the viewer blocks `x`, mutes it while the mute applies, or blocks its domain. Nobody filters themselves; an anonymous viewer filters nothing.                                                     |
| `listedForSql(x, viewer, now)`                                             | R12: `x` may be listed among others (who favourited or boosted): available, not filtered, and not blocking the viewer.                                                                                |
| `followListsShownSql(owner, viewer)`                                       | R13: the viewer is shown the owner's followers and following: the owner is available and, unless the viewer is the owner, neither hides its network (`hide_collections`) nor blocks the viewer.       |
| `followListedSql(x, owner, viewer, now)`                                   | R13: `x` is listed among the owner's followers or following: to an anonymous viewer and the owner, always; to anyone else, unless they block or mute `x` (while the mute applies) or `x` blocks them. |
| `findableBySql(x, viewer)`                                                 | R14: the viewer finds `x` by account search or search resolution: available, and not on a domain the viewer blocks.                                                                                   |
| `mentionableBySql(x, author)`                                              | R17: the author may mention or address `x`: available, and the author blocks neither it nor its domain.                                                                                               |
| `followableBySql(x, viewer)`                                               | R21: the viewer may follow `x`: available, someone else, no block either way, no domain block by the viewer.                                                                                          |

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

| Rule                      | Where it is applied                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 available              | `availableSql` in every status and account rule below; the object endpoint, outbox, followers and following collections and web pages (`availableLocalSql`); user counts.                                                                                                                                                                                                                                                          |
| R2, R3 show and view      | `visibleSql`, `viewableSql`, `canView`: single status, history, write responses, replies, favourites and boosts, inbound `Like`, search resolution (with `domainBlocksSql` of the author), web pages.                                                                                                                                                                                                                              |
| R4 servable               | `SERVABLE` in `activities.ts` (`DISTRIBUTABLE_SQL` and `availableLocalSql`); web pages use `visibleSql` with no viewer.                                                                                                                                                                                                                                                                                                            |
| R5 source                 | The author only (`statusSource`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| R6 history                | `canView`, with the audience frozen at write time (`editStatus`).                                                                                                                                                                                                                                                                                                                                                                  |
| R7 filtered               | `filteredForSql`, inside `listableSql`, account statuses (boosted originals), familiar followers.                                                                                                                                                                                                                                                                                                                                  |
| R8 listable               | `listableSql`: public, tag, bookmarks, favourites, context, status and hashtag search.                                                                                                                                                                                                                                                                                                                                             |
| R9 home                   | `homeFilterSql` in `homeTimeline`, with its membership and the follow's options.                                                                                                                                                                                                                                                                                                                                                   |
| R10 public and tag feeds  | `publicConditions` in `timelines.ts` on `listableSql`; the tag feed and a tag's history take their candidates from the hashtags of public statuses (`status_tags.public`, written with `tagPublicSql`).                                                                                                                                                                                                                            |
| R11 account statuses      | `visibleSql`, `blocksSql` (the viewer blocks the account), and `visibleSql` with `filteredForSql` for a boosted original.                                                                                                                                                                                                                                                                                                          |
| R12 listed accounts       | `listedForSql` in `favourited_by` and `reblogged_by` (`DISTRIBUTABLE_SQL` boosts only).                                                                                                                                                                                                                                                                                                                                            |
| R13 follower lists        | `followListsShownSql` and `followListedSql` in `listFollows` (`GET /api/v1/accounts/:id/followers` and `/following`); `hidesCollectionsSql` in familiar followers (none for an account that hides its network, whoever asks; no follower that hides its own); `followListsShownSql` with no viewer in the ActivityPub followers and following collections: a hidden network shows `totalItems` only, and a page of it answers 403. |
| R14 account search        | `findableBySql` in `findAccounts` and for an account answered by search resolution. Mastodon's account search leaves out suspended accounts only; Kopje also leaves out those on a domain the viewer blocks.                                                                                                                                                                                                                       |
| R15 notifications         | `shownSql` in `notify`, `listNotifications`, `getNotification` and the push target.                                                                                                                                                                                                                                                                                                                                                |
| R16 push                  | `shownSql` and `pushWantedSql` at record, claim and confirm time.                                                                                                                                                                                                                                                                                                                                                                  |
| R17 mentionable           | `mentionableBySql` in `resolveMentions`; an edit drops mentions the author now blocks (`blockedSql`).                                                                                                                                                                                                                                                                                                                              |
| R18 reblog, R19 favourite | `canView` and `blocksAuthor` (`blocksSql`) in `statuses.ts`.                                                                                                                                                                                                                                                                                                                                                                       |
| R20 reply                 | `canView` of the parent.                                                                                                                                                                                                                                                                                                                                                                                                           |
| R21 follow                | `followableBySql` for a local follow and for each follower a `Move` carries; an inbound `Follow` is ignored when the actor blocks the target (`blocksSql`) and rejected when the target blocks it or its domain (`blockedSql`).                                                                                                                                                                                                    |
| R22 addressing            | `addressingOf` and `boostAnnounce` (`blockedSql`).                                                                                                                                                                                                                                                                                                                                                                                 |
| R23 delivery targets      | `audienceTargets` in `deliveries.ts`: `domainBlocksSql` on followers, `blockedSql` on addressed accounts for content.                                                                                                                                                                                                                                                                                                              |

## Status ids the presenter accepts

The status presenter (`src/domain/status-presenter.ts`) turns ids into Mastodon `Status` entities for every read path
and write response. It takes only ids the policy module made, as TypeScript brands (types only, nothing at run time):

| Type                       | Made by                                                            | Meaning                                                                |
| -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `VisibleStatusId`          | `statusReads(viewer, at)` (`select`, `union`), `viewableStatusId`  | The read rule passed this status for the viewer.                       |
| `OwnStatusId`              | `ownStatusId(db, author, id)`                                      | The status is the viewer's own (R2: the author sees all of their own). |
| `WithVisibleStatus<Row,K>` | `statusReads(viewer, at).notifications` (and the rows of `select`) | Rows whose column `K` holds `VisibleStatusId`s (or null).              |

`statusReads(viewer, { viewer: '?1', now: '?5' })` writes a viewer's status queries itself, so the rule cannot be left
out of one and nothing is parsed at run time. A caller gives the parts of each SELECT; the reader writes the rest:

```sql
SELECT s.id AS id [, <expression> AS <column> ...] FROM <from> main.statuses s <join>
WHERE (<where>) AND (<rule over s>) AND (<and>) <tail>
```

- `select(db, rule, parts)` runs one such SELECT, after an optional `WITH` clause its joins and conditions may read,
  with further columns after the id. `rule` is `visible` (R2), `listable` (R8) or `homeFilter` (R9).
- `union(db, rule, { all, branches, tail })` combines several, each with the same rule and selecting the id alone:
  `SELECT id FROM (SELECT * FROM (<branch>) UNION [ALL] ...) <tail>`.
- `notifications(db, parts)` selects `n.status_id` and further columns from `notifications n`, with `shownSql` (R15,
  the viewer as the recipient, which shows a status only if they may view it) as the rule.

The rule is a conjunct of the SELECT's own WHERE, over the `statuses s` whose id it selects, so no condition, subquery,
join or `WITH` table of the caller's can stand in for it. The reader and the fragments name their tables with the
`main.` schema, so a `WITH` table named `statuses` or `blocks` cannot take their place, and a further column is a plain
identifier other than the id column (`id`, or `status_id` for notifications), refused by the types and at run time.
The caller's conditions go before (`where`) or after (`and`) it, in the order a hand-written query would give them, so
the terms, the plan and the rows read are the same. Each query runs only with its parameters at `viewer` and `now`
bound to the context's account id and time. `viewableStatusId` is `canView` (R3) for one id. `ownStatusId` checks the
author. The callers:

| Caller                                                     | Ids from                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| home                                                       | `union` of its three membership branches under `homeFilter`                      |
| public feed, bookmarks and favourites, context             | `select` under `listable`; the tag feed a `union` of its names under it          |
| account statuses                                           | `select` under `visible`, with `visibleSql` and `filteredForSql` for an original |
| status search                                              | `select` under `listable`, with its candidates as a `WITH` table                 |
| notifications (list and one)                               | `notifications`                                                                  |
| web profile and status pages                               | `select` under `visible` with no viewer; the parent through `viewableStatusId`   |
| single status, history, actions (favourite, bookmark, ...) | `viewableStatusId`                                                               |
| search resolution                                          | `viewableStatusId`, after the domain block of the author                         |
| post, edit, delete, boost (and their repeats)              | `ownStatusId`, then `presentOwnStatus`                                           |

The presenter reads a boost's original through `visibleSql` for the same viewer, whatever brand the boost's id has: a
`VisibleStatusId` boost whose original the viewer may not see is left out (R3), and an `OwnStatusId` boost is shown
with `reblog: null`, as the response to deleting a boost of an original the viewer may no longer see. Only
`presentOwnStatus` takes `source` (the source text a delete answers with).

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

An allowed file that no longer matches fails the test too, so the list does not outlive its reason.

It also keeps the status id brands with the policy module. Elsewhere, `VisibleStatusId`, `OwnStatusId` and
`WithVisibleStatus` may be named only in an import or as the type of a function parameter: a cast, a type argument
(`db.all<{ id: VisibleStatusId }>`), a type predicate, an alias or an annotated variable or result could make one from
a plain string. The presenter is called only from `src/domain/`, where ESLint refuses an `any` argument
(`eslint.config.js`), so no `any` reaches its parameters. The test also checks the generated visibility sets and that
`REACHES_FOLLOWERS_SQL` is the list of the `statuses_feed` index.

The fragments nest: Cloudflare's SQLite refuses an expression deeper than 100 levels, and each nested `EXISTS` and
each term of an `AND` chain adds to it. The deepest fragment, `shownSql`, compiles at a depth of about 76; keep the
deepest terms last in a chain and prefer `JOIN ... ON` to `WHERE` for a lookup inside a subquery.

## The oracle and the bounds harness

`test/policy-oracle.test.ts` checks each fragment against a second statement of its rule. `test/policy-model.ts` states
the rules of this page in plain TypeScript, without importing the module. `test/policy-world.ts` generates worlds with
[fast-check](https://fast-check.dev/): four local accounts (one of them may be suspended, some may hide their network),
two or three remote accounts on two domains (some with an actor id on a subdomain, with a port, with a trailing dot or
on the other domain), up to 22 statuses of every visibility with mentions (some silent), boosts, replies and replies
that continue the author's own thread (written with the conversation partner `statuses.ts` carries over), accepted and
pending follows, blocks both ways, mutes that have expired, expire at the time of the read or later, or never, with or
without notifications, and domain blocks in their stored form, including the instance's own domain and a domain nobody
lives on. Each property writes a world into one Store and evaluates its fragment over every pair the rule takes: every
viewer (each account and the anonymous one) with every account or status (for the list rules, `listableSql` and
`homeFilterSql`, the viewers their callers judge: each local account and the anonymous one), every owner with every
account, for `followListedSql` every viewer with every owner and account, and, for `shownSql`, every local recipient
with every notification type, sender and status (or none). The set of pairs it accepts must equal the model's. A failure
prints the shrunk world, the pairs only one side accepts, and the seed; `FC_SEED=<seed> pnpm vitest run
test/policy-oracle.test.ts` replays it.

`test/policy-bounds.test.ts` takes one generated world, for a fixed seed, in which every endpoint below shows the viewer
something. It runs home, the public and tag feeds, account statuses, notifications, context, favourites, bookmarks,
`favourited_by`, `reblogged_by`, relationships, the followers and following of an account (one that no unrelated account
follows), status and hashtag search, and account search among the viewer's follows (a search of every account reads the
newest accounts the instance knows, a window that grows with them up to its limit) on that world alone, and again with
1,000 unrelated remote accounts and 100 unrelated local ones: their statuses (never public, though they carry the
hashtag the tag feed reads), replies and boosts, their follows, blocks, mutes and domain blocks of the world's accounts
and domains, and their favourites, bookmarks and notifications, together with the viewer's own blocks and mutes of those
accounts and domain blocks of domains nobody lives on. Each endpoint must show the same with them as without (the same
statuses, accounts, notifications and hashtags in the same order, and the same relationship flags), and the rows it
reads (RES-7) may grow by at most 10.

`test/policy-endpoints.test.ts` runs the read endpoints themselves on generated worlds, with favourites, bookmarks and
notifications added, for each available local viewer and, where the endpoint answers without a token, the anonymous
one. No endpoint may show a status or an account the model does not allow the viewer by the endpoint's rule, and a
boost must come with its own original (never `reblog: null` on a read), which the viewer may see:

| Endpoint                                                   | Asserted                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| public feed, tag feed, account statuses (of every account) | exactly the model's members the rule allows (R10, R11), newest first, over pages of 3                                                                           |
| favourites, bookmarks                                      | exactly the viewer's edges the list rule allows (R8), newest edge first, over pages                                                                             |
| home                                                       | no status home hides (R9)                                                                                                                                       |
| single status, context                                     | nothing for a status the viewer may not view (R3); context members listable (R8)                                                                                |
| `favourited_by`, `reblogged_by`                            | nothing for a status the viewer may not view; only listed interactors (R12)                                                                                     |
| status search                                              | listable statuses only (R8)                                                                                                                                     |
| notifications                                              | only the viewer's, as written, that the rule shows (R15), with statuses they may view                                                                           |
| followers, following (of every account)                    | exactly the accepted follows the list rule shows (R13), newest first, over pages of 3                                                                           |
| account search                                             | exactly the accounts the viewer may find (R14)                                                                                                                  |
| search resolution (of every stored account and status)     | an account exactly when account search finds it (R14); a status exactly when the single-status read shows it (R3), unless the viewer blocks its author's domain |

Each endpoint must show something in some case, so a property cannot pass by showing nothing.
