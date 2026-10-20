# Visibility and audience

Who may see a status or an account, what a viewer filters out, who is notified and whom an author may address are
decided in one module: `src/domain/audience.ts`. It is plain SQL fragments, spliced into the queries that read and
write. No read path, notification path or delivery path keeps its own copy of a rule. The threat model states the
invariants (VIS-1 to VIS-19, NET-2, PUSH-3); this page describes how the code applies them.

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

| Fragment                                                                   | Rule                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `availableSql(x)`, `availableLocalSql(l)`                                  | R1: the account is not a suspended local account, nor a remote account the instance suspended (R38), whose deletion has started, or that an instance domain block covers (R38). The second form takes the `local_accounts` row of a local account already joined; `availableJoinedSql(a, l)` reads both joined rows, as account presentation does. |
| `blocksSql(owner, x)`, `domainBlocksSql(owner, x)`, `blockedSql(owner, x)` | `owner` blocks `x`, blocks its domain, or either.                                                                                                                                                                                                                                                                                                  |
| `inDomainSql(a, domain)`                                                   | The account row `a` lives on `domain`: its stored domain or the host of its actor id, exactly.                                                                                                                                                                                                                                                     |
| `filteredForSql(x, viewer, now)`                                           | R7: the viewer blocks `x`, mutes it while the mute applies, or blocks its domain. Nobody filters themselves; an anonymous viewer filters nothing.                                                                                                                                                                                                  |
| `listedForSql(x, viewer, now)`                                             | R12: `x` may be listed among others (who favourited or boosted, the profile directory): available, not filtered, and not blocking the viewer.                                                                                                                                                                                                      |
| `followListsShownSql(owner, viewer)`                                       | R13: the viewer is shown the owner's followers and following: the owner is available and, unless the viewer is the owner, neither hides its network (`hide_collections`) nor blocks the viewer.                                                                                                                                                    |
| `followListedSql(x, owner, viewer, now)`                                   | R13: `x` is listed among the owner's followers or following: to an anonymous viewer and the owner, always; to anyone else, unless they block or mute `x` (while the mute applies) or `x` blocks them.                                                                                                                                              |
| `endorsementsShownSql(owner)`, `endorsementListedSql(x)`                   | R28: the accounts the owner endorses are listed, to anyone, while the owner is available; an endorsed account is listed while it is available.                                                                                                                                                                                                     |
| `suggestionSourceSql(owner, viewer)`                                       | R39: the viewer's follow of `owner` brings the accounts the owner follows into their suggestions: R13 shows the viewer the owner's following (`followListsShownSql`).                                                                                                                                                                              |
| `suggestionCandidateSql(x, a, viewer)`                                     | R39: `x` (its accounts row `a` in scope) is a candidate for the viewer's suggestions: someone else, discoverable, neither followed nor requested by the viewer, and not dismissed by them (`follow_recommendation_mutes`). R12 judges each candidate after it.                                                                                     |
| `findableBySql(x, viewer)`                                                 | R14: the viewer finds `x` by account search or search resolution: available, and not on a domain the viewer blocks.                                                                                                                                                                                                                                |
| `mentionableBySql(x, author)`                                              | R17: the author may mention or address `x`: available, and the author blocks neither it nor its domain.                                                                                                                                                                                                                                            |
| `followableBySql(x, viewer)`                                               | R21: the viewer may follow `x`: available, someone else, no block either way, no domain block by the viewer.                                                                                                                                                                                                                                       |

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

Home also has the public statuses, not boosts, that carry a hashtag the viewer follows (`tag_follows`, migration
`0016_tags`), whoever wrote them: Mastodon's `FanOutOnWriteService#deliver_to_hashtag_followers!` puts a broadcastable
status into its hashtag followers' home feeds, and `FeedManager#filter_from_tags?` leaves out a status whose author or
active mention the viewer blocks or mutes, whose author blocks the viewer, or whose author's domain the viewer blocks:
`homeFilterSql` for such a status. None of the follow's options nor the exclusive lists apply to them, as Mastodon's
`:tags` filter checks neither; a status that home has by more than one way is shown once. Kopje has no silenced
accounts, the third condition of Mastodon's `broadcastable?`. As home is read, a followed hashtag's statuses from before
the follow are shown too, and they leave home when the follow ends (Mastodon's `TagUnmergeWorker`).

Home reads each followed hashtag's public statuses as a stream, through the partial index `status_tags_public`, so a
hashtag's unlisted, private, direct and limited statuses are never read; an account follows at most
`MAX_FOLLOWED_TAGS` (100) hashtags, Kopje's cap where Mastodon has none, so the streams of a page are bounded.
Home and a list's timeline merge streams into one candidate window (see "Read bounds" below): for each account home
shows (for a list, each active member), its public, unlisted and private statuses from the cursor through the partial
index `statuses_feed`; home adds the viewer's own statuses, whatever their visibility, the direct and limited statuses
that mention the viewer, as a stream per followed account of the viewer's mentions by that account, through the
partial index `status_mentions_requires_mention` of the mentions in direct and limited statuses by recipient and
author (`status_mentions.requires_mention` and `author_id`, which the writers of `status_mentions` copy from the status,
migration `0008_status_mentions_requires_mention`), and the followed hashtags' streams. An account the rule rejects as
a whole (unavailable, blocking the viewer, filtered by them) has no stream. The rule, the follow's options and
`homeFilterSql` then apply to the window's candidates. Mastodon filters home as statuses arrive; Kopje filters it as it
is read, so a page whose window holds mostly what the filters leave out is short or empty, and its next link moves on
past the window. A followed account's direct and limited statuses to others are never read, and neither are the
viewer's mentions in public, unlisted and private statuses or by accounts they do not follow. The number of streams is
the number of accounts the viewer follows (a list's active members are among them): the viewer's own choice, not data
others control, and not a hard bound. The follow API has Mastodon's `FollowLimitValidator` as an admission rule on the
viewer's own follows: a new follow or request is refused (422) once the viewer has 7,500 accepted follows, or past that
1.1 times their followers (`test/follow-limit.test.ts`). Pending requests do not count and may all be accepted later,
authorizing a request or a Move's follower transfer is not limited, and the ratio grows with followers, so the rule
keeps the windows near 7,500 only for an account that follows through the API and has few followers.

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
written once when a status is stored and never changed: a reply to a status stored takes that status's thread; a
received status that names its conversation (Mastodon's `conversation`, which `ActivityPub::Activity::Create` reads)
takes that identifier, so the statuses of a thread delivered out of order share it; otherwise a reply to a status not
stored takes the uri it names (`in_reply_to_uri`), and any other status its own uri (the trigger `statuses_thread`).
Any identifier is taken, whatever its origin, as Mastodon takes it: a sender can only group its own statuses with
others, and a conversation is also keyed by its participants, the sender among them. Deleting a status or a conversation changes no other status's thread, so a later reply joins
the thread its parent was stored in. Migration `0009_conversations` gives the statuses already stored theirs by the
same rule, from the start of each reply chain down (a status in a cycle of replies, or below one, takes what a start
would), reading the conversation a received status named from the object it keeps (`raw`),
with the same checks as the receive path. A status leaves its
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

Notifications: `shownSql(r, type, from, status, now, admin)` is R15, one rule for writing (`notify`), listing and reading
notifications, and for sending their pushes (`domain/push.ts`, judged again at the time of sending). The sender is not
the recipient, is available, is neither blocked (either way), muted with notifications nor domain-blocked by the
recipient, and the recipient may see the status. A reblog notification also needs the sender's boost to be visible to
the recipient. A mention is left out when its status mentions or replies to an account the recipient blocks or mutes
with notifications. A post notification (`status`) is shown only for a status that is not a reply, or is one in the
author's own conversation (its partner is the author; an unknown partner does not count), and only when
`homeFilterSql` passes for it, as Mastodon's `FeedInsertWorker` notifies only of what home shows: so a sender the recipient mutes, with or without
notifications, sends none. A report notification (`admin.report`) is shown only while its recipient is the OAuth admin
(R37; `shownSql`'s `admin`, `adminAccountIdOnce`), and goes with its report.

R15 also has a policy part, the recipient's notification policy (`notificationPolicySql`, Mastodon's
`NotifyService::DropCondition#drop?` and `FilterCondition#filter?`, migration `0020_notification_policies`), which
`notify` applies as it writes: for each of its conditions the recipient chooses accept, filter or drop
(`notification_policies`, Mastodon's defaults without a row: private mentions filtered, the rest accepted). The
conditions are a sender the recipient does not follow; a sender that has not followed the recipient for three days; an
account younger than 30 days the recipient does not follow; and a mention in a direct status from an account the
recipient does not follow that answers none of the recipient's private mentions of the sender (the walk up the thread
reads the parent and at most 100 statuses above it, as Mastodon's). Only mentions, boosts, favourites, follows and
follow requests are filterable, and a sender the recipient accepted a request from (`notification_permissions`) is
always accepted. A condition chosen as drop drops the notification (nothing is written); otherwise one chosen as filter
filters it: it is written with `notifications.filtered` set and no group, is not pushed, does not join a conversation,
and a mention opens or updates its sender's request (`notification_requests`). Kopje has no silenced accounts (the
limited accounts condition never matches) and no staff role. Every read of notifications leaves a filtered one out
unless the request asks for filtered ones (`include_filtered`, or `account_id` in v1, as Mastodon's
`Notification.browserable`): `statusReads(...).notifications` takes `includeFiltered` and otherwise adds the term
`n.filtered = 0`, which reads the partial index `notifications_unfiltered` of the unfiltered rows, so no list or count
reads a filtered notification; a read by id (v1, and `ungrouped-<id>` in v2, as Mastodon's `show`) shows one. The push
target leaves them out too (`UNFILTERED_SQL`). Accepting a request records the permission and unfilters the sender's
filtered notifications, adding its direct mentions to the recipient's conversations, as Mastodon's
`UnfilterNotificationsWorker` does; dismissing one deletes them; both walk the sender's notifications in bounded
batches (`src/domain/notification-requests.ts`), the first in the request and the rest with the inbound jobs. Requests,
the policy and permissions are their recipient's alone: only their owner reads or answers them.

R15 also hides what its recipient cleared or dismissed (migration `0023_notification_clears`). Clearing
(`POST /api/v1/notifications/clear` and its v2 form, Mastodon's `delete_all`) records the highest id of the
recipient's notifications at the time (`notification_clears`), and dismissing a group
(`POST /api/v2/notifications/:group_key/dismiss`, `destroy_all` of `by_group_key`) the highest id of that group's
(`notification_dismissals`); a later one raises it. From then on, no reader shows a notification of the recipient at or
below the clear, or of the group at or below its dismissal: `statusReads(...).notifications` (the lists, a
notification by id, the grouped reads, both unread counts) takes the higher of the cursor and the clear (and, for a
read of one group, its dismissal) as the lower bound on the id (`keptFloorSql`), a constant over key lookups, so the
index walk starts above what is hidden and never reads it; a read of every group checks each notification's group
dismissal by its key. The push target and an accepted request's job check both by key (`keptSql`), so a cleared
notification is not pushed, unfiltered or added to a conversation. A notification written later has a higher id
(notification ids are never reused) and shows as usual; `notify` does not join a group with no notification above them
(a dismissed group is not remembered, as when its rows were deleted). A notification whose natural key a hidden row still holds
replaces that row (`notify` deletes it first), so it is not lost to the conflict. The hidden rows are then deleted in bounded
batches, newest first (`removeNotifications` in `src/domain/notifications.ts`), the first in the request and the rest
with the inbound jobs; the record goes with the last of them. An `ungrouped-<id>` key and a single dismissal
(`POST /api/v1/notifications/:id/dismiss`) delete their one notification at once.

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
and notifications (R7, R15).

A quote (R35, VIS-27; Mastodon 4.5's `REST::BaseQuoteSerializer` and `StatusFilter#filter_state_for_quote`) is shown
with the status that makes it, and never widens what that status's rule passed: the quoted status is judged on its own
by R2 for the same viewer. `quoteReads(viewer).of` in `src/domain/audience.ts` is the only read of `quotes` for a client.
For each status it gives the quote's state and, when the viewer is shown it, the quoted status:

- a status with no quote, or with a legacy quote (a Note without `quote`, a Misskey quote) that is not accepted, has
  none (`quote: null`), as Mastodon's `Quote#acceptable?`;
- a quote in a stored state other than accepted (`pending`, `rejected`, `revoked`, `deleted`) shows that state and no
  status, except in the response to its deletion (`DELETE /api/v1/statuses/:id`, for redrafting), which shows the
  quoted status when the viewer may see it (R2);
- an accepted quote is, in this order: `accepted` for the quoted author; `unauthorized` when the viewer may not see the
  quoted status (R2), with no status; for a signed-in viewer, `blocked_domain` when they block its author's domain,
  `blocked_account` when they block its author, and `muted_account` when they mute its author (while the mute applies),
  each with the status for the client to fold; `accepted` otherwise. A quoted status that is gone has made its quote
  `deleted` already (the detach in `quotes.ts` and `inbox.ts`).

The presenter embeds the quoted status as a full status for the same viewer (its own flags, `filtered`, media and
poll), whose own `quote` is a ShallowQuote (the state and the id of the status it quotes, from the same rule), never a
second embedded status; a boost shows its original's quote in its `reblog` and none of its own (Mastodon gives a reblog
no quote; one a converted row attaches to a boost is not read). Feeds neither include nor exclude a status
for its quote: the state tells the client what to hide. `GET /api/v1/statuses/:id/quotes` lists the statuses that
quote a status the viewer may see by itself (R3), by their accepted quotes, under R8 for anyone but the quoted author,
and R2 for the quoted author, who may see the quotes of accounts they block or mute (Mastodon skips `StatusFilter`
for them).

Who may quote a status is R36. Its policy part, `quotePolicySql` in `src/domain/audience.ts`, is Mastodon's
`Status#quote_policy_for_account`: a status's quote policy (`statuses.quote_policy`, Mastodon's bit flags, automatic
approval in the high 16 bits and manual approval in the low ones, each of `unsupported_policy`, `public`, `followers`
and `following`) answers a quoter `automatic` when its automatic half allows public, or followers and the quoter
follows the author (an accepted follow), or following and the author follows the quoter; `manual` when its manual half
allows the same; `unknown` when either half sets `unsupported_policy`; and `denied` otherwise, and to an anonymous
viewer. It judges the policy alone. The rest of R36, `mayQuoteSql` (Mastodon's `StatusPolicy#quote?` with `Quote`'s
validations), judges the quoter: the status is not a boost, the quoter may see it by itself (R3, so an author who
blocks the quoter or its domain refuses), the quoter blocks neither its author nor the author's domain, and either it
is the quoter's own and neither direct nor limited, or it is public or unlisted and its policy does not answer
`denied`. An inbound QuoteRequest for a local status is decided by `mayQuoteSql` alone, read in the inbox's final
Store round (`answerQuoteRequest` in `src/domain/quotes.ts`): an object that is not a local, available author's public
or unlisted original gets no answer at all, so no answer confirms that a private status exists; a refusal is a
`Reject`; an acceptance is the approval (Kopje stores no manual policy of its own), and adds the quoted author as a
silent mention of the quoting status, so the author may always see the quote (Mastodon's `Quote#ensure_quoted_access`).
A local status gets its policy when it is
posted, scheduled, edited or given one through `interaction_policy`: its author's choice, or their
`default_quote_policy`, and nobody (0) for a status that is not public or unlisted (`storedQuotePolicy`, Mastodon's
`Status#downgrade_quote_policy`); statuses stored before quote policies existed keep 0. A remote status gets the
policy its Note states (`interactionPolicy.canQuote`, `remoteQuotePolicy` in `src/domain/remote-statuses.ts`, 0 when
it states none) when it is first stored and on every `Update` of it, never from a `Create` of a status already stored;
remote statuses stored before Kopje read policies keep 0 until such an `Update`. Every status shows its policy as
`quote_approval` (a boost its original's), with `current_user` R36 for the viewer (`quoteApprovalReads`): `denied`
whenever R36 refuses, `automatic` for the viewer's own status, and otherwise what the policy answers them. This is
stricter than Mastodon, which answers by the policy alone, so a client never offers a quote that the post would refuse.
Notes advertise the automatic half (`interactionPolicy.canQuote`); that is advisory to receivers (FEP-044f), and only
the quoted author's answer approves a quote (VIS-28).

A local quote (`quoted_status_id` on `POST /api/v1/statuses`, rechecked at scheduled publication) is authorized by
R36 in the writing transaction (`preparePost` in `src/domain/statuses.ts`). Refusal returns Mastodon's 404 without
confirming an invisible status. The quoted author is a silent recipient who can always see the quote, including a
private one. Local targets are accepted immediately; remote targets wait for their author's `Accept` (VIS-28).
Quoting one's own private status makes the quote private; a direct quote of another author's status must mention them.
R35 shows the stored state to every viewer and embeds the target only when the viewer may see it independently.

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

| Rule                         | Where it is applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 available                 | `availableSql` in every status and account rule below, which covers a remote account the instance suspended (R38) as well; account presentation reads it live with the row (`availableJoinedSql` in `ACCOUNT_COLUMN_MAP`); the object endpoint, outbox, followers and following collections and web pages (`availableLocalSql`); user counts. The account presenter shows an unavailable account redacted (`suspended: true`). A suspended local sender's queued deliveries are dropped when claimed (`REFUSED_SENDER` in `deliveries.ts`, through `availableLocalSql`), except retractions (`outboundKind`) and its suspension's own actor `Update`, so its queued content is dropped when it is claimed while the account is suspended, which the queue does within moments of the suspension.                                                                                                                                                                                                                                                                                                                                                                                                          |
| R2, R3 show and view         | `visibleSql`, `viewableSql`, `canView`: single status, history, write responses, replies, favourites and boosts, inbound `Like` and `Announce`, search resolution (with `domainBlocksSql` of the author), web pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R4 servable                  | `SERVABLE` in `activities.ts` (`DISTRIBUTABLE_SQL` and `availableLocalSql`); web pages use `visibleSql` with no viewer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R5 source                    | The author only (`statusSource`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R6 history                   | `canView`, with the audience frozen at write time (`editStatus`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R7 filtered                  | `filteredForSql`, inside `listableSql`, account statuses (boosted originals), familiar followers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R8 listable                  | `listableSql`: public, tag, bookmarks, favourites, context, status and hashtag search.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R9 home                      | `homeFilterSql` in `homeTimeline`, with its membership, the follow's options (boosts, languages, reply partners) and the viewer's exclusive lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R10 public and tag feeds     | `publicConditions` in `timelines.ts` on `listableSql`; the tag feed and a tag's history take their candidates from the hashtags of public statuses (`status_tags.public`, written with `tagPublicSql`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R11 account statuses         | `visibleSql`, `blocksSql` (the viewer blocks the account), and `visibleSql` with `filteredForSql` for a boosted original.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R12 listed accounts          | `listedForSql` in `favourited_by` and `reblogged_by` (`DISTRIBUTABLE_SQL` boosts only), and in the profile directory (`directory` in `directory.ts`) over the discoverable accounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R13 follower lists           | `followListsShownSql` and `followListedSql` in `listFollows` (`GET /api/v1/accounts/:id/followers` and `/following`); `hidesCollectionsSql` in familiar followers (none for an account that hides its network, whoever asks; no follower that hides its own); `followListsShownSql` with no viewer in the ActivityPub followers and following collections: a hidden network shows `totalItems` only, and a page of it answers 403.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R14 account search           | `findableBySql` in `findAccounts` and for an account answered by search resolution. Mastodon's account search leaves out suspended accounts only; Kopje also leaves out those on a domain the viewer blocks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R15 notifications            | `shownSql` in `notify` (through `notifiedSql`, which adds R31, with `notificationPolicySql`, the recipient's policy), `listNotifications`, `getNotification`, the grouped reads and unread counts (`notification-groups.ts`) and the push target, each leaving out filtered notifications (`UNFILTERED_SQL`) unless asked for, and cleared or dismissed ones (`keptFloorSql`, `keptSql`); an `admin.report` only while its recipient is the OAuth admin (R37, `shownSql`'s `admin`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R16 push                     | `shownSql` and `pushWantedSql` at record, claim and confirm time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R17 mentionable              | `mentionableBySql` in `resolveMentions`; an edit drops mentions the author now blocks (`blockedSql`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R18 reblog, R19 favourite    | `canView` and `blocksAuthor` (`blocksSql`) in `statuses.ts`; for an inbound `Announce` or `Like`, `canView` of the actor (`mayInteract` in `inbox.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R20 reply                    | `canView` of the parent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R21 follow                   | `followableBySql` for a local follow and for each follower a `Move` carries; an inbound `Follow` is ignored when the actor blocks the target (`blocksSql`) and rejected when the target blocks it or its domain (`blockedSql`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R22 addressing               | `addressingOf` for a status; for a boost, `addresses` (through `boostAnnounce`): the `Announce` leaves out an author the booster blocks or domain-blocks, its `Undo` names them. See "Outbound recipients".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R23 delivery targets         | `recipientsFor`, by `outboundKind`, turned into inboxes by `audienceTargets` in `deliveries.ts`. See "Outbound recipients".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R24 list timeline            | `homeFilterSql` in `listTimeline`, with the list's active members, the follow's options and the list's `replies_policy`; the owner's lists only (`ownList` in `lists.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R25 conversations            | `visibleSql` (through `statusReads`) for each last status; rows are the owner's only (`listConversations`, `markConversation`, `deleteConversation` in `conversations.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R26 scheduled statuses       | `scheduledOwnSql` in every read of `scheduled_statuses`, all in `scheduled-statuses.ts`: the owner's alone, anyone else's not found; published through `writePost`, after which R1 to R25 apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R29 hashtags                 | `tag_follows` read in `tags.ts` (the viewer's own) and in home's `TagWindows` (R9) alone; featured hashtags (`featured-tags.ts`) shown to anyone for an available account (R1, `availableSql`), none for an unavailable one, and in the actor's `featuredTags` collection for an available local actor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R27 polls                    | `viewableStatusId` (R3) for a poll's status in `getPoll`, `vote` and the presenter's callers; `mayVoteSql` (R3, and the voter blocks neither the author nor its domain) for a local vote and a received one; `poll_votes` read in `polls.ts` alone, only the viewer's own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R28 endorsements, notes      | `endorsementsShownSql` and `endorsementListedSql` in `endorsedPage` (`endorsements.ts`): an account's endorsements, to anyone, and the viewer's own. A private note is its author's alone: read only in the viewer's relationships (`relationshipsOf` in `accounts.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R31 pins, conversation mutes | Pins: `accountStatuses` with `pinned` (R11 over the account's pins), `getFeatured` in `activities.ts` (R4: the Note of a public or unlisted pin, the uri of any other). Conversation mutes: `conversationMutedSql`, read only in `audience.ts`, for the viewer's `muted` (the presenter) and in `notifiedSql`, which `notify` applies (R15 at write time).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R32 stream delete            | `streamDelete` (`streaming.ts`), at four sites before a status's audience first changes (`test-node/layering.test.ts`): a row per listening account that may view the status (R3, `deleteAudience` in `audience.ts`); for an account on `user` or a list, with the boosts of it the account may view that it or an account it follows made, at most 40, and for the status and each boost the account's subscribed lists whose read positioned at it returned it (`listStatus`); for a public status that is not a boost, a tombstone (local, media, the hashtags some account subscribes to) while an account listens on a feed it reaches. A `delete` goes only where the capture allows, on a list only while it is still the viewer's (`ownList`), on a `public*` or `hashtag*` stream only for the status itself, never a boost, when its tombstone matches the stream (`tombstoneFeeds`).                                                                                                                                                                                                                                                                                                           |
| R33 stream membership        | `streamUnit` (`streaming.ts`), re-authorizing the token (`authorizeStream`): a `notification` if the notification list positioned at it shows it (`streamedNotification`); `update` if home positioned at it does (`homeStatus`, R9) within the real-time window, on `list:<id>` if the list positioned at it does (`listStatus`, the viewer's list only), and on a `public*` or `hashtag*` stream if the public or the hashtag's timeline positioned at it does (`publicStatus`, `tagStatus`, R8) and it mentions no account the viewer blocks or mutes (`mentionsFilteredFor`); `status.update` if home, a list, such a feed or, with a notification scope, the mention reference does (`mentionedStatus`); `conversation` on `direct` if the conversation is the viewer's row (`streamedConversation`, presented as the list presents it, R25); `notifications_merged` under a notification scope, on the transition to no pending accept job.                                                                                                                                                                                                                                                         |
| R34 reports                  | `reports` read and written only in `reports.ts` (the reporter's own report by `createReport`, answered once, a remote reporter's by `fileRemoteReports` from an inbound Flag, and the OAuth admin's reads and actions under R37) and deleted by a remote account's purge (`inbox.ts`) when its target or its reporter is purged; a local reporter's status passes `accountStatusIds` in `timelines.ts` (R11 less the reporter's own block of the account, as Mastodon's `AccountStatusesFilter`), a remote reporter's `remoteReportableSql` (`remoteReportStatusIds` in `audience.ts`); the Flag of a forwarded report goes to `reportForwardees` (R23), signed by the instance actor. A report's `status_ids` (the ids admitted when it was filed) are metadata shown only to the admin (R15, R37). A report's `admin.report` (`notifyStaff`) is written in its transaction and deleted before it by the purge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R35 quotes                   | `quoteReads` (`audience.ts`): each quote's state and quoted status by `visibleSql`, `domainBlocksSql`, `blocksSql` and `mutesSql` for the viewer, read by the presenter (`status-presenter.ts`) for a response's statuses and originals, then for the quoted statuses it embeds; a `DELETE` response's source reads the quoted status in any state. The quotes list (`statusQuotes` in `statuses.ts`): `viewable` (R3) for the quoted status, then one window of accepted quotes (`acceptedQuoteWindow` in `quotes.ts`) under `listableSql` (R8), or `visibleSql` (R2) for the quoted author.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R36 quote policies           | `quotePolicySql` (`audience.ts`) answers the policy flags (Mastodon's `Status#quote_policy_for_account`); `mayQuoteSql` checks visibility, ownership, boosts and account/domain blocks, and alone decides an inbound QuoteRequest. `storedQuotePolicy` stores nobody unless public or unlisted; `remoteQuotePolicy` stores a remote Note's; `quote_approval` shows the flags (a boost its original's) and `current_user` by `quoteApprovalReads` (R36 for the viewer). Posting a quote (`preparePost` in `statuses.ts`) applies `mayQuoteSql`. See the policy rules above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R37 admin views              | Only the OAuth admin (`adminAccountId`, `admin-authority.ts`: the one local account whose email matches `admin_email`, failing closed), through a token covering the route's admin scope, reads or acts through `/api/v1/admin/*` (`adminReadOperation`, `adminWriteOperation` in `auth.ts`, checked in the operation's transaction, and only for the permissions in `ADMIN_PERMISSIONS`). The admin sees every report and its accounts (`presentAdminAccounts`, local emails included); a report's statuses only while its reporter may still see them (`accountStatusIds` with `viewerOf(admin, reporter)`, or for a remote reporter `remoteReportStatusIds` with its domain), presented with the admin as the viewer. With manage_users, the admin lists and shows every account, local and remote, with each local account's email (`listAdminAccounts`, `getAdminAccount` in `admin-accounts.ts`); an unavailable account (R1) is shown as suspended. It suspends and unsuspends local accounts other than its own (`actOnAccount`, `unsuspendAdminAccount`; `suspension.ts`), which makes them unavailable (R1) and fences their tokens; the Access admin unsuspends too (`unsuspendAccount`). The admin alone is shown a report's `admin.report` notification (R15). |
| R38 instance suspension      | `suspendRemote`/`unsuspendRemote` and the jobs in `remote-suspension.ts`; `availableSql` makes a suspended account unavailable (R1) from the commit, and a `suspend` block every account it covers by either key (a host's rule is its longest matching block). The inbox gate (`receive` in `inbox.ts`), `upsertRemoteActor` and `storeRemoteStatus` gate inbound work; a running `Move` from it stops, `answerFollowRequest` refuses it and `listFollowRequests` leaves it out. Unsuspension restores availability, not what was severed. See the remote suspension paragraphs below and "Instance domain blocks".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R39 suggestions              | `suggestionSourceSql` and `suggestionCandidateSql`, then `listedForSql` (R12), in `suggestions` (`suggestions.ts`, `GET /api/v1/suggestions` and `/api/v2/suggestions`); see "Suggestions" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The streaming API (`src/domain/streaming.ts`, `src/stream-hub.ts`) judges each message when it is made, never when the
write is journaled (R33), and a `delete` by what was captured before the status's audience changed (R32). "Positioned at
x" is the REST read with `max_id` just above x and `limit` 1: its predicates, cursor and windows. `statusReads` takes
`only` for it, which adds `s.id = x` to every branch, cuts an author window to x's author and the followed hashtags to
x's own; home's exclusive-list exclusion is read for x's author alone, from the viewer's lists, and each of x's followed
hashtags is bounded at x, whose window it heads. Positioned membership agrees with a page read from the top for every
per-row predicate. It differs only for home's followed-hashtag windows, which a page cuts at `tagCandidates` candidates
from its cursor: a post of a followed hashtag behind 40 or more newer posts the viewer's home hides is sent, though the
first page of home leaves it out. That is what `max_id` paging returns, and the post passes R9; the difference is
accepted. R32 differs from Mastodon in two accepted ways: at most 40 boosts of a deleted status are deleted on each
viewer's stream (those by the viewer and the accounts it follows), and an account's purge sends no `delete`. A list's
read positioned at x (`listStatus`) cuts the list's members to x's author, read by the list's key; the list must be
the viewer's. A conversation is not a status position: `conversation` is sent for the viewer's own row, by the owner's
change sequence (`conversations.stream_seq`, from a mark that is never lowered), journaled as one event per owner
until it is sent, at most the 20 newest changes each.
The `public*` and `hashtag*` streams are the public timeline (local, remote or both, media only or not) and a
hashtag's timeline (`hashtag:local`: local statuses only) positioned at x: public statuses, not boosts, the public
timeline's not replies to others (a hashtag's keeps them, as Mastodon's `TagFeed` and hashtag streams do), of authors
the viewer neither blocks, mutes nor domain-blocks and who do not block the viewer (R8). Positioned at x, the read is
the status's own row: the public timeline's by its key, a hashtag's by the status's row of the hashtag. Mastodon's
streaming server also drops, per connection, a status that mentions an account the viewer blocks or mutes; Kopje does
the same (`mentionsFilteredFor`), which only narrows R33. Mastodon sends nothing on these streams for a silenced
account; Kopje has no silencing. A `delete` on them is the status's alone: Mastodon's `RemoveStatusService` publishes
a public status's delete on `public`, its local or remote stream, their media streams when it had media, and the
hashtag streams of its hashtags (`:local` for a local status), and none for a boost; Kopje's tombstone holds those
facts from before the delete, and the hashtags only some account subscribed to then. Unlike Mastodon, the viewer must
have been able to view the status at capture (R3): an author who blocks the viewer sends them no `delete`.

Pins and conversation mutes (`src/domain/status-actions.ts`, Mastodon's `StatusPin` and `ConversationMute`, migration
`0018_status_pins_and_conversation_mutes`) act on a status the viewer may see by itself (R3; anything else is not
found). A pin is of the viewer's own status, not a boost, direct or limited, at most five (`StatusPinValidator`); pins
are public (R31): `GET /api/v1/accounts/:id/statuses?pinned=true` reads the account's pins through their primary key
and applies the account statuses rule (R11), newest pin first; the actor's `featured` collection serves them as the
object endpoint serves statuses (R4), the uri alone of a private one, as Mastodon's `CollectionsController` does; and
pinning or unpinning records an `Add` or `Remove` for the followers (R23, kind `other`), after an `Update` of the
actor before the account's first one, pin or featured hashtag (`announceFeatured` in `actor-update.ts`). A conversation mute is its
owner's and names a thread (`statuses.thread`); only the policy module reads it (`conversationMutedSql`): the
presenter shows it in the viewer's `muted` of each status (a boost's own thread, as Mastodon gives a boost its own
conversation), and `notify` writes through `notifiedSql`, R15 less a notification about a status of a conversation
the recipient mutes (`NotifyService#conversation_muted?`; a reblog notification names the original). Listing and
pushes keep `shownSql`: a notification written before the mute stays, as Mastodon drops only new ones.

Endorsements (`src/domain/endorsements.ts`, Mastodon's `AccountPin`, migration `0014_account_notes_and_pins`) are
the accounts a local user features. An account is endorsed only while its endorser follows it (an accepted follow,
`AccountPin#validate_follow_relationship`): the trigger `account_pins_follow_ended` deletes the endorsement with the
follow, whatever ends it, as `Follow#remove_endorsements` does. They are public (R28): `GET
/api/v1/accounts/:id/endorsements` lists an account's to anyone, viewer or not, and `GET /api/v1/endorsements` the
viewer's own, by the same rule: nothing while the owner is unavailable, and of the endorsed accounts only the available
ones (`Account.without_suspended`). No block, mute or hidden network changes the list, as in Mastodon 4.5, whose
`Accounts::EndorsementsController` checks none. They are not federated: Mastodon 4.5's actor has no endorsements
collection. A private note (`account_notes`, Mastodon's `AccountNote`) is shown only to its author, as the `note` of
their Relationship with the account; no other path reads it (the architecture test below).

The profile directory (`src/domain/directory.ts`, `GET /api/v1/directory`, Mastodon's `Api::V1::DirectoriesController`)
lists the discoverable accounts that R12 lists to the viewer: `accounts.discoverable` is 1, a local account's setting
(`update_credentials`) or what a remote actor published (an actor that published nothing is not listed), and
`listedForSql` leaves out an unavailable account (R1) and, for a signed-in viewer, one they block or mute (while the
mute applies), one on a domain they block, and one that blocks them: Mastodon's `Account.discoverable` with
`not_excluded_by_account` and `not_domain_blocked_by_account` (Kopje has no silenced accounts and does not record that an account moved). A local account
is never on a blocked domain, so `local=true` changes nothing there, as in Mastodon. `order=active` orders by the
account's newest public, unlisted or private status (`accounts.last_status_id`, which the triggers of migration
`0021_directory` keep as statuses are stored, deleted or hidden), accounts without one last, then by id; `order=new` by
id. A page reads the partial index of its order (discoverable accounts only, all or local) from the start, a window of
`DIRECTORY_WINDOW` (2) times offset plus limit entries, judges each by key, and answers those R12 lists from the offset:
so it never reads an account that is not discoverable nor one below the window, and when more than half the window is
hidden from the viewer the page comes back short (a slice of the full directory, since the window is a prefix of it).
An offset above `MAX_DIRECTORY_OFFSET` (400) answers no accounts.

### Suggestions (R39)

Follow suggestions (`src/domain/suggestions.ts`, `GET /api/v1/suggestions` and `/api/v2/suggestions`, Mastodon's
`AccountSuggestions`) come from the one source Kopje has data for, friends of friends (`FriendsOfFriendsSource`): the
accounts the viewer's follows follow. A source is an accepted follow of the viewer's whose following R13 shows them
(`suggestionSourceSql`: available, not hiding its network, not blocking the viewer; Mastodon asks only the second, so
Kopje never counts an edge the viewer could not read in that following list, VIS-8). An edge is an accepted follow of a
source; its target is a candidate when `suggestionCandidateSql` passes (someone else, `accounts.discoverable` 1, no
follow by the viewer in either state, no dismissal) and R12 lists it (`listedForSql`: available, not blocked, muted
while the mute applies or domain-blocked by the viewer by stored domain or actor host, not blocking the viewer).
Mastodon also leaves out silenced, moved and memorial accounts, which Kopje does not record. Candidates rank by how
many counted edges reach them, then by `accounts.followers_count` (lowest first), then by id (newest first); the first
`SUGGESTIONS_KEPT` (40) are kept and a request answers `offset` and `limit` of them (`[]` from offset 40 on, where
Mastodon answers 500). A remote account's follower count is not learned (stored as 0), so at equal frequency remote
accounts come before local ones. There is no cache: the order is deterministic, so an offset is stable only while the
follows, blocks, mutes and dismissals stay as they were. v2 wraps each account as
`{"source": "past_interactions", "sources": ["friends_of_friends"], "account": ...}`.

The ranking is over a bounded graph, by windows of follow ids that the query reads as ranges of `follows_following`
(`account_id`, `id`), each from the id of its last entry, which a scalar lookup of that index finds, so the access
does not depend on the planner's statistics:

- sources: the viewer's `SUGGESTION_SOURCES` (1,000) accepted follows with the highest ids; one R13 hides takes its
  slot and brings nothing;
- edges: each source's `SUGGESTION_EDGES_PER_SOURCE` (100) accepted follows with the highest ids, each taking a slot
  whatever its target (the viewer, an account they follow or dismissed, a hidden or undiscoverable one);
- cutoff: the first `SUGGESTION_EDGES` (10,000) edges, sources by descending follow id and each source's edges by
  descending follow id, the order the two ranges give, so no sort holds them;
- candidates: the distinct targets of the kept edges that pass `suggestionCandidateSql`, each judged by R12 before the
  ranking, so a hidden account takes no place in it and cannot change who else is shown.

So the answer is not a prefix of Mastodon's: an edge outside a window is not counted, which can reorder two candidates
or bring in one Mastodon ranks lower (`test/suggestions.test.ts`, "ranks over the windowed graph"). What the windows
still let a viewer infer comes from the raw edge window, kept so: an edge to an account the viewer is not shown takes a
slot, so whether a candidate behind it is counted can tell the viewer that a source's newest 100 follows hold one more
account than its following list shows them (`followListedSql` leaves out an account that blocks them or that they block
or mute). It tells neither which account nor why; R12's judgment of the candidates themselves reveals nothing
(`test/suggestions.test.ts`, "judges every candidate before the ranking": the same edge to an undiscoverable or a
discoverable account blocking the viewer leaves the answer unchanged).

A dismissal (`DELETE /api/v1/suggestions/:id`, `dismissSuggestion`) stores a row of `follow_recommendation_mutes`
(migration `0050_follow_recommendation_mutes`) for an account Kopje knows (a legacy id resolves) and answers `{}`
whatever the id, as Mastodon does. Only its owner's suggestions read it; a remote account's purge deletes the rows
naming it in bounded batches.

A scheduled status (`src/domain/scheduled-statuses.ts`, migration `0011_scheduled_statuses`) is not a status: it is
a row of `scheduled_statuses` with the post's parameters, and its owner's alone (R26, `scheduledOwnSql`). No read,
notification or delivery path reads that table (the architecture test below), so nothing of it is listed, notified or
sent before it is published. The cron publishes it, when it is due, through `preparePost` and `writePost` in
`src/domain/statuses.ts`, the path of an immediate post, in the transaction that deletes the row; from then on it is
an ordinary status under the rules above. The uploads it will attach are held (`media_attachments.scheduled_status_id`),
so no other post attaches them and the sweep of unattached uploads leaves them. `test/scheduled-statuses.test.ts`
("nothing leaks before publication") schedules generated posts of every visibility, with mentions and replies, and
checks after each that no other table changed and that each account sees only its own.

A poll (`src/domain/polls.ts`, migration `0013_polls`) is shown with its status, to whoever may see the status, and
its API id is its status's: `GET /api/v1/polls/:id` and its votes answer 404 for a poll on a status the viewer may
not see by itself (R3). Who may vote is R27 (`mayVoteSql`, Mastodon's `PollPolicy#vote?`): the status is viewable and
the voter blocks neither its author (an author who blocks the voter hides it already) nor the author's domain
(where the vote would not be delivered); a remote vote, a Note naming a
choice in reply to a local poll, passes the same rule (Mastodon checks none for it) and is never stored as a status.
Votes are their voters' own: a poll shows its counts (`votes_count`, `voters_count`, and each choice's, which
`hide_totals` hides from everyone, the author included, until the poll ends, as `Poll#show_totals_now?`), and the
viewer's own votes (`voted`, `own_votes`), never who voted. The counts are kept as votes are cast, never recounted on
read. A poll's end notifies its local author and local voters (`poll`, from the poll's author; R15 applies, with the
author's own poll the one notification from oneself). Its `Question` goes to its status's audience (R23), and its
Update of counts also to the remote voters of a public or unlisted status; a local vote in a remote poll goes to the
poll's author alone.

A report (`src/domain/reports.ts`, Mastodon's `Report` and `ReportService`, migration `0022_reports`) is its
reporter's (R34): it is stored for the instance's moderation and answered once, to its reporter, and nothing else reads
it (the architecture test below) but the OAuth admin of the Mastodon admin API (R37). That admin lists every report,
newest first, by state, reporter and reported account, and resolves, reopens, assigns and re-categorizes them; each such
write is recorded in the moderation log in its transaction. The admin is shown a report's statuses only while its
reporter may still see them by the rule the report was made under (R11, the reporter as the viewer); Mastodon shows
them all, deleted ones included. A resolved report shows `action_taken` to its reporter. It names an available account (any other is not
found) and only statuses of that account the reporter may see by the account statuses rule (R11, `accountStatusIds`):
one they may not see, or of another account, makes the whole report not found, as Mastodon's `.find` does. Unlike the
profile read, the reporter's own block of the account hides nothing there, as `AccountStatusesFilter#blocked?` is the
account's block of the reporter alone. Forwarded, the report becomes a `Flag` from the instance actor (so it names no
local account), carrying the reporter's comment and the uris of the account and its reported statuses, to the
servers Mastodon chooses (`reportForwardees`, R23, below). A reported status deleted later stays named by its id;
a remote account's purge deletes the reports of it, and the notification of each before it.

A remote server reports by a `Flag` (Mastodon's `ActivityPub::Activity::Flag`): its actor, a remote account, is the
reporter, and each local account it names (or remote one, with a named status replying to a local account) gets a
report under the Flag's id, once. Its named statuses are attached by the remote reporter rule (`remoteReportableSql`,
Mastodon's `ReportService#reported_status_ids` for a remote source): the reported account's originals that are public
or unlisted, private ones while the account has an accepted follower on the reporter's domain (two bounded probes), and
any that itself mentions an account there. The admin is shown them while they still pass; the report's `status_ids`
keep what was admitted. A domain block with `reject_reports` refuses the Flag, and one actor's unresolved reports are
capped (RES-7).

A report also notifies the OAuth admin (`admin.report`, Mastodon's `ReportService#notify_staff!`) when no other report
of the same account is unresolved; the notification carries the report as its reporter sees it, and R15 shows it to
the current admin alone (R37): it leaves every read, stream and push when `admin_email` changes, and comes back with
the match. The admin's own report notifies nobody (R15: not from oneself). Each report has its own notification
(migrations `0040_report_notifications` and `0041_report_notifications_key`), also several of one reporter.

The same admin, once Kopje grants it manage_users (with local suspension, PR A3b; until then the routes refuse it as
everyone), lists every account, local and remote, through `GET /api/v1/admin/accounts` and `/api/v2/admin/accounts`
(R37, `src/domain/admin-accounts.ts`), and shows one: a local account with its email and role, a remote one with the
fields of a missing user null, and an unavailable account (R1: a suspended local account, or a remote one whose
deletion has started) as suspended, its nested account redacted as everywhere. The filters are Mastodon's
(`AccountFilter`), read as each version's controller reads them, and Fedilab's v1 names sent to v2 are read as v1's.
`enable`, `unsilence` and `unsensitive` change nothing and are logged; `approve` and `reject` are refused.

The admin suspends a local account other than its own (`POST .../action` with `suspend`, `src/domain/suspension.ts`),
which makes it unavailable (R1) at once, and unsuspends it. The suspension refuses every token and code issued before
it, also after the unsuspension (the credential epoch, which a suspension moves and an unsuspension keeps), resolves the reports on the account frozen at its time, and sends an
`Update` of the redacted actor; the unsuspension sends one of the full actor. Both go to the audience of Mastodon's
`AccountReachFinder` (R23, `reachFollowers`, `reachMentioned` and `reachFollowing` in `audience.ts`): the accepted
remote followers, the remote accounts its newest 200 statuses of the two days before the suspension mention (at most
2,000), and the remote accounts it followed or asked to follow in those two days (at most 2,000 of each). The `Update`
is neither content nor a retraction, so no one is left out. While the account is suspended, its lanes send only
retractions and that `Update` (R1 above).

The admin also suspends a remote account (R38, `src/domain/remote-suspension.ts`, migration `0045_remote_suspension`),
as Mastodon's `SuspendAccountService` for a remote account: it is unavailable (R1) from the suspension's commit, shown
redacted and as suspended (presentation reads availability live, in the query that reads the row), listed under
`status=suspended` and not under `active`, and unsuspended through `POST .../unsuspend` (403 when the instance did not
suspend it: not suspended, or only being deleted). Kopje does not fetch the account again at unsuspension, as Mastodon
does. The suspension resets the account's one job row (`remote_moderation_jobs`) in its transaction, freezing the
newest follow, report and moderation log id; each round first requires that the account is still individually
suspended, so an unsuspension ends the job, and a suspension again restarts it. The job resolves the reports frozen
at the suspension (VIS-29's fence), then ends the account's follows of local accounts up to the follow bound: an
accepted follow with a withdrawing `Reject` (VIS-3, a retraction, so neither admission nor the send-time check
refuses it), a request by deleting it without one. The `Reject` goes to the follower's current inbox alone (its shared
inbox when known, else its personal one), as Mastodon's `RejectFollowService` and `reject_remote_follows!` send it,
not to the earlier receivers of the `Accept`s it withdraws: a Follow's answer matters to the follower's server only.
Before it is recorded, the job supersedes those earlier `Accept`s in bounded steps, so none still waiting is sent after
it. Local accounts' follows of it are kept; their `Follow` and any other content to it is dropped at send time
(VIS-30). Each round writes at most `MODERATION_ROUND_ROWS` rows: a follow notification's push deliveries are deleted
in bounded steps before the follow ends.

Unsuspending an account that a `suspend` block still covers answers 200 and converts the suspension: the
account keeps `suspended_at` with `suspension_source = 'domain'`, so it stays unavailable and the entity shows
`suspended: true`, and the same transaction resets its job to mode `domain` with a fresh follow bound. In that mode
each round requires the domain mark and live coverage, and the job severs both ways, as the domain job severs a
covered account (below). Suspending it again sets mode `account` back, which keeps local follows of it; a stale mode
ends the job at its next round. An account held only by a domain mark answers 403: lowering the block lifts it.

Inbound, the gate runs in every round after the deleted-actor check and before the actor upsert: a verified document
of an individually suspended actor updates only its inbox and shared inbox, so the job's `Reject` reaches a current
inbox; then only its `Delete`, `DeleteActor`, `Undo` and `Reject` apply, with its stored row, which only remove state
(a `Reject` of a local follow of it must apply, since those follows are kept). Mastodon also applies its `Update`;
Kopje does not. `upsertRemoteActor` never refreshes an unavailable account's profile, keys or domain, on any path
(search resolution, quotes, Announce originals, Move targets), and `storeRemoteStatus` stores nothing of an
unavailable author.

## Filters

A viewer's filters (`src/domain/filters.ts`, Mastodon's `CustomFilter`) are applied after the rules above, to what that
viewer is shown and to nobody else's reads. They are not a visibility rule and are not in `audience.ts`: a read first
selects what the rules let the viewer see, and the presenter then reports, in each status's `filtered`, every active
(unexpired) filter of the viewer that matches it, whatever its context and action (`warn`, `hide`, `blur`), as
Mastodon's `StatusRelationshipsPresenter` does; a boost and its original report the same. Nothing is removed on the
server: the client decides by context, so pages and cursors are those of the read. A filter matches a status by a
keyword in its spoiler text, text (a remote status's lines as Mastodon's `PlainTextFormatter` extracts them), poll
choices or media descriptions (of the original, for a boost), with `whole_word` as Mastodon's regex reads it, or by a status it names
(the status or, for a boost, its original). A filter status can be added only for a status the viewer may view
(`canView`); one they may not view is refused as a missing one is, and a filter status is listed by its ids alone,
whatever the viewer may see of it later. `test/policy-filters.test.ts` checks the endpoints on generated worlds against
a model of the matching. Matching is bounded: each status is matched on at most 10,000 code units of its text, and the
statuses of one response on 400,000 together, by water-filling (short texts whole, long ones up to one level), so a
keyword deep in a long status of a very large response may be missed; filter statuses always match.

## Outbound recipients

`recipientsFor(db, signer, activity, audience)` decides whom an activity of a local account reaches (R23), and
`addresses(db, kind, signer, x)` whether it names an addressed account (R22). Both read the activity's kind,
`outboundKind(activity)`:

| Kind       | Activities                                                                                           | Followers                                                                                | Addressed accounts                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| content    | `Create`, `Update` of a status, `Announce`                                                           | accepted remote followers, less unavailable ones and those on a domain the signer blocks | remote, less unavailable ones and those the signer blocks or domain-blocks |
| retraction | `Delete`, `Undo` of anything, a `Reject` that ends an accepted follow                                | every accepted remote follower                                                           | every remote account of the audience, blocked or not                       |
| other      | `Update` of the actor, `Like`, `Follow`, `Accept`, a `Reject` of a request, `Block`, `Add`, `Remove` | every accepted remote follower                                                           | every remote account of the audience                                       |

A retraction also reaches every inbox that received what it withdraws, or may still: the receipts of its status, and
the delivery rows and unexpanded targets of earlier activities about it (`receiversOf` in `deliveries.ts`). So a
`Delete` reaches a follower who has left or been blocked since, and the `Undo` of a boost names and reaches the
original's author even when the booster blocks them or their domain (its `Announce` left them out).

A `Flag` (a forwarded report, kind other) is addressed to the accounts `reportForwardees` gives, as Mastodon's
`ReportService` chooses them: the reported remote account when its domain is among `forward_to_domains` (by default its
own), and the remote accounts on those domains that the reported statuses reply to, less any whose inbox is one of the
reported account's. It is the one activity signed by the instance actor rather than its lane's account (DATA-7).

The rule for activities that are neither content nor retractions is Mastodon 4.5's: none of them is filtered by
block or domain block. `FavouriteService`, `FollowService`, `BlockService` and `RejectFollowService` send to the
account's inbox, and `ActivityPub::UpdateDistributionWorker` sends a profile `Update` to `followers.inboxes`
(`AccountReachFinder`). A domain block instead ends the follows with the domain (`AfterBlockDomainFromAccountService`,
the cleanup in `blocks.ts`); until the cleanup reaches a follower there, it is sent profile changes but no content.

`audienceTargets` turns the recipients into targets: followers and accounts named in `to` or `cc` by shared inbox,
a silent recipient of an addressed activity by a copy of its own at its personal inbox (VIS-2), and the recipient of
an activity without `to` by shared inbox, else personal inbox. No other SQL turns follows into inboxes or reads an
account's shared inbox (the architecture test below).

### Instance domain blocks (R38, VIS-30)

The instance's own domain policy (`instance_domain_blocks`, migration `0046_instance_domain_blocks`; Mastodon's
`DomainBlock`), written by the Store operations of `src/domain/instance-domain-blocks.ts`, each in one transaction
that fetches nothing. A block names a domain, stored as `blockedDomain` returns it, with severity `suspend` or `noop`.

- **The admin API.** The OAuth admin (VIS-29) lists, shows, creates, updates and deletes blocks through
  `/api/v1/admin/domain_blocks` (`src/domain/admin-domain-blocks.ts`), each write logged in its transaction. Beyond
  Mastodon's refusals, a create or update answers 422 for severity `silence` (not built; also Mastodon's default when
  none is sent), for `reject_media=true` (no remote media cache to reject from), and for a comment longer than
  `MAX_BLOCK_COMMENT` (1,000) characters, which bounds a page of `MAX_DOMAIN_BLOCKS_LIMIT` (500) blocks. The domain is
  validated on create only, since an update never changes it: a raw domain longer than `MAX_DOMAIN_INPUT` is refused
  before it is normalized, a normalized one beyond Mastodon's 255 characters or 63 per label is invalid, and one
  deeper than `MAX_BLOCK_LABELS` is refused before any ruling block is looked up. `reject_reports` is stored and shown, and changes nothing:
  Kopje receives no remote reports. `obfuscate` changes only how the public block list shows the domain.
- **The public block list** (`GET /api/v1/instance/domain_blocks`, `publicDomainBlocks` in
  `src/domain/instance-domain-blocks.ts`; Mastodon's `Api::V1::Instances::DomainBlocksController`). A suspended
  user's token is answered 403 (`Your login is currently disabled`) first, whatever the settings. Then the setting
  `show_domain_blocks` decides: `all` lists to anyone, `users` to a user's valid token, `disabled` (also when unset)
  to no one, with Mastodon's empty 404. An unknown, expired or stale token and an app token read as anonymous. The
  list holds the suspend blocks only, never a noop, in domain order (SQLite's binary order), each as
  `{domain, digest, severity, comment}`: `domain` obfuscated as Mastodon's `DomainBlock#public_domain` when the block
  has `obfuscate`, `digest` the SHA-256 of the stored domain, and `comment` the public comment when
  `show_domain_blocks_rationale` shows it to the viewer by the same rule, else null. The private comment is never
  shown. The digest lets anyone test a guessed domain, as on Mastodon: obfuscation is not secrecy.
- **The measure `instance_follows`** (`src/domain/admin-measures.ts`), which Fediblockhole reads before a block
  stricter than silence, counts the accepted follows of the domain's accounts (with `include_subdomains`, of its
  subdomains' too). It walks from the local accounts (a `CROSS JOIN`, so a remote account's follow of a local one is
  never read) through each one's accepted follows (`follows_accepted`), reading each target by key, at most
  `MEASURE_FOLLOWS` (20,000) rows, and answers 422 beyond that, never an undercount. Its series has at most
  `MEASURE_DAYS` (366) points, so at most 368 grouped rows leave SQLite, and a request names at most
  `MAX_MEASURE_KEYS` (16) keys, each repeating the series, so the answer stays under 400 KB. The total falls as the
  domain job severs a blocked domain's follows.

- **Precedence.** The rule of a host is the block on the host itself or on its nearest parent, the longest match
  (Mastodon's `DomainBlock.rule_for`). A host is covered when its rule is a `suspend`, so a child `noop` exempts its
  subdomain tree from a parent's `suspend`. Creating a block follows Mastodon's refusals: a domain already blocked, or
  one whose ruling block is at least as strict (`stricter_than?`).
- **The label bound.** A stored block has at most `MAX_BLOCK_LABELS` (8) labels (the table's CHECK; the create
  operation refuses a deeper one), so a host's rule is among its suffixes of at most 8 labels, and a deeper host is
  still matched by them. `hostCoveredSql` walks a host's suffixes from the longest and stops at the first one a block
  names: at most two unique seeks per suffix of 2 to 8 labels.
- **Availability.** `availableSql` makes a remote account unavailable when a block covers either key `inDomainSql`
  compares (its stored domain or its actor id's host), read live in every statement; no mark is read. While the
  instance has no `suspend` block the rule costs one constant seek per predicate a statement emits, and its `CASE`
  skips the walk in a result column too; otherwise it reads the account's row by its key and walks each key. Account
  presentation reads the same rule with the row (`availableJoinedSql`).
- **The domain job and its marks.** A write that moves the hosts a block's domain rules into or out of `suspend`
  coverage resets one `remote_moderation_jobs` row (kind `domain`) in its transaction, freezing the newest follow as its
  bound. Rounds reconcile the domain marks (`suspension_source = 'domain'`) with the live blocks; marks serve the
  admin's lists only, while availability reads coverage. Two walks:
    - **clear:** the suspended accounts by id (`accounts_suspended`, which holds every mark whatever the account's
      domain is now); a mark no block covers any more is cleared. A permitted refresh of a marked account
      (`upsertRemoteActor`, which stores only an uncovered account) clears its stale mark in its own transaction.
    - **mark** (only while a `suspend` block exists): every account by id, `MARK_WINDOW` (2,000) a round, the predicate
      evaluated for each remote one. A covered account that is not individually suspended is marked if it is not yet,
      and severed both ways up to the bound, marked or not: its follows of local accounts (an accepted one with a
      withdrawing `Reject`, a request deleted without one) and local accounts' follows and requests of it (each with
      its `Undo`), through `severFollow` with the account job's preparation. Before a local follower's follow ends,
      the preparation removes the account from that follower's lists, writing at most the round's room (about 259
      rows) a round, so the follow's final delete writes no list row. Its reads are not bounded the same way: each
      preparatory step, and the final delete's trigger (`list_members_follow_ended`), scans all of the follower's
      lists, O(L) for L lists. That is the follower's own data, at most 50 lists through the API (always removed in
      one round), and unbounded only for legacy lists a converted instance imported. At most `MARK_ACCOUNTS` (100) accounts are reconciled a round,
      one resumed from the round before included. An individually suspended account is skipped, so its local follows
      are kept (`account` wins). **Limit (imported lists):** the memberships are removed before the follow ends,
      and nothing restores them. A follower imported with more than about 259 lists that include a covered account
      needs several rounds for them; if the block is lifted meanwhile (an unblock, or a conversion back to an
      individual suspension), the follow can survive with some of those list memberships removed.

    No account is stored or moves into a covered domain, so the last walk after the last reset finds every covered
    account, and whatever the order of transitions and rounds, marks and severing agree with the blocks once the job
    ends. Severing is never reversed, as in Mastodon. Every round reads at most `MARK_WINDOW` accounts or `CLEAR_ROUND`
    (500) suspended accounts, and `SEVER_ROUND` follows, and writes at most `MODERATION_ROUND_ROWS`.

- **The admin's lists.** `status=active` walks `accounts_active` and `status=suspended` `accounts_suspended`, which
  hold or leave out marked accounts; while the domain job exists both answer 503 with `Retry-After: 30` and the error
  "moderation in progress, try again", never a short or empty page. Searches, which filter by the live rule, are not
  affected.
- **For operators: how long marking takes.** On the benchmark store (1,000,000 accounts over 1,000 domains, in
  workerd's local SQLite), a round walking 2,000 accounts took 7 to 9 ms (at most 36 ms at the 99th percentile), so a
  walk of the whole store is about 500 rounds and 3 to 6 s of Store time; each Queue message runs 4 rounds, so the
  walk is about 125 messages back to back, and the lists answer 503 that long. A block covering many accounts marks
  about 100 a round (8 ms each): about 10,000 rounds, 80 s of Store time and 2,500 messages per million accounts it
  covers. The cron resumes the rounds if a message is lost.
- **Deliveries.** The send-time check below refuses a covered inbox host, and a row all of whose listed hosts are
  covered; retractions still go.
- **Fetches (advisory).** The Worker asks the Store before each request, a redirect's included (`fetchRefused`), and
  makes none to a covered host: search resolution, `Announce` originals, keys, owner documents, collection syncs and
  quote rounds. A block that commits between that read and a request costs that request, whose result the writes
  refuse.
- **Writes.** `upsertRemoteActor` stores no account whose actor host or domain is covered and refreshes no covered
  row (not even its routing), so no account moves into a blocked domain; `storeRemoteStatus` refuses an unavailable
  author, so nothing of a covered account is stored.
- **Inbound.** For an actor on a covered host, or whose stored account is covered (judged from the activity's
  envelope, whatever its type), the Worker ignores everything but `Delete`, `DeleteActor`, `Undo` and `Reject` before
  any fetch, and verifies those only against a key the Store already holds, of any age, with no fetch (a rotated key
  fails). The Store's gate holds such an actor in every round, as it holds an individually suspended one, without the
  routing refresh; an actor of a covered host with no stored row is ignored. An envelope that names no single actor,
  id and type (an actor array included) is checked with stored keys only and never causes a fetch: without a valid
  signature under a stored key it is refused (401, ID-1), and with a key id the Store does not hold it is ignored.

### The send-time check (VIS-30)

Each target also records the recipients behind it, so the check below can tell whose inbox it is: an inbox says
nothing about the accounts it serves, and may be on another host than theirs. `recipientsFor` returns recipients (each
one's id and the host of its actor id) rather than distinct inboxes, at most 34 per inbox: the first 17 by id and the
first of each of the first 17 hosts, enough to tell either overflow. `targetsOf` merges them per inbox across
followers, addressed accounts, silent recipients, poll voters and `reachOf` before deduplicating, keeping at most 17
accounts and 17 hosts per target. A target lists up to 16 accounts and their hosts; above 16 accounts it is marked
`many` ("not all unavailable"), and above 16 hosts it lists none. A target that also serves an inbox with unknown
recipients (a retraction's earlier receivers) has none.

At the claim, and again at confirmation right before the POST (`confirmDelivery`), a row that is not a retraction is
dropped when:

| Rule     | Refused when                                                                            |
| -------- | --------------------------------------------------------------------------------------- |
| sender   | the signer is unavailable (R1), but for its own suspension `Update`                     |
| inbox    | an instance domain block covers the inbox's host                                        |
| accounts | it lists accounts, and none of them exists and is available (R1)                        |
| domains  | it lists hosts, and an instance domain block covers every one                           |
| original | it is an `Announce` whose boosted original is gone, or whose author is unavailable (R1) |

`availableSql` reads an unknown id as available, so the accounts rule joins `accounts`: a purged recipient counts as
gone. A recipient the instance suspended (R38) is unavailable, so content to its personal inbox, or to a shared inbox
serving only suspended recipients, is dropped; a shared inbox that also serves an available recipient is sent (the
suspended one is left out of the content's audience already). A row without provenance gets the sender and inbox
rules only. Retractions are never dropped. A recipient covered only through a stored domain that differs from the host
its provenance lists counts as not covered at a shared inbox, as a mixed inbox does; a row without provenance to a
gateway inbox for a blocked domain is judged by the gateway's host. The oracle's `sends` in `test/policy-model.ts`
states the rule.

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

    A branch may also be a `TagWindows`, a window of each followed hashtag's statuses (home's), in the same form with
    `(<tags>) g` selecting each hashtag once as `name` and `<tag> = g.name` in the window's WHERE; a hashtag has no rule
    of its own, so every status of its window is judged by the rule.

- `authorShown(db, rule, { author, and })` decides that part of the rule for one author, with `and`, before a read of
  that author's statuses alone, which can then return nothing without reading them.

- `notifications(db, parts)` selects `n.status_id` and further columns from `notifications n`, with `shownSql` (R15,
  the viewer as the recipient, which shows a status only if they may view it) as the rule. It reads the viewer's
  notifications only, within the parts' cursor (`range`) and above the viewer's clear, of one group (`group`) above its
  dismissal, or of every group each above its own; with `within`, the candidates of a window alone.
  `notificationWindow(db, parts)` reads those candidates: the same rows without the rule and the per-row dismissal.
- `authorRule(rule, author)` is the rule over the author as SQL, for a window's author-level exclusion.

The rule is a conjunct of the SELECT's own WHERE, over the `statuses s` whose id it selects, so no condition, subquery,
join or `WITH` table of the caller's can stand in for it. The reader and the fragments name their tables with the
`main.` schema, so a `WITH` table named `statuses` or `blocks` cannot take their place, and a further column is a plain
identifier other than the id column (`id`, or `status_id` for notifications), refused by the types and at run time.
The caller's conditions go before (`where`) or after (`and`) it, in the order a hand-written query would give them, so
the terms, the plan and the rows read are the same. Each query runs only with its parameters at `viewer` and `now`
bound to the context's account id and time. `viewableStatusId` is `canView` (R3) for one id. `ownStatusId` checks the
author. The callers:

| Caller                                                     | Ids from                                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| home (a page)                                              | `select` under `homeFilter` of its window's candidates; positioned (R33): the `union` of `AuthorWindows`, own and `TagWindows` narrowed to the status |
| list timeline                                              | as home: its window's candidates, or the narrowed `union` of one `AuthorWindows`                                                                      |
| public and tag feeds, bookmarks and favourites, context    | `select` under `listable` (feeds and edges: of their window's candidates)                                                                             |
| account statuses                                           | `authorShown`, then `select` under `visible` of its window, with `visibleSql` and `filteredForSql` for an original                                    |
| status search                                              | `select` under `listable`, with its candidates as a `WITH` table                                                                                      |
| notifications (list and one, groups, unread counts)        | `notifications`, with `includeFiltered`                                                                                                               |
| web profile and status pages                               | `select` under `visible` with no viewer; the parent through `viewableStatusId`                                                                        |
| conversations (list, read, unread)                         | `select` under `visible` of each last status                                                                                                          |
| single status, history, actions (favourite, bookmark, ...) | `viewableStatusId`                                                                                                                                    |
| search resolution                                          | `viewableStatusId`, after the domain block of the author                                                                                              |
| post, edit, delete, boost (and their repeats)              | `ownStatusId`, then `presentOwnStatus`                                                                                                                |

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

`test-node/policy-boundary.test.ts` reads the source tree (as `test-node/layering.test.ts` does) and fails when SQL
outside the policy module:

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
- reads or writes `scheduled_statuses` outside `scheduled-statuses.ts`, whose every read is the owner's
  (`scheduledOwnSql`, R26).
- reads or writes `poll_votes` outside `polls.ts`, which shows only counts and a viewer's own votes (R27).
- reads or writes `tag_follows` outside `tags.ts` and home's windows in `timelines.ts`, each the viewer's own (R29).
- reads `conversation_mutes` outside the policy module, except `status-actions.ts`, whose unmute deletes the viewer's
  own mute (R31).
- reads or writes `follow_recommendation_mutes` outside the policy module (`suggestionCandidateSql`, R39), except
  `suggestions.ts`, which writes the viewer's own dismissals, and `inbox.ts`, whose actor purge deletes the dismissals
  of the account.
- reads `account_notes` outside `accounts.ts`, which reads only the viewer's own (R28) and writes them, and `inbox.ts`,
  whose actor purge deletes the notes on the account.
- reads or writes `reports` outside `reports.ts`, which writes the reporter's report and answers it once (R34), files
  a remote reporter's (`fileRemoteReports`), serves the OAuth admin's reads and actions (R37) and walks an account's
  reporters for a suspension's reach (`reachReporters`), and `inbox.ts`, whose actor purge deletes the reports of the
  account and by it.
- reads or writes `quotes`, `quote_revocations` or `quote_requests` outside `quotes.ts`, which stores and verifies
  received quotes, applies the `Delete` of a stamp (ID-6), answers QuoteRequests, serves and revokes Kopje's
  authorizations (VIS-28) and reads the quotes list's window, `inbox.ts`, whose batched delete of a status detaches the
  quotes of it and deletes its own, and the policy module, whose `quoteReads` is the only read of a quote for a client
  (R35) and `reachQuoters` the only one for an audience.
- writes `status_mentions` outside `statuses.ts`, `remote-statuses.ts`, `inbox.ts` and `quotes.ts` (an accepted
  QuoteRequest's silent mention of the quoted author).

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

## Read bounds

A paged read whose rule hides rows reads a candidate window (`src/domain/windows.ts`; RES-7 in the threat model):

- From its cursor, in cursor order, it reads at most a fixed number of candidates through an index, with its request's
  own conditions (types, hashtags, media, the follow relation of the stream) but without the rule.
- It applies the rule to those candidates alone, each by its key, and returns the first that pass, at most a page.
- The page may be short or empty. When the window ended before the cursor's range did, the page's far end is the
  window's last candidate (or the last item of a full page), and the next link is offered whatever the page holds
  (`Page.cut`), so paging moves on by the window and reaches what lies behind any hidden range. `min_id`, `since_id`
  and the `prev` link keep Mastodon's meaning. Mastodon paginates its quotes list before it filters, and does the same.
- A merged read (home, a list, a hashtag timeline's names) reads at most `streamWindow` candidates per stream and
  merges them up to the highest end of a stream that filled, at most `readWindow`, so no candidate below a stream's end
  is passed over. A read positioned at a status (`max_id` just above it, `limit` 1) has it as its first candidate, so
  the narrowed reads of R33 return it exactly when the positioned read does.

The cursor rule: a row hidden from the viewer by its own visibility or audience (private, direct or limited that they
may not see, a boost of such an original, a status of an author on whose blocked domain a remote viewer lives) is
never a candidate, so it never supplies a cursor, a Link id or any other id in a response. Candidate queries keep it out
with `audienceSql` (the row's visibility and audience, and its original's, without availability or filters), or with
`visibility IN ('public', 'unlisted')` for anonymous pages; a follower or interactor that blocks the viewer is left out
of their candidates too. A candidate may be hidden only by availability (an account being deleted or suspended), by
the viewer's own blocks, mutes and domain blocks, by a follow's options or the home filter, or, for rows the viewer
owns (their notifications, bookmarks, favourites, notification requests, list members, endorsements), by the rule over
what the row names: the viewer already knows their own relations and rows, and Mastodon paginates before filtering
there. Where a read cannot keep rows hidden by visibility out with an index, it walks past them: such rows cost
their number, never a cursor.

The windows, for a page of `limit` (`readWindow(limit)` = max(3 × limit, 40); `streamWindow(limit)` = max(2 ×
limit, 40); statuses page by 20 and at most 40, accounts and notifications by 40 and at most 80):

| Read                                 | Window                                                                                                        | What its candidates may hide                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| home                                 | `streamWindow` per followed account, mention stream, own and followed hashtag; merged `readWindow`            | availability of a boosted original, filters, follow options, home filter |
| list timeline                        | `streamWindow` per active member; merged `readWindow`                                                         | as home                                                                  |
| public timeline                      | `readWindow`, on `statuses_public`                                                                            | availability, the viewer's filters, a blocking author                    |
| hashtag timeline                     | `streamWindow` per name (at most five); merged `readWindow`                                                   | as the public timeline                                                   |
| account statuses                     | `readWindow`, on `statuses_account`, within the audience                                                      | availability or filters of a boosted original                            |
| bookmarks, favourites                | `readWindow` of the viewer's edges                                                                            | the rule over the status the viewer saved                                |
| notifications (v1)                   | `readWindow` of the viewer's notifications                                                                    | R15                                                                      |
| grouped notifications, unread counts | at most `GROUP_WALK` (2,000) per page or count; a group's count, samples and oldest among `GROUP_COUNT` (400) | R15                                                                      |
| a group by its key                   | its own notifications, at most `GROUP_DISCOVERY` (20,000; see below)                                          | R15                                                                      |
| a group's accounts                   | `readWindow` of the group's notifications                                                                     | R15                                                                      |
| notification requests                | `readWindow` of the viewer's requests                                                                         | an unavailable sender                                                    |
| followers, following                 | `readWindow` of the account's accepted follows                                                                | the viewer's blocks and mutes                                            |
| `favourited_by`, `reblogged_by`      | `readWindow` of the status's favourites or public boosts                                                      | availability, the viewer's filters                                       |
| list members, endorsements           | `readWindow` (1,000 answered without a page, within 8 MiB of accounts (RES-3): 3,000)                         | availability                                                             |
| profile web page, outbox             | `readWindow` of 21 (63), public and unlisted only                                                             | availability of a boosted original (outbox)                              |
| quotes list (statuses.ts)            | a page of accepted quotes; for anyone but the quoted author, within the audience (stricter than Mastodon)     | R8, or R2 for the quoted author                                          |

Showing one group by its key (`GET /api/v2/notifications/:group_key`) is the one read with no cursor to resume from:
it walks at most `GROUP_DISCOVERY` (20,000) of that group's own notifications, through `notifications_group`, to find
its newest shown one, and a group whose newest 20,000 notifications are all hidden answers 404 even when a page of the
list shows it. The limit is deliberate: an unbounded walk would let a hidden range cost a request its whole length,
which these bounds exist to prevent, and Mastodon's API gives a group show no token to continue from.

Following and the interactors read their windows through the indexes of migration `0043_read_window_indexes`, in id
order. Reads bounded otherwise: search (2,500
per library source), the directory (`DIRECTORY_WINDOW`), the admin lists (their residual budget), context (its
traversal cap), conversations (no rule before `LIMIT`), and the blocks, mutes, domain blocks and follow requests lists
(no rule before `LIMIT`). The link timeline answers an empty list.

Suggestions read their windows ("Suggestions" above) through `follows_following` as ranges, with fresh statistics and
with statistics taken before a source grew to 100,001 follows (`test/suggestions-bounds.test.ts` checks the plan in
workerd: the source and edge ranges, and no sort under the edges). Their rows read grow below each window's bound and
stay within 10 past it: a source's follows from 100 to 100,000, the viewer's from 1,000 to 2,000 with the newest
sources the same, and from 100 to 1,000 saturated sources only by the lookup of the source window's bound, one entry
per source. Every candidate is judged, so the work grows with the distinct candidates up to 10,000, not with the graph:
75,244 rows with 1,000 sources of 10 distinct candidates each, fewer as the viewer hides more of them (a mute ends R12
early), and 315,844 at the measured maximum, where every source and candidate is on a domain of eight labels with its
actor id on another such host and the instance has a suspend block, so each walks every suffix of both keys
(`availableSql`), each keeps a stale domain mark and the viewer's mute of each candidate has expired, each read and
passed. The ranking returns at most 40 ids.

A cursor range is a direct range (`id < coalesce(?2, ':')`, `edgeRangeSql`), never `(?2 IS NULL OR id < ?2)`, which
no index can seek; `test-node/range-predicates.test.ts` checks every statement in `src`.

`test/read-windows.test.ts` checks that every windowed read stays bounded in front of hidden ranges of each kind,
that paging by `max_id` and by `min_id` reaches every visible row on both sides once, in order, and that no response
field names a status, blocking follower or interactor the viewer may not see.

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
test/policy-oracle.test.ts` replays it. Worlds also hold local accounts' pins of their own statuses and their conversation mutes, and
`notifiedSql` and `conversationMutedSql` are checked as `shownSql` is. Worlds hold quotes in every stored state
(legacy quotes, self-quotes and gone quoted statuses among them) and policies with any flags; `quoteReads` (R35), with
and without the source, and `quotePolicySql` (R36) are checked for every viewer with every status.

`test/policy-bounds.test.ts` takes one generated world, for a fixed seed, in which every endpoint below shows the viewer
something. It runs home, the public and tag feeds, account statuses, notifications (the list, a page of groups, a group
and its accounts, and both unread counts), context, conversations, favourites, bookmarks, `favourited_by`,
`reblogged_by`, relationships (with the viewer's endorsement of and note on each account), the followers and following
of an account (one that no unrelated account follows), a list's timeline (a list of every account of the world), the
viewer's timeline markers, status and hashtag search, the viewer's scheduled statuses, the viewer's endorsements (of
every account it follows) through both endpoints, the world's accounts by id, the viewer's suggestions (an account
outside the world that one of its follows follows), and account search among the viewer's follows (a search of every
account reads the newest accounts the instance knows, a window that grows with them up to its limit) on that world
alone, and again with 1,000 unrelated remote accounts and 100 unrelated local ones: their statuses (never public, though
they carry the hashtag the tag feed reads), replies and boosts, their follows, blocks, mutes and domain blocks of the
world's accounts and domains, their favourites, bookmarks and notifications, their exclusive lists of the world's
accounts and their own, their endorsements of and notes on those accounts, and their timeline markers and scheduled
statuses, together with the viewer's own blocks and mutes of those accounts and domain blocks of domains nobody lives
on. Each endpoint must show the same with them as without (the same statuses, accounts, notifications and hashtags in
the same order, and the same relationship flags), and the rows it reads (RES-7) may grow by at most 10 (home by 11: each
followed hashtag's window judges its statuses again, and the probe of the viewer's blocks and mutes reads the next index
entry, which the unrelated accounts provide; the same with ten times the unrelated rows). A second case grows the
history of each author home and a list read instead: the viewer, who follows seven accounts and has a list of them, and
those accounts, from 60 statuses each to 2,000, one of the accounts posting only direct statuses addressed to another
account. The newest page, a page from the middle of the longer histories and the oldest page of home and of the list
must each be full and read at most 10 rows more. A third case does the same for the conversation list, with 20 or 2,000
conversations of the viewer, each a thread of three direct statuses.

A third case grows the generated world's own history: the same world with every status replicated 100 and 400 times,
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
dominate. Another case grows the accounts that hold scheduled statuses, from 10 to 300 with 30 each: the viewer's
page of scheduled statuses, the listing of the due ones and the publication of one must each read at most 10 rows more.
A last case grows the histories the viewer never sees, from 20 statuses each to 2,000: an account the viewer
does not follow sending them direct statuses, which home must not read, and an account that blocks the viewer, one the
viewer blocks, a suspended one and one being deleted, whose statuses the account statuses endpoint must not read. Home
must show a full page and the account statuses none, reading at most 10 rows more.
A case grows the accounts the profile directory never lists first, from 20 to 2,000 of each kind: accounts that are not
discoverable (with the newest statuses), and discoverable ones behind the page, with older statuses and ids, that the
viewer blocks, mutes or domain-blocks, that block the viewer, that are suspended, or that nothing hides, with the
viewer's blocks and mutes of them; in front, 10 accounts the viewer is shown and 3 it is not. The newest page of each
order, all and local, for the viewer and anonymously, must show the same and read at most 10 rows more. Another grows
the hidden accounts in front from a window's worth to 2,000: the page reads its window and no further.
Another case grows the accounts with timeline markers from 10 to 2,000: the viewer's markers read at most 10 rows
more. The world gives every original status a poll of four choices with the viewer's vote, and the unrelated accounts
polls and votes of their own and votes in the target's poll (rows only); the target's poll (`GET /api/v1/polls/:id`) is
an endpoint of both cases. A last poll case grows the votes in each of a page's 20 polls from 10 to 1,000: the account
statuses page, the poll and a vote in it must each read at most 10 rows more. Another grows the accounts the viewer
endorses and keeps notes on from 20 to 2,000: the newest, a middle and the oldest page of the viewer's endorsements
through both endpoints, and the relationships of 20 of them, read at most 10 rows more. Another grows the notifications
of one group (favourites of the viewer's status) from 2,500 to 5,000, past the walk's limit, between older follows and
newer follow requests: the newest page of groups, one from the middle of the group and one above the follows, the group,
a newest, a middle and the oldest page of its accounts and both unread counts read at most 10 rows more, since a walk
reads at most 2,000 notifications it shows and a group counts at most 400. The viewer also follows the world's hashtag
and another, and features both; the followed hashtags, the featured hashtags (the viewer's and their account's) and the
suggestions are endpoints of both cases (the suggestions exempt from the history case: they read the viewer's newest
1,000 statuses, a window that grows with the history up to that limit). The unrelated local accounts follow and feature
hashtags too, and a case of its own grows the accounts that follow hashtags from 10 to 2,000: home and the followed
hashtags must read at most 10 rows more. A last case follows `MAX_FOLLOWED_TAGS` hashtags, each with 40 or 400 public
statuses: home's newest and oldest pages must read the same rows (at most 10 more), and at most a window per hashtag
more than with none.
The viewer pins its newest pinnable statuses and mutes the conversations of half the world's statuses, and the
unrelated local accounts pin a status of their own and mute the world's conversations: the viewer's pinned statuses,
the statuses by id and the viewer's `featured` collection are endpoints of both cases (pins are at most five, so they
add no dimension). Another case grows the conversations the viewer mutes from 20 to 2,000: presenting 20 statuses (half
of them muted) and a favourite of one (which notifies, or not, through `notifiedSql`) read at most 10 rows more. Another
grows the remote boosts of one public pinned status from 20 to 2,000: its Note through the object endpoint, the outbox
and the `featured` collection read at most 10 rows more.
A last case grows the viewer's filtered notifications from 2,500 to 5,000 private mentions between older follows and
newer follow requests, each from a sender of its own with a request, or all from one sender with one request: the
newest page and the page below them of the notifications and of the grouped notifications, both unread counts, the
newest page of requests, a request, the policy's summary and `merged` read at most 10 rows more, and so do accepting and
dismissing a request (its batches walk at most 2,000 of the sender's notifications). Another grows the pending jobs of answered requests
from 1,000 to 5,000: `merged` and a round of the jobs read at most 10 rows more.

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
| grouped notifications, unread counts                       | the groups of exactly the notifications the list shows, each counting and sampling its own, newest first; the unread counts count those notifications and groups                                                                                        |
| followers, following (of every account)                    | exactly the accepted follows the list rule shows (R13), newest first, over pages of 3                                                                                                                                                                   |
| account search                                             | exactly the accounts the viewer may find (R14)                                                                                                                                                                                                          |
| profile directory (both orders, all and local)             | exactly the discoverable accounts R12 lists to the viewer in the order's window, in order, from each offset (pages of 3 and one of 40), each account's `discoverable` generated as 1, 0 or unset                                                        |
| suggestions (both versions)                                | exactly the model's (R39) over the Store's windows, in order, at offsets 0, 1, 39 and 40 with limits 1, 40 and 80; worlds add dismissals and more local follows, so some case suggests something                                                        |
| conversations                                              | exactly the viewer's conversations the model makes of the direct statuses and the mentions seeded (R25), newest last status first, both ways over pages; each last status only if the viewer may see it (R2), else null; another account's is not found |
| pinned statuses (of every account)                         | exactly the account statuses the model allows that the account pins, newest pin first (R11, R31)                                                                                                                                                        |
| statuses by id (every status, 20 at a time)                | exactly the listable statuses (R8), in the order asked                                                                                                                                                                                                  |
| search resolution (of every stored account and status)     | an account exactly when account search finds it (R14); a status exactly when the single-status read shows it (R3), unless the viewer blocks its author's domain                                                                                         |

Home and each list are read page by page: by `max_id` in pages of 3 and by `min_id` from the oldest in pages of 2, each
page exactly the next of the model's members, so a page cannot come back short while members remain; and the `since_id`
and `min_id` pages above the middle member. Each endpoint must show something in some case, so a property cannot pass by
showing nothing, and some case's home must hold a status only a followed hashtag brings.

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
- every local account endorses each account it follows (accepted), and keeps after the action what it endorsed
  before, less each account it no longer follows (accepted);
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

`test/streaming-oracle.test.ts` checks R33 for the `user`, list, `public*` and `hashtag*` streams' statuses on generated worlds, with the mention
notifications `notify` would write (some filtered by the recipient's policy): for every local viewer and every status,
with each kind of token (`read`, `read:statuses`, `read:notifications`), the streams the unit sends an `update` and a
`status.update` on must be those the references give: home read with `max_id` just above the status and `limit` 1,
and the viewer's mention notifications listed in full. Its window cases pin the documented difference: a post of a
followed hashtag behind 41 newer hidden posts (sent; a page from the top leaves it out), at the 40th candidate (both),
with ascending `min_id` paging, and an empty home. `test/policy-bounds.test.ts` grows what a streamed status's checks
could read, at once, from 20 statuses per author to 2,000, 10 follows to 1,000, no exclusive-list members to 1,000,
none of 40 unrelated followed hashtags and 20 of the viewer's mention notifications to 2,000: the `update` of the
author's newest, middle and oldest status, a followed account's, an exclusive member's (not sent) and a followed
hashtag's newest and oldest, and the `status.update` of a status in home and of the newest and oldest mention, must
each read at most 10 rows more. A delete's capture reads the same with 10 or 1,000 follows per listening account when
the status has few boosts, a constant per listening account, and, past 2,000 boosts by unfollowed accounts, the same
with 2,000 or 20,000; the journal's scan and a page of a delete's units read the same with 1 or 256 captured viewers.
The same oracle compares each world's lists: for every viewer, every list (its own or another owner's) and every
status, `update` and `status.update` go on `list:<id>` exactly when the list read with `max_id` just above the status
and `limit` 1 returns it. A separate conversation oracle adds the conversations the world's direct statuses make and
checks, for every viewer and every conversation, that `conversation` is sent exactly for the viewer's own, with the
presentation of its whole conversation list read in one page; two conversations sharing a last status are each
returned alone. `test/policy-bounds.test.ts` grows a list's members from 10 to 1,000, its author's statuses from 20 to
2,000 and the owner's conversations from 20 to 2,000: a list's `update` and `status.update`, a delete's list capture,
the subscription's ownership check, a conversation's unit and the read of an owner's newest changes each read at most
10 rows more.
The oracle also gives each world's originals shown and hidden media, and checks, for every viewer and every status,
that `update` and `status.update` go on each of the six `public*` streams and on `hashtag` and `hashtag:local` (the
world's hashtag) exactly when that timeline read with `max_id` just above the status and `limit` 1 returns it and the
status mentions (not silently) no account the viewer blocks or mutes. `test/policy-bounds.test.ts` grows an author's
public hashtag statuses, others' and those of accounts the viewer blocks, mutes or domain-blocks from 20 to 2,000: the
`update` of the author's newest and oldest, a local status with media, a status mentioning a muted account and a
filtered author's (neither sent), and the `status.update` of the oldest, over every feed at once, each read at most 10
rows more, and so does a public status's tombstone capture. `test/streaming/public.test.ts` drives the streams over
sockets: the feeds a local and a remote status with media reach, what the timelines leave out, the per-viewer filters
(block, mute, domain block, an author's block, a mention of a blocked or muted account) and a keyword filter in
`filtered`, the real-time window, edits, the tombstone's matching (local, remote, media, hashtag, never a boost or a
non-public status), and 256 sockets on distinct tokens over several turns, each message once.
`test/stream-delete.test.ts` checks R32's capture: once, when a remote `Delete`'s job is created, through every batch
and a redelivery, for a direct status and a private one a mention authorizes; by its own id for a boost removed by
`Delete` or `Undo`; without a booster whose purge has begun or one the viewer does not follow; at most 40 boosts, and a
row over its bound truncated while the delete still happens; at its maxima (16 lists, each holding the status and 40
boosts) within its bound, and truncated boosts first, then lists. The tombstone holds local, media and the subscribed
hashtags of a public status, for a listener on feeds alone (without boosts), and nothing for a boost, a non-public
status or a feed the status would not reach; at its maxima (16 accounts on `user` and 15 hashtags of 256 bytes each,
a status carrying 100 of them and 40 boosts each account follows) it holds the 100 hashtags within 27 KiB, with 16
rows of 40 boosts within theirs, and over its bound it drops its last hashtags while the delete still happens.
