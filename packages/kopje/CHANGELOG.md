# Changelog

All notable changes to the `kopje` package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semver](https://semver.org). Before 1.0, a minor version may make breaking changes.

Each version says whether it changes the Store's schema (adds migrations) and whether an instance must change its
`wrangler.jsonc` (a binding, a compatibility date or flag). See [docs/upgrade.md](docs/upgrade.md).

## [Unreleased]

### Added

- The notification policy and notification requests, as Mastodon 4.5 has them: `GET`, `PATCH` and `PUT` of
  `/api/v1/notifications/policy` (`filter_not_following`, `filter_not_followers`, `filter_new_accounts`,
  `filter_private_mentions`, each true for filter and false for accept) and `/api/v2/notifications/policy`
  (`for_not_following`, `for_not_followers`, `for_new_accounts`, `for_private_mentions`, `for_limited_accounts`, each
  `accept`, `filter` or `drop`), with the `summary` of pending requests; `GET /api/v1/notifications/requests` (40 by
  default, at most 80, with Link headers), `GET /api/v1/notifications/requests/:id`,
  `POST /api/v1/notifications/requests/:id/accept` and `/dismiss`, the bulk `POST /api/v1/notifications/requests/accept`
  and `/dismiss` (`id[]`), and `GET /api/v1/notifications/requests/merged`. Scopes are `read:notifications` and
  `write:notifications` (or `read` and `write`).
    - A notification from an account you do not follow, from one that has not followed you for three days, from an
      account younger than 30 days you do not follow, or a private mention from an account you do not follow that
      answers none of your private mentions of it, is accepted, filtered or dropped as your policy chooses. Mentions,
      favourites, boosts, follows and follow requests are filtered or dropped; posts, edits and poll ends never are.
      By default, as on Mastodon, private mentions are filtered and the rest accepted.
    - A dropped notification is not written. A filtered one is written but left out of the notifications, the grouped
      notifications and both unread counts unless you ask with `include_filtered=true` (or, in v1, `account_id`); it is
      not pushed, joins no group, and a private mention does not reach your conversations. A filtered mention opens or
      updates a request for its sender, which counts up to 100 of them.
    - Blocking an account deletes its request and the permission you gave it by accepting one.
    - Accepting a request lets its sender through from then on, shows the sender's filtered notifications, and adds
      the private mentions among them to your conversations. Dismissing one deletes the sender's filtered notifications.
      Both happen in the request for up to 2,000 of the sender's notifications and in the background rounds for the
      rest; `merged` answers false until an accepted request's notifications are all shown.
    - Where Kopje differs from Mastodon: Kopje has no silenced accounts, so `for_limited_accounts` is kept but never
      matches, and no staff role that bypasses blocks, so no sender is exempt as staff; a follow counts from when it was
      requested, not when it was accepted; a request's count is kept as its mentions arrive, so deleting one of them
      does not lower it and the request stays until it is answered; the summary looks at 100 requests at most (Mastodon
      names that limit, but its query counts all of them); a v2 value other than `accept`, `filter`, `drop` or 0 to 2
      answers 422 (`'x' is not a valid for_not_following`) and changes nothing, where Mastodon answers 500; a v1 form
      value of `false` or `0` accepts, where Mastodon filters for any value sent; a domain block keeps the permissions of accepted requests from accounts there (Mastodon's
      AfterBlockDomainFromAccountService deletes them), so after an unblock those senders pass your policy again; the bulk
      forms take at most 100 ids
      (more answer 422); and `merged` reflects the work an accepted request has left, which Kopje runs in rounds a few
      minutes apart rather than at once. As on Mastodon, the bulk dismiss deletes the requests alone and leaves their
      filtered notifications, and `GET /api/v1/notifications/:id` and `GET /api/v2/notifications/ungrouped-:id` show a
      filtered notification.
- Mastodon 4.5's remaining small endpoints, under Mastodon's scopes, answered as Mastodon answers when the feature has
  nothing to show or is not configured: `GET /api/v1/annual_reports` (none),
  `GET /api/v1/instance/translation_languages` (`{}`), `GET /api/v1/emails/check_confirmation` (`true`) and
  `DELETE /api/v1/suggestions/:id` (`{}`); 404 for
  `GET /api/v1/timelines/link`, `GET /api/v1/annual_reports/:id`, `POST /api/v1/annual_reports/:id/read`,
  `POST /api/v1/announcements/:id/dismiss`, announcement reactions, `GET /api/v1/instance/terms_of_service/:date`,
  `POST /api/v1/statuses/:id/translate` and `GET /api/v1_alpha/async_refreshes/:id`; and 403 for
  `POST /api/v1/emails/confirmations`. `GET /api/v1/peers/search` finds up to 10 known peers by domain prefix, and
  `PATCH /api/v1/push/subscription` updates as `PUT` does.
- The profile directory, `GET /api/v1/directory`, as Mastodon 4.5 has it (token optional, any scope): the discoverable
  accounts, the most recently active first (`order=active`, the default; accounts that have not posted come last) or
  the newest first (`order=new`), all of them or the local ones (`local=true`), 40 by default and at most 80 by `limit`,
  from `offset`. A local account is listed when its owner made it discoverable, a remote account when its actor says
  `discoverable: true`. Suspended accounts and accounts being deleted are never listed, and a signed-in viewer is not
  shown the accounts they block or mute, those on domains they block, nor those that block them. An answer without a
  token may be cached for 15 seconds, as Mastodon's.
    - Where Kopje differs from Mastodon: an offset above 400 answers no accounts, and a page looks at most twice offset
      plus limit accounts of the directory, so when more than half of them are hidden from you (accounts you block or
      mute, say), that page comes back shorter; `order=active` goes by an account's newest public, unlisted or private
      post or boost as stored, the one its `last_status_at` shows, so the account moves back when that post is deleted,
      and accounts that have not posted are ordered newest first (Mastodon leaves their order open); an unknown `order`
      reads as `active` (Mastodon fails); Kopje has no silenced accounts, and it does not record that an account moved, so a moved
      account stays listed while its actor says it is discoverable.

### Changed

- Hashtags are normalized as Mastodon 4.5 normalizes them (HashtagNormalizer): NFKC, lowercase, Latin letters with
  diacritics folded to ASCII by Mastodon's table, and the characters a hashtag cannot hold dropped. `#Café`, `#cafe`
  and `#CAFÉ` are one hashtag, as on Mastodon, wherever a hashtag is named: in a posted or received status (a received
  `Hashtag` loses every `#` with the rest), on hashtag timelines, in home through a followed hashtag, in search, on
  the tagged profile page, and among featured hashtags, so featuring `blahaj` after `BLÅHAJ` is refused as taken.
  A hashtag in status text that leaves nothing once normalized (a lone combining mark) stays text, and hashtag search
  drops the spaces of its query rather than finding nothing. The cutover and `verify-conversion` name hashtags the same
  way. Stored names are renormalized by the migration below.

### Instance changes

- Store schema: adds three migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0019_tag_normalization`: renames the stored hashtags (`status_tags`, `tag_follows`, `featured_tags`) to
      Mastodon's normalization. Names that become one are merged: a status keeps one row of the hashtag, an account
      keeps its earliest follow and its earliest featured hashtag (with its spelling), and the featured hashtags left
      are recounted from the account's statuses; a featured hashtag merged away sends no `Remove`, since Mastodon
      servers already hold the names as one featured hashtag. A name that leaves nothing is deleted. A stored name
      made from a word-final capital sigma keeps its `ς` (Mastodon would store `σ`), since the stored name cannot tell
      it from a typed `ς`. It reads each table once to find the names with a character other than `a`–`z`, `0`–`9`
      and `_`, walks each such distinct name's characters, and rewrites the rows of the renamed names through indexes,
      so its work grows linearly with the hashtag rows stored.
    - `0020_notification_policies`: adds `notifications.filtered` (every stored notification stays shown), the
      partial index of unfiltered notifications the lists read, and the tables of notification policies, permissions,
      requests and their background work. Adding the column reads no row; building the index reads each stored
      notification once and writes an entry for each, so its work grows linearly with the notifications stored.
    - `0021_directory`: adds `accounts.last_status_id` (each account's newest public, unlisted or private status, kept
      by triggers as statuses are stored, deleted or hidden), fills it with one lookup per account through an index, and
      indexes the discoverable accounts by the directory's two orders. Its work grows linearly with the accounts
      stored, whatever the statuses.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.6] - 2026-10-16

A sixth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- `GET` and `POST /oauth/userinfo`, as Mastodon 4.5 has it: for a token with the `profile` scope, the OpenID Connect
  claims of its account (`iss`, `sub`, `name`, `preferred_username`, `profile`, `picture`). A token without `profile`
  is refused with 403, an app token with 422.
- `GET /.well-known/oauth-authorization-server` (RFC 8414), as Mastodon 4.5 has it: the OAuth endpoints, including
  `userinfo_endpoint` and Mastodon's `app_registration_endpoint`, the scopes, and the supported response types and
  modes, grant types, client authentication methods and PKCE methods.
- Filters, as Mastodon 4.5 has them: `/api/v2/filters` with keywords (`keywords_attributes`, `_destroy`) and statuses,
  `/api/v2/filters/:id/keywords`, `/api/v2/filters/keywords/:id`, `/api/v2/filters/:id/statuses` and
  `/api/v2/filters/statuses/:id`, and the v1 `/api/v1/filters` over the same filters. Every status shown to you carries
  in `filtered` your active filters that match it, whatever their context and action, and your client hides or warns by
  context, as with Mastodon. An account has at most 50 filters, a filter 20 keywords and 200 statuses. A status is
  matched on the beginning of its text: at most 10,000 characters each, and a response's statuses share 400,000 (short
  ones whole, long ones on an equal share), so a page is matched in full but a keyword deep in a long status of a very
  large thread may be missed (filtered statuses always match). Keywords match case-insensitively by simple Unicode case
  folding; the multi-character folds Mastodon also applies (ß and ss, İ and i̇) do not match. Deleting a v1 filter also
  deletes its filter when that leaves it with no keyword and no status.
- Conversations in the Mastodon API, as Mastodon 4.5 has them: `GET /api/v1/conversations` (paged by the last status
  with Link headers, 20 by default and at most 40), `DELETE /api/v1/conversations/:id` and
  `POST /api/v1/conversations/:id/read` and `/unread`. Scopes are `read:statuses` and `write:conversations` (or `read`
  and `write`); another account's conversation answers 404.
    - Your direct statuses, and the direct statuses you are notified of as a mention, are grouped by thread and by the
      other accounts in them. A received status that names its conversation, as Mastodon's do, joins that thread even
      when it arrives before the status it replies to. A new status from someone else marks the conversation unread; your own does not.
    - Deleting a status takes it out of its conversations; a conversation with none left goes. Deleting a
      conversation keeps its statuses, and a later one makes a new conversation. Blocking an account ends your
      conversations with it.
    - A conversation's last status is shown only while you may still see it (its author is not suspended and does not
      block you); otherwise it is `null`.
    - The conversations of the direct statuses already stored are made when the instance upgrades, and the cutover
      makes them of the statuses it carries.
- Timeline markers in the Mastodon API, as Mastodon 4.5 has them: `GET /api/v1/markers` (`timeline[]`: `home`,
  `notifications`; other names are ignored) and `POST /api/v1/markers` (`home[last_read_id]`,
  `notifications[last_read_id]`), each marker with its `last_read_id`, `version` and `updated_at`. Scopes are
  `read:statuses` and `write:statuses` (or `read` and `write`). An update that changes a marker counts a version; the
  same value changes nothing. `last_read_id` is kept as sent, up to 255 characters; a blank one answers 422 with
  Mastodon's message. Updates are applied one at a time, so two at once both succeed instead of one answering 409.
- Scheduled statuses, as Mastodon 4.5 has them: `POST /api/v1/statuses` with `scheduled_at` answers a
  `ScheduledStatus`, checked as a post is, at least 5 minutes ahead, at most 300 per account and 25 per day (a time
  not in the future posts at once). `GET /api/v1/scheduled_statuses` lists them, and `GET`, `PUT`, `PATCH` and
  `DELETE` on `/api/v1/scheduled_statuses/:id` show, move and delete one. The cron publishes each when it is due
  (within its 5-minute schedule) as an ordinary post, and drops one that no longer passes (the status it replies to is
  gone, or its account is suspended); one that fails with an error is retried four times over about five hours, then
  dropped. An `Idempotency-Key` that scheduled a status answers with it on a repeat, with or without `scheduled_at`.
  Media attached to a scheduled status is kept until it is published or deleted.
- Polls, as Mastodon 4.5 has them: `POST /api/v1/statuses` takes `poll[options][]`, `poll[expires_in]`,
  `poll[multiple]` and `poll[hide_totals]` (2 to 4 choices of at most 50 characters, 5 minutes to a month, refused
  with media), and every status shows its `Poll`. `GET /api/v1/polls/:id` shows a poll to whoever may see its status,
  and `POST /api/v1/polls/:id/votes` (`choices[]`) votes, with Mastodon's validation and messages; a voter who blocks
  the author is refused. `hide_totals` hides the counts from everyone until the poll ends, and who voted is never
  shown. Editing a status's poll moves its end, and changed choices drop the votes cast; an edit without a poll
  removes it. A scheduled status keeps its poll and creates it on publication. When a poll ends, its local author and
  local voters are notified (`poll`, with Web Push), by the cron within its 5-minute schedule.
    - Over ActivityPub, a poll is a `Question` in its Create, Update and served object; votes in a local poll update
      it with an Update about 3 minutes after the first new vote (one for all, and one when it ends), and a vote in a
      remote poll goes to its author as Mastodon's vote Note. A received `Question` is stored with its poll, an
      Update refreshes its counts and end, and a received vote counts in a local poll once, from an account that may
      see it, and is never stored as a status.
    - Where Kopje differs from Mastodon: a poll's id is its status's id; a voter who blocks the author's domain is
      refused, since the vote could not be delivered; a remote poll keeps at most 100 choices of 1,000 code units, and a
      choice cut to that length cannot be voted for; any Note naming a choice in reply to a local poll is treated as a
      vote, never as a status; a local poll's `Question` says `closed` once the cron has ended it, within 5 minutes of
      its end; and the Update of counts reaches remote voters only for a public or unlisted status.
- `PATCH /api/v1/media/:id`, the same update as `PUT`, and `DELETE /api/v1/media/:id`, as Mastodon 4.5 has them (scope
  `write:media`): your own media only, else 404. Media a status uses, or a scheduled status holds, answers 422 with
  Mastodon's message, and so does an image the cutover kept unattached (one only earlier versions of a status show, or
  one legacy kept); otherwise the media is deleted with its files and the answer is `{}`.
- `DELETE /api/v1/profile/avatar` and `DELETE /api/v1/profile/header`, as Mastodon 4.5 has them (scope
  `write:accounts`): the account shows the default image again, the removed image's files are deleted, followers'
  servers receive the profile `Update`, and the answer is your `CredentialAccount`.
- Followed hashtags, as Mastodon 4.5 has them: `POST /api/v1/tags/:id/follow` and `/unfollow` (scope
  `write:follows`), and `GET /api/v1/followed_tags` (scope `read:follows`; newest follow first, 100 by default and at
  most 200, with Link headers). A name that is not a hashtag answers 404; any other name may be followed, used or not.
  Home also shows the public statuses, not boosts, with a hashtag you follow, from anyone, unless you block or mute
  their author or an account they mention, block their author's domain, or their author blocks you. The Tag entity
  shows `following` and `featuring` to a signed-in user wherever it appears, search's hashtags included.
    - Where Kopje differs from Mastodon: an account follows at most 100 hashtags; home shows a followed hashtag's
      statuses posted before the follow too (home is read, not filled as statuses arrive), and they leave it at once
      on an unfollow; the followed hashtags and the suggestions below show each hashtag with an empty `history`, as
      search's do; and home looks at most two pages (at least 40) of a followed hashtag's newest statuses for a page, so
      when most of them are hidden from you (say, a blocked account's), that page shows fewer of the hashtag's
      statuses.
- Featured hashtags, as Mastodon 4.5 has them: `GET` and `POST /api/v1/featured_tags`,
  `DELETE /api/v1/featured_tags/:id`, `GET /api/v1/featured_tags/suggestions` (the hashtags of your newest 1,000
  statuses you do not feature yet, the most used first), `POST /api/v1/tags/:id/feature` and `/unfeature` (scopes
  `read:accounts` and `write:accounts`), and `GET /api/v1/accounts/:id/featured_tags`, public, empty for a suspended
  account. An account features at most 10 hashtags, with Mastodon's validation and messages. Each shows the number of
  your public and unlisted statuses with it and the date of the newest, kept as you post, edit and delete. Its `url`,
  `/@username/tagged/:tag`, is your public profile page with only your posts with the hashtag.
    - Over ActivityPub, the actor publishes `featuredTags` (its featured hashtags as `Hashtag`s) and `featured` (its
      pinned statuses, below), and featuring or unfeaturing a hashtag sends your followers Mastodon's `Add` or
      `Remove` of the `Hashtag`; before an account's first one, its followers are sent the actor again, as servers that
      stored it earlier know no `featured` collection to add to. Kopje does not read the featured hashtags of remote
      accounts.
    - Where Kopje differs from Mastodon: an edit that adds a hashtag to an older status keeps the newest date rather
      than taking the older status's.
- The remaining account endpoints of Mastodon 4.5:
    - Private notes: `POST /api/v1/accounts/:id/note` (`comment`, at most 2,000 characters; a blank one deletes the
      note) answers the Relationship. Every Relationship now carries your note on the account in `note`; nobody else
      is shown it.
    - Endorsements: `POST /api/v1/accounts/:id/endorse` and `/unendorse` (also as `/pin` and `/unpin`), which answer
      the Relationship, now with a real `endorsed`; `GET /api/v1/endorsements` (yours, 40 by default and at most 80
      with Link headers, or all at once with `limit=0`, up to 1,000), which no longer answers empty; and
      `GET /api/v1/accounts/:id/endorsements` (anyone's, to anyone). You can endorse only an account you follow (else
      422 with Mastodon's message), and the endorsement goes when the follow ends, however it ends. Suspended accounts
      and accounts being deleted are not listed. Endorsements are not federated, as in Mastodon 4.5.
    - `POST /api/v1/accounts/:id/remove_from_followers` ends the account's follow of you: a remote follower is sent a
      `Reject`, as when a block ends its follow. A pending request is left alone.
    - `GET /api/v1/accounts?id[]=` shows up to 40 accounts at once, as `GET /api/v1/accounts/:id` shows each; more
      answer 422.
    - `GET /api/v1/accounts/:id/identity_proofs` answers `[]`, as Mastodon's deprecated endpoint does.
    - `POST /api/v1/accounts` (registration) answers as Mastodon does with registrations closed: 403 `Forbidden` for an
      app token with `write:accounts`, after Mastodon's token checks. Kopje has no open registration.
- The remaining status actions of Mastodon 4.5:
    - Pins: `POST /api/v1/statuses/:id/pin` and `/unpin` (scope `write:accounts`), which answer the status. You can pin
      up to 5 of your own statuses, not boosts or direct statuses; anything else answers 422 with Mastodon's messages,
      and pinning a status again answers 422 `Duplicate record`. Your statuses now carry a real `pinned`, and
      `GET /api/v1/accounts/:id/statuses?pinned=true` lists an account's pins, newest pin first, to whoever may see
      each. Your actor publishes its `featured` collection of pins (the post of a public or unlisted one, the address
      of any other), and your followers' servers are sent an `Add` or `Remove` when you pin or unpin; before an
      account's first one, pin or featured hashtag, its followers are sent the actor again. A later `Add` or `Remove` of
      the same status replaces an earlier one still waiting or given up. Deleting a pinned status unpins it.
    - Conversation mutes: `POST /api/v1/statuses/:id/mute` and `/unmute` (scope `write:mutes`) mute the conversation
      of a status you may see, and every status of it then shows `muted: true` to you. While it is muted, nothing in
      it notifies you (mentions, favourites, boosts, poll ends, edits), and its direct statuses no longer reach your
      conversations; notifications you already had stay.
    - `GET /api/v1/statuses?id[]=` shows up to 20 statuses at once, those you may see and have not filtered out by a
      block, mute or domain block, each as `GET /api/v1/statuses/:id` shows it, in the order asked; more answer 422.
    - `PATCH /api/v1/statuses/:id` edits a status, as `PUT` does.
- Grouped notifications, as Mastodon 4.5 has them: `GET /api/v2/notifications` answers `accounts`, `statuses` and
  `notification_groups` (with `types[]`, `exclude_types[]`, `grouped_types[]`, `expand_accounts=partial_avatars` and
  paging with Link headers, 40 groups by default and at most 80), `GET /api/v2/notifications/:group_key` shows one
  group, `GET /api/v2/notifications/:group_key/accounts` lists its accounts, and
  `POST /api/v2/notifications/:group_key/dismiss` and `POST /api/v2/notifications/clear` delete. Favourites and
  boosts of the same status, and follows, group by the hour, joining a group of the same kind from up to 11 hours
  before; v1 notifications show their `group_key` too. Scopes are `read:notifications` and `write:notifications` (or
  `read` and `write`).
    - A group counts and shows only the notifications you are shown in v1: a notification from an account you have
      since blocked or muted, or about a status you may no longer see, is left out.
    - Each group on a page counts and samples its notifications up to the page's newest, those below the page
      included, as Mastodon does.
    - Where Kopje differs from Mastodon: a group counts at most 400 notifications, and a page reads at most 2,000
      notifications, skipping those of the groups it has found, so a page ends early, with the groups found and a `next`
      link that goes on from there, only when its walk meets more than that of the groups it found (in practice a status
      favourited by thousands within a few hours). A dismissed group is not remembered, so a later notification within
      its hours starts a new one. Dismissing a group and clearing delete at once, in the request.
    - Notifications stored before the upgrade stay ungrouped, each a group of its own, as Mastodon left those it
      stored before it grouped them.
- `GET /api/v1/notifications/unread_count` and `GET /api/v2/notifications/unread_count`, as Mastodon 4.5 has them: the
  notifications (v1) or groups (v2) newer than your notifications marker, up to `limit` (100 by default, at most 1,000),
  with the same filters as the lists.

### Changed

- A missing, unknown or expired bearer token is refused with a `WWW-Authenticate: Bearer` challenge
  (`error="invalid_token"`), as Mastodon refuses it.
- The public timeline, account statuses, notifications, favourites and bookmarks read a bounded number of rows for a
  page anywhere in the history, and home and list timelines no longer read the statuses of followed accounts they
  hide entirely. Home reads only the mentions of you in direct and limited statuses by accounts you follow, not every
  mention of you, and the statuses of an account that blocks you, that you block, or that is suspended or being deleted
  are no longer read to show its empty profile.
- A page of a list's members (`GET /api/v1/lists/:id/accounts` with `max_id` or `min_id`) is read from its cursor, not
  from the newest member.

### Fixed

- Media an edit removes from a status stays with the status, as with Mastodon, so the status's edit history still
  shows it: it is no longer deleted a day after the edit. The status no longer shows it, and it cannot be attached to
  another status or a scheduled status; a later edit of the same status can attach it again, and it is deleted with
  the status (at once with `delete_media`, otherwise after the grace period, as the status's other media). An image
  that only earlier versions of a converted status show now belongs to that status too, so it is no longer offered as
  an unattached upload, and goes with the status.

### Instance changes

- Store schema: adds eleven migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0008_status_mentions_requires_mention`: adds `status_mentions.requires_mention` and `status_mentions.author_id`,
      marks the mentions in direct and limited statuses with their status's author, and indexes them by recipient and
      author. Its work grows linearly with the mentions stored (one pass, with a lookup of each one's status); locally,
      200,000 mentions took under a second.
    - `0009_conversations`: adds `statuses.thread` (the thread a status belongs to, given to each status stored, from
      the start of each reply chain down, and to each new one by a trigger), the `conversations` and
      `conversation_statuses` tables, the trigger that takes a deleted status out of its conversations, and the
      conversations of the direct statuses stored. It rewrites every status once (its thread) and reads each a few
      times, so its work grows linearly with the statuses stored; locally, 500,000 statuses, 50,000 of them direct in
      two long reply chains, took about 1.2 seconds.
    - `0010_markers`: adds the `markers` table. It is quick.
    - `0011_scheduled_statuses`: adds the `scheduled_statuses` table and `media_attachments.scheduled_status_id`, with
      their indexes. Its work grows linearly with the media stored (one pass to add the column and one to build its
      partial index).
    - `0012_filters`: adds the `filters`, `filter_keywords` and `filter_statuses` tables, empty. Its work does not grow
      with the Store.
    - `0013_polls`: adds the `polls` and `poll_votes` tables, with their indexes, and `status_edits.poll_options`. It is
      quick.
    - `0014_account_notes_and_pins`: adds the `account_notes` and `account_pins` tables, empty, and the trigger that
      deletes an endorsement with its follow. Its work does not grow with the Store.
    - `0015_media_shown`: adds `media_attachments.shown`, rebuilds the index `media_attachments_status` with it, and
      gives back to its status, not shown, each kept upload that earlier versions of exactly one status of its author
      name (an image the cutover kept for earlier versions, or media an edit detached that is more than an hour from
      its sweep); other uploads stay as they are. Its work grows linearly with the media and the edits stored (one pass
      over the media for the column and one for the index, and one over the edits' media, grouped by id, with a
      lookup of each named upload).
    - `0016_tags`: adds the `tag_follows` and `featured_tags` tables, empty, and `local_accounts.featured_announced`.
      It is quick.
    - `0017_notification_groups`: adds `notifications.group_key`, empty for the notifications stored, and its partial
      index by recipient and group. It reads each notification once to build the index, so its work grows linearly
      with the notifications stored.
    - `0018_status_pins_and_conversation_mutes`: adds the `status_pins` and `conversation_mutes` tables, empty. Its
      work does not grow with the Store.
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.5] - 2026-10-15

A fifth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- `kopje-admin keys rewrap` moves the private keys of local accounts and the instance actor from the KEK in
  `USER_KEK_PREVIOUS` (unset reads as the empty KEK) to `USER_KEK`, keeping the same key pairs. Keys already under
  `USER_KEK` are skipped, so it can run again; a key neither KEK unwraps is reported and left unchanged. See "Rotating
  the KEK" in docs/setup.md.

### Changed

- Home and list timelines read a bounded number of rows per page.

### Instance changes

- Store schema: unchanged.
- `wrangler.jsonc`: unchanged. `USER_KEK_PREVIOUS` is a new optional secret, set only while rotating the KEK.

## [0.1.0-rc.4] - 2026-10-15

A fourth release candidate of the first release, published under the npm dist-tag `next`.

### Added

- Lists in the Mastodon API, as Mastodon 4.5 has them: `GET` and `POST /api/v1/lists`, `GET`, `PUT`, `PATCH` and
  `DELETE /api/v1/lists/:id` (`title`, at most 256 characters; `replies_policy` `followed`, `list` or `none`, `list` by
  default; `exclusive`), at most 50 lists per account; `GET`, `POST` and `DELETE /api/v1/lists/:id/accounts`
  (`account_ids[]`; the members paged by Link headers, 40 by default and at most 80, or all at once with `limit=0`, up
  to 1,000); `GET /api/v1/accounts/:id/lists`; and `GET /api/v1/timelines/list/:id`. Scopes are `read:lists` and
  `write:lists` (or `read` and `write`). Errors answer as Mastodon's do (422 with its validation messages, 404 for an
  unknown account or a list of someone else's).
    - A list holds you and accounts you follow or have asked to follow; anyone else is refused. An account whose
      request is pending is listed but adds nothing to the timeline until you are accepted.
    - The list timeline has the public, unlisted and private statuses and boosts of its members, filtered as home
      filters them (blocks, mutes, domain blocks, a follow's boosts and languages), with the list's `replies_policy`
      deciding which replies to others are shown. Like home, it is worked out when read, so it also shows what members
      posted before they were added.
    - An exclusive list keeps its members' statuses and boosts out of home. Post notifications (`notify` on a follow)
      are still sent for them, as in Mastodon.
    - When your follow of a member ends (you unfollow it, either of you blocks the other, a domain block's cleanup
      reaches it, it rejects or removes your follow, or its account is deleted), it leaves your lists, and following it
      again does not bring it back. When an account you follow moves, its new account takes its place in your lists.

- Blocks, mutes and domain blocks in the Mastodon API, as Mastodon 4.5 has them: `POST /api/v1/accounts/:id/block`,
  `/unblock`, `/mute` (`notifications`, default true, and `duration` in seconds, 0 for no expiry) and `/unmute`, which
  answer the Relationship; `GET /api/v1/blocks` and `GET /api/v1/mutes` (with `mute_expires_at`), paged by Link
  headers; and `GET`, `POST` and `DELETE /api/v1/domain_blocks` and `GET /api/v1/domain_blocks/preview`. Scopes are
  `read:blocks`, `write:blocks`, `read:mutes`, `write:mutes` or `follow`.
    - A block ends the follows between the two accounts both ways. A blocked remote account is sent an `Undo` of our
      follow, a `Reject` of its follow, and the `Block`; an unblock sends the `Block`'s `Undo`. A blocked account (or
      one on a blocked domain) is not mentioned in, or sent, the statuses you write after the block (deliveries already
      queued are sent as queued, as in Mastodon).
    - A mute is not federated. It expires after its duration: it stops applying at that time, whether or not it has
      been removed yet. `muting_expires_at` in relationships shows the expiry.
    - A domain block takes the domain as Mastodon normalizes it and refuses this instance's own domain. As in Mastodon
      4.5, it ends your follows to and from accounts on that domain (a `Reject` to each follower, an `Undo` of each of
      your follows). Kopje does this in the background in bounded batches until done (the Queue and the 5-minute cron
      continue it); meanwhile what you post is not delivered to followers there. Unblocking the domain stops the rest.
    - `GET /api/v1/domain_blocks/preview` needs `write:blocks` (or `write` or `follow`), as in Mastodon.

- Web Push, as Mastodon 4.5 offers it. `POST`, `GET`, `PUT` and `DELETE /api/v1/push/subscription` keep one
  subscription per access token, under the `push` scope, with Mastodon's alerts (per notification type) and policy
  (`all`, `followed`, `follower`, `none`) and `server_key` from `VAPID_JWK`. The endpoint must be a public https URL
  and the client keys valid, or the request answers 422. Each new notification is pushed to the recipient's
  subscriptions that want it, from the Queue consumer, with the retries of deliveries; right before each POST, the
  notification is checked again and the push dropped if it is gone or no longer shown. Pushes are encrypted as the
  subscription asks (`standard`: RFC 8291 aes128gcm; otherwise the aesgcm draft most clients use), signed with VAPID
  (RFC 8292), and carry Mastodon's payload, the subscription's access token included. A push service answering a 4xx
  other than 408 and 429 ends the subscription, as Mastodon 4.5 does. Revoking a token or suspending an account
  deletes its subscriptions. Without `VAPID_JWK`, the endpoints answer 404 and the instance advertises no key; Kopje
  never makes one.

- Mastodon API endpoints that clients read at startup and that answered 404 before. `GET /api/v1/preferences` shows
  the account's posting defaults (visibility, sensitive, language) and Mastodon's defaults for the reading preferences
  (`reading:expand:media` `default`, `reading:expand:spoilers` false).

- `GET /api/v1/instance/rules` (the rules `/api/v2/instance` shows), `/api/v1/instance/peers` (the domains of known
  remote accounts, at most 10,000), `/api/v1/instance/extended_description` (none set) and `/api/v1/instance/languages`
  (ISO 639-1). `privacy_policy`, `terms_of_service`, `activity` and `domain_blocks` answer 404, as Mastodon does when
  none is configured or the feature is off.

- `GET /api/v1/tags/:id`: any valid hashtag, with seven days of history counted from public statuses.
  It needs no scope; `following` is false for a signed-in viewer, since tag follows do not exist yet.

- `GET /api/v1/accounts/familiar_followers`: for each requested account, the accounts the user follows that follow it
  among up to 10,000 of the user's follows (at most 20 ids and 80 accounts each), without accounts the user blocks,
  mutes (while the mute lasts) or whose domain the user blocks.

- Empty answers, under the scopes Mastodon requires, for features Kopje has no data for yet: `GET /api/v1/filters`,
  `/api/v2/filters`, `/api/v1/followed_tags`, `/api/v1/featured_tags`, `/api/v1/accounts/:id/featured_tags`,
  `/api/v1/endorsements`, `/api/v1/announcements` (any user token), `/api/v1/trends` (and `/trends/tags`,
  `/trends/statuses`, `/trends/links`), `/api/v1/suggestions` and `/api/v2/suggestions`.

- `hide_collections`, Mastodon's setting to hide an account's network: `PATCH /api/v1/accounts/update_credentials` takes
  it, and the Account entity and the credential account's `source` show it (`null` for a remote account, whose setting
  Kopje does not learn). While it is on, the account's followers and following are listed to nobody but the account
  itself, familiar followers show none of its followers (to anyone, as Mastodon) and leave it out as a follower, and the
  ActivityPub followers and following collections show their size (`totalItems`) only and refuse a page (403), as
  Mastodon's do.

- The `profile` OAuth scope, as Mastodon 4.5 has it: an app may register and request it alone or with other scopes. A
  `profile` token reads `GET /api/v1/accounts/verify_credentials` (the same answer as with `read:accounts`) and no other
  route that requires a scope; `read` does not include `profile`.

### Changed

- An inbound `Announce` of a local status by an account its author blocks, or by an account on a domain its author
  blocks, is ignored, as an inbound `Like` (a favourite or a reaction) by a blocked account already was; a `Like` by an
  account on a blocked domain is now ignored too. A public or unlisted status is not visible to a remote account on a
  domain its author blocks, as in Mastodon 4.5's status policy. Mastodon stores such favourites and boosts and filters
  only their notifications.

- `GET /api/v1/accounts/:id/followers` and `/following` read an optional token (`read:accounts`), as Mastodon does,
  and list as Mastodon 4.5 lists for the viewer: nothing when the account is suspended, or, to anyone but the account
  itself, when it blocks the viewer or hides its network; and without the accounts the viewer blocks, mutes (while
  the mute lasts) or is blocked by. A suspended account stays in the lists, shown redacted. The ActivityPub followers
  and following collections of a suspended account answer 404, as its outbox does.

- Who an outbound activity goes to is decided by one rule, by what the activity does. Content (a new status, an edit,
  a boost) still goes to no account you block or whose domain you block, and to no unavailable account (suspended, or
  a remote account being deleted). The `Undo` of a boost now names and reaches the boosted status's author even when
  you block them or their domain, as every other `Delete` and `Undo` does. A profile change, and a `Delete` or `Undo`,
  now also reach a follower on a domain you have just blocked, until the domain block's cleanup has ended that follow,
  as Mastodon 4.5 sends them; new statuses still do not reach that follower.

- Home and mention notifications also leave out a status that mentions or replies to an account you block or mute
  (for mention notifications, a mute that hides notifications), as Mastodon filters them; so do post notifications
  of accounts you follow with `notify`, whenever home leaves the status out.

- A post notification (`notify` on a follow) is no longer created, shown or pushed for a post by an account you mute,
  even with a mute that keeps notifications, as Mastodon creates none: home leaves that post out.

- Home leaves out a reply whose conversation partner is unknown: a reply to a status the instance never stored, or one
  continuing such a reply, as Mastodon's home does. A reply to an account whose deletion has been processed counts as
  one, so removing that account no longer brings into home a reply that home left out. A reply whose parent is deleted
  keeps its partner and stays in home as before. Your own replies are shown as before. Such a reply also creates, lists
  and pushes no post notification (`notify` on a follow), as home leaves it out.

- The cutover leaves out a legacy list member that is neither the list's owner nor an account the owner follows or has
  asked to follow, counted (`list_accounts:not-followed-left-out`): legacy kept members whatever the follows, while a
  list in Kopje, as in Mastodon, holds an account only while you follow it. `verify-conversion` expects the same.

- The cutover converts a legacy domain block as Kopje's API stores one: lowercase, in punycode and without a trailing
  dot, the form domain blocks are matched in. Rows that become the same block are merged, and a value that is no
  domain name is dropped and counted (`domain_blocks:invalid-domain`), so the conversion stops on it until
  `--accept-deletions`.

- `verify-conversion` also compares hashtags, status language and edit time, actor type and discoverability, each
  local account's aliases and posting defaults (visibility, sensitivity, language), follow languages, the Like and
  Block records of favourites and blocks, and client websites.

- The cutover converts a status's language as Kopje reads one from a remote object: the primary subtag of the first
  language in `contentMap` (else `nameMap`, `summaryMap`), when it is two or three letters. It used to keep the whole
  tag, and only when `contentMap` had a single language.

- The cutover names hashtags as Kopje does: a received `Hashtag` tag loses only its one leading `#`, and a legacy
  `note_hashtags` value is kept whole, both then NFKC and lowercase. It used to drop a leading `#` or `＃` from either,
  so a tag named `＃Foo` became `foo` rather than `#foo`.

- The cutover carries a local account that never set `discoverable` as not discoverable, as legacy showed and published
  it, rather than as unset. A remote account that omits it stays unset, as Kopje stores a fetched actor.

- `VAPID_JWK` must hold the private key (`d`), not only the public point: a key without it now makes the instance
  answer 503 as misconfigured, as any invalid value does.

- Hashtag timelines and a tag's history read only the statuses that can appear on them: each hashtag records whether
  its status is public, and these reads go through an index of those hashtags, so their work no longer grows with the
  tag's unlisted, private, direct or limited statuses. A hashtag timeline also reads each requested tag in status id
  order from the page's cursor and stops once it has a page, so a page's work no longer grows with the tag's history.
  What they show is unchanged. The cutover writes the mark and `verify-conversion` compares it.

- The content of an account being deleted is hidden as soon as its deletion starts: from the transaction that accepts a
  remote account's `Delete`, its statuses, boosts, notifications and interactions are shown to nobody, it cannot be
  followed, mentioned, boosted or found, and the account itself is shown redacted (`suspended: true`), while its purge
  removes what it has in the background. Blocks and mutes of the account are removed last, so a post that mentions it
  stays filtered for whoever blocks or mutes it while that mention remains.

- A suspended account's rescue documents (its actor document and WebFinger answers, served while the Store refuses
  requests) are removed when the account is suspended: they answer 503 until a live request keeps the redacted
  document, which is then served.

### Fixed

- A `Move` whose new account a follower may not follow (the follower blocks it, or its domain) leaves that follower's
  follow of the old account, and the old account in the follower's lists, as they are, as in Mastodon. Before, the old
  follow was ended anyway.

- The cutover reads a legacy export that holds `d1_kv`, a table D1 now creates in a database by itself: the table list
  of the export (`kopje-admin fingerprint tables-sql`) leaves it out, as it leaves out `_cf_*`, and the fingerprint and
  the conversion ignore both in an export that has them. Before, such an export was refused as a schema mismatch.

- A remote actor that deletes itself again, after its earlier deletion's 30-day record has expired and it was stored
  again, is purged to the end and its record renewed, also when the expired record has not been cleaned up yet.

- Home applies its rule to your own direct and limited statuses too. A converted Store can hold a legacy direct boost
  of yours, and home used to list it with its original even when you may no longer see the original (its author
  blocks you or is suspended, or it is private and you no longer follow its author) or you filter its author; such a
  boost is now left out, as your other boosts are.

### Instance changes

- Store schema: adds seven migrations, applied in order on the first request after the deploy; a rollback to an earlier
  version needs the point-in-time restore described in [docs/upgrade.md](docs/upgrade.md).
    - `0001_blocks_and_mutes`: `mutes.expires_at` with an index, and the `domain_block_cleanups` table. It is quick.
    - `0002_web_push`: the subscription's encoding and sealed token on `push_subscriptions`, and the
      `push_deliveries` table.
    - `0003_domain_block_form`: drops the trailing dot that earlier converters kept on a legacy domain block, so the
      block keeps applying now that blocks are compared as stored, and merges a row that then repeats a block of the
      same account. It is quick.
    - `0004_status_tags_public`: adds `status_tags.public`, marks the hashtags of public statuses, and indexes them.
      Its work grows linearly with the hashtags stored (one pass, with a lookup of each one's status); locally, 500,000
      hashtags took a few seconds.
    - `0005_hide_collections`: adds `local_accounts.hide_collections`, 0 for every account. It is quick.
    - `0006_account_deletion`: adds `accounts.deleted_at` with a partial index, and marks the account of a purge that
      is still running. Its work grows linearly with the accounts stored (one check and one index pass); locally,
      200,000 accounts took under a second.
    - `0007_list_members`: removes the list members whose list's owner neither is nor follows them (a Store converted
      by an earlier release keeps them), and adds the trigger that removes a member with the follow. Its work grows
      linearly with the list members stored (one check of each); it is quick.
- `wrangler.jsonc`: unchanged. Set the `VAPID_JWK` secret to turn Web Push on.

## [0.1.0-rc.3] - 2026-10-14

A third release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The cutover can move a legacy instance's images out of Cloudflare Images. `kopje-admin images-export` downloads the
  images the legacy data references under the operator's Images account, through the Images API with a token read
  from `CF_IMAGES_TOKEN`, or else from the delivery URLs, which give copies in the stored format that may be resized.
  It checks them as Kopje checks an upload and records them in `images.json`; a rerun downloads only what is new.
  `kopje-admin convert --images` then maps avatars, headers, attachments and earlier versions of edited statuses to
  local media rows, each with a file token and an original of its own (also when several show one image), drops
  legacy's default profile images so Kopje's defaults apply, and writes the originals for R2 under their media ids.
  `verify-conversion --images` checks the result independently. A missing image stops the conversion unless
  `--accept-missing-images` is given. The served files are made by `kopje-admin media-rebuild` (below). Without
  `--images`, the conversion is unchanged. See docs/cutover.md ("Media") and docs/cutover-runbook.md.

- `kopje-admin media-rebuild [--dry-run]` (`POST /admin/media/rebuild`, Access admin only) makes the served files of
  local media whose files are missing from their originals in R2: media restored from a backup, which holds only the
  originals, and images moved by the cutover. Each is re-encoded as an upload is, and its sizes in `meta` are corrected
  to the files made. Rows whose files exist are skipped, so it can be run again; it reports rows whose original is
  missing, whose type does not match their URLs, or that fail to re-encode, and stops on the Images quota or the
  monthly transformation budget (exit 3). It writes only while nothing can delete media: before publication, or once
  the Store's maintenance (`kopje-admin maintenance on`) has lasted 20 minutes (otherwise `rebuild-needs-readonly` or
  `rebuild-settling`, exit 3). One call runs at a time under a Store lease, during which imports, resets, publication,
  leaving maintenance, PITR restores and every media-deleting write are refused; after a PITR restore it waits for the
  settle period again. A restore or a cutover thus serves its images when published
  ([docs/backup.md](docs/backup.md), [docs/cutover-runbook.md](docs/cutover-runbook.md) step 8).

- Publication of a cutover converted with `--images` sends an `Update(Person)` to the followers of each local account
  whose avatar or header the conversion changed, so other servers show the new profile images before Cloudflare Images
  is retired. `convert --images` lists those accounts in the dump (the `kopje_state` row `profile_updates`), which
  `verify-conversion` checks; `kopje-admin publish` queues the Updates in its transaction, reports them as
  `profileUpdates`, and queues none when repeated; it is refused while a dump runs (`dump-in-progress`). The list
  holds at most 100 distinct accounts: more changed profiles stop the conversion (`profile-updates-over-limit`). A dump
  that declares fewer restorable `kopje_state` names, such as one from 0.1.0-rc.2, is still accepted
  ([docs/cutover.md](docs/cutover.md), "Media").

### Changed

- The setup guide and the instance template's README state that Kopje needs the Workers Paid plan: the Free plan's
  10 ms of CPU time and 50 subrequests per request are exceeded by signature checks on federated requests, the daily
  backup and media processing.

### Instance changes

- Store schema: unchanged (`0000_initial`).
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.2] - 2026-10-14

A second release candidate of the first release, published under the npm dist-tag `next`.

### Fixed

- The cutover tools read a real D1 export: `convert`, `verify-conversion` and `fingerprint export` accept the
  `DELETE FROM sqlite_sequence` line that `wrangler d1 export` writes, match columns by name (a legacy database may
  have re-added a column in another position, nullable), drop the notifications legacy created for the author of a
  remote post and never showed (`--accept-deletions`), read outbox rows written before legacy migration 0016 as
  targets, and replace lone surrogates in carried text, counting each.

- `kopje-admin import` bounds each call by what it writes, so a real-sized import no longer stops on the Durable
  Object CPU limit: a chunk holds at most 2,000 statements in 4 MiB, and link statements are applied during verify in
  bounded steps. An interrupted import saved by an earlier version cannot be resumed (`import-chunks-outdated`): run
  `import-reset` and import again.

- An activity without addressing (a Follow, Accept, Reject, Like or their Undo) now goes to the recipient's shared
  inbox when it has one, and to its personal inbox only otherwise. Some servers accept such activities at a personal
  inbox but never process them, so a follow could stay pending. If the shared inbox answers 404, 405 or 410 (some
  servers advertise one they have disabled), the activity is sent to the recipient's personal inbox on the same
  server instead. An addressed activity that reaches a recipient without naming it still goes to that recipient's
  personal inbox.

- The cutover rollback no longer reads a Queue holding only delayed messages as empty: Queues leaves a delayed message
  out of the backlog's message count, so `kopje-admin cutover drain` and `kopje-admin cutover close` now count a Queue
  as empty only when its message count and byte count are both 0, and fail closed on a malformed reading. Before, a
  drain could finish while an older request was still delayed in Kopje's Queue, and `cutover close` could remove the
  handoff receipts while a delayed copy of a handed-off request remained.

### Instance changes

- Store schema: unchanged (`0000_initial`).
- `wrangler.jsonc`: unchanged.

## [0.1.0-rc.1] - 2026-10-13

A release candidate of the first release, published under the npm dist-tag `next`.

### Added

- The first release: the Mastodon API, ActivityPub federation, media, search, the `/setup` wizard, the daily
  encrypted backup and the `kopje-admin` CLI.
- The instance template (`deploy/` in the repository), with the Deploy to Cloudflare button.
- The cutover from a legacy Wildebeest instance: `convert`, `verify-conversion`, `cutover-preflight`, `fingerprint`,
  `maintenance-worker`, `maintenance-worker-check` and `cutover` in `kopje-admin`, and
  [docs/cutover-runbook.md](docs/cutover-runbook.md).

### Instance changes

- Store schema: `0000_initial`.
- `wrangler.jsonc`: as in the template, compatibility date `2026-10-11`. Tested with wrangler 4.149.0. The Queue
  consumer has a dead-letter queue (`dead_letter_queue`), which must exist before the deploy.
