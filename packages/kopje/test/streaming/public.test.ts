import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../../src/db/sql";
import { streamDelete } from "../../src/domain/streaming";
import { ACCOUNT_EMOJIS_BYTES, STATUS_EMOJIS_BYTES } from "../../src/platform/stored-bounds";
import { sha256Hex } from "../../src/security/tokens";
import { STREAM_LIMITS } from "../../src/stream-hub";
import { type ApiHarness, bearer, json, sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import { accountAtCap, statusAtCap } from "../emoji-fixtures";
import { BUILD } from "../helpers";
import {
  act,
  block,
  community,
  domainBlock,
  getJson,
  mute,
  post,
  remoteAccount,
  seedStatus,
  type Status,
} from "../status-helpers";
import { connect, drained, echo, type Inbox, settled, type StreamMessage, subscribed, takeAll } from "./stream-helpers";

// The `public*` and `hashtag*` streams: `update` and `status.update` when the public
// or the hashtag's timeline positioned at the status returns it (R33), less a status that mentions an account the
// viewer blocks or mutes (Mastodon's per-connection filter), and `delete` of the status, never a boost, on the feeds
// its tombstone matches (R32). Absence is proved with the drain barrier.

const HOUR = 3_600_000;
const PUBLIC = ["public", "public:local", "public:remote", "public:media", "public:local:media", "public:remote:media"];

// The messages left on a socket, as [the stream joined, event, the payload's status id (or the deleted id)].
function events(inbox: Inbox): [string, string | undefined, string][] {
  return inbox.rest().map((m) => [(m.stream ?? []).join(" "), m.event, idOf(m)]);
}

function idOf(m: StreamMessage): string {
  if (m.event === "delete") {
    return m.payload ?? "";
  }
  const payload: unknown = JSON.parse(m.payload ?? "null");
  return typeof payload === "string" ? payload : ((payload as { id?: string } | null)?.id ?? "");
}

// A socket subscribed to every `public*` stream and to the hashtags `tags` on `hashtag` and `hashtag:local`.
async function feeds(h: ApiHarness, token: string, tags: string[] = ["#Cats"]): Promise<Inbox> {
  const inbox = await subscribed(h, token, ...PUBLIC);
  for (const tag of tags) {
    inbox.send({ type: "subscribe", stream: "hashtag", tag });
    inbox.send({ type: "subscribe", stream: "hashtag:local", tag });
  }
  await settled(h, inbox);
  return inbox;
}

// A remote public status written straight to the Store (no turn), arrived `arrivedAgo` before NOW and published
// `publishedAgo` before it arrived, with #cats, and with a shown media attachment when `media`.
let nextRemote = 900000000000000000n;
async function remoteStatus(
  h: ApiHarness,
  author: string,
  options: { media?: boolean; publishedAgo?: number; visibility?: "public" | "unlisted" } = {},
): Promise<string> {
  const id = String(nextRemote++);
  const arrived = new Date(NOW).toISOString();
  await sql(
    h.store,
    `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
		VALUES (?, ?, ?, ?, '<p>#cats</p>', ?, ?)`,
    id,
    `https://remote.example/objects/${id}`,
    author,
    options.visibility ?? "public",
    new Date(NOW - (options.publishedAgo ?? 0)).toISOString(),
    arrived,
  );
  await sql(
    h.store,
    "INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', visibility = 'public' FROM statuses WHERE id = ?",
    id,
  );
  if (options.media === true) {
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?, ?, ?, 'image', 'https://remote.example/m.png')`,
      String(BigInt(id) + 50000000000000000n),
      author,
      id,
    );
  }
  return id;
}

async function remove(h: ApiHarness, token: string, id: string): Promise<void> {
  const response = await h.request(`/api/v1/statuses/${id}`, bearer(token, { method: "DELETE" }));
  expect(response.status).toBe(200);
}

describe("subscribing to public and hashtag streams", () => {
  it("needs a tag within bounds, echoes it as sent, and keys it normalized", async () => {
    const h = await community(["alice"]);
    const inbox = await connect(h, h.users.alice.token);
    inbox.send({ type: "subscribe", stream: "hashtag" });
    expect(await inbox.next()).toEqual({ error: "Missing tag name parameter", status: 400 });
    inbox.send({ type: "subscribe", stream: "hashtag:local", tag: 7 });
    expect(await inbox.next()).toEqual({ error: "Invalid parameter", status: 400 });
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "x".repeat(257) });
    expect(await inbox.next()).toEqual({ error: "Invalid parameter", status: 400 });
    // Two spellings of one hashtag are one subscription, echoed as first sent.
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "#Cats" });
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
    inbox.send({ type: "subscribe", stream: "hashtag:local", tag: "x".repeat(256) });
    inbox.send({ type: "subscribe", stream: "public:remote:media" });
    await settled(h, inbox);
    expect(
      await sql(
        h.store,
        "SELECT stream_key FROM stream_subscriptions WHERE account_id = ? ORDER BY stream_key",
        h.users.alice.id,
      ),
    ).toEqual([
      { stream_key: "hashtag:cats" },
      { stream_key: `hashtag:local:${"x".repeat(256)}` },
      { stream_key: "public:remote:media" },
    ]);
    await post(h, h.users.alice, { status: "hello #CATS", visibility: "public" });
    await drained(h, inbox);
    expect(inbox.rest().map((m) => m.stream)).toEqual([["hashtag", "#Cats"]]);
    await inbox.next();
    // Unsubscribing by another spelling ends it.
    inbox.send({ type: "unsubscribe", stream: "hashtag", tag: "CATS" });
    await settled(h, inbox);
    await post(h, h.users.alice, { status: "again #cats", visibility: "public" });
    await drained(h, inbox);
    expect(inbox.rest()).toEqual([]);
  });
});

describe("update on public and hashtag streams", () => {
  it("sends a public status on the feeds it belongs to, as REST presents it to the viewer", async () => {
    const h = await community(["alice", "bob"]);
    const erin = await remoteAccount(h.store, "erin");
    const inbox = await feeds(h, h.users.alice.token);
    const local = await post(h, h.users.bob, { status: "local #cats", visibility: "public" });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", local.id],
      ["public:local", "update", local.id],
      ["hashtag #Cats", "update", local.id],
      ["hashtag:local #Cats", "update", local.id],
    ]);
    const rest = await getJson<Status>(h, `/api/v1/statuses/${local.id}`, h.users.alice.token);
    expect(JSON.parse((await inbox.next()).payload!)).toEqual(rest.body);
    for (let i = 0; i < 3; i++) {
      await inbox.next();
    }

    const remote = await remoteStatus(h, erin, { media: true });
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", remote],
      ["public:remote", "update", remote],
      ["public:media", "update", remote],
      ["public:remote:media", "update", remote],
      ["hashtag #Cats", "update", remote],
    ]);
  });

  it("leaves out what the timelines leave out: unlisted, private, boosts, and on public replies to others", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const inbox = await feeds(h, h.users.alice.token);
    const parent = await post(h, h.users.carol, { status: "parent", visibility: "unlisted" });
    await post(h, h.users.bob, { status: "unlisted #cats", visibility: "unlisted" });
    await post(h, h.users.bob, { status: "private #cats", visibility: "private" });
    const boosted = await post(h, h.users.carol, { status: "boosted #cats", visibility: "public" });
    await drained(h, inbox);
    await takeAll(inbox);
    expect((await act(h, h.users.bob, `/api/v1/statuses/${boosted.id}/reblog`)).status).toBe(200);
    // A reply to someone else: not on public, but on its hashtags (Mastodon's TagFeed and hashtag streams keep
    // replies).
    const reply = await post(h, h.users.bob, {
      status: "reply #cats",
      visibility: "public",
      in_reply_to_id: parent.id,
    });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["hashtag #Cats", "update", reply.id],
      ["hashtag:local #Cats", "update", reply.id],
    ]);
    await takeAll(inbox);
    // A reply in the author's own thread is in the public timeline.
    const own = await post(h, h.users.bob, { status: "own", visibility: "public" });
    const thread = await post(h, h.users.bob, { status: "thread", visibility: "public", in_reply_to_id: own.id });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", own.id],
      ["public:local", "update", own.id],
      ["public", "update", thread.id],
      ["public:local", "update", thread.id],
    ]);
  });

  it("needs read:statuses", async () => {
    const h = await community(["alice", "bob"], "read:notifications write");
    const inbox = await connect(h, h.users.alice.token);
    inbox.send({ type: "subscribe", stream: "public" });
    expect(await inbox.next()).toEqual({ error: "Access token does not have the required scopes", status: 401 });
    inbox.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
    expect(await inbox.next()).toEqual({ error: "Access token does not have the required scopes", status: 401 });
    await settled(h, inbox);
    expect(await sql(h.store, "SELECT count(*) AS n FROM stream_subscriptions")).toEqual([{ n: 0 }]);
  });

  it("filters per viewer: blocks and mutes of the author and the mentioned, the author's block, domain blocks", async () => {
    const h = await community(["alice", "bob", "carol", "dave", "erin", "frank"]);
    const far = await remoteAccount(h.store, "far", "far.example");
    const inbox = await feeds(h, h.users.alice.token);
    await block(h.store, h.users.alice.id, h.users.bob.id);
    await mute(h.store, h.users.alice.id, h.users.carol.id);
    await block(h.store, h.users.dave.id, h.users.alice.id);
    await domainBlock(h.store, h.users.alice.id, "far.example");
    await block(h.store, h.users.alice.id, h.users.erin.id);
    await post(h, h.users.bob, { status: "blocked #cats", visibility: "public" });
    await post(h, h.users.carol, { status: "muted #cats", visibility: "public" });
    await post(h, h.users.dave, { status: "blocks alice #cats", visibility: "public" });
    await remoteStatus(h, far);
    // Mentions of an account alice blocks, and of one she mutes.
    await post(h, h.users.frank, { status: "hi @erin #cats", visibility: "public" });
    await post(h, h.users.frank, { status: "hi @carol #cats", visibility: "public" });
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);
    // The same in REST: neither the public timeline nor the hashtag's shows them but the mentions (a stream-only
    // filter, as Mastodon's).
    const control = await post(h, h.users.frank, { status: "shown #cats", visibility: "public" });
    await drained(h, inbox);
    expect(events(inbox).map(([stream]) => stream)).toEqual([
      "public",
      "public:local",
      "hashtag #Cats",
      "hashtag:local #Cats",
    ]);
    expect(events(inbox).every(([, , id]) => id === control.id)).toBe(true);
  });

  it("reports a matching keyword filter in `filtered`, as REST does", async () => {
    const h = await community(["alice", "bob"]);
    const created = await h.request(
      "/api/v2/filters",
      bearer(
        h.users.alice.token,
        json({
          title: "Spoilers",
          context: ["public"],
          filter_action: "hide",
          keywords_attributes: [{ keyword: "finale" }],
        }),
      ),
    );
    expect(created.status).toBe(200);
    const inbox = await subscribed(h, h.users.alice.token, "public");
    const status = await post(h, h.users.bob, { status: "the finale", visibility: "public" });
    await drained(h, inbox);
    const sent = JSON.parse((await inbox.next()).payload!) as Status & { filtered: { filter: { title: string } }[] };
    expect(sent.filtered.map((result) => result.filter.title)).toEqual(["Spoilers"]);
    const rest = await getJson<Status>(h, `/api/v1/statuses/${status.id}`, h.users.alice.token);
    expect(sent).toEqual(rest.body);
  });

  it("leaves out a status published more than 6 hours before it arrived (the real-time window)", async () => {
    const h = await community(["alice"]);
    const erin = await remoteAccount(h.store, "erin");
    const inbox = await feeds(h, h.users.alice.token);
    await remoteStatus(h, erin, { publishedAgo: 6 * HOUR + 1000 });
    const fresh = await remoteStatus(h, erin, { publishedAgo: 6 * HOUR - 1000 });
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "update", fresh],
      ["public:remote", "update", fresh],
      ["hashtag #Cats", "update", fresh],
    ]);
  });

  it("sends an edit as status.update on the feeds that show it", async () => {
    const h = await community(["alice", "bob"]);
    const status = await post(h, h.users.bob, { status: "before #cats", visibility: "public" });
    const inbox = await feeds(h, h.users.alice.token);
    const response = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(h.users.bob.token, json({ status: "after #cats" }, { method: "PUT" })),
    );
    expect(response.status).toBe(200);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["public", "status.update", status.id],
      ["public:local", "status.update", status.id],
      ["hashtag #Cats", "status.update", status.id],
      ["hashtag:local #Cats", "status.update", status.id],
    ]);
  });
});

describe("custom emoji on public streams (RES-2)", () => {
  // RES-3: a status and author at their presented emoji bounds are streamed whole within the payload bound.
  it("sends a status and its author with their emojis at the bound", async () => {
    const h = await community(["alice"]);
    const erin = await remoteAccount(h.store, "erin");
    const inbox = await feeds(h, h.users.alice.token);
    const status = await remoteStatus(h, erin);
    await sql(h.store, "UPDATE statuses SET emojis = ? WHERE id = ?", JSON.stringify(statusAtCap()), status);
    await sql(h.store, "UPDATE accounts SET emojis = ? WHERE id = ?", JSON.stringify(accountAtCap()), erin);
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    expect(events(inbox)[0]).toEqual(["public", "update", status]);
    const sent = (await inbox.next()).payload!;
    const payload = JSON.parse(sent) as { emojis: unknown[]; account: { emojis: unknown[] } };
    expect([payload.emojis.length, payload.account.emojis.length]).toEqual([11, 6]);
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    expect([bytes(payload.emojis), bytes(payload.account.emojis)]).toEqual([STATUS_EMOJIS_BYTES, ACCOUNT_EMOJIS_BYTES]);
    expect(new TextEncoder().encode(sent).length).toBeLessThan(STREAM_LIMITS.payloadBytes);
  });
});

describe("delete on public and hashtag streams", () => {
  it("sends the delete of a public status on the feeds its tombstone matches, and of no boost or non-public status", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const status = await post(h, h.users.bob, { status: "gone #cats", visibility: "public" });
    const unlisted = await post(h, h.users.bob, { status: "unlisted #cats", visibility: "unlisted" });
    const boosted = await post(h, h.users.carol, { status: "boosted", visibility: "public" });
    expect((await act(h, h.users.bob, `/api/v1/statuses/${boosted.id}/reblog`)).status).toBe(200);
    const inbox = await feeds(h, h.users.alice.token, ["#Cats", "dogs"]);
    await remove(h, h.users.bob.token, unlisted.id);
    expect((await act(h, h.users.bob, `/api/v1/statuses/${boosted.id}/unreblog`)).status).toBe(200);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);
    expect(await sql(h.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'delete'")).toEqual([{ n: 0 }]);

    await remove(h, h.users.bob.token, status.id);
    await drained(h, inbox);
    expect(inbox.rest()).toEqual([
      { stream: ["public"], event: "delete", payload: status.id },
      { stream: ["public:local"], event: "delete", payload: status.id },
      { stream: ["hashtag", "#Cats"], event: "delete", payload: status.id },
      { stream: ["hashtag:local", "#Cats"], event: "delete", payload: status.id },
    ]);
  });

  it("matches remote, media and hashtag facts, and sends a boost delete on user only", async () => {
    const h = await community(["alice", "bob"]);
    const erin = await remoteAccount(h.store, "erin");
    const status = await remoteStatus(h, erin, { media: true });
    const plain = await remoteStatus(h, erin);
    await sql(h.store, "DELETE FROM status_tags WHERE status_id = ?", plain);
    const boost = await seedStatus(h.store, { accountId: h.users.bob.id, visibility: "public", reblogOfId: plain });
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      h.users.alice.id,
      h.users.bob.id,
    );
    const inbox = await feeds(h, h.users.alice.token, ["cats", "dogs"]);
    inbox.send({ type: "subscribe", stream: "user" });
    await settled(h, inbox);
    for (const id of [status, plain]) {
      await runInDurableObject(h.store, (_instance, state) => {
        state.storage.transactionSync(() => streamDelete(new Db(state.storage.sql), id, NOW));
      });
    }
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    // Each unit's messages go in the socket's subscription order (`user` last).
    expect(inbox.rest()).toEqual([
      { stream: ["public"], event: "delete", payload: status },
      { stream: ["public:remote"], event: "delete", payload: status },
      { stream: ["public:media"], event: "delete", payload: status },
      { stream: ["public:remote:media"], event: "delete", payload: status },
      { stream: ["hashtag", "cats"], event: "delete", payload: status },
      { stream: ["user"], event: "delete", payload: status },
      // Without media or hashtags; its boost goes on user alone.
      { stream: ["public"], event: "delete", payload: plain },
      { stream: ["public:remote"], event: "delete", payload: plain },
      { stream: ["user"], event: "delete", payload: plain },
      { stream: ["user"], event: "delete", payload: boost },
    ]);
  });

  it("sends a delete to a viewer the status could be viewed by, not to one its author blocks", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const status = await post(h, h.users.bob, { status: "gone", visibility: "public" });
    const alice = await subscribed(h, h.users.alice.token, "public");
    const carol = await subscribed(h, h.users.carol.token, "public");
    await block(h.store, h.users.bob.id, h.users.carol.id);
    await remove(h, h.users.bob.token, status.id);
    await drained(h, alice, carol);
    expect(events(alice)).toEqual([["public", "delete", status.id]]);
    expect(events(carol)).toEqual([]);
  });
});

// `count` local accounts (ids 5 then 17 digits), each with a token of its own `feed-<id>` (read).
async function viewers(h: ApiHarness, count: number): Promise<string[]> {
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username) SELECT printf('5%017d', i), 'https://kopje.test/ap/users/v' || i, 'v' || i FROM n`,
    count,
  );
  await sql(
    h.store,
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`,
  );
  const ids = Array.from({ length: count }, (_, i) => `5${String(i + 1).padStart(17, "0")}`);
  for (const id of ids) {
    await sql(
      h.store,
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) SELECT ?, 'access', client_id, ?, 'read' FROM oauth_tokens LIMIT 1",
      await sha256Hex(`feed-${id}`),
      id,
    );
  }
  return ids;
}

describe("feeds at the caps", () => {
  // 256 sockets (the instance's cap), each of its own account and token, on `public` and `hashtag` #cats: a turn's
  // token sweep takes 256 checks of its 512 and each unit at most 64 presentations, so one status takes several turns,
  // each within its budget, each socket sent each message once.
  it("sends a status and its delete to 256 sockets on distinct tokens, once each, over several turns", async () => {
    const h = await community(["author"]);
    const ids = await viewers(h, 256);
    const inboxes: Inbox[] = [];
    for (const id of ids) {
      const inbox = await connect(h, `feed-${id}`);
      inbox.send({ type: "subscribe", stream: "public" });
      inbox.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
      inboxes.push(inbox);
    }
    for (const inbox of inboxes) {
      await echo(inbox);
    }
    const before = (await drained(h)).turns;
    const status = await post(h, h.users.author, { status: "for everyone #cats", visibility: "public" });
    const sent = await drained(h, ...inboxes);
    for (const inbox of inboxes) {
      expect(events(inbox)).toEqual([
        ["public", "update", status.id],
        ["hashtag cats", "update", status.id],
      ]);
      await inbox.next();
      await inbox.next();
    }
    // 256 presentations, at most 64 a turn.
    expect(sent.turns - before).toBeGreaterThanOrEqual(4);
    await remove(h, h.users.author.token, status.id);
    await drained(h, ...inboxes);
    for (const inbox of inboxes) {
      expect(events(inbox)).toEqual([
        ["public", "delete", status.id],
        ["hashtag cats", "delete", status.id],
      ]);
    }
  }, 120_000);
});
