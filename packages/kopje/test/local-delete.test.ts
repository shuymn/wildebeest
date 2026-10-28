import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { deleteActivity } from "../src/domain/activities";
import { claimDeliveries, completeDelivery, TARGET_CHUNK_SIZE } from "../src/domain/deliveries";
import { deleteStatusBatch, PURGE_BATCH, runInboundJobs } from "../src/domain/inbox";
import { JOB_RETRY_DELAYS_MS } from "../src/domain/job-attempts";
import { DETACHED_GRACE_MS } from "../src/domain/media";
import { MAX_PUSH_BACKLOG } from "../src/domain/notifications";
import { pollRound } from "../src/domain/polls";
import { MAX_STATUS_MEDIA, MAX_STATUS_TAGS } from "../src/domain/status-bounds";
import { DELETE_SUPERSEDES, deleteStatus, MAX_DELETE_NAMED } from "../src/domain/statuses";
import { homeTimeline } from "../src/domain/timelines";
import { ACTOR_URI_LIMIT, STATUS_URI_LIMIT } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { batch, batches, remoteAccountsAt, retractionInboxes, seedStagingRetractions } from "./delete-job-helpers";
import { BUILD, migratedStore } from "./helpers";
import { MASTODON, mastodonActor } from "./inbox-helpers";
import {
  ALICE,
  ALICE_URI,
  AS,
  create,
  DAVE,
  followed,
  localStatus,
  mastodonNote,
  PUBLIC,
  type Setup,
  setup,
  statusRow,
} from "./inbox-status-helpers";
import { copyConfig, dumpViaRpc, importViaRpc, setAccess } from "./ops-helpers";
import { quoteAccept, quoting } from "./quote-helpers";
import { rowsRead, watchedCursor } from "./read-helpers";
import { seedReceipts } from "./status-helpers";

// RES-6, VIS-1, VIS-3, ID-7: a local status's DELETE (statuses.ts deleteStatus) records its Delete over a snapshot,
// hides the status and removes what it alone shows, each within a bound, then its job (inbox.ts deleteStatusBatch)
// stages the Delete's targets while what they are read from stays, withdraws its local boosts and deletes the rest in
// batches of at most PURGE_BATCH rows. Nobody sees the status from the DELETE on, and no producer records content
// about it after its Delete.

const PRESENT = { origin: "https://kopje.test" };
const ENCODER = new TextEncoder();

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
  (await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n;

// The bytes JSON writes for the string `value`, without its quotes.
const escaped = (value: string) => ENCODER.encode(JSON.stringify(value)).length - 2;

// A URI of exactly `limit` JSON-escaped UTF-8 bytes, `prefix` then NUL characters (six escaped bytes each, one raw) and
// astral ones (four bytes either way), then ASCII: its raw bytes and code units within `limit` too.
function boundedUri(prefix: string, limit: number): string {
  let uri = prefix;
  for (let i = 0; i < 64 && escaped(`${uri}\u0000`) <= limit; i++) {
    uri += "\u0000";
  }
  for (let i = 0; i < 64 && escaped(`${uri}\u{1F600}`) <= limit; i++) {
    uri += "\u{1F600}";
  }
  while (escaped(`${uri}a`) <= limit) {
    uri += "a";
  }
  return uri;
}

async function credential(t: Setup, as: "alice" | "dave" = "alice") {
  return { tokenHash: await sha256Hex(t.tokens[as]), scope: "write:statuses" as const, now: NOW };
}

// alice's DELETE of `id` as a Store operation in its own transaction: its answer, the rows it wrote (total_changes())
// and its time.
async function deleted(t: Setup, id: string, deleteMedia = false) {
  const input = { credential: await credential(t), id, deleteMedia, now: NOW, present: PRESENT };
  return runInDurableObject(t.store, (_instance, state) => {
    const db = new Db(state.storage.sql);
    const changes = () => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
    const before = changes();
    const started = performance.now();
    const result = state.storage.transactionSync(() => deleteStatus.run(state.storage.sql, input));
    const answer = result.status === "ok" ? result.value.status : result.status;
    return { answer, wrote: changes() - before, ms: performance.now() - started };
  });
}

// The Delete's envelope as stored, at its maxima: its status's uri three times (the activity id, the Tombstone and its
// atomUri), its author's actor id twice (actor, and the followers collection in cc) and MAX_DELETE_NAMED actor ids in
// cc, each at its bound in JSON-escaped UTF-8 bytes (identity-bounds.ts), and the status's id twice (18 bytes each).
const ENVELOPE_BYTES =
  ENCODER.encode(
    JSON.stringify(
      deleteActivity({
        id: "1".repeat(18),
        uri: "",
        actorUri: "",
        visibility: "public",
        named: Array.from({ length: MAX_DELETE_NAMED }, () => ""),
        poll: true,
      }),
    ),
  ).length +
  3 * STATUS_URI_LIMIT +
  (2 + MAX_DELETE_NAMED) * ACTOR_URI_LIMIT;

// The rows a DELETE of an original writes at most (RES-6), at every input's maximum: the streaming capture (an event,
// a tombstone and 256 viewers), DELETE_SUPERSEDES earlier activities superseded (an update and a delete each, and the
// end of the staging of one still staging, which only an import holds: outbound_activities_staging_ended), the
// intent, the hide and the account's last status (its trigger), the card, trend row, review, author's pin and poll,
// its own quote (the quote, its target's count and Kopje's revocation), MAX_STATUS_TAGS hashtags, MAX_STATUS_MEDIA
// media, the two counts and the job.
const SUPERSEDE_ROWS = 3 * DELETE_SUPERSEDES;
const REQUEST_ROWS = 258 + SUPERSEDE_ROWS + 1 + 2 + 5 + 3 + MAX_STATUS_TAGS + MAX_STATUS_MEDIA + 2 + 1;

describe("the Delete of a local status (VIS-3, RES-6)", () => {
  it("stores its envelope within its derived bound, the identities at their bound at the worst escaping", async () => {
    const t = await setup();
    const status = await localStatus(t, { status: "bounded", poll: { options: ["a", "b"], expires_in: 600 } });
    // alice's actor id, the status's uri and MAX_DELETE_NAMED mentioned accounts' actor ids at their bound, with NUL
    // and astral characters, as an import may store them; more mentions than it names, silent ones among them.
    await sql(
      t.store,
      "UPDATE accounts SET uri = ? WHERE id = ?",
      boundedUri("https://kopje.test/", ACTOR_URI_LIMIT),
      ALICE,
    );
    const uri = boundedUri("https://kopje.test/ap/o/", STATUS_URI_LIMIT);
    await sql(t.store, "UPDATE statuses SET uri = ? WHERE id = ?", uri, status.id);
    const mentioned = await remoteAccountsAt(t.store, "6", "m", MAX_DELETE_NAMED + 20);
    for (const id of mentioned.slice(0, MAX_DELETE_NAMED)) {
      await sql(
        t.store,
        "UPDATE accounts SET uri = ? WHERE id = ?",
        boundedUri(`https://m.example/${id}/`, ACTOR_URI_LIMIT),
        id,
      );
    }
    await sql(
      t.store,
      `INSERT INTO status_mentions (status_id, account_id, silent)
			SELECT ?, id, CASE WHEN id > ? THEN 1 ELSE 0 END FROM accounts WHERE id GLOB '6*'`,
      status.id,
      mentioned[MAX_DELETE_NAMED + 9]!,
    );
    const { answer, wrote } = await deleted(t, status.id);
    expect(answer).toBe("ok");
    expect(wrote).toBeLessThanOrEqual(REQUEST_ROWS);
    const [body] = await sql<{ bytes: number; cc: number }>(
      t.store,
      `SELECT length(CAST(body AS BLOB)) AS bytes, json_array_length(body, '$.activity.cc') AS cc
			FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Delete'`,
    );
    // Every identity at its bound and MAX_DELETE_NAMED of them named: the derived figure, exactly.
    expect(body).toEqual({ bytes: ENVELOPE_BYTES, cc: 1 + MAX_DELETE_NAMED });
    // The mentions past MAX_DELETE_NAMED, and the silent ones, each get a copy of their own when it is staged.
    await settle(t.store);
    const personal = await sql<{ addressee: string }>(
      t.store,
      `SELECT json_extract(t.value, '$.addressee') AS addressee FROM outbound_targets c, json_each(c.targets) t
			WHERE json_extract(t.value, '$.addressee') IS NOT NULL`,
    );
    expect(personal).toHaveLength(20);
  });

  it("names no mention past its bound, and records no Delete of a status whose uri is past its bound", async () => {
    const t = await setup();
    const [long, short] = await remoteAccountsAt(t.store, "6", "m", 2);
    await sql(
      t.store,
      "UPDATE accounts SET uri = ? WHERE id = ?",
      boundedUri("https://m1.example/", ACTOR_URI_LIMIT + 1),
      long!,
    );
    const mentioning = await localStatus(t, { status: "two" });
    await sql(
      t.store,
      "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?1, ?2, 0), (?1, ?3, 0)",
      mentioning.id,
      long!,
      short!,
    );
    expect((await deleted(t, mentioning.id)).answer).toBe("ok");
    const [named] = await sql<{ cc: string }>(
      t.store,
      "SELECT json_extract(body, '$.activity.cc') AS cc FROM outbound_activities WHERE object_uri = ?",
      mentioning.uri,
    );
    expect(JSON.parse(named!.cc)).toEqual([`${ALICE_URI}/followers`, "https://m2.example/users/u"]);
    await settle(t.store);
    expect(await retractionInboxes(t.store, mentioning.uri, "Delete")).toEqual(
      new Set(["https://m1.example/users/u/inbox", "https://m2.example/inbox"]),
    );
    // An imported status whose uri is past STATUS_URI_LIMIT records no Delete (VIS-3, an accepted limit): it is
    // hidden and removed all the same.
    const imported = await localStatus(t, { status: "imported" });
    await sql(
      t.store,
      "UPDATE statuses SET uri = ? WHERE id = ?",
      boundedUri("https://kopje.test/", STATUS_URI_LIMIT + 1),
      imported.id,
    );
    expect((await deleted(t, imported.id)).answer).toBe("ok");
    expect(await sql(t.store, "SELECT withdrawn FROM statuses WHERE id = ?", imported.id)).toEqual([{ withdrawn: 1 }]);
    expect(await count(t.store, "SELECT 1 FROM outbound_activities WHERE account_id = ? AND retracts = 1", ALICE)).toBe(
      1,
    );
    await settle(t.store);
    expect(await count(t.store, "SELECT 1 FROM statuses WHERE id = ?", imported.id)).toBe(0);
  });
});

// The worst converted local status at once: every child past its native bound (mentions, hashtags with more featured
// hashtags than the writer allows, media, edits, pins, filters), favourites with their tracked Like ids, notifications
// of many senders with one holding all MAX_PUSH_BACKLOG pushes, remote boosts and a local boost, receipts staged over
// more than one call, a voter in no other part of its audience, replies, near-exhausting authorized quotes of it, an
// accepted quote of its own, conversations, a trend row, a review and a card, earlier activities about it past
// DELETE_SUPERSEDES with delivered, leased, exposed and given-up rows, and every streaming subscription.
async function worst(t: Setup) {
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob, DAVE);
  const parent = mastodonNote(bob);
  expect(await t.post(bob, create(bob, parent))).toBe(202);
  const parentId = (await statusRow(t.store, parent.id))!.id;
  const daves = await localStatus(t, { status: "quoted by alice" }, "dave");
  const other = await localStatus(t, { status: "another #t000 #t149" });
  const status = await localStatus(t, {
    status: "the worst",
    in_reply_to_id: parentId,
    poll: { options: ["a", "b"], expires_in: 600 },
  });
  const id = status.id;
  const followers = await remoteAccountsAt(t.store, "5", "f", 5);
  await sql(
    t.store,
    `INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*'`,
    ALICE,
  );
  const mentioned = await remoteAccountsAt(t.store, "6", "m", 260);
  await sql(
    t.store,
    `INSERT INTO status_mentions (status_id, account_id, silent)
		SELECT ?, id, CASE WHEN id > '600000000000000220' THEN 1 ELSE 0 END FROM accounts WHERE id GLOB '6*'`,
    id,
  );
  // 150 hashtags, more than MAX_STATUS_TAGS; alice features 12 of them (more than MAX_FEATURED_TAGS), 6 past the first
  // hundred by name, and t000 and t149 are also on her other status.
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 149)
		INSERT INTO status_tags (status_id, name, public) SELECT ?, printf('t%03d', i), 1 FROM n`,
    id,
  );
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 149)
		INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at)
		SELECT printf('7%017d', i), ?, printf('t%03d', i), printf('t%03d', i), 2, '2026-10-12T00:00:00.000Z' FROM n
		WHERE i < 6 OR i >= 144`,
    ALICE,
  );
  // Eight local uploads, four shown and four an edit dropped; 120 edits.
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 7)
		INSERT INTO media_attachments (id, account_id, status_id, position, type, url, file_token, shown)
		SELECT printf('8%017d', i), ?1, ?2, i, 'image', 'https://kopje.test/files/f' || i, 'f' || i, i < 4 FROM n`,
    ALICE,
    id,
  );
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 119)
		INSERT INTO status_edits (status_id, content, created_at) SELECT ?, 'v' || i, '2026-10-12T00:00:00.000Z' FROM n`,
    id,
  );
  // alice's pin and dave's (an import's), 60 filters of dave's naming it.
  await sql(t.store, "INSERT INTO status_pins (account_id, status_id) VALUES (?1, ?3), (?2, ?3)", ALICE, DAVE, id);
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 59)
		INSERT INTO filters (id, account_id, title, context) SELECT printf('9%017d', i), ?, 'f' || i, '["home"]' FROM n`,
    DAVE,
  );
  await sql(
    t.store,
    `INSERT INTO filter_statuses (id, filter_id, status_id) SELECT printf('3%017d', rowid), id, ? FROM filters`,
    id,
  );
  // 30 favourites, four tracked Like ids each; 300 notifications from as many senders, and one holding every push.
  await sql(
    t.store,
    "INSERT INTO favourites (account_id, status_id) SELECT id, ? FROM accounts WHERE id GLOB '6*' AND id <= '600000000000000030'",
    id,
  );
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
		INSERT INTO favourite_likes (favourite_id, uri, received_at)
		SELECT f.id, 'https://likes.example/' || f.id || '/' || n.i, 0 FROM favourites f, n`,
  );
  await sql(
    t.store,
    "INSERT INTO notifications (account_id, type, from_account_id, status_id) SELECT ?, 'favourite', id, ? FROM accounts WHERE id GLOB '6*' AND id <= '600000000000000300'",
    ALICE,
    id,
  );
  const [held] = await sql<{ id: number }>(t.store, "SELECT min(id) AS id FROM notifications WHERE status_id = ?", id);
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
		SELECT 'push-' || i, 'access', (SELECT client_id FROM oauth_tokens LIMIT 1), ?2, 'push' FROM n`,
    MAX_PUSH_BACKLOG,
    ALICE,
  );
  await sql(
    t.store,
    `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth)
		SELECT token_hash, 'https://push.example/' || token_hash, 'k', 'a' FROM oauth_tokens WHERE token_hash GLOB 'push-*'`,
  );
  await sql(
    t.store,
    `INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
		SELECT id, ?, ?, ? FROM push_subscriptions WHERE token_hash GLOB 'push-*'`,
    held!.id,
    NOW,
    NOW,
  );
  // 40 remote boosts; dave's boost, which his remote follower received; five remote replies.
  const boosters = await remoteAccountsAt(t.store, "4", "b", 40);
  await sql(
    t.store,
    `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
		SELECT '41' || substr(id, 3), uri || '/boost', id, ?, 'public', '2026-10-12T00:00:00.000Z' FROM accounts WHERE id GLOB '4*'`,
    id,
  );
  await remoteAccountsAt(t.store, "2", "d", 1);
  await sql(
    t.store,
    "INSERT INTO follows (account_id, target_account_id, state) VALUES ('200000000000000001', ?, 'accepted')",
    DAVE,
  );
  const reblogged = await t.request(`/api/v1/statuses/${id}/reblog`, {
    method: "POST",
    headers: { authorization: `Bearer ${t.tokens.dave}` },
  });
  expect(reblogged.status).toBe(200);
  await sql(
    t.store,
    `INSERT INTO statuses (id, uri, account_id, in_reply_to_id, in_reply_to_uri, visibility, content, published_at)
		SELECT '61' || substr(id, 3), uri || '/reply', id, ?1, ?2, 'public', '', '2026-10-12T00:00:00.000Z'
		FROM accounts WHERE id GLOB '6*' AND id <= '600000000000000005'`,
    id,
    status.uri,
  );
  // A voter in no other part of its audience.
  await remoteAccountsAt(t.store, "1", "v", 1);
  await sql(t.store, "INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, '100000000000000001', 0)", id);
  // 400 accepted quotes of it with Kopje's authorization, by as many remote authors; its own accepted quote of dave's.
  const quoters = await remoteAccountsAt(t.store, "3", "q", 400);
  await sql(
    t.store,
    `INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT '31' || substr(id, 3), uri || '/quote', id, 'public', '2026-10-12T00:00:00.000Z' FROM accounts WHERE id GLOB '3*'`,
  );
  await sql(
    t.store,
    `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, authorization_id, updated_at)
		SELECT s.id, ?2, ?1, ?3, 'accepted', hex(randomblob(16)), '2026-10-12T00:00:00.000Z'
		FROM statuses s WHERE s.id GLOB '31*'`,
    id,
    status.uri,
    ALICE,
  );
  await sql(
    t.store,
    `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, authorization_id,
			updated_at)
		VALUES (?, ?, ?, ?, 'accepted', 1, hex(randomblob(16)), '2026-10-12T00:00:00.000Z')`,
    id,
    daves.uri,
    daves.id,
    DAVE,
  );
  // Ten conversations of dave's holding it; its trend row, review and card.
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9)
		INSERT INTO conversations (account_id, thread, participants, last_status_id, unread)
		SELECT ?1, 't' || i, json_array(?2), ?3, 1 FROM n`,
    DAVE,
    ALICE,
    id,
  );
  await sql(
    t.store,
    "INSERT INTO conversation_statuses (conversation_id, status_id) SELECT id, ? FROM conversations",
    id,
  );
  await sql(t.store, "INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, 1)", id, ALICE);
  await sql(
    t.store,
    "INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at) VALUES (?, 1, '2026-10-12T00:00:00.000Z')",
    id,
  );
  await sql(
    t.store,
    `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
		VALUES (?, 'https://link.example/', 0, 1, 'a link', 0)`,
    id,
  );
  // DELETE_SUPERSEDES - 1 retractions of it still staging (an import's), recorded before the Updates: the request
  // supersedes them.
  await seedStagingRetractions(t.store, DELETE_SUPERSEDES - 1, ALICE, status.uri, "Delete");
  // DELETE_SUPERSEDES + 1 earlier Updates about it, each with a row in another state (and exposed).
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO outbound_activities (account_id, body, object_uri, created_at)
		SELECT ?2, json_object('activity', json_object('type', 'Update', 'id', 'u' || i), 'audience',
			json_object('followers', json('true'), 'accounts', json('[]'))), ?3, 0 FROM n`,
    DELETE_SUPERSEDES,
    ALICE,
    status.uri,
  );
  await sql(
    t.store,
    `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, lease_token,
			exposed)
		SELECT id, account_id, 'https://e' || id || '.example/inbox', 'https://e' || id || '.example',
			CASE id % 3 WHEN 0 THEN 'leased' WHEN 1 THEN 'gave_up' ELSE 'pending' END, 0, 0,
			CASE id % 3 WHEN 0 THEN 'held' END, id % 3 = 0
		FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Update'`,
    status.uri,
  );
  // Receipts past what one staging call writes (a chunk per row), so its staging spans calls.
  await seedReceipts(t.store, id, ALICE, PURGE_BATCH * TARGET_CHUNK_SIZE + 1);
  // Every streaming subscription.
  await sql(
    t.store,
    `INSERT INTO stream_subscriptions (account_id, stream_key, sockets)
		VALUES (?1, 'user', 1), (?1, 'user:notification', 1), (?1, 'direct', 1), (?1, 'public', 1), (?1, 'hashtag:t000', 1),
			(?2, 'user', 1), (?2, 'public:local', 1)`,
    DAVE,
    ALICE,
  );
  return { status, id, other, daves, parent, bob, followers, mentioned, boosters, quoters };
}

describe("a local status deleted at every bound at once (RES-6)", () => {
  it("writes the request within its derived rows, each batch within PURGE_BATCH, and reaches every receiver", async () => {
    const t = await setup();
    const w = await worst(t);
    // The inboxes earlier activities about it went or may go to, in every state, its Create's among them.
    const earlier = await sql<{ inbox: string }>(
      t.store,
      `SELECT DISTINCT d.inbox_url AS inbox FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id
			WHERE o.object_uri = ? AND o.retracts = 0`,
      w.status.uri,
    );
    expect(await count(t.store, "SELECT 1 FROM outbound_targets")).toBe(0);
    const { answer, wrote, ms } = await deleted(t, w.id);
    expect(answer).toBe("ok");
    expect(wrote).toBeLessThanOrEqual(REQUEST_ROWS);
    console.info({ event: "local-delete.request", wrote, bound: REQUEST_ROWS, ms: Math.round(ms) });
    // The hide and what it alone showed: at once.
    expect(await sql(t.store, "SELECT withdrawn, visibility, content FROM statuses WHERE id = ?", w.id)).toEqual([
      { withdrawn: 1, visibility: "direct", content: "" },
    ]);
    expect(await count(t.store, "SELECT 1 FROM status_tags WHERE status_id = ? AND public = 1", w.id)).toBe(50);
    expect(await count(t.store, "SELECT 1 FROM trend_statuses UNION ALL SELECT 1 FROM status_trend_reviews")).toBe(0);
    expect(await count(t.store, "SELECT 1 FROM status_cards")).toBe(0);
    expect(await sql(t.store, "SELECT account_id FROM status_pins")).toEqual([{ account_id: DAVE }]);
    expect(await sql(t.store, "SELECT quotes_count FROM statuses WHERE id = ?", w.daves.id)).toEqual([
      { quotes_count: 0 },
    ]);
    expect(await count(t.store, "SELECT 1 FROM media_attachments WHERE status_id IS NULL")).toBe(MAX_STATUS_MEDIA);
    // Its DELETE superseded its Create and the retractions still staging (each staging ended, its intent dropped),
    // DELETE_SUPERSEDES in all; the DELETE_SUPERSEDES + 1 Updates are left to its job.
    expect(
      await count(
        t.store,
        "SELECT 1 FROM outbound_activities WHERE object_uri = ? AND superseded = 0 AND retracts = 0",
        w.status.uri,
      ),
    ).toBe(DELETE_SUPERSEDES + 1);
    expect(
      await sql(
        t.store,
        "SELECT count(*) AS n, total(ended) AS ended FROM retraction_stagings WHERE phase = 'followers'",
      ),
    ).toEqual([{ n: DELETE_SUPERSEDES - 1, ended: DELETE_SUPERSEDES - 1 }]);
    expect(
      await count(
        t.store,
        "SELECT 1 FROM outbound_activities WHERE id IN (SELECT activity_id FROM retraction_stagings)",
      ),
    ).toBe(0);
    // Those rows of the request: the Create's update (it keeps rows), and each retraction's update, staging end and
    // drop.
    expect(1 + 3 * (DELETE_SUPERSEDES - 1)).toBeLessThanOrEqual(SUPERSEDE_ROWS);
    const [job] = await sql<{ bound: string }>(
      t.store,
      "SELECT bound FROM inbound_jobs WHERE kind = 'delete' AND key = ?",
      w.id,
    );
    expect(job!.bound).toBe(new Date(NOW + DETACHED_GRACE_MS).toISOString());

    // The job: each batch within PURGE_BATCH, its Delete staged over more than one call.
    let staging = 0;
    const taken = await batches(t.store, w.id, async () => {
      const [intent] = await sql<{ staged: string | null }>(
        t.store,
        "SELECT staged FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Delete'",
        w.status.uri,
      );
      if (intent !== undefined && intent.staged !== null && intent.staged !== "") {
        staging++;
      }
    });
    expect(staging).toBeGreaterThan(0);
    console.info({ event: "local-delete.batches", batches: taken });
    expect(await count(t.store, "SELECT 1 FROM statuses WHERE id = ? OR reblog_of_id = ?", w.id, w.id)).toBe(0);
    expect(await count(t.store, "SELECT 1 FROM inbound_jobs WHERE kind = 'delete' AND done_at IS NULL")).toBe(0);

    // Its Delete reaches every receiver, as durable identities: the followers, the receipts, the earlier activities'
    // rows in every state, the mentions (the named at their shared inbox, the rest with a copy of their own), the
    // remote boosters, the quoters and the parent's author (each named nowhere, so each with a copy of its own) and the
    // voter (at its shared inbox, as a follower).
    const targets = await retractionInboxes(t.store, w.status.uri, "Delete");
    const expected = new Set([
      ...Array.from({ length: 5 }, (_, i) => `https://f${i + 1}.example/inbox`),
      ...Array.from({ length: PURGE_BATCH * TARGET_CHUNK_SIZE + 1 }, (_, i) => `https://r${i + 1}.example/inbox`),
      ...earlier.map((row) => row.inbox),
      ...Array.from({ length: 260 }, (_, i) =>
        i < MAX_DELETE_NAMED ? `https://m${i + 1}.example/inbox` : `https://m${i + 1}.example/users/u/inbox`,
      ),
      ...Array.from({ length: 40 }, (_, i) => `https://b${i + 1}.example/users/u/inbox`),
      ...Array.from({ length: 400 }, (_, i) => `https://q${i + 1}.example/users/u/inbox`),
      `${MASTODON}/users/bob/inbox`,
      "https://v1.example/inbox",
    ]);
    expect([...expected].filter((inbox) => !targets.has(inbox))).toEqual([]);
    expect([...targets].filter((inbox) => !expected.has(inbox))).toEqual([]);
    // One Undo of dave's boost; the media its DELETE did not show, given the job's bound; the featured hashtags counted
    // again; every earlier activity superseded; Kopje's 400 authorizations of quotes of it retired with its own.
    expect(
      await count(
        t.store,
        "SELECT 1 FROM outbound_activities WHERE account_id = ? AND json_extract(body, '$.activity.type') = 'Undo'",
        DAVE,
      ),
    ).toBe(1);
    expect(await sql(t.store, "SELECT DISTINCT gc_at, status_id FROM media_attachments")).toEqual([
      { gc_at: new Date(NOW + DETACHED_GRACE_MS).toISOString(), status_id: null },
    ]);
    const published = (await statusRow(t.store, w.other.uri))!;
    expect(
      await sql(
        t.store,
        "SELECT name, statuses_count, last_status_at FROM featured_tags WHERE account_id = ? ORDER BY name",
        ALICE,
      ),
    ).toEqual(
      ["t000", "t001", "t002", "t003", "t004", "t005", "t144", "t145", "t146", "t147", "t148", "t149"].map((name) =>
        name === "t000" || name === "t149"
          ? { name, statuses_count: 1, last_status_at: published.published_at }
          : { name, statuses_count: 0, last_status_at: null },
      ),
    );
    expect(
      await count(
        t.store,
        "SELECT 1 FROM outbound_activities WHERE object_uri = ? AND superseded = 0 AND retracts = 0",
        w.status.uri,
      ),
    ).toBe(0);
    expect(await count(t.store, "SELECT 1 FROM quote_revocations")).toBe(401);
    expect(
      await count(
        t.store,
        "SELECT 1 FROM quotes WHERE quoted_status_id IS NOT NULL AND quoted_status_id <> ?",
        w.daves.id,
      ),
    ).toBe(0);
  }, 300_000);
});

// An API request as `as`, with a JSON body.
async function api(t: Setup, method: string, path: string, body?: unknown, as: "alice" | "dave" = "alice") {
  const init = body === undefined ? { method } : json(body, { method });
  const response = await t.request(path, bearer(t.tokens[as], init));
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    link: response.headers.get("link"),
  };
}

describe("who the Delete reaches (VIS-3)", () => {
  // A delivered Update leaves no receipt and the row goes, and a removed poll's voters are not read: only the
  // receipt its delivery records once the status is withdrawn keeps that inbox a target of the Delete, staged later.
  it("reaches an inbox an Update alone was delivered to before the Delete was staged, and one a Create was", async () => {
    const t = await setup();
    await remoteAccountsAt(t.store, "1", "v", 1);
    const [follower] = await remoteAccountsAt(t.store, "5", "f", 1);
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      follower!,
      ALICE,
    );
    const status = await localStatus(t, { status: "vote", poll: { options: ["a", "b"], expires_in: 600 } });
    await sql(
      t.store,
      "INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, '100000000000000001', 0)",
      status.id,
    );
    // The poll's Update goes to its voter alone; the Create to the follower, who then leaves.
    await sql(
      t.store,
      "UPDATE polls SET update_due_at = ? WHERE status_id = ?",
      new Date(NOW).toISOString(),
      status.id,
    );
    await runInDurableObject(t.store, (_instance, state) => pollRound.run(state.storage.sql, { now: NOW }));
    const claim = await runInDurableObject(t.store, (_instance, state) =>
      claimDeliveries.run(state.storage.sql, { now: NOW, leaseToken: "held" }),
    );
    expect(claim.deliveries.map((d) => d.inbox).sort()).toEqual([
      "https://f1.example/inbox",
      "https://v1.example/inbox",
    ]);
    await sql(t.store, "DELETE FROM follows WHERE account_id = ?", follower!);
    // The poll goes before the delete (an edit's removal), so its voters are none.
    await sql(t.store, "UPDATE polls SET removed = 1, generation = generation + 1 WHERE status_id = ?", status.id);
    expect((await deleted(t, status.id)).answer).toBe("ok");
    for (const delivery of claim.deliveries) {
      const done = await runInDurableObject(t.store, (_instance, state) =>
        completeDelivery.run(state.storage.sql, {
          id: delivery.id,
          leaseToken: "held",
          now: NOW,
          outcome: { kind: "delivered", status: 202 },
        }),
      );
      expect(done.status).toBe("delivered");
    }
    // The voter's row is gone, and with it every other evidence of what it holds.
    expect(await count(t.store, "SELECT 1 FROM deliveries WHERE inbox_url = 'https://v1.example/inbox'")).toBe(0);
    await settle(t.store);
    expect(await retractionInboxes(t.store, status.uri, "Delete")).toEqual(
      new Set(["https://f1.example/inbox", "https://v1.example/inbox"]),
    );
  });

  // A private status's followers are in its audience, but only a public or unlisted one reaches beyond them.
  it("reaches a parent's remote author only from a public or unlisted reply", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const parent = mastodonNote(bob);
    expect(await t.post(bob, create(bob, parent))).toBe(202);
    const parentId = (await statusRow(t.store, parent.id))!.id;
    const inboxes: Record<string, string[]> = {};
    for (const visibility of ["private", "public"]) {
      const reply = await localStatus(t, { status: "no mention", in_reply_to_id: parentId, visibility });
      expect(await count(t.store, "SELECT 1 FROM status_mentions WHERE status_id = ?", reply.id)).toBe(0);
      await sql(t.store, "DELETE FROM deliveries");
      expect((await deleted(t, reply.id)).answer).toBe("ok");
      await settle(t.store);
      inboxes[visibility] = [...(await retractionInboxes(t.store, reply.uri, "Delete"))];
    }
    expect(inboxes).toEqual({ private: [], public: [`${MASTODON}/users/bob/inbox`] });
  });
});

describe("writes refused once the status is withdrawn (ID-7, VIS-28)", () => {
  // A pending quote of alice's ends with her status's hide, and its quoted author's late Accept applies nothing.
  it("ignores a late Accept of a deleted status's pending quote, and records no Update after its Delete", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const note = mastodonNote(bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    t.web.serve(note.id, { "@context": AS, ...note });
    const theirs = (await statusRow(t.store, note.id))!.id;
    const gone = await localStatus(t, { status: "quote", quoted_status_id: theirs });
    const live = await localStatus(t, { status: "quote too", quoted_status_id: theirs });
    const states = () =>
      sql<{ id: string; state: string }>(
        t.store,
        "SELECT status_id AS id, state FROM quotes WHERE status_id IN (?, ?) ORDER BY status_id",
        gone.id,
        live.id,
      );
    expect((await states()).map((q) => q.state)).toEqual(["pending", "pending"]);
    expect((await deleted(t, gone.id)).answer).toBe("ok");
    const updates = () =>
      count(t.store, "SELECT 1 FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Update'");
    const before = await updates();
    // The Accept reaches the inbox while the status is still stored (withdrawn): it changes nothing.
    expect(await sql(t.store, "SELECT withdrawn FROM statuses WHERE id = ?", gone.id)).toEqual([{ withdrawn: 1 }]);
    const stamp = `${bob.uri}/quote_authorizations/gone`;
    expect(await t.post(bob, quoteAccept(bob, gone.uri, stamp))).toBe(202);
    expect(await updates()).toBe(before);
    // The same Accept of the live quote applies, and records its Update.
    expect(await t.post(bob, quoteAccept(bob, live.uri, `${bob.uri}/quote_authorizations/live`))).toBe(202);
    expect(await updates()).toBe(before + 1);
    expect(await states()).toEqual([
      { id: gone.id, state: "revoked" },
      { id: live.id, state: "accepted" },
    ]);
  });

  it("refuses interactions, replies, quotes, votes, edits and pins of it, and a second DELETE writes nothing", async () => {
    const t = await setup();
    const poll = { options: ["a", "b"], expires_in: 600 };
    const gone = await localStatus(t, { status: "gone", poll });
    const live = await localStatus(t, { status: "live", poll });
    const pollOf = async (id: string) =>
      (await sql<{ id: string }>(t.store, "SELECT status_id AS id FROM polls WHERE status_id = ?", id))[0]!.id;
    expect((await deleted(t, gone.id)).answer).toBe("ok");
    // The row is there, withdrawn: each refusal below is the rule's, not a missing status's.
    expect(await sql(t.store, "SELECT withdrawn FROM statuses WHERE id = ?", gone.id)).toEqual([{ withdrawn: 1 }]);
    const answers = async (id: string) => ({
      show: (await api(t, "GET", `/api/v1/statuses/${id}`, undefined, "dave")).status,
      favourite: (await api(t, "POST", `/api/v1/statuses/${id}/favourite`, undefined, "dave")).status,
      bookmark: (await api(t, "POST", `/api/v1/statuses/${id}/bookmark`, undefined, "dave")).status,
      reblog: (await api(t, "POST", `/api/v1/statuses/${id}/reblog`, undefined, "dave")).status,
      reply: (await api(t, "POST", "/api/v1/statuses", { status: "r", in_reply_to_id: id }, "dave")).status,
      quote: (await api(t, "POST", "/api/v1/statuses", { status: "q", quoted_status_id: id }, "dave")).status,
      vote: (await api(t, "POST", `/api/v1/polls/${await pollOf(id)}/votes`, { choices: ["0"] }, "dave")).status,
      edit: (await api(t, "PUT", `/api/v1/statuses/${id}`, { status: "edited" })).status,
      policy: (await api(t, "PUT", `/api/v1/statuses/${id}/interaction_policy`, { quote_approval_policy: "nobody" }))
        .status,
      pin: (await api(t, "POST", `/api/v1/statuses/${id}/pin`)).status,
      source: (await api(t, "GET", `/api/v1/statuses/${id}/source`)).status,
    });
    const writes = async () =>
      sql(
        t.store,
        `SELECT (SELECT count(*) FROM favourites) AS favourites, (SELECT count(*) FROM bookmarks) AS bookmarks,
					(SELECT count(*) FROM poll_votes) AS votes, (SELECT count(*) FROM status_pins) AS pins,
					(SELECT count(*) FROM status_edits WHERE status_id = ?1) AS edits,
					(SELECT count(*) FROM statuses WHERE reblog_of_id = ?1 OR in_reply_to_id = ?1) AS children,
					(SELECT count(*) FROM quotes WHERE quoted_status_id = ?1) AS quotes`,
        gone.id,
      );
    const before = await writes();
    expect(await answers(gone.id)).toEqual({
      show: 404,
      favourite: 404,
      bookmark: 404,
      reblog: 404,
      reply: 404,
      quote: 404,
      vote: 404,
      edit: 404,
      policy: 404,
      pin: 404,
      source: 404,
    });
    expect(await writes()).toEqual(before);
    const second = await deleted(t, gone.id);
    expect([second.answer, second.wrote]).toEqual(["not_found", 0]);
    // The same requests about the live status pass.
    expect(Object.values(await answers(live.id)).every((status) => status === 200)).toBe(true);
  });

  it("links no remote reply or quote to it, and its poll rounds notify and record nothing", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const gone = await localStatus(t, { status: "gone" });
    expect((await deleted(t, gone.id)).answer).toBe("ok");
    const reply = mastodonNote(bob, { inReplyTo: gone.uri });
    expect(await t.post(bob, create(bob, reply))).toBe(202);
    expect((await statusRow(t.store, reply.id))!).toMatchObject({ in_reply_to_id: null, in_reply_to_uri: gone.uri });
    const quote = quoting(bob, gone.uri, null);
    expect(await t.post(bob, create(bob, quote))).toBe(202);
    expect(
      await sql(
        t.store,
        "SELECT q.quoted_status_id FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
        quote.id,
      ),
    ).toEqual([{ quoted_status_id: null }]);
    expect(await sql(t.store, "SELECT replies_count, quotes_count FROM statuses WHERE id = ?", gone.id)).toEqual([
      { replies_count: 0, quotes_count: 0 },
    ]);
    // A remote poll whose status's removal has begun, which dave voted in, ends with no notification.
    const polls: Record<string, string> = {};
    for (const name of ["withdrawn", "live"]) {
      const note = mastodonNote(bob);
      expect(await t.post(bob, create(bob, note))).toBe(202);
      const id = (await statusRow(t.store, note.id))!.id;
      polls[name] = id;
      await sql(
        t.store,
        `INSERT INTO polls (status_id, options, tallies, expires_at) VALUES (?, '["a","b"]', '[1,0]', ?)`,
        id,
        new Date(NOW - 1000).toISOString(),
      );
      await sql(t.store, "INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 0)", id, DAVE);
    }
    await sql(t.store, "UPDATE statuses SET withdrawn = 1 WHERE id = ?", polls.withdrawn!);
    await sql(t.store, "DELETE FROM notifications");
    await runInDurableObject(t.store, (_instance, state) => pollRound.run(state.storage.sql, { now: NOW }));
    expect(await sql(t.store, "SELECT status_id FROM polls WHERE ended = 1 ORDER BY status_id")).toEqual(
      [polls.withdrawn!, polls.live!].sort().map((status_id) => ({ status_id })),
    );
    expect(await sql(t.store, "SELECT status_id FROM notifications WHERE type = 'poll'")).toEqual([
      { status_id: polls.live! },
    ]);
  });
});

describe("reads while the removal runs (VIS-1, RES-7)", () => {
  it("names it in no followed-hashtag home page or Link while its hashtags are still on the index", async () => {
    const t = await setup();
    const status = await localStatus(t, { status: "tagged" });
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 149)
			INSERT INTO status_tags (status_id, name, public) SELECT ?, printf('t%03d', i), 1 FROM n`,
      status.id,
    );
    await sql(t.store, "INSERT INTO tag_follows (account_id, name) VALUES (?, 't149')", DAVE);
    const home = () => api(t, "GET", "/api/v1/timelines/home", undefined, "dave");
    expect(((await home()).body as unknown as { id: string }[]).map((s) => s.id)).toEqual([status.id]);
    expect((await deleted(t, status.id)).answer).toBe("ok");
    // t149 is past the MAX_STATUS_TAGS the DELETE took off the index.
    expect(
      await sql(t.store, "SELECT public FROM status_tags WHERE status_id = ? AND name = 't149'", status.id),
    ).toEqual([{ public: 1 }]);
    const after = await home();
    expect([after.body, after.link ?? ""]).toEqual([[], ""]);
    const tag = await api(t, "GET", "/api/v1/timelines/tag/t149", undefined, "dave");
    expect([tag.body, (tag.link ?? "").includes(status.id)]).toEqual([[], false]);
  });

  it("shows a quote of it as deleted, to its author too", async () => {
    const t = await setup();
    const quoted = await localStatus(t, { status: "quoted" });
    const quote = await localStatus(t, { status: "quote", quoted_status_id: quoted.id }, "dave");
    expect((await api(t, "GET", `/api/v1/statuses/${quote.id}`)).body.quote).toMatchObject({ state: "accepted" });
    expect((await deleted(t, quoted.id)).answer).toBe("ok");
    for (const as of ["alice", "dave"] as const) {
      expect((await api(t, "GET", `/api/v1/statuses/${quote.id}`, undefined, as)).body.quote).toEqual({
        state: "deleted",
        quoted_status: null,
      });
    }
  });

  it("reads a bounded home window of its author past 1,000 withdrawn statuses of theirs, the page short", async () => {
    const t = await setup();
    const visible = [];
    for (let i = 0; i < 3; i++) {
      visible.push((await localStatus(t, { status: `kept ${i}` })).id);
    }
    const credential = { tokenHash: await sha256Hex(t.tokens.alice), scope: "read", now: NOW } as const;
    const read = () => rowsRead(t, homeTimeline, { credential, page: { limit: 20 }, present: PRESENT });
    const few = await read();
    // 1,000 of alice's statuses deleted after those, their jobs not run yet: newer than the kept ones.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, withdrawn)
			SELECT printf('9%017d', i), 'https://kopje.test/ap/o/w' || i, ?, 'direct', '', '2026-10-12T00:00:00.000Z', 1 FROM n`,
      ALICE,
    );
    const many = await read();
    const page = await api(t, "GET", "/api/v1/timelines/home?limit=20");
    console.info({ event: "local-delete.own-home", few, many, shown: (page.body as unknown as unknown[]).length });
    // The window reads its own candidates and stops: the page is empty and links on past them.
    expect(page.body).toEqual([]);
    expect(page.link).toContain("max_id=");
    expect(many).toBeLessThan(few + 400);
  });
});

describe("the job’s rounds (RES-5, RES-6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls a failing batch back whole, and resumes from what the last one committed", async () => {
    const t = await setup();
    const status = await localStatus(t, { status: "many edits" });
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1199)
			INSERT INTO status_edits (status_id, content, created_at) SELECT ?, 'v' || i, '2026-10-12T00:00:00.000Z' FROM n`,
      status.id,
    );
    expect((await deleted(t, status.id)).answer).toBe("ok");
    await batch(t.store, status.id);
    const left = await count(t.store, "SELECT 1 FROM status_edits");
    expect(left).toBeLessThan(1200);
    // The next batch fails midway (its edits run from where the last one stopped): nothing of it stays.
    await sql(
      t.store,
      `CREATE TRIGGER fail_midway BEFORE DELETE ON status_edits WHEN OLD.content = 'v800'
			BEGIN SELECT RAISE(ABORT, 'midway'); END`,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() =>
        runInboundJobs.run(state.storage.sql, { now: NOW }, (fn) => state.storage.transactionSync(fn)),
      ),
    );
    // The round commits, and nothing of the failed batch stays: its attempt is recorded, the job backs off.
    expect(failed).toMatchObject({ pending: false });
    expect(await count(t.store, "SELECT 1 FROM status_edits")).toBe(left);
    expect(
      await sql(t.store, "SELECT attempts, due_at FROM inbound_jobs WHERE kind = 'delete' AND key = ?", status.id),
    ).toEqual([{ attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]! }]);
    await sql(t.store, "DROP TRIGGER fail_midway");
    // At its due time the rounds resume from what the last batch committed.
    for (let round = 0; round < 20; round++) {
      const at = NOW + JOB_RETRY_DELAYS_MS[0]!;
      if (!(await t.store.runInboundJobs(BUILD, { now: at })).pending) {
        break;
      }
    }
    expect(await count(t.store, "SELECT 1 FROM statuses WHERE id = ?", status.id)).toBe(0);
  });

  it("supersedes the earlier activities, reading none of the superseded history, under stale statistics", async () => {
    const read: number[] = [];
    for (const history of [100, 10_000]) {
      const t = await setup();
      const status = await localStatus(t, { status: "edited often" });
      await sql(t.store, "ANALYZE");
      await sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2)
				INSERT INTO outbound_activities (account_id, body, object_uri, superseded, created_at)
				SELECT ?3, '{"activity":{"type":"Update"},"audience":{"followers":true,"accounts":[]}}', ?4,
					CASE WHEN i < ?1 THEN 1 ELSE 0 END, 0 FROM n`,
        history,
        DELETE_SUPERSEDES,
        ALICE,
        status.uri,
      );
      read.push(
        await rowsRead(t, deleteStatus, {
          credential: await credential(t),
          id: status.id,
          deleteMedia: false,
          now: NOW,
          present: PRESENT,
        }),
      );
      // One left past DELETE_SUPERSEDES, which its job supersedes.
      expect(await count(t.store, "SELECT 1 FROM outbound_activities WHERE superseded = 0 AND retracts = 0")).toBe(1);
      await settle(t.store);
      expect(await count(t.store, "SELECT 1 FROM outbound_activities WHERE superseded = 0 AND retracts = 0")).toBe(0);
    }
    console.info({ event: "local-delete.superseded-history", read });
    expect(read[1]).toBeLessThanOrEqual(read[0]! + 10);
  });

  it("delivers to each server the Create, pending, leased or unexpanded, before the Delete", async () => {
    const t = await setup();
    const servers = await remoteAccountsAt(t.store, "5", "f", 2 * TARGET_CHUNK_SIZE + 5);
    await sql(
      t.store,
      "INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*'",
      ALICE,
    );
    const status = await localStatus(t, { status: "to many" });
    // One step expanded at posting, one more by a claim whose completion is lost (its row stays leased until its lease
    // ends), and targets of the Create still unexpanded when the Delete is recorded and staged.
    const lost = await runInDurableObject(t.store, (_instance, state) =>
      claimDeliveries.run(state.storage.sql, { now: NOW, leaseToken: "lost", limit: 1 }),
    );
    expect(lost.deliveries).toHaveLength(1);
    expect((await deleted(t, status.id)).answer).toBe("ok");
    await settle(t.store);
    expect(
      await count(
        t.store,
        `SELECT 1 FROM outbound_targets c JOIN outbound_activities o ON o.id = c.activity_id
				WHERE json_extract(o.body, '$.activity.type') = 'Create'`,
      ),
    ).toBeGreaterThan(0);
    // The delivery rounds' order, as sent: each claim, its rows confirmed, each delivered; the lost lease ends first.
    const sent = new Map<string, string[]>();
    for (let round = 0, now = NOW + 120_000; round < 200; round++) {
      const claim = await t.store.claimDeliveries(BUILD, { now, leaseToken: `round-${round}` });
      if (claim.deliveries.length === 0 && (await count(t.store, "SELECT 1 FROM deliveries")) === 0) {
        break;
      }
      for (const delivery of claim.deliveries) {
        const confirmed = await t.store.confirmDelivery(BUILD, { id: delivery.id, leaseToken: `round-${round}`, now });
        expect(confirmed.status).toBe("send");
        const type = (JSON.parse((confirmed as { body: string }).body) as { type: string }).type;
        const lane = new URL(delivery.inbox).origin;
        sent.set(lane, [...(sent.get(lane) ?? []), type]);
        await t.store.completeDelivery(BUILD, {
          id: delivery.id,
          leaseToken: `round-${round}`,
          now,
          outcome: { kind: "delivered", status: 202 },
        });
      }
    }
    expect(sent.size).toBe(servers.length);
    expect(new Set([...sent.values()].map((types) => types.join(" ")))).toEqual(new Set(["Create Delete"]));
  });
});

describe("reads bounded by the inputs at their worst (RES-6, RES-7)", () => {
  // The DELETE takes its first MAX_STATUS_TAGS hashtags by name off the index whatever their flag: an imported status
  // with thousands of non-public hashtags before its public ones, or none public at all, costs it that window only.
  it("reads a window of MAX_STATUS_TAGS hashtags in the request, past a long non-public prefix", async () => {
    const reads: Record<string, number> = {};
    for (const [name, hidden, shown] of [
      ["200 non-public", 200, 0],
      ["5,000 non-public", 5000, 0],
      ["5,000 non-public, then public", 5000, 10],
    ] as const) {
      const t = await setup();
      const status = await localStatus(t, { status: name });
      await sql(
        t.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 + ?3)
				INSERT INTO status_tags (status_id, name, public) SELECT ?1, printf('t%05d', i), i > ?2 FROM n`,
        status.id,
        hidden,
        shown,
      );
      reads[name] = await rowsRead(t, deleteStatus, {
        credential: await credential(t),
        id: status.id,
        deleteMedia: false,
        now: NOW,
        present: PRESENT,
      });
      await settle(t.store);
      expect(await count(t.store, "SELECT 1 FROM status_tags")).toBe(0);
    }
    console.info({ event: "local-delete.tag-window", ...reads });
    // Past the windows (its MAX_STATUS_TAGS, the answer's MAX_PRESENTED_TAGS), a longer prefix costs nothing.
    expect(reads["5,000 non-public"]).toBeLessThanOrEqual(reads["200 non-public"]! + 10);
    expect(reads["5,000 non-public, then public"]).toBeLessThanOrEqual(reads["200 non-public"]! + 10);
  }, 120_000);

  // The request and every batch of the job read what the status holds, not what the Store holds: grown after ANALYZE
  // by 20,000 statuses of another account (so neither the featured hashtag's recount nor the local booster's
  // statuses_count, which read their account's statuses as posting does, is grown: accepted costs, docs/threat-model.md
  // RES-6) with their own hashtags, mentions, alice's receipts and earlier activities about them, a DELETE
  // and its job read at most 20 rows more each (a coarse regression threshold: a walk of the grown rows costs
  // thousands). The status populates each branch measured: a mention, receipts, a hashtag its author features, a local
  // and a remote boost, shown and dropped media, its own accepted quote and an accepted quote of it, its author's pin
  // and another's, a card, a trend row and its review; the measured batches finish its removal.
  it("reads no more in the request and its job after the Store grew past its statistics", async () => {
    const read = async (t: Setup, digit: string) => {
      const [bob, booster, quoter] = await remoteAccountsAt(t.store, digit, `m${digit}x`, 3);
      const daves = await localStatus(t, { status: "quoted" }, "dave");
      const status = await localStatus(t, { status: "measured #a #b", quoted_status_id: daves.id });
      const id = status.id;
      await sql(t.store, "INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 0)", id, bob!);
      await seedReceipts(t.store, id, ALICE, 3);
      await sql(
        t.store,
        "INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count) VALUES (?, ?, 'a', 'a', 1) ON CONFLICT DO NOTHING",
        `8${digit}0000000000000000`,
        ALICE,
      );
      expect((await api(t, "POST", `/api/v1/statuses/${id}/reblog`, undefined, "dave")).status).toBe(200);
      await sql(
        t.store,
        `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
				VALUES (?1 || '1', 'https://b.example/' || ?1, ?2, ?3, 'public', '2026-10-12T00:00:00.000Z')`,
        `4${digit}000000000000000`,
        booster!,
        id,
      );
      await sql(
        t.store,
        `INSERT INTO media_attachments (id, account_id, status_id, position, type, url, file_token, shown)
				VALUES (?1 || '1', ?2, ?3, 0, 'image', 'https://kopje.test/f', 'f1' || ?1, 1),
					(?1 || '2', ?2, ?3, 1, 'image', 'https://kopje.test/f', 'f2' || ?1, 0)`,
        `9${digit}000000000000000`,
        ALICE,
        id,
      );
      await sql(
        t.store,
        `INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				VALUES (?1, 'https://q.example/' || ?1, ?2, 'public', '2026-10-12T00:00:00.000Z')`,
        `3${digit}0000000000000001`,
        quoter!,
      );
      await sql(
        t.store,
        `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, authorization_id, updated_at)
				VALUES (?1, ?2, ?3, ?4, 'accepted', hex(randomblob(16)), '2026-10-12T00:00:00.000Z')`,
        `3${digit}0000000000000001`,
        status.uri,
        id,
        ALICE,
      );
      await sql(t.store, "INSERT INTO status_pins (account_id, status_id) VALUES (?1, ?3), (?2, ?3)", ALICE, DAVE, id);
      await sql(
        t.store,
        `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
				VALUES (?, 'https://link.example/', 0, 1, 'a link', 0)`,
        id,
      );
      await sql(t.store, "INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, 1)", id, ALICE);
      await sql(
        t.store,
        "INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at) VALUES (?, 1, '2026-10-12T00:00:00.000Z')",
        id,
      );
      expect(await sql(t.store, "SELECT state FROM quotes WHERE status_id = ?", id)).toEqual([{ state: "accepted" }]);
      const request = await rowsRead(t, deleteStatus, {
        credential: await credential(t),
        id,
        deleteMedia: false,
        now: NOW,
        present: PRESENT,
      });
      let job = 0;
      for (let n = 0; ; n++) {
        expect(n, "the measured batches finish the removal").toBeLessThan(20);
        let more = false;
        job += await runInDurableObject(t.store, (_instance, state) => {
          let rows = 0;
          const real = state.storage.sql;
          const counting = {
            exec: (query: string, ...params: SqlStorageValue[]) => {
              const cursor = real.exec(query, ...params);
              return watchedCursor(cursor, () => (rows += cursor.rowsRead));
            },
          } as unknown as SqlStorage;
          more = state.storage.transactionSync(() => deleteStatusBatch(new Db(counting), id, NOW));
          return rows;
        });
        if (!more) {
          break;
        }
      }
      expect(await count(t.store, "SELECT 1 FROM statuses WHERE id = ? OR reblog_of_id = ?", id, id)).toBe(0);
      return { request, job };
    };
    const t = await setup();
    await sql(t.store, "ANALYZE");
    const few = await read(t, "6");
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('7%017d', i), 'https://g.example/s/' || i, ?, 'public', '', '2026-10-12T00:00:00.000Z' FROM n`,
      (await remoteAccountsAt(t.store, "2", "g", 1))[0]!,
    );
    await sql(
      t.store,
      "INSERT INTO status_tags (status_id, name, public) SELECT id, 'a', 1 FROM statuses WHERE id GLOB '7*'",
    );
    await sql(
      t.store,
      "INSERT INTO status_mentions (status_id, account_id, silent) SELECT id, ?, 0 FROM statuses WHERE id GLOB '7*'",
      DAVE,
    );
    await sql(
      t.store,
      `INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT id, 'https://g.example/inbox', ?, 0 FROM statuses WHERE id GLOB '7*'`,
      ALICE,
    );
    await sql(
      t.store,
      `INSERT INTO outbound_activities (account_id, body, object_uri, superseded, created_at)
			SELECT ?, '{"activity":{"type":"Update"},"audience":{"followers":true,"accounts":[]}}', uri, 0, 0
			FROM statuses WHERE id GLOB '7*'`,
      ALICE,
    );
    const many = await read(t, "5");
    console.info({ event: "local-delete.stale-statistics", few, many });
    expect(many.request).toBeLessThanOrEqual(few.request + 20);
    expect(many.job).toBeLessThanOrEqual(few.job + 20);
  }, 300_000);
});

describe("the staging of the Delete before the cleanup (VIS-3)", () => {
  // The first batch removes 499 pins of the status by imported accounts, which leaves it one row: too few for a chunk
  // and the staging's update, so staging writes nothing, and the batch stops there; the cleanup after it would delete
  // the receipt of the inbox X, and X would never get the Delete.
  it("stages the Delete before the receipts go, whatever the first batch left", async () => {
    const t = await setup();
    const status = await localStatus(t, { status: "pinned by many" });
    const pinners = await remoteAccountsAt(t.store, "4", "p", PURGE_BATCH - 1);
    await sql(
      t.store,
      "INSERT INTO status_pins (account_id, status_id) SELECT id, ? FROM accounts WHERE id GLOB '4*'",
      status.id,
    );
    await sql(
      t.store,
      "INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, 'https://x.example/inbox', ?, 0)",
      status.id,
      ALICE,
    );
    expect((await deleted(t, status.id)).answer).toBe("ok");
    const first = await batch(t.store, status.id);
    expect(first).toEqual({ wrote: pinners.length, more: true });
    expect(await count(t.store, "SELECT 1 FROM outbound_receipts")).toBe(1);
    expect(await count(t.store, "SELECT 1 FROM outbound_targets")).toBe(0);
    await batches(t.store, status.id);
    expect(await retractionInboxes(t.store, status.uri, "Delete")).toEqual(new Set(["https://x.example/inbox"]));
  });
});

describe("a local Delete staged in part, dumped and restored (RES-5, OPS)", () => {
  // The job's marker (the withdrawn row), its row with the media bound, the intent's staging position, its chunks and
  // the receipts left round-trip a dump; the restored Store finishes the job with the targets of an uninterrupted run.
  it("finishes in the restored Store with the same targets", async () => {
    const run = async () => {
      const t = await setup();
      await setAccess(t.store);
      const status = await localStatus(t, { status: "dumped" });
      await seedReceipts(t.store, status.id, ALICE, PURGE_BATCH * TARGET_CHUNK_SIZE + 1);
      expect((await deleted(t, status.id)).answer).toBe("ok");
      return { t, status };
    };
    const whole = await run();
    await batches(whole.t.store, whole.status.id);
    const expected = await retractionInboxes(whole.t.store, whole.status.uri, "Delete");

    const { t, status } = await run();
    // Batches until the Delete is staged in part.
    for (let n = 0; ; n++) {
      expect(n).toBeLessThan(20);
      await batch(t.store, status.id);
      const [intent] = await sql<{ staged: string | null }>(
        t.store,
        "SELECT staged FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Delete'",
      );
      if (intent!.staged !== null && intent!.staged !== "") {
        break;
      }
    }
    const state = (store: StoreStub) =>
      sql(
        store,
        `SELECT (SELECT withdrawn FROM statuses WHERE id = ?1) AS withdrawn,
					(SELECT bound FROM inbound_jobs WHERE kind = 'delete' AND key = ?1) AS bound,
					(SELECT staged FROM outbound_activities WHERE retracts = 1) AS staged,
					(SELECT count(*) FROM outbound_targets) AS chunks,
					(SELECT count(*) FROM outbound_receipts) AS receipts`,
        status.id,
      );
    const { text } = await dumpViaRpc(t.store);
    const target = await migratedStore();
    await copyConfig(t.store, target);
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] });
    expect(await state(target)).toEqual(await state(t.store));
    await batches(target, status.id);
    expect(await count(target, "SELECT 1 FROM statuses WHERE id = ?", status.id)).toBe(0);
    expect(await retractionInboxes(target, status.uri, "Delete")).toEqual(expected);
  }, 300_000);
});
