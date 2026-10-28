import type { Db } from "../db/sql";
import { storeMaintenanceError } from "../platform/store-errors";
import type { StoreOperation } from "../platform/store-kernel";
import { grantsAny } from "../security/scopes";
import { streamedAnnouncement, streamedAnnouncementReaction } from "./announcements";
import { canView, deleteAudience, mentionsFilteredFor } from "./audience";
import { authorize, authorizeStream, listenerContext, type UserContext } from "./auth";
import { streamedConversation } from "./conversations";
import { ownList } from "./lists";
import { mentionedStatus, streamedNotification } from "./notifications";
import { readOperation, sessionOperation } from "./operation";
import { instanceOrigin } from "./push";
import { presentStatus } from "./status-presenter";
import { journalFull } from "./stream-journal";
import { homeStatus, listStatus, ownListStatus, type PublicFeed, publicStatus, tagStatus } from "./timelines";

// The streaming API's operations on the Store's data (Mastodon 4.5's streaming server; the sockets themselves are
// src/stream-hub.ts's). A write records what a stream may carry in the journal (stream_events, by a trigger of
// migration 0026_streaming, ids only), and a turn of the hub makes each message later, one unit at a time:
//
//   R33 (stream membership): a message (event e, subject x) reaches a subscription (viewer V, stream k) only if the
//   reference for (e, k) returns x to V in the transaction that makes the message, which also authorizes V's tokens
//   and checks k's scope; the payload is that reference's presentation for V. The references:
//     - `notification` on `user` (with a notification scope) and `user:notification`: V's notification list
//       positioned at x (streamedNotification in notifications.ts: R15, unfiltered, kept);
//     - `update` on `user`: home positioned at x (homeStatus in timelines.ts), for a status published within 6 hours
//       of its arrival (Mastodon's real-time window);
//     - `status.update` on `user`: home positioned at x or, with a notification scope, the mention reference (V's
//       notification read restricted to V's mention of x: mentionedStatus in notifications.ts); on
//       `user:notification`, the mention reference alone;
//     - `update` and `status.update` on `list:<id>`: the list's read positioned at x, which includes that the list is
//       V's (listStatus in timelines.ts), with the same real-time window for `update`;
//     - `update` and `status.update` on `public[:local|:remote][:media]` and `hashtag[:local]:<tag>`: the public or the
//       hashtag's timeline positioned at x (publicStatus and tagStatus in timelines.ts: public statuses, not boosts,
//       on `public*` not replies to others, of authors V neither blocks, mutes nor domain-blocks and who do not block
//       V), with the same real-time window for `update`, less a status that mentions an account V blocks or mutes
//       (Mastodon's streaming server filters these per connection; mentionsFilteredFor in audience.ts);
//     - `conversation` on `direct`: the conversation relation, V's row x, presented as the list presents it
//       (streamedConversation in conversations.ts, R25);
//     - `notifications_merged` on `user` (with a notification scope) and `user:notification`: V's transition to no
//       pending accept job (streamMerged, written by notification-requests.ts);
//     - `announcement`, `announcement.reaction` and `announcement.delete` on `user` (with a status scope): the
//       announcement x as it is when sent (R40: published, else its delete; announcements.ts streamedAnnouncement and
//       streamedAnnouncementReaction), the same for every V, presented with no viewer (streamAnnouncement).
//   Each status is presented as REST presents it to V (presentStatus).
//
//   R32 (stream delete): a `delete` of x (a status, or a boost of it) reaches (V, k) only if, in the transaction that
//   first changes the status's audience, V was listening and could view x (R3), and k is `user`, or `list:<id>` when
//   that list's read positioned at x returned x then and the list is still V's when it is sent, or, for the status
//   itself and never a boost, a `public*` or `hashtag*` key its tombstone matches: the status was public, local or
//   remote, with media or not, and carried the key's hashtag, as Mastodon's RemoveStatusService publishes it. The
//   capture (streamDelete) is taken once, before that change, in bounded rows (stream_delete_viewers, migration
//   0028_streaming_home, and stream_delete_tombstones, migration 0035_streaming_public); the unit re-checks V's tokens
//   and the lists' owner.
//
// A conversation's write takes its owner's next change sequence (conversations.ts nextStreamSeq, migration
// 0032_streaming_lists), and the mark's move journals a 'conversation' event for the owner unless one is still ahead of
// the position (one row per owner however many changes a burst makes). Its units are the owner's newest changes above
// what its sockets were sent (streamConversations), at the event's place in the journal.
//
// A unit is one subject for one viewer. Units go in a stable order (event id, then viewer account id ascending, then
// the subject within the viewer's units: 0 for the status, then a delete's captured boosts by id), and the position
// past a unit is persisted by compare-and-set before its messages are sent, so none is sent twice (streamAdvance).
// Delivery is at most once and live: REST is authoritative.

// The stream names Mastodon's streaming server knows (streaming/index.js channelNameToIds), all of them served.
export const STREAM_NAMES: readonly string[] = [
  "user",
  "user:notification",
  "public",
  "public:local",
  "public:remote",
  "public:media",
  "public:local:media",
  "public:remote:media",
  "hashtag",
  "hashtag:local",
  "list",
  "direct",
];

const PUBLIC_STREAMS: readonly string[] = STREAM_NAMES.filter(
  (name) => name === "public" || name.startsWith("public:"),
);

// A subscription's key, as the registry (stream_subscriptions) and a socket's attachment hold it: the stream's name,
// `list:<id>` for a list, or `hashtag:<tag>` and `hashtag:local:<tag>` for a hashtag (the tag normalized as status_tags
// holds it, normalizeTag: it has no colon, so `hashtag:local` is the hashtag #local on `hashtag`).
export function listKey(listId: string): string {
  return `list:${listId}`;
}

export function keyList(key: string): string | null {
  return key.startsWith("list:") ? key.slice("list:".length) : null;
}

export type HashtagStream = "hashtag" | "hashtag:local";

export function hashtagKey(stream: HashtagStream, tag: string): string {
  return `${stream}:${tag}`;
}

export function keyHashtag(key: string): { stream: HashtagStream; tag: string } | null {
  if (key.startsWith("hashtag:local:")) {
    return { stream: "hashtag:local", tag: key.slice("hashtag:local:".length) };
  }
  return key.startsWith("hashtag:") ? { stream: "hashtag", tag: key.slice("hashtag:".length) } : null;
}

function keyPublicFeed(key: string): PublicFeed | null {
  return PUBLIC_STREAMS.includes(key)
    ? { local: key.includes(":local"), remote: key.includes(":remote"), onlyMedia: key.endsWith(":media") }
    : null;
}

// Whether a key is a `public*` or `hashtag*` stream's (Mastodon's feeds that need filtering per connection).
export function isFeedKey(key: string): boolean {
  return keyPublicFeed(key) !== null || keyHashtag(key) !== null;
}

// What a token may stream (streaming/index.js checkScopes and channelsForUserStream): `user` and the other timelines
// need `read:statuses`, `user:notification` and the notifications on `user` need `read:notifications` (`read`
// covers both).
export type StreamGrant = { statuses: boolean; notifications: boolean };

function streamGrant(scopes: readonly string[]): StreamGrant {
  return {
    statuses: grantsAny(scopes, "read:statuses"),
    notifications: grantsAny(scopes, "read:notifications"),
  };
}

export function maySubscribe(grant: StreamGrant, stream: string): boolean {
  return stream === "user:notification" ? grant.notifications : grant.statuses;
}

function carriesNotifications(grant: StreamGrant, key: string): boolean {
  switch (key) {
    case "user:notification":
      return grant.notifications;
    case "user":
      return grant.statuses && grant.notifications;
    default:
      return false;
  }
}

// Whether a subscription with the key `key` may carry an event of `kind` (the journal's: a notification inserted, a
// status inserted, a status edited, a delete captured, a merge done; or a conversation changed) for a token with
// `grant`, before any reference is read: the streams and scopes each event goes to.
export function mayCarry(kind: string, grant: StreamGrant, key: string): boolean {
  const timeline = key === "user" || keyList(key) !== null || isFeedKey(key);
  switch (kind) {
    case "notification":
    case "merged":
      return carriesNotifications(grant, key);
    case "status":
    case "delete":
      return timeline && grant.statuses;
    case "edit":
      return timeline ? grant.statuses : key === "user:notification" && grant.notifications;
    case "conversation":
      return key === "direct" && grant.statuses;
    case "announcement":
    case "announcement_reaction":
      return key === "user" && grant.statuses;
    default:
      return false;
  }
}

// The `update` event's real-time window (Mastodon's Status::REAL_TIME_WINDOW): a status published more than this long
// before it arrived (a remote post fetched late) is not streamed.
const REAL_TIME_WINDOW = "-6 hours";

// A delete's capture (R32): at most this many boosts per viewer, a viewer row of at most this many bytes, and a
// tombstone of at most this many bytes of hashtags (100 hashtags, each a subscribed key's, at most 256 bytes, quoted).
// A row over it (only a change of these caps could make one) drops boosts, newest first, then lists, and a tombstone
// its last hashtags, and is logged; the capture never fails the delete. Tests lower the bytes.
export const CAPTURE_LIMITS = { boosts: 40, viewerBytes: 16 * 1024, tombstoneBytes: 27 * 1024 };

// The conversation changes of one owner a conversation event sends, the newest; older ones are skipped (REST is
// authoritative).
export const CONVERSATIONS_PER_TURN = 20;

// Journal rows pruned per call, at or below the finished position.
export const PRUNE_BATCH = 500;

// The fan-out's position: the last unit sent, as (event id, viewer account id, subject index within the viewer's
// units), the account null once the event is done.
export type StreamPosition = { event: number; subject: number; account: string | null };

// The upgrade: the token is valid and a user's (Mastodon's accountFromToken joins users, so an app token fails), and
// the instance is published. `since` is the journal head: a socket receives only later events.
export const streamAccept = readOperation<
  { tokenHash: string; now: number },
  { status: "ok"; accountId: string; grant: StreamGrant; since: number } | { status: "unauthenticated" }
>((db, { tokenHash, now }) => {
  if (db.first("SELECT 1 AS x FROM kopje_state WHERE name = 'unpublished'") !== undefined) {
    throw storeMaintenanceError("unpublished");
  }
  const auth = authorize(db, { tokenHash, scope: null, now });
  if (auth.status !== "ok" || auth.viewer.accountId === null) {
    return { status: "unauthenticated" };
  }
  return {
    status: "ok",
    accountId: auth.viewer.accountId,
    grant: streamGrant(auth.viewer.scopes),
    since: journalHead(db),
  };
});

// The tokens of the open sockets that are still valid and still their account's (VIS-26: a revoked or expired token,
// or a suspended account's, is closed at the next turn).
export const streamTokens = readOperation<
  { sockets: readonly { tokenHash: string; accountId: string }[]; now: number },
  string[]
>((db, { sockets, now }) => {
  const valid: string[] = [];
  for (const { tokenHash, accountId } of sockets) {
    if (authorizeStream(db, accountId, [tokenHash], now).context !== null) {
      valid.push(tokenHash);
    }
  }
  return valid;
});

// A subject of a unit: its index among the viewer's units of the event (0 for the status, then a delete's captured
// boosts by id; for a conversation event, the change's sequence), and its id.
export type StreamSubject = { index: number; id: string };

// A journal event and, but for a delete (read a page at a time: streamDeleteUnits), the accounts that may be sent it in
// unit order, after the position within it.
export type StreamEvent = { id: number; kind: string; subject: string; viewers: string[] };

// The journal after `position`, oldest first, at most `limit` events, each with the accounts that may be sent it in
// unit order: for a notification, its recipient while it exists; for a merge, its recipient; for a status, every
// account listening on `user` or a list, and for an edit on `user`, `user:notification` or a list (the registry's, at
// most 256, read once a scan), and for either, while the status is public and not a boost, every account listening on
// a `public*` stream (read once a scan) or on a hashtag of the status (each of its hashtags, a
// seek of stream_subscriptions_key for each of the two hashtag streams, once a scan for each status). A delete's units
// are not read here. The event of a position within an event is read again (for its units after the position's), and a
// finished one is not, so a full window means more may follow. Also the journal's span.
export const streamEvents = readOperation<
  { limit: number },
  { position: StreamPosition; ceiling: number; events: StreamEvent[]; head: number; tail: number }
>((db, { limit }) => {
  const { position, ceiling } = readCursor(db);
  const rows = db.all<{ id: number; kind: string; subject: string; recipient: string | null }>(
    `SELECT e.id, e.kind, e.subject, n.account_id AS recipient FROM stream_events e
			LEFT JOIN notifications n ON e.kind = 'notification' AND n.id = CAST(e.subject AS INTEGER)
		WHERE e.id > ?1 OR (e.id = ?1 AND ?3 IS NOT NULL) ORDER BY e.id LIMIT ?2`,
    position.event,
    limit,
    position.account,
  );
  const listeners = new Map<string, string[]>();
  const listening = (keys: readonly string[]) => {
    const name = keys.join(",");
    let accounts = listeners.get(name);
    if (accounts === undefined) {
      accounts = db
        .all<{ account_id: string }>(
          `SELECT DISTINCT account_id FROM stream_subscriptions
					WHERE stream_key IN (SELECT value FROM json_each(?)) OR (stream_key > 'list:' AND stream_key < 'list;')
					ORDER BY account_id`,
          JSON.stringify(keys),
        )
        .map((row) => row.account_id);
      listeners.set(name, accounts);
    }
    return accounts;
  };
  let userListeners: string[] | null = null;
  let publicListeners: string[] | null = null;
  // Cache per status within this scan's transaction; see streamEvents for read bounds.
  const fedByStatus = new Map<string, string[]>();
  const fed = (statusId: string) => {
    let found = fedByStatus.get(statusId);
    if (found === undefined) {
      found = readFed(statusId);
      fedByStatus.set(statusId, found);
    }
    return found;
  };
  const readFed = (statusId: string): string[] => {
    const shown = db.first(
      "SELECT 1 AS x FROM statuses WHERE id = ? AND visibility = 'public' AND reblog_of_id IS NULL",
      statusId,
    );
    if (shown === undefined) {
      return [];
    }
    publicListeners ??= db
      .all<{ account_id: string }>(
        `SELECT DISTINCT account_id FROM stream_subscriptions WHERE stream_key >= 'public' AND stream_key < 'public;'`,
      )
      .map((row) => row.account_id);
    const tagged = db
      .all<{ account_id: string }>(
        `SELECT ss.account_id FROM status_tags t
					CROSS JOIN stream_subscriptions ss ON ss.stream_key IN ('hashtag:' || t.name, 'hashtag:local:' || t.name)
				WHERE t.status_id = ?`,
        statusId,
      )
      .map((row) => row.account_id);
    return [...publicListeners, ...tagged];
  };
  const merged = (...lists: string[][]) => [...new Set(lists.flat())].toSorted();
  const events = rows.map((row): StreamEvent => {
    let viewers: string[];
    switch (row.kind) {
      case "notification":
        viewers = row.recipient === null ? [] : [row.recipient];
        break;
      case "merged":
      case "conversation":
        viewers = [row.subject];
        break;
      case "status":
        viewers = merged(listening(["user"]), fed(row.subject));
        break;
      case "edit":
        viewers = merged(listening(["user", "user:notification"]), fed(row.subject));
        break;
      case "announcement":
      case "announcement_reaction":
        userListeners ??= db
          .all<{ account_id: string }>(
            "SELECT DISTINCT account_id FROM stream_subscriptions WHERE stream_key = 'user' ORDER BY account_id",
          )
          .map((r) => r.account_id);
        viewers = userListeners;
        break;
      default:
        viewers = [];
    }
    // Within the position's event, only the viewers after its account (these events have one unit per viewer; a
    // conversation event's units, all its owner's, are resumed by the hub from the position's subject).
    const after = row.id === position.event ? position.account : null;
    if (after !== null) {
      viewers = viewers.filter((viewer) => viewer > after);
    }
    return { id: row.id, kind: row.kind, subject: row.subject, viewers };
  });
  // Each bound its own subquery: one seek each (min and max together would scan the journal).
  const span = db.first<{ head: number | null; tail: number | null }>(
    "SELECT (SELECT max(id) FROM stream_events) AS head, (SELECT min(id) FROM stream_events) AS tail",
  );
  return { position, ceiling, events, head: span?.head ?? 0, tail: span?.tail ?? 0 };
});

// Where a page of a delete's units starts: after the unit (account, subject), or at the start.
export type StreamUnitAfter = { account: string; subject: number } | null;

// A page of a delete event's units after `after`: at most `rows` viewers' captures (stream_delete_viewers, by its key),
// each viewer's status (subject 0) then its captured boosts oldest first, each with the lists its capture allowed, so
// the units read at once never exceed `rows` × 41 however many viewers the capture holds; and where the next page
// starts, or null after the last.
export const streamDeleteUnits = readOperation<
  { eventId: number; statusId: string; after: StreamUnitAfter; rows: number },
  { units: { viewer: string; subject: StreamSubject; lists: string[] }[]; next: StreamUnitAfter }
>((db, { eventId, statusId, after, rows }) => {
  const captured = db.all<{ account_id: string; lists: string; boosts: string }>(
    `SELECT account_id, lists, boosts FROM stream_delete_viewers WHERE event_id = ?1 AND account_id >= ?2
		ORDER BY account_id LIMIT ?3`,
    eventId,
    after?.account ?? "",
    rows,
  );
  const units = captured.flatMap((row) =>
    [[statusId, JSON.parse(row.lists) as string[]] as const, ...(JSON.parse(row.boosts) as [string, string[]][])]
      .map(([id, lists], index) => ({ viewer: row.account_id, subject: { index, id }, lists: [...lists] }))
      .filter((unit) => after === null || unit.viewer > after.account || unit.subject.index > after.subject),
  );
  const last = captured.at(-1);
  return {
    units,
    next:
      captured.length < rows || last === undefined
        ? null
        : { account: last.account_id, subject: Number.MAX_SAFE_INTEGER },
  };
});

// What a unit sends: one event, its payload (presented once), and the streams it goes on (by key), each with the
// scopes a socket's token needs for it; and the reference reads it made.
export type StreamUnit = {
  grants: Record<string, StreamGrant>;
  event: string;
  payload: unknown;
  streams: { stream: string; needs: StreamGrant }[];
  checks: number;
};

const STATUSES: StreamGrant = { statuses: true, notifications: false };
const NOTIFICATIONS: StreamGrant = { statuses: false, notifications: true };
const BOTH: StreamGrant = { statuses: true, notifications: true };

// One unit: the viewer's tokens checked (each one's grant, while valid), then the reference reads of the event for the
// viewer's streams (R33), and the subject presented once if any reference returns it; for a delete, what its capture
// allowed (R32), with each captured list still the viewer's and, for the status of the delete event `eventId`, the
// feeds its tombstone matches. `lists` are the list ids the unit may go on: those the viewer's sockets subscribe to
// (for a delete, of those its capture allowed); `feeds` the `public*` and `hashtag*` keys they subscribe to. Nothing
// is sent when no token is valid. Each token is a check, and so is each reference read: home, the mention and one
// for each list and feed (the account's keys, at most 16 in all), and the mention filter of the feeds, or a delete's
// tombstone (UNIT_WORST in stream-hub.ts).
export const streamUnit = readOperation<
  {
    kind: string;
    subject: string;
    accountId: string;
    tokenHashes: readonly string[];
    lists?: readonly string[];
    feeds?: readonly string[];
    eventId?: number;
    now: number;
  },
  StreamUnit
>((db, { kind, subject, accountId, tokenHashes, lists = [], feeds = [], eventId, now }) => {
  const { scopes, context } = authorizeStream(db, accountId, tokenHashes, now);
  const grants = Object.fromEntries([...scopes].map(([hash, granted]) => [hash, streamGrant(granted)]));
  const none = { grants, event: "", payload: null, streams: [], checks: 0 };
  const origin = instanceOrigin(db);
  if (context === null || origin === null) {
    return none;
  }
  const notified = Object.values(grants).some((grant) => grant.notifications);
  switch (kind) {
    case "notification": {
      const notification = notified ? streamedNotification(db, context, subject, { origin }) : null;
      return notification === null
        ? { ...none, checks: notified ? 1 : 0 }
        : {
            grants,
            event: "notification",
            payload: notification,
            streams: [
              { stream: "user", needs: BOTH },
              { stream: "user:notification", needs: NOTIFICATIONS },
            ],
            checks: 1,
          };
    }
    case "status": {
      const fresh =
        db.first(
          `SELECT 1 AS x FROM statuses
					WHERE id = ? AND published_at >= strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '${REAL_TIME_WINDOW}')`,
          subject,
        ) !== undefined;
      const home = fresh ? homeStatus(db, context, subject) : null;
      const listed = fresh ? listedIn(db, context, lists, subject) : [];
      const fed = fresh ? fedIn(db, context, feeds, subject) : NOT_FED;
      const shown = home ?? listed[0]?.status ?? fed.status;
      const status = shown === null ? null : presentStatus(db, shown, { origin, viewer: context });
      const checks = fresh ? 1 + lists.length + fed.checks : 0;
      if (status === null) {
        return { ...none, checks };
      }
      const streams: StreamUnit["streams"] = home === null ? [] : [{ stream: "user", needs: STATUSES }];
      return {
        grants,
        event: "update",
        payload: status,
        streams: [...streams, ...listStreams(listed), ...feedStreams(fed.keys)],
        checks,
      };
    }
    case "edit": {
      const home = homeStatus(db, context, subject);
      const mention = notified ? mentionedStatus(db, context, subject) : null;
      const listed = listedIn(db, context, lists, subject);
      const fed = fedIn(db, context, feeds, subject);
      const shown = home ?? mention ?? listed[0]?.status ?? fed.status;
      const status = shown === null ? null : presentStatus(db, shown, { origin, viewer: context });
      const checks = (notified ? 2 : 1) + lists.length + fed.checks;
      if (status === null) {
        return { ...none, checks };
      }
      const streams: StreamUnit["streams"] = [];
      if (home !== null || mention !== null) {
        streams.push({ stream: "user", needs: home !== null ? STATUSES : BOTH });
      }
      if (mention !== null) {
        streams.push({ stream: "user:notification", needs: NOTIFICATIONS });
      }
      return {
        grants,
        event: "status.update",
        payload: status,
        streams: [...streams, ...listStreams(listed), ...feedStreams(fed.keys)],
        checks,
      };
    }
    case "delete": {
      // The captured lists still the viewer's (R32: a list deleted since receives nothing).
      const owned = lists.filter((id) => ownList(db, accountId, id) !== undefined);
      // The feeds the status's tombstone matches (none for a boost: the tombstone is the event's status's).
      const fedKeys = feeds.length > 0 && eventId !== undefined ? tombstoneFeeds(db, eventId, subject, feeds) : [];
      return {
        grants,
        event: "delete",
        payload: subject,
        streams: [
          { stream: "user", needs: STATUSES },
          ...owned.map((id) => ({ stream: listKey(id), needs: STATUSES })),
          ...feedStreams(fedKeys),
        ],
        checks: lists.length + (feeds.length > 0 ? 1 : 0),
      };
    }
    case "merged":
      // No reference to read: the transition was judged when it was written (notification-requests.ts).
      return notified
        ? {
            grants,
            event: "notifications_merged",
            payload: "1",
            streams: [
              { stream: "user", needs: BOTH },
              { stream: "user:notification", needs: NOTIFICATIONS },
            ],
            checks: 0,
          }
        : none;
    case "announcement": {
      const { event, payload } = streamedAnnouncement(db, subject, origin);
      return { grants, event, payload, streams: [{ stream: "user", needs: STATUSES }], checks: 1 };
    }
    case "announcement_reaction": {
      const payload = streamedAnnouncementReaction(db, subject);
      return payload === null
        ? { ...none, checks: 1 }
        : {
            grants,
            event: "announcement.reaction",
            payload,
            streams: [{ stream: "user", needs: STATUSES }],
            checks: 1,
          };
    }
    case "conversation": {
      const conversation = streamedConversation(db, context, subject, { origin });
      return conversation === null
        ? { ...none, checks: 1 }
        : {
            grants,
            event: "conversation",
            payload: conversation,
            streams: [{ stream: "direct", needs: STATUSES }],
            checks: 1,
          };
    }
    default:
      return none;
  }
});

function listedIn(db: Db, viewer: UserContext, lists: readonly string[], statusId: string) {
  return lists.flatMap((id) => {
    const status = listStatus(db, viewer, id, statusId);
    return status === null ? [] : [{ id, status }];
  });
}

function listStreams(listed: readonly { id: string }[]): StreamUnit["streams"] {
  return listed.map(({ id }) => ({ stream: listKey(id), needs: STATUSES }));
}

function feedStreams(keys: readonly string[]): StreamUnit["streams"] {
  return keys.map((key) => ({ stream: key, needs: STATUSES }));
}

type Fed = { keys: string[]; status: ReturnType<typeof publicStatus>; checks: number };

const NOT_FED: Fed = { keys: [], status: null, checks: 0 };

// The feeds (`public*` and `hashtag*` keys) among `feeds` whose read positioned at the status returns it (publicStatus,
// tagStatus), with the status; none when the status mentions an account the viewer blocks or mutes (the per-connection
// filter of Mastodon's streaming server, read once if any feed returned it). Each read is a check.
function fedIn(db: Db, viewer: UserContext, feeds: readonly string[], statusId: string): Fed {
  let status: Fed["status"] = null;
  const keys = feeds.filter((key) => {
    const found = feedStatus(db, viewer, key, statusId);
    status ??= found;
    return found !== null;
  });
  if (keys.length === 0) {
    return { ...NOT_FED, checks: feeds.length };
  }
  if (mentionsFilteredFor(db, viewer.accountId, viewer.now, statusId)) {
    return { ...NOT_FED, checks: feeds.length + 1 };
  }
  return { keys, status, checks: feeds.length + 1 };
}

function feedStatus(db: Db, viewer: UserContext, key: string, statusId: string) {
  const feed = keyPublicFeed(key);
  if (feed !== null) {
    return publicStatus(db, viewer, feed, statusId);
  }
  const hashtag = keyHashtag(key);
  return hashtag === null ? null : tagStatus(db, viewer, hashtag.tag, hashtag.stream === "hashtag:local", statusId);
}

// A delete's tombstone (R32, written by streamDelete for a public status that is not a boost): whether the status was
// local and had media, and those of its hashtags some listener subscribed to.
type Tombstone = { local: boolean; media: boolean; tags: string[] };

// Whether a delete with the tombstone `t` goes on the feed `key` (Mastodon's RemoveStatusService#remove_from_public,
// remove_from_media and remove_from_hashtags).
function tombstoneCarries(t: Tombstone, key: string): boolean {
  const feed = keyPublicFeed(key);
  if (feed !== null) {
    return (!feed.local || t.local) && (!feed.remote || !t.local) && (!feed.onlyMedia || t.media);
  }
  const hashtag = keyHashtag(key);
  return hashtag !== null && t.tags.includes(hashtag.tag) && (hashtag.stream === "hashtag" || t.local);
}

// The feeds among `feeds` the tombstone of the delete event `eventId` matches, when `subject` is the event's status
// (one read, by the tombstone's key; a boost's subject finds none).
function tombstoneFeeds(db: Db, eventId: number, subject: string, feeds: readonly string[]): string[] {
  const row = db.first<{ local: number; media: number; tags: string }>(
    `SELECT t.local, t.media, t.tags FROM stream_delete_tombstones t JOIN stream_events e ON e.id = t.event_id
		WHERE t.event_id = ? AND e.subject = ?`,
    eventId,
    subject,
  );
  if (row === undefined) {
    return [];
  }
  const tombstone = { local: row.local === 1, media: row.media === 1, tags: JSON.parse(row.tags) as string[] };
  return feeds.filter((key) => tombstoneCarries(tombstone, key));
}

// R32's capture of the delete of the status (or boost) `statusId`, made once, before the first change to its audience
// (the four sites: deleteStatus and unreblog in statuses.ts, a remote Delete when its job is created and a remote
// Delete or Undo of a boost in inbox.ts): a 'delete' event in the journal, with one row per listening account that may
// view the status (R3): those listening on `user` or a list, each with the boosts of it the account may view
// (deleteAudience in audience.ts, at most CAPTURE_LIMITS.boosts), and for the status and each boost the account's
// subscribed lists whose read positioned at it returns it (listStatus: at most 16 lists, each a narrowed read); and
// those listening only on feeds the status's tombstone matches, without boosts (canView alone). The tombstone
// (stream_delete_tombstones) is written for a public status that is not a boost while some account listens on a
// `public*` stream or a hashtag of it: whether it is local and has media, and its hashtags that some account subscribes
// to. Nothing is written when nobody listening may view it, or when the journal is full (the fan-out stalled; logged as
// the triggers' events are).
// The rows are at most 1 + 256 (the registry's accounts), each within CAPTURE_LIMITS.viewerBytes, and the tombstone
// within CAPTURE_LIMITS.tombstoneBytes; a row over it is truncated and logged, never refused, so the capture never
// fails the delete.
export function streamDelete(db: Db, statusId: string, now: number): void {
  const listening = new Map<string, string[]>();
  const feeds = new Map<string, string[]>();
  for (const row of db.all<{ account_id: string; stream_key: string }>(
    `SELECT account_id, stream_key FROM stream_subscriptions
		WHERE stream_key = 'user' OR (stream_key > 'list:' AND stream_key < 'list;')
			OR (stream_key >= 'public' AND stream_key < 'public;') OR (stream_key > 'hashtag:' AND stream_key < 'hashtag;')
		ORDER BY account_id`,
  )) {
    if (isFeedKey(row.stream_key)) {
      feeds.set(row.account_id, [...(feeds.get(row.account_id) ?? []), row.stream_key]);
      continue;
    }
    const lists = listening.get(row.account_id) ?? [];
    const list = keyList(row.stream_key);
    if (list !== null) {
      lists.push(list);
    }
    listening.set(row.account_id, lists);
  }
  const tombstone = feeds.size === 0 ? null : tombstoneOf(db, statusId, [...feeds.values()].flat());
  const fed =
    tombstone === null
      ? []
      : [...feeds]
          .filter(([account, keys]) => !listening.has(account) && keys.some((key) => tombstoneCarries(tombstone, key)))
          .map(([account]) => account);
  if (listening.size === 0 && fed.length === 0) {
    return;
  }
  if (journalFull(db, "delete")) {
    return;
  }
  // A feed's listener is sent the status's delete only (never a boost's): its boosts are not read. Every viewer in
  // account id order, as the rows are written.
  const audience = [
    ...deleteAudience(db, statusId, [...listening.keys()].toSorted(), CAPTURE_LIMITS.boosts),
    ...fed.flatMap((accountId) => (canView(db, accountId, statusId) ? [{ accountId, boosts: [] }] : [])),
  ].toSorted((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  if (audience.length === 0) {
    return;
  }
  const event = db.first<{ id: number }>(
    "INSERT INTO stream_events (kind, subject, created_at) VALUES ('delete', ?, ?) RETURNING id",
    statusId,
    new Date(now).toISOString(),
  )!.id;
  if (tombstone !== null) {
    db.run(
      "INSERT INTO stream_delete_tombstones (event_id, local, media, tags) VALUES (?, ?, ?, ?)",
      event,
      tombstone.local ? 1 : 0,
      tombstone.media ? 1 : 0,
      JSON.stringify(tombstone.tags),
    );
  }
  for (const viewer of audience) {
    // The viewer's subscribed lists that are its own, in order, each found once for the status and all its boosts.
    const owned = (listening.get(viewer.accountId) ?? []).flatMap((id) => ownList(db, viewer.accountId, id) ?? []);
    const context = listenerContext(viewer.accountId, now);
    const lists = (id: string) =>
      owned.filter((list) => ownListStatus(db, context, list, id) !== null).map((list) => list.id);
    const row = captureRow(
      lists(statusId),
      viewer.boosts.map((boost) => [boost, lists(boost)]),
    );
    db.run(
      "INSERT INTO stream_delete_viewers (event_id, account_id, lists, boosts) VALUES (?, ?, ?, ?)",
      event,
      viewer.accountId,
      row.lists,
      row.boosts,
    );
  }
}

// The tombstone of the status `statusId` if it is public and not a boost (Mastodon publishes no other delete on its
// feeds), with its hashtags that one of `keys` (the subscribed feeds) names, each at most once and read by the status's
// key, within CAPTURE_LIMITS.tombstoneBytes (the last by name dropped while over, logged).
function tombstoneOf(db: Db, statusId: string, keys: readonly string[]): Tombstone | null {
  const status = db.first<{ local: number; media: number }>(
    `SELECT a.domain IS NULL AS local,
			EXISTS (SELECT 1 FROM media_attachments m WHERE m.status_id = s.id AND m.shown = 1) AS media
		FROM statuses s JOIN accounts a ON a.id = s.account_id
		WHERE s.id = ? AND s.visibility = 'public' AND s.reblog_of_id IS NULL`,
    statusId,
  );
  if (status === undefined) {
    return null;
  }
  const subscribed = new Set(keys.flatMap((key) => keyHashtag(key)?.tag ?? []));
  // Each subscribed hashtag sought by the status's key (status_id, name), so an imported status's other hashtags are
  // never read: at most one probe per hashtag key of the subscription registry, which bounds the names. Every
  // subscribed hashtag the status carries is kept, so each feed that got the status gets its delete, within the
  // byte bound below.
  const tags = db
    .all<{ name: string }>(
      `SELECT name FROM status_tags WHERE status_id = ?1 AND name IN (SELECT value FROM json_each(?2))
			ORDER BY name`,
      statusId,
      JSON.stringify([...subscribed]),
    )
    .map((row) => row.name);
  const size = () => new TextEncoder().encode(JSON.stringify(tags)).byteLength;
  if (size() > CAPTURE_LIMITS.tombstoneBytes) {
    while (tags.length > 0 && size() > CAPTURE_LIMITS.tombstoneBytes) {
      tags.pop();
    }
    console.warn({ event: "kopje.stream.capture-truncated", tags: tags.length });
  }
  const tombstone = { local: status.local === 1, media: status.media === 1, tags };
  return keys.some((key) => tombstoneCarries(tombstone, key)) ? tombstone : null;
}

// A viewer's capture as its row's JSON, within CAPTURE_LIMITS.viewerBytes: boosts dropped from the newest while it is
// over, then the status's list ids (logged once).
function captureRow(lists: string[], boosts: [string, string[]][]): { lists: string; boosts: string } {
  const kept = { lists: [...lists], boosts: [...boosts] };
  const size = () => JSON.stringify(kept.boosts).length + JSON.stringify(kept.lists).length;
  let truncated = false;
  while (size() > CAPTURE_LIMITS.viewerBytes && (kept.boosts.length > 0 || kept.lists.length > 0)) {
    truncated = true;
    if (kept.boosts.length > 0) {
      kept.boosts.pop();
    } else {
      kept.lists.pop();
    }
  }
  if (truncated) {
    console.warn({
      event: "kopje.stream.capture-truncated",
      boosts: kept.boosts.length,
      lists: kept.lists.length,
    });
  }
  return { lists: JSON.stringify(kept.lists), boosts: JSON.stringify(kept.boosts) };
}

// Moves the position from `from` to `to` if it is still at `from`: false when another turn moved it first.
export const streamAdvance = sessionOperation<{ from: StreamPosition; to: StreamPosition }, boolean>(
  (db, { from, to }) =>
    db.run(
      `UPDATE stream_cursor SET event_id = ?4, subject = ?5, account_id = ?6
			WHERE id = 1 AND event_id = ?1 AND subject = ?2 AND account_id IS ?3`,
      from.event,
      from.subject,
      from.account,
      to.event,
      to.subject,
      to.account,
    ) === 1,
);

// Moves the position from `from` into the conversation event `eventId` of `owner`, before its first unit, if it is
// still at `from`, and fixes the event's ceiling: the owner's mark now. The same write makes the trigger
// stream_conversation_changed journal any later change of the owner in a new row (the position is at this event), so
// the event sends changes up to the ceiling only and ends after at most CONVERSATIONS_PER_TURN units. Returns the
// ceiling, or null when another turn moved the position first.
export const streamEnterConversation = sessionOperation<
  { from: StreamPosition; eventId: number; owner: string },
  number | null
>((db, { from, eventId, owner }) => {
  const row = db.first<{ ceiling: number | null }>(
    `UPDATE stream_cursor SET event_id = ?4, subject = 0, account_id = ?5,
			ceiling = coalesce((SELECT seq FROM stream_conversation_marks WHERE account_id = ?5), 0)
		WHERE id = 1 AND event_id = ?1 AND subject = ?2 AND account_id IS ?3 RETURNING ceiling`,
    from.event,
    from.subject,
    from.account,
    eventId,
    owner,
  );
  return row === undefined ? null : (row.ceiling ?? 0);
});

// Deletes at most PRUNE_BATCH rows in all at or below `upTo`, a finished event, but the newest journal row: it keeps the
// next id above every id given (the journal has no AUTOINCREMENT counter). Journal rows go first, so the journal's span
// shrinks as soon as the fan-out passes them; then, with what is left of the batch, the capture rows of finished
// deletes, oldest first, viewers then tombstones (they name their event by id only, so nothing cascades). Returns how
// many journal rows went, and whether prunable rows are left for another call.
export const streamPrune = sessionOperation<{ upTo: number }, { pruned: number; more: boolean }>((db, { upTo }) => {
  const changes = () => db.first<{ n: number }>("SELECT changes() AS n")?.n ?? 0;
  db.run(
    `DELETE FROM stream_events WHERE id IN (SELECT id FROM stream_events
			WHERE id <= ?1 AND id < (SELECT max(id) FROM stream_events) ORDER BY id LIMIT ?2)`,
    upTo,
    PRUNE_BATCH,
  );
  const pruned = changes();
  let left = PRUNE_BATCH - pruned;
  if (left > 0) {
    db.run(
      `DELETE FROM stream_delete_viewers WHERE (event_id, account_id) IN (SELECT event_id, account_id
				FROM stream_delete_viewers WHERE event_id <= ?1 AND event_id < (SELECT max(id) FROM stream_events)
				ORDER BY event_id, account_id LIMIT ?2)`,
      upTo,
      left,
    );
    left -= changes();
  }
  if (left > 0) {
    db.run(
      `DELETE FROM stream_delete_tombstones WHERE event_id IN (SELECT event_id FROM stream_delete_tombstones
				WHERE event_id <= ?1 AND event_id < (SELECT max(id) FROM stream_events) ORDER BY event_id LIMIT ?2)`,
      upTo,
      left,
    );
  }
  const more =
    db.first(
      `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM stream_events
					WHERE id <= ?1 AND id < (SELECT max(id) FROM stream_events))
				OR EXISTS (SELECT 1 FROM stream_delete_viewers
					WHERE event_id <= ?1 AND event_id < (SELECT max(id) FROM stream_events))
				OR EXISTS (SELECT 1 FROM stream_delete_tombstones
					WHERE event_id <= ?1 AND event_id < (SELECT max(id) FROM stream_events))`,
      upTo,
    ) !== undefined;
  return { pruned, more };
});

export type StreamKeys = readonly { key: string; sockets: number }[];

// The stream keys an account's open sockets subscribe to, replacing what was recorded: written on subscribe,
// unsubscribe and close. With `direct`, the account's conversation mark, made on its first subscription from the
// highest stream_seq of its conversations (one seek of conversations_stream), never lowered; returned as where a socket
// that subscribes now starts (its convSeq).
export const streamRegister = sessionOperation<{ accountId: string; keys: StreamKeys }, { convSeq: number | null }>(
  (db, { accountId, keys }) => {
    db.run("DELETE FROM stream_subscriptions WHERE account_id = ?", accountId);
    insertKeys(db, accountId, keys);
    if (!keys.some(({ key }) => key === "direct")) {
      return { convSeq: null };
    }
    db.run(
      `INSERT INTO stream_conversation_marks (account_id, seq)
			SELECT ?1, coalesce((SELECT max(stream_seq) FROM conversations WHERE account_id = ?1), 0)
			ON CONFLICT (account_id) DO NOTHING`,
      accountId,
    );
    return {
      convSeq: db.first<{ seq: number }>("SELECT seq FROM stream_conversation_marks WHERE account_id = ?", accountId)!
        .seq,
    };
  },
);

// Whether the list `listId` is the account's: a `list` subscription needs it (Mastodon's authorizeListAccess), and each
// message checks it again (listStatus, or a delete's ownList).
export const streamListOwned = readOperation<{ accountId: string; listId: string }, boolean>(
  (db, { accountId, listId }) => ownList(db, accountId, listId) !== undefined,
);

// An owner's conversation changes above `after` (the lowest convSeq of its `direct` sockets, or the position within the
// event) and at most `upTo` (the event's ceiling): the newest `limit`, by conversations_stream, oldest of them first,
// so they are sent in order and each socket's convSeq rises with each. Older changes are skipped.
export const streamConversations = readOperation<
  { accountId: string; after: number; upTo: number; limit: number },
  { id: string; seq: number }[]
>((db, { accountId, after, upTo, limit }) =>
  db
    .all<{ id: string; seq: number }>(
      `SELECT CAST(id AS TEXT) AS id, stream_seq AS seq FROM conversations WHERE account_id = ?1 AND stream_seq > ?2
				AND stream_seq <= ?4
			ORDER BY stream_seq DESC LIMIT ?3`,
      accountId,
      after,
      limit,
      upTo,
    )
    .toReversed(),
);

// The streaming API's `notifications_merged` for the account (notification-requests.ts calls it on its transition to
// no pending accept job): a 'merged' event in the journal, while the account listens on `user` or `user:notification`
// (the scope is checked when it is sent) and the journal is not full.
export function streamMerged(db: Db, accountId: string, now: string): void {
  const listening = db.first(
    "SELECT 1 AS x FROM stream_subscriptions WHERE account_id = ? AND stream_key IN ('user', 'user:notification')",
    accountId,
  );
  if (listening === undefined) {
    return;
  }
  if (journalFull(db, "merged")) {
    return;
  }
  db.run("INSERT INTO stream_events (kind, subject, created_at) VALUES ('merged', ?, ?)", accountId, now);
}

// The whole registry rebuilt from the open sockets, by the first turn after the Store starts (sockets closed while it
// was not running left their rows).
export const streamReconcile = sessionOperation<{ accounts: readonly { accountId: string; keys: StreamKeys }[] }, null>(
  (db, { accounts }) => {
    db.run("DELETE FROM stream_subscriptions");
    for (const { accountId, keys } of accounts) {
      insertKeys(db, accountId, keys);
    }
    return null;
  },
);

// Streaming-test drain barrier: position reached the journal head, including conversation changes.
export const streamCaughtUp = readOperation<void, boolean>((db) => {
  const position = readPosition(db);
  const head = journalHead(db);
  return head === 0 || (position.event >= head && position.account === null);
});

// The operations the hub runs for itself: their commits start no turn.
export const STREAM_OPERATIONS: ReadonlySet<StoreOperation<never, unknown>> = new Set<StoreOperation<never, unknown>>([
  streamAdvance,
  streamEnterConversation,
  streamPrune,
  streamRegister,
  streamReconcile,
]);

function insertKeys(db: Db, accountId: string, keys: StreamKeys): void {
  for (const { key, sockets } of keys) {
    db.run(
      "INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, ?, ?)",
      accountId,
      key,
      sockets,
    );
  }
}

// The position, and the ceiling of the conversation event it is within (streamEnterConversation; meaningless
// elsewhere).
function readCursor(db: Db): { position: StreamPosition; ceiling: number } {
  const row = db.first<{ event_id: number; subject: number; account_id: string | null; ceiling: number | null }>(
    "SELECT event_id, subject, account_id, ceiling FROM stream_cursor WHERE id = 1",
  );
  return {
    position: { event: row?.event_id ?? 0, subject: row?.subject ?? 0, account: row?.account_id ?? null },
    ceiling: row?.ceiling ?? 0,
  };
}

function readPosition(db: Db): StreamPosition {
  return readCursor(db).position;
}

function journalHead(db: Db): number {
  return db.first<{ head: number | null }>("SELECT max(id) AS head FROM stream_events")?.head ?? 0;
}
