# Visibility and audience

Who may see a status or an account, what a viewer filters out, who is notified and whom an author may address are
decided in one module: `src/domain/audience.ts`. It is plain SQL fragments, spliced into the queries that read and
write. No read path, notification path or delivery path keeps its own copy of a rule. The threat model states the
invariants (VIS-1 to VIS-16, NET-2, PUSH-3); this page describes how the code applies them.

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
| `availableSql(x)`, `availableLocalSql(l)`                                  | R1: the account is not a suspended local account, nor a remote account whose deletion has started. The second form takes the `local_accounts` row of a local account already joined.                  |
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

| Fragment                                           | Rule                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visibleSql(s, viewer)`, `canView(db, viewer, id)` | R2 (`StatusPolicy#show?`): an available author; the author sees all of their own; an author who blocks the viewer hides everything from them; public and unlisted are seen by everyone else but a remote account on a domain the author blocks, private by accepted followers and the mentioned, direct and limited by the mentioned only (silent mentions included). It has no time. |
| `viewableSql(s, viewer)`                           | R3: visible, and so is a reblogged original.                                                                                                                                                                                                                                                                                                                                          |
| `listableSql(s, viewer, now)`                      | R8 (`StatusFilter`): viewable, and the viewer filters neither the author nor a reblogged original's author. Feeds, context, bookmarks, favourites and search.                                                                                                                                                                                                                         |
| `homeFilterSql(s, viewer, now)`                    | R9, what home hides for the viewer's choices (`FeedManager#filter_from_home`): what the list rule hides, and a status or boosted original that mentions (not silently) an account the viewer blocks or mutes. The viewer's own statuses pass. Home membership and the follow's options (boosts, replies, languages) stay in the home query.                                           |

Home (`homeTimeline` in `src/domain/timelines.ts`, R9 with `FeedManager#filter_from_home`) has the viewer's own
statuses, the public, unlisted and private statuses of the accounts the viewer follows (accepted), and their direct
and limited statuses that mention the viewer. Of these, a status that is not the viewer's also needs the follow's
options: a boost needs `show_reblogs`, a post in a language needs the follow's languages (if any) to include it, and a
reply (`in_reply_to_uri` set) passes only when its conversation partner (`in_reply_to_account_id`, carried through
self-replies) is known and is the author, the viewer or an account the viewer follows. A reply whose partner is
unknown is left out: its parent was never stored (the partner is written with the parent), it continues such a reply,
or the partner's account was purged (the purge clears the partner and ends every follow of that account, so no
follow would let the reply through anyway, and a reply home left out stays out). A reply whose parent is deleted keeps
its partner. Then `homeFilterSql` applies. A status that is not the viewer's is also left out when its author is in one
of the viewer's exclusive lists, a pending member included (`EXCLUSIVE_MEMBERS` in `timelines.ts`: Mastodon's
`FeedManager#filter_from_home` answers `:skip_home` for an author in `crutches_exclusive_list_users`). It is home's
own filter, not part of `homeFilterSql`: Mastodon's `FeedInsertWorker#notify?` refuses only `:filter`, so an exclusive
member's post still notifies a follower with `notify` on, as the post notification rule below has it.

Home and a list's timeline read a window of each author's statuses (`AuthorWindows` below): for each account home
shows (for a list, each active member), the newest public, unlisted and private statuses of theirs inside the cursor
that pass every filter above, at most a page, through the partial index `statuses_feed` from the cursor; then the
newest page of all those windows. A status of the page is within its author's window, so the page is the one a single
query over every author's statuses would give, and the filters apply inside each window, so an author whose newest
statuses are all left out still shows older ones on the same page. Home merges two more streams: the viewer's own
statuses, whatever their visibility (the read rule shows the viewer all of them, so this reads at most a page), and the
direct and limited statuses that mention the viewer, as a window per followed account of the viewer's mentions by that
account, in status id order from the cursor, through the partial index `status_mentions_requires_mention` of the
mentions in direct and limited statuses by recipient and author (`status_mentions.requires_mention` and `author_id`,
which the writers of `status_mentions` copy from the status, migration `0008_status_mentions_requires_mention`). A page
reads a page of shown statuses per author however long each author's history; a followed account's direct and limited
statuses to others are never read, and neither are the viewer's mentions in public, unlisted and private statuses or
by accounts they do not follow. What a follow's options (boosts, languages, replies) and `homeFilterSql` leave out is
still read on the way: an author whose recent statuses are mostly left out costs those rows.

A list (`src/domain/lists.ts`) belongs to a local account and holds the owner or accounts the owner follows or has
asked to follow (Mastodon's `ListAccount#validate_relationship`). A member leaves the owner's lists when that follow
ends, whatever ends it: the trigger `list_members_follow_ended` of migration `0007_list_members` deletes the rows with
the follow, as Mastodon's foreign keys from `list_accounts` to `follows` and `follow_requests` do. A request accepted
later keeps its row. A list's timeline (`listTimeline` in `src/domain/timelines.ts`, Mastodon's `ListFeed` as
`FanOutOnWriteService#deliver_to_lists` and `FeedManager#filter` with `timeline_type` `:list` fill it) has the public,
unlisted and private statuses and boosts of its active members: the owner, when a member, and the members the owner
follows (accepted). A member with a pending request contributes nothing until the request is accepted. Of these, a
status that is not the owner's needs the follow's options as in home (`show_reblogs`, languages), and a reply passes
when its partner is known and is the author or the owner, or by the list's `replies_policy`
(`FeedManager#filter_from_list?` with the list's `crutches_following`): `followed`, any reply of the owner's own and one
to an account the owner follows; `list`, one to a member of the list (pending included); `none`, nothing more. Then
`homeFilterSql` applies for the owner. Exclusive does not change the list's own timeline. Only the owner reads or
changes a list; to anyone else it is not found.

Conversations (`src/domain/conversations.ts`, Mastodon's `AccountConversation` and `Api::V1::ConversationsController`)
are written when a direct status is stored, never worked out when read (R25). A local author's own direct status joins
the author's conversation (`FanOutOnWriteService#deliver_to_conversation!`), read; a direct status a local account is
notified of as a mention joins that account's (`NotifyService#push_to_conversation!`, called from `notify`), unread. So
the notification rule (R15) decides who receives one: a status from an account the owner blocks or mutes with
notifications adds nothing, and a limited status (a silent recipient) is not a direct message. A conversation is keyed
by its owner, its thread and its participants (`src/domain/conversation-rows.ts`): the participants are the status's
author and its mentions (not silent) less the owner; the thread is `statuses.thread`, Mastodon's `conversation_id`,
written once when a status is stored and never changed (the trigger `statuses_thread`): a reply to a
status stored takes that status's thread, a reply to a status not stored the uri it names (`in_reply_to_uri`), any
other status its own uri. Deleting a status or a conversation changes no other status's thread, so a later reply joins
the thread its parent was stored in. Migration `0009_conversations` gives the statuses already stored theirs by the
same rule, from the start of each reply chain down (a status in a cycle of replies, or below one, takes its own
`in_reply_to_uri`, else its uri). A status leaves its
conversations however it is deleted (a delete, an inbound `Delete`, a purge): its `conversation_statuses` rows cascade,
and the trigger `conversation_statuses_removed` of migration `0009_conversations` moves the last status back to the
newest left, or deletes the conversation when none is left (`AccountConversation.remove_status`). A block ends the
blocker's conversations with the blocked account (`AfterBlockService#clear_conversations!`). The list reads only the
owner's rows, newest last status first, through the `(account_id, last_status_id)` index; anyone else's conversation
is not found, read, marked or deleted. Mastodon renders a conversation's last status with no read rule; Kopje shows it
only when the owner may still see it (`statusReads` under `visible`, R2), and otherwise shows `last_status: null`, as
Mastodon does for a last status it can no longer load: so a last status whose author is suspended or blocks the owner
is not shown, while the conversation and its participants stay. The participants are presented as accounts are
elsewhere (an unavailable one redacted); with nobody else in it, the owner's own account.

Notifications: `shownSql(r, type, from, status, now)` is R15, one rule for writing (`notify`), listing and reading
notifications, and for sending their pushes (`domain/push.ts`, judged again at the time of sending). The sender is not
the recipient, is available, is neither blocked (either way), muted with notifications nor domain-blocked by the
recipient, and the recipient may see the status. A reblog notification also needs the sender's boost to be visible to
the recipient. A mention is left out when its status mentions or replies to an account the recipient blocks or mutes
with notifications. A post notification (`status`) is shown only for a status that is not a reply, or is one in the
author's own conversation (its partner is the author; an unknown partner does not count), and only when
`homeFilterSql` passes for it, as Mastodon's `FeedInsertWorker` notifies only of what home shows: so a sender the recipient mutes, with or without
notifications, sends none.

An account becomes unavailable when its deletion starts: a remote actor's `Delete` writes `accounts.deleted_at` in the
transaction that writes its purge job (`deleteActor` in `src/domain/inbox.ts`), before the purge's batches remove its
relationships, notifications and statuses, so none of them is shown while they are removed. Blocks and mutes of the
account go last, once nothing they filter (its statuses, mentions of it, replies to it, its notifications) is left. The
row goes with the purge's last batch; until then the actor's own activities are ignored, its document is not stored
again, and no boost of its statuses is accepted nor any status of it fetched (its tombstone, `isDeletedActor`). `availableSql` finds a deleted account through the partial index
`accounts_deleted`, which holds only such accounts, so for any other account the rule reads its `local_accounts` row
alone. A local account is never marked (the schema refuses it), so `availableLocalSql` needs only that row.

A remote account is a viewer when it acts on a local status: an inbound `Like` (a favourite, a Misskey reaction or
an `EmojiReact`) or `Announce` is stored only if the actor may see the status by itself (`canView`, through
`mayInteract` in `src/domain/inbox.ts`; an `Announce` must also wrap a public or unlisted status or the actor's own,
VIS-6). So an author who blocks the actor, or blocks its domain, refuses both, and so does a private, direct or limited
status the actor is not in the audience of. Mastodon 4.5's `ActivityPub::Activity::Like` checks no read rule, and its
`Announce` only `announceable?`, leaving it to `NotifyService` to filter the author's notification. Kopje refuses the
interaction itself (VIS-13, VIS-15). A reply is a status of the actor's own: it is stored
whatever the author of its parent blocks, as Mastodon stores it, and that author's blocks keep it out of their lists
and notifications (R7, R15). Kopje has no quote posts.

The domain term of R2 applies only to a remote viewer, as Mastodon's `author_blocking_domain?` does: whether the viewer
is remote does not depend on the status, so SQLite evaluates it once per query (one row for a local viewer, none for
an anonymous one), and the domain block is looked up only for a remote viewer. Nothing serves a status to a remote
account as a viewer otherwise: the object endpoint and the outbox serve public and unlisted statuses to anyone, signed
or not (R4).

Visibility sets are generated from `isDistributable` and `requiresMention`: `DISTRIBUTABLE_SQL` (public, unlisted),
`REQUIRES_MENTION_SQL` (direct, limited) and `REACHES_FOLLOWERS_SQL` (public, unlisted, private, the list of the
partial index `statuses_feed`, which SQLite uses only for the same list). SQL elsewhere writes `visibility IN
${DISTRIBUTABLE_SQL}`, never the literals.

## The rules as the module implements them

| Rule                      | Where it is applied                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 available              | `availableSql` in every status and account rule below; the object endpoint, outbox, followers and following collections and web pages (`availableLocalSql`); user counts. The account presenter shows an unavailable account redacted (`suspended: true`).                                                                                                                                                                         |
| R2, R3 show and view      | `visibleSql`, `viewableSql`, `canView`: single status, history, write responses, replies, favourites and boosts, inbound `Like` and `Announce`, search resolution (with `domainBlocksSql` of the author), web pages.                                                                                                                                                                                                               |
| R4 servable               | `SERVABLE` in `activities.ts` (`DISTRIBUTABLE_SQL` and `availableLocalSql`); web pages use `visibleSql` with no viewer.                                                                                                                                                                                                                                                                                                            |
| R5 source                 | The author only (`statusSource`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| R6 history                | `canView`, with the audience frozen at write time (`editStatus`).                                                                                                                                                                                                                                                                                                                                                                  |
| R7 filtered               | `filteredForSql`, inside `listableSql`, account statuses (boosted originals), familiar followers.                                                                                                                                                                                                                                                                                                                                  |
| R8 listable               | `listableSql`: public, tag, bookmarks, favourites, context, status and hashtag search.                                                                                                                                                                                                                                                                                                                                             |
| R9 home                   | `homeFilterSql` in `homeTimeline`, with its membership, the follow's options (boosts, languages, reply partners) and the viewer's exclusive lists.                                                                                                                                                                                                                                                                                 |
| R10 public and tag feeds  | `publicConditions` in `timelines.ts` on `listableSql`; the tag feed and a tag's history take their candidates from the hashtags of public statuses (`status_tags.public`, written with `tagPublicSql`).                                                                                                                                                                                                                            |
| R11 account statuses      | `visibleSql`, `blocksSql` (the viewer blocks the account), and `visibleSql` with `filteredForSql` for a boosted original.                                                                                                                                                                                                                                                                                                          |
| R12 listed accounts       | `listedForSql` in `favourited_by` and `reblogged_by` (`DISTRIBUTABLE_SQL` boosts only).                                                                                                                                                                                                                                                                                                                                            |
| R13 follower lists        | `followListsShownSql` and `followListedSql` in `listFollows` (`GET /api/v1/accounts/:id/followers` and `/following`); `hidesCollectionsSql` in familiar followers (none for an account that hides its network, whoever asks; no follower that hides its own); `followListsShownSql` with no viewer in the ActivityPub followers and following collections: a hidden network shows `totalItems` only, and a page of it answers 403. |
| R14 account search        | `findableBySql` in `findAccounts` and for an account answered by search resolution. Mastodon's account search leaves out suspended accounts only; Kopje also leaves out those on a domain the viewer blocks.                                                                                                                                                                                                                       |
| R15 notifications         | `shownSql` in `notify`, `listNotifications`, `getNotification` and the push target.                                                                                                                                                                                                                                                                                                                                                |
| R16 push                  | `shownSql` and `pushWantedSql` at record, claim and confirm time.                                                                                                                                                                                                                                                                                                                                                                  |
| R17 mentionable           | `mentionableBySql` in `resolveMentions`; an edit drops mentions the author now blocks (`blockedSql`).                                                                                                                                                                                                                                                                                                                              |
| R18 reblog, R19 favourite | `canView` and `blocksAuthor` (`blocksSql`) in `statuses.ts`; for an inbound `Announce` or `Like`, `canView` of the actor (`mayInteract` in `inbox.ts`).                                                                                                                                                                                                                                                                            |
| R20 reply                 | `canView` of the parent.                                                                                                                                                                                                                                                                                                                                                                                                           |
| R21 follow                | `followableBySql` for a local follow and for each follower a `Move` carries; an inbound `Follow` is ignored when the actor blocks the target (`blocksSql`) and rejected when the target blocks it or its domain (`blockedSql`).                                                                                                                                                                                                    |
| R22 addressing            | `addressingOf` for a status; for a boost, `addresses` (through `boostAnnounce`): the `Announce` leaves out an author the booster blocks or domain-blocks, its `Undo` names them. See "Outbound recipients".                                                                                                                                                                                                                        |
| R23 delivery targets      | `recipientsFor`, by `outboundKind`, turned into inboxes by `audienceTargets` in `deliveries.ts`. See "Outbound recipients".                                                                                                                                                                                                                                                                                                        |
| R24 list timeline         | `homeFilterSql` in `listTimeline`, with the list's active members, the follow's options and the list's `replies_policy`; the owner's lists only (`ownList` in `lists.ts`).                                                                                                                                                                                                                                                         |
| R25 conversations         | `visibleSql` (through `statusReads`) for each last status; rows are the owner's only (`listConversations`, `markConversation`, `deleteConversation` in `conversations.ts`).                                                                                                                                                                                                                                                        |

## Outbound recipients

`recipientsFor(db, signer, activity, audience)` decides whom an activity of a local account reaches (R23), and
`addresses(db, kind, signer, x)` whether it names an addressed account (R22). Both read the activity's kind,
`outboundKind(activity)`:

| Kind       | Activities                                                                          | Followers                                                                                | Addressed accounts                                                         |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| content    | `Create`, `Update` of a status, `Announce`                                          | accepted remote followers, less unavailable ones and those on a domain the signer blocks | remote, less unavailable ones and those the signer blocks or domain-blocks |
| retraction | `Delete`, `Undo` of anything, a `Reject` that ends an accepted follow               | every accepted remote follower                                                           | every remote account of the audience, blocked or not                       |
| other      | `Update` of the actor, `Like`, `Follow`, `Accept`, a `Reject` of a request, `Block` | every accepted remote follower                                                           | every remote account of the audience                                       |

A retraction also reaches every inbox that received what it withdraws, or may still: the receipts of its status, and
the delivery rows and unexpanded targets of earlier activities about it (`receiversOf` in `deliveries.ts`). So a
`Delete` reaches a follower who has left or been blocked since, and the `Undo` of a boost names and reaches the
original's author even when the booster blocks them or their domain (its `Announce` left them out).

The rule for activities that are neither content nor retractions is Mastodon 4.5's: none of them is filtered by
block or domain block. `FavouriteService`, `FollowService`, `BlockService` and `RejectFollowService` send to the
account's inbox, and `ActivityPub::UpdateDistributionWorker` sends a profile `Update` to `followers.inboxes`
(`AccountReachFinder`). A domain block instead ends the follows with the domain (`AfterBlockDomainFromAccountService`,
the cleanup in `blocks.ts`); until the cleanup reaches a follower there, it is sent profile changes but no content.

`audienceTargets` turns the recipients into targets: followers and accounts named in `to` or `cc` by shared inbox,
a silent recipient of an addressed activity by a copy of its own at its personal inbox (VIS-2), and the recipient of
an activity without `to` by shared inbox, else personal inbox. No other SQL turns follows into inboxes or reads an
account's shared inbox (the architecture test below).

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
  `SELECT id FROM (SELECT * FROM (<branch>) UNION [ALL] ...) <tail>`. A branch is such a SELECT or an `AuthorWindows`,
  a window of each author's statuses, in which the rule is a conjunct of the window's WHERE over its `statuses s`:

    ```sql
    SELECT w.id AS id FROM (SELECT wa.account_id FROM (<authors>) wa WHERE <rule over the author>) a
      CROSS JOIN main.statuses w ON w.id IN (SELECT s.id FROM <from> main.statuses s <join>
      WHERE (<author> = a.account_id AND <where>) AND (<rule over s>) AND (<and>) <window tail>)
    ```

    `<authors>` selects each author once as `account_id`, and the window's tail orders by id and cuts to a page. The
    rule over the author is the part of the rule that holds for all of an author's statuses or none (available, not
    blocking the viewer, and for `listable` and `homeFilter` not filtered by them), so an author it rejects has no
    window. `<author>` is `s.account_id` unless the window reads another index: home's mentions window reads the
    viewer's mentions by author (`m.author_id`), with `status_mentions m` in `<from>`.

- `authorShown(db, rule, { author, and })` decides that part of the rule for one author, with `and`, before a read of
  that author's statuses alone, which can then return nothing without reading them.

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

| Caller                                                     | Ids from                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| home                                                       | `union` under `homeFilter` of two `AuthorWindows` (follows, mentions) and own                        |
| list timeline                                              | `union` of one `AuthorWindows` under `homeFilter`: the list's active members                         |
| public feed, bookmarks and favourites, context             | `select` under `listable`; the tag feed a `union` of its names under it                              |
| account statuses                                           | `authorShown`, then `select` under `visible`, with `visibleSql` and `filteredForSql` for an original |
| status search                                              | `select` under `listable`, with its candidates as a `WITH` table                                     |
| notifications (list and one)                               | `notifications`                                                                                      |
| web profile and status pages                               | `select` under `visible` with no viewer; the parent through `viewableStatusId`                       |
| conversations (list, read, unread)                         | `select` under `visible` of each last status                                                         |
| single status, history, actions (favourite, bookmark, ...) | `viewableStatusId`                                                                                   |
| search resolution                                          | `viewableStatusId`, after the domain block of the author                                             |
| post, edit, delete, boost (and their repeats)              | `ownStatusId`, then `presentOwnStatus`                                                               |

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
- judges suspension or deletion (`suspended_at` or `deleted_at IS [NOT] NULL`) or spells a set of visibilities
  (`IN ('public', ...`);
- inserts into `notifications` outside `notifications.ts`, or into `outbound_activities` or `deliveries` outside
  `deliveries.ts`;
- inserts into `status_mentions` outside its listed writers: `statuses.ts`, `remote-statuses.ts` and `inbox.ts`;
- selects inboxes from `follows` (follower expansion) outside the policy module, except the ActivityPub followers and
  following collections in `actors.ts`, whose items name an inbox and are not sent anything;
- reads `shared_inbox_url` outside the policy module, except where `inbox.ts` stores a remote actor's inboxes and where
  `deliveries.ts` moves a row its recipient's shared inbox refused to that recipient's personal inbox.

An allowed file that no longer matches fails the test too, so the list does not outlive its reason.

It also keeps the status id brands with the policy module. Elsewhere, `VisibleStatusId`, `OwnStatusId` and
`WithVisibleStatus` may be named only in an import or as the type of a function parameter: a cast, a type argument
(`db.all<{ id: VisibleStatusId }>`), a type predicate, an alias or an annotated variable or result could make one from
a plain string. The presenter is called only from `src/domain/`, where ESLint refuses an `any` argument
(`eslint.config.js`), so no `any` reaches its parameters. The test also checks the generated visibility sets and that
`REACHES_FOLLOWERS_SQL` is the list of the `statuses_feed` index.

The fragments nest: Cloudflare's SQLite refuses an expression deeper than 100 levels, and each nested `EXISTS` and
each term of an `AND` chain adds to it. The deepest fragment, `shownSql`, compiles at a depth of about 76; keep the
deepest terms last in a chain and prefer `JOIN ... ON` to `WHERE` for a lookup inside a subquery. The Workers suites
allow 90: `test/sql-depth-setup.ts` records each statement a suite runs through `Db` and has its depth measured on
Node (`test-node/sql-depth.ts`), so a statement nearing the limit fails the suite that runs it.

## The oracle and the bounds harness

`test/policy-oracle.test.ts` checks each fragment against a second statement of its rule. `test/policy-model.ts` states
the rules of this page in plain TypeScript, without importing the module. `test/policy-world.ts` generates worlds with
[fast-check](https://fast-check.dev/): four local accounts (one of them may be suspended, some may hide their network),
two or three remote accounts on two domains (some with an actor id on a subdomain, with a port, with a trailing dot or
on the other domain; one may be being deleted, with its statuses and edges still stored), up to 22 statuses of every
visibility with mentions (some silent), boosts, replies and replies that continue the author's own thread (written
with the conversation partner `statuses.ts` carries over), replies to a status never stored (no parent and no
partner) and replies continuing those (a parent but no partner, as a purge leaves a reply to the account it removes),
accepted and pending follows, blocks both ways, mutes that have expired, expire at the time of the read or later, or never, with or without notifications, and domain blocks in
their stored form, including the instance's own domain and a domain nobody lives on, and lists of local accounts, exclusive or not, with each
`replies_policy`, whose members are their owner and accounts it follows, accepted or pending, whatever else the owner
blocks, mutes or domain-blocks (a Store holds no other member: the trigger, migration `0007_list_members` and the
converter keep it so). Each property writes a world into one Store and evaluates its fragment over every pair the rule takes: every
viewer (each account and the anonymous one) with every account or status (for the list rules, `listableSql` and
`homeFilterSql`, the viewers their callers judge: each local account and the anonymous one), every owner with every
account, for `followListedSql` every viewer with every owner and account, and, for `shownSql`, every local recipient
with every notification type, sender and status (or none). The set of pairs it accepts must equal the model's. A failure
prints the shrunk world, the pairs only one side accepts, and the seed; `FC_SEED=<seed> pnpm vitest run
test/policy-oracle.test.ts` replays it.

`test/policy-bounds.test.ts` takes one generated world, for a fixed seed, in which every endpoint below shows the viewer
something. It runs home, the public and tag feeds, account statuses, notifications, context, conversations, favourites,
bookmarks, `favourited_by`, `reblogged_by`, relationships, the followers and following of an account (one that no unrelated account
follows), a list's timeline (a list of every account of the world), status and hashtag search, and account search among the viewer's follows (a search of every account reads the
newest accounts the instance knows, a window that grows with them up to its limit) on that world alone, and again with
1,000 unrelated remote accounts and 100 unrelated local ones: their statuses (never public, though they carry the
hashtag the tag feed reads), replies and boosts, their follows, blocks, mutes and domain blocks of the world's accounts
and domains, their favourites, bookmarks and notifications, and their exclusive lists of the world's accounts and their
own, together with the viewer's own blocks and mutes of those
accounts and domain blocks of domains nobody lives on. Each endpoint must show the same with them as without (the same
statuses, accounts, notifications and hashtags in the same order, and the same relationship flags), and the rows it
reads (RES-7) may grow by at most 10. A second case grows the history of each author home and a list read instead:
the viewer, who follows seven accounts and has a list of them, and those accounts, from 20 statuses each to 2,000, one
of the accounts posting only direct statuses addressed to another account. The newest page, a page from the middle of
the longer histories and the oldest page of home and of the list must each be full and read at most 10 rows more. A
third case does the same for the conversation list, with 20 or 2,000 conversations of the viewer, each a thread of
three direct statuses.

A third case grows the generated world's own history: the same world with every status replicated 40 and 400 times,
each copy a new status older than every original, with its original's author, visibility, mentions, hashtag and
reply or boost (to the copy of its parent or original in the same replica), and the viewer's favourite, bookmark and
notification of it. Accounts, follows, blocks, mutes, domain blocks and list memberships are not replicated. Because
the composition stays the same, a read that walks past what it hides or filters reads a constant multiple of a page
once each author's history holds more than a page of what it shows, while a read that walks or sorts a whole history
grows with the factor. Each endpoint that pages statuses or the viewer's edges is read on its newest page, a page from
the middle of the replicated history and its oldest page, and the others once; every read must show the viewer
something, the newest pages must be the same at both factors, and the rows read may grow by at most 10. Status and
hashtag search are exempt (their windows grow with the history up to their documented limits). The case does not grow
the author set (no follow cap bounds it yet), and it does not build skewed histories, where one author's statuses
dominate. A last case grows the histories the viewer never sees, from 20 statuses each to 2,000: an account the viewer
does not follow sending them direct statuses, which home must not read, and an account that blocks the viewer, one the
viewer blocks, a suspended one and one being deleted, whose statuses the account statuses endpoint must not read. Home
must show a full page and the account statuses none, reading at most 10 rows more.

`test/policy-endpoints.test.ts` runs the read endpoints themselves on generated worlds, with favourites, bookmarks and
notifications added, for each available local viewer and, where the endpoint answers without a token, the anonymous
one. No endpoint may show a status or an account the model does not allow the viewer by the endpoint's rule, and a
boost must come with its own original (never `reblog: null` on a read), which the viewer may see:

| Endpoint                                                   | Asserted                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| public feed, tag feed, account statuses (of every account) | exactly the model's members the rule allows (R10, R11), newest first, over pages of 3                                                                                                                                                                   |
| favourites, bookmarks                                      | exactly the viewer's edges the list rule allows (R8), newest edge first, over pages                                                                                                                                                                     |
| home                                                       | exactly the model's members home allows (R9: membership, exclusive lists, the follow's options and `homeFilterSql`), newest first, page by page (below)                                                                                                 |
| list timeline (of each of the viewer's lists)              | exactly what the model allows of the list's members (R24), page by page as home; another account's list is not found                                                                                                                                    |
| single status, context                                     | nothing for a status the viewer may not view (R3); context members listable (R8)                                                                                                                                                                        |
| `favourited_by`, `reblogged_by`                            | nothing for a status the viewer may not view; only listed interactors (R12)                                                                                                                                                                             |
| status search                                              | listable statuses only (R8)                                                                                                                                                                                                                             |
| notifications                                              | only the viewer's, as written, that the rule shows (R15), with statuses they may view                                                                                                                                                                   |
| followers, following (of every account)                    | exactly the accepted follows the list rule shows (R13), newest first, over pages of 3                                                                                                                                                                   |
| account search                                             | exactly the accounts the viewer may find (R14)                                                                                                                                                                                                          |
| conversations                                              | exactly the viewer's conversations the model makes of the direct statuses and the mentions seeded (R25), newest last status first, both ways over pages; each last status only if the viewer may see it (R2), else null; another account's is not found |
| search resolution (of every stored account and status)     | an account exactly when account search finds it (R14); a status exactly when the single-status read shows it (R3), unless the viewer blocks its author's domain                                                                                         |

Home and each list are read page by page: by `max_id` in pages of 3 and by `min_id` from the oldest in pages of 2,
each page exactly the next of the model's members, so a page cannot come back short while members remain; and the
`since_id` and `min_id` pages above the middle member. Each endpoint must show something in some case, so a property
cannot pass by showing nothing.

`test/policy-writes.test.ts` runs the write paths on generated worlds, with remote accounts given personal and some
shared inboxes and local accounts given Web Push subscriptions (alerts, policy, valid or expired token). Each case
runs 10 to 24 actions: local authors post with every visibility, mentions and replies, edit (a mention dropped by an
edit stays silent), delete, boost and undo a boost, favourite and undo it, and change their profile; deliveries are
made (claimed and completed); remote followers leave; authors block accounts (ending the follows) and domains (before
the cleanup). After each action the model (`outboundKindOf`, `statusAudience`, `names`, `reaches`, `pushed` in
`test/policy-model.ts`) judges what it recorded:

- every target of each activity is an inbox of an account the activity reaches (R23), or, for a retraction, an inbox
  something about its object was sent to before; a personal copy goes only to an addressed account it does not name;
- `to` and `cc` (the activity's and its object's) name only Public, the signer's followers and the accounts R22 lets
  it name: never a silent recipient, and for content never an account the author blocks or domain-blocks; a boost's
  `Announce` names the author exactly when R22 allows, its `Undo` always;
- a retraction is recorded, and reaches every inbox something about its object was delivered to, is still queued for
  (a deliveries row in any state) or is still in a chunk of targets not yet expanded; a profile change reaches every
  remote follower;
- every notification written satisfies R15, and every push recorded R16, at the time of the action;
- a list holds what it held before the action, less each account its owner no longer follows in either state; its
  owner stays;
- the conversations hold what `AccountConversation.add_status` and `remove_status` make of the action (R25): a direct
  status joins its author's conversation and that of each local account the notification rule lets it notify, by
  thread and participants, and leaves each when it is deleted, the last status moving back or the conversation going.

The property runs 500 cases from a fixed seed (`FC_SEED` replays another). Next to it, witnesses (cases written by
hand) run each scenario it must check: content leaving out an account being deleted while its retraction reaches it,
a delivered retraction reaching a blocked receiver, one reaching a target still
queued after its follower left, one reaching targets not yet expanded (more followers than an expansion step, who
leave before the `Delete`), the `Undo` of a boost naming a blocked author, a profile `Update` to a domain-blocked
follower, content leaving one out, a personal copy, notifications and pushes, and list members leaving with a block
either way. So coverage never depends on chance.
