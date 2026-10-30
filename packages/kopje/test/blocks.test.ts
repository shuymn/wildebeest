import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import type { Relationship } from "../src/domain/accounts";
import { canView } from "../src/domain/audience";
import {
  blockDomain as blockDomainOperation,
  DOMAIN_BLOCK_BATCHES_PER_RUN,
  DOMAIN_BLOCK_WINDOW,
  runDomainBlockCleanups,
} from "../src/domain/blocks";
import { JOB_RETRY_DELAYS_MS } from "../src/domain/job-attempts";
import { publicTimeline } from "../src/domain/timelines";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, bearer, json, login, settleDeliveries, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, claimSent, runStoreJobs } from "./helpers";
import { watchedCursor } from "./read-helpers";
import { receive, rejects } from "./remote-suspension-helpers";
import {
  act,
  community,
  domainBlock,
  follow,
  getJson,
  ids,
  outbound,
  post,
  remoteAccount,
  remoteFollows,
  seedStatus,
  type User,
} from "./status-helpers";

// Blocks, mutes and domain blocks through the API (domain/blocks.ts, mastodon/blocks.ts): the endpoints, their scopes
// and errors, the relationships they end and the activities they send, and how they filter timelines, search and
// notifications (VIS-5, VIS-13, VIS-14, VIS-15 in docs/threat-model.md).

const ALICE_URI = "https://kopje.test/ap/users/alice";

async function relationship(h: ApiHarness, user: User, id: string): Promise<Relationship> {
  const { status, body } = await getJson<Relationship[]>(h, `/api/v1/accounts/relationships?id[]=${id}`, user.token);
  expect(status).toBe(200);
  return body[0]!;
}

async function relate(h: ApiHarness, user: User, path: string, body: Record<string, unknown> = {}) {
  const response = await act(h, user, path, body);
  expect(response.status).toBe(200);
  return response.json<Relationship>();
}

async function follows(h: ApiHarness): Promise<{ account_id: string; target_account_id: string; state: string }[]> {
  return sql(h.store, "SELECT account_id, target_account_id, state FROM follows ORDER BY id");
}

// Each outbound activity with the inboxes it was expanded to.
async function sent(h: ApiHarness) {
  const deliveries = await sql<{ activity_id: number; inbox_url: string }>(
    h.store,
    "SELECT activity_id, inbox_url FROM deliveries ORDER BY id",
  );
  const rows = await sql<{ id: number; retracts: number; superseded: number }>(
    h.store,
    "SELECT id, retracts, superseded FROM outbound_activities ORDER BY id",
  );
  const bodies = await outbound(h.store);
  return rows.map((row, i) => ({
    ...bodies[i]!,
    retracts: row.retracts,
    superseded: row.superseded,
    inboxes: deliveries.filter((d) => d.activity_id === row.id).map((d) => d.inbox_url),
  }));
}

describe("blocks", () => {
  it("blocks a local account: the follows end both ways and neither may follow again until unblocked", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, alice, bob.id);
    await follow(h, bob, alice.id);

    expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/block`)).toMatchObject({
      id: bob.id,
      following: false,
      followed_by: false,
      blocking: true,
      blocked_by: false,
    });
    expect(await relationship(h, bob, alice.id)).toMatchObject({ blocking: false, blocked_by: true });
    expect(await follows(h)).toEqual([]);
    // The follow notifications go with the follows; counts are recomputed.
    expect(await sql(h.store, "SELECT 1 FROM notifications WHERE type = 'follow'")).toEqual([]);
    expect(
      await sql(h.store, "SELECT followers_count, following_count FROM accounts WHERE id IN (?, ?)", alice.id, bob.id),
    ).toEqual([
      { followers_count: 0, following_count: 0 },
      { followers_count: 0, following_count: 0 },
    ]);
    expect((await act(h, alice, `/api/v1/accounts/${bob.id}/follow`)).status).toBe(403);
    expect((await act(h, bob, `/api/v1/accounts/${alice.id}/follow`)).status).toBe(403);
    // Blocking again changes nothing; a local block federates nothing.
    expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/block`)).toMatchObject({ blocking: true });
    expect(await sql(h.store, "SELECT uri FROM blocks")).toEqual([{ uri: null }]);
    expect(await outbound(h.store)).toEqual([]);

    expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/unblock`)).toMatchObject({ blocking: false });
    expect(await relationship(h, bob, alice.id)).toMatchObject({ blocked_by: false });
    expect((await act(h, bob, `/api/v1/accounts/${alice.id}/follow`)).status).toBe(200);
  });

  it("sends a remote account Undo Follow, Reject and Block, and Undo Block on unblock", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const carol = await remoteAccount(h.store, "carol");
    const carolUri = "https://remote.example/users/carol";
    await follow(h, alice, carol);
    const carolFollow = "https://remote.example/users/carol#follows/9";
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'accepted', ?)",
      carol,
      alice.id,
      carolFollow,
    );
    const [ours] = await sql<{ id: number; uri: string }>(
      h.store,
      "SELECT id, uri FROM follows WHERE account_id = ?",
      alice.id,
    );

    expect(await relate(h, alice, `/api/v1/accounts/${carol}/block`)).toMatchObject({
      blocking: true,
      following: false,
      requested: false,
      followed_by: false,
    });
    const [edge] = await sql<{ id: number; uri: string }>(h.store, "SELECT id, uri FROM blocks");
    const blockId = `${ALICE_URI}#blocks/${edge!.id}`;
    expect(edge!.uri).toBe(blockId);
    const [, undoFollow, reject, blockActivity] = await sent(h);
    const shared = ["https://remote.example/inbox"];
    expect(undoFollow).toMatchObject({
      signer: alice.id,
      activity: {
        type: "Undo",
        actor: ALICE_URI,
        object: { id: ours!.uri, type: "Follow", actor: ALICE_URI, object: carolUri },
      },
      audience: { followers: false, accounts: [carol] },
      inboxes: shared,
    });
    // The Reject ends a follow we had accepted, so it withdraws it.
    expect(reject).toMatchObject({
      activity: {
        type: "Reject",
        actor: ALICE_URI,
        object: { id: carolFollow, type: "Follow", actor: carolUri, object: ALICE_URI },
      },
      retracts: 1,
      inboxes: shared,
    });
    expect(blockActivity).toMatchObject({
      activity: { id: blockId, type: "Block", actor: ALICE_URI, object: carolUri },
      audience: { followers: false, accounts: [carol] },
      retracts: 0,
      inboxes: shared,
    });
    // The ended Follow is recorded as retracted, so a replay of it does not come back (ID-7).
    expect(await sql(h.store, "SELECT actor_uri, target_uri FROM inbound_retractions")).toEqual([
      { actor_uri: carolUri, target_uri: carolFollow },
    ]);

    expect(await relate(h, alice, `/api/v1/accounts/${carol}/unblock`)).toMatchObject({ blocking: false });
    const all = await sent(h);
    expect(all.at(-1)).toMatchObject({
      activity: {
        id: `${blockId}/undo`,
        type: "Undo",
        actor: ALICE_URI,
        object: { id: blockId, type: "Block", actor: ALICE_URI, object: carolUri },
      },
      retracts: 1,
      inboxes: shared,
    });
    // The Undo supersedes the Block it retracts.
    expect(all.find((o) => o.activity.type === "Block")).toMatchObject({ superseded: 1 });
    expect(await sql(h.store, "SELECT 1 FROM blocks")).toEqual([]);
  });

  it("answers a pending remote request with a Reject that withdraws nothing", async () => {
    const h = await community(["alice"]);
    const carol = await remoteAccount(h.store, "carol");
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
      carol,
      h.users.alice.id,
      "https://remote.example/users/carol#follows/1",
    );
    await relate(h, h.users.alice, `/api/v1/accounts/${carol}/block`);
    expect((await sent(h)).map((o) => [o.activity.type, o.retracts])).toEqual([
      ["Reject", 0],
      ["Block", 0],
    ]);
    expect(await follows(h)).toEqual([]);
  });

  it("answers 404 for an unknown account and 403 for oneself, and needs write:blocks or follow", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    expect((await act(h, alice, "/api/v1/accounts/999999999999999999/block")).status).toBe(404);
    expect((await act(h, alice, `/api/v1/accounts/${alice.id}/block`)).status).toBe(403);
    expect((await act(h, alice, `/api/v1/accounts/${alice.id}/mute`)).status).toBe(403);
    expect((await h.request(`/api/v1/accounts/${bob.id}/block`, { method: "POST" })).status).toBe(401);
    const { token: readOnly } = await login(h, { email: "alice@example.com", scope: "read" });
    const { token: legacy } = await login(h, { email: "alice@example.com", scope: "follow" });
    const { token: blocksOnly } = await login(h, { email: "alice@example.com", scope: "write:blocks read:blocks" });
    const statusOf = async (path: string, token: string, method = "POST") =>
      (await h.request(path, bearer(token, { method }))).status;
    expect(await statusOf(`/api/v1/accounts/${bob.id}/block`, readOnly)).toBe(403);
    expect(await statusOf(`/api/v1/accounts/${bob.id}/mute`, blocksOnly)).toBe(403);
    expect(await statusOf(`/api/v1/accounts/${bob.id}/block`, blocksOnly)).toBe(200);
    expect(await statusOf(`/api/v1/accounts/${bob.id}/mute`, legacy)).toBe(200);
    expect(await statusOf("/api/v1/blocks", blocksOnly, "GET")).toBe(200);
    expect(await statusOf("/api/v1/mutes", blocksOnly, "GET")).toBe(403);
    expect(await statusOf("/api/v1/mutes", legacy, "GET")).toBe(200);
    expect(await statusOf("/api/v1/domain_blocks", readOnly, "GET")).toBe(200);
    expect(await statusOf("/api/v1/domain_blocks", readOnly)).toBe(403);
    // The preview previews a write (Mastodon's DomainBlocks::PreviewsController).
    const { token: writeBlocks } = await login(h, { email: "alice@example.com", scope: "write:blocks" });
    const { token: readBlocks } = await login(h, { email: "alice@example.com", scope: "read:blocks" });
    const preview = "/api/v1/domain_blocks/preview?domain=remote.example";
    expect(await statusOf(preview, writeBlocks, "GET")).toBe(200);
    expect(await statusOf(preview, readBlocks, "GET")).toBe(403);
    expect(await statusOf(preview, legacy, "GET")).toBe(200);
  });

  it("lists blocked accounts newest first, paged by Link headers", async () => {
    const h = await community(["alice"]);
    const targets = [
      await remoteAccount(h.store, "one"),
      await remoteAccount(h.store, "two"),
      await remoteAccount(h.store, "three"),
    ];
    for (const target of targets) {
      await relate(h, h.users.alice, `/api/v1/accounts/${target}/block`);
    }
    const first = await h.request("/api/v1/blocks?limit=2", bearer(h.users.alice.token));
    expect((await first.json<{ id: string }[]>()).map((a) => a.id)).toEqual([targets[2], targets[1]]);
    const link = first.headers.get("link") ?? "";
    const next = /<([^>]+)>; rel="next"/.exec(link)?.[1];
    expect(next).toMatch(/max_id=\d+/);
    expect(link).toMatch(/min_id=\d+>; rel="prev"/);
    expect(await ids(h, next!.replace("https://kopje.test", ""), h.users.alice.token)).toEqual([targets[0]]);
  });

  it("applies an inbound Block and its Undo: blocked_by, both follows ended, theirs rejected, ours undone", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const carol = await remoteAccount(h.store, "carol");
    const carolUri = "https://remote.example/users/carol";
    await follow(h, alice, carol);
    await remoteFollows(h.store, carol, alice.id);
    const receive = (activity: Parameters<typeof h.store.receiveActivity>[1]["activity"]) =>
      h.store.receiveActivity(BUILD, {
        now: NOW,
        origin: "https://kopje.test",
        actorUri: carolUri,
        actor: null,
        actorRevision: null,
        activity,
      });
    const blockId = `${carolUri}#blocks/1`;

    expect(await receive({ type: "Block", id: blockId, object: ALICE_URI })).toMatchObject({ applied: true });
    expect(await relationship(h, alice, carol)).toMatchObject({
      blocked_by: true,
      blocking: false,
      following: false,
      requested: false,
      followed_by: false,
    });
    expect(await follows(h)).toEqual([]);
    expect((await outbound(h.store)).map((o) => o.activity.type)).toEqual(["Follow", "Reject", "Undo"]);
    expect((await act(h, alice, `/api/v1/accounts/${carol}/follow`)).status).toBe(403);

    const undo = { id: `${blockId}/undo`, object: { id: blockId, type: "Block", actor: carolUri, object: ALICE_URI } };
    expect(await receive({ type: "Undo", ...undo })).toMatchObject({ applied: true });
    expect(await relationship(h, alice, carol)).toMatchObject({ blocked_by: false });
  });
});

// An inbound Block of alice by r, as Mastodon's ActivityPub::Activity::Block (block.rb:14-16) applies it: r's accepted
// follow ends with a withdrawing Reject (unfollow_service.rb:35-36), r's pending request stays for alice to authorize
// or reject as any other (follow_requests_controller.rb, authorize_follow_service.rb, follow_request.rb#authorize!
// check no block), and alice's follow and request of r end. A Follow r sends after its Block is taken as any other
// (follow.rb:18 refuses only a follower the target blocks).
describe("an inbound Block by a follower (VIS-13, ID-7)", () => {
  const R_URI = "https://remote.example/users/r";
  let n = 0;

  async function blocked(options: { locked?: boolean } = {}) {
    const h = await community(["alice"]);
    const { alice } = h.users;
    if (options.locked === true) {
      await sql(h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", alice.id);
    }
    const r = await remoteAccount(h.store, "r");
    const from = (activity: Record<string, unknown> & { type: string }) => receive(h.store, R_URI, activity);
    const followFrom = async (id = `https://remote.example/follows/${++n}`) => ({
      id,
      result: await from({ id, type: "Follow", object: ALICE_URI }),
    });
    const blockFrom = async (id = `https://remote.example/blocks/${++n}`) => ({
      id,
      result: await from({ id, type: "Block", object: ALICE_URI }),
    });
    const undoFrom = (object: { id: string; type: string }) =>
      from({ id: `${object.id}/undo`, type: "Undo", object: { ...object, actor: R_URI, object: ALICE_URI } });
    const answer = async (decision: "authorize" | "reject") =>
      (await act(h, alice, `/api/v1/follow_requests/${r}/${decision}`)).status;
    const types = async () => (await outbound(h.store)).map((o) => o.activity.type);
    const retracted = async (uri: string) =>
      (await sql(h.store, "SELECT 1 FROM inbound_retractions WHERE actor_uri = ? AND target_uri = ?", R_URI, uri))
        .length > 0;
    const followers = async () =>
      (await sql<{ n: number }>(h.store, "SELECT followers_count AS n FROM accounts WHERE id = ?", alice.id))[0]!.n;
    const canSee = (viewer: string, status: string) =>
      runInDurableObject(h.store, (_instance, state) => canView(new Db(state.storage.sql), viewer, status));
    return { h, alice, r, from, followFrom, blockFrom, undoFrom, answer, types, retracted, followers, canSee };
  }

  it("keeps a pending request: not retracted, listed, a replay a duplicate, nothing sent", async () => {
    const t = await blocked({ locked: true });
    const request = await t.followFrom();
    expect(request.result).toMatchObject({ reason: "follow-requested" });
    expect((await t.blockFrom()).result).toMatchObject({ applied: true, reason: "blocked" });
    expect(await follows(t.h)).toEqual([{ account_id: t.r, target_account_id: t.alice.id, state: "pending" }]);
    expect(await t.retracted(request.id)).toBe(false);
    expect(await t.followFrom(request.id)).toMatchObject({ result: { applied: false, reason: "duplicate" } });
    expect(await t.types()).toEqual([]);
    expect(await ids(t.h, "/api/v1/follow_requests", t.alice.token)).toEqual([t.r]);
    // The follow_request notification stays stored with its request; the notification rule hides it while r blocks
    // alice (docs/mastodon-deviations.md).
    expect(
      await sql(
        t.h.store,
        "SELECT type FROM notifications WHERE account_id = ? AND from_account_id = ?",
        t.alice.id,
        t.r,
      ),
    ).toEqual([{ type: "follow_request" }]);
    expect(await relationship(t.h, t.alice, t.r)).toMatchObject({ blocked_by: true, requested_by: true });
  });

  it("authorizes a kept request during the block: the Accept, the count, VIS-1 both ways; an Undo keeps it", async () => {
    const t = await blocked({ locked: true });
    const request = await t.followFrom();
    const block = await t.blockFrom();
    const mine = (await post(t.h, t.alice, { status: "followers only", visibility: "private" })).id;
    const theirs = await seedStatus(t.h.store, {
      accountId: t.r,
      visibility: "private",
      mentions: [{ accountId: t.alice.id }],
    });
    expect(await t.canSee(t.r, mine)).toBe(false);
    expect(await t.answer("authorize")).toBe(200);
    expect(await follows(t.h)).toEqual([{ account_id: t.r, target_account_id: t.alice.id, state: "accepted" }]);
    const [accept] = await outbound(t.h.store);
    expect(accept?.activity).toMatchObject({ type: "Accept", object: { id: request.id } });
    expect(await t.followers()).toBe(1);
    expect(await t.canSee(t.r, mine)).toBe(true);
    expect(await t.canSee(t.alice.id, theirs)).toBe(false);
    // A Block again under a new id updates the block only (block.rb's early return): the follow stays.
    const again = await t.blockFrom();
    expect(again.result).toMatchObject({ applied: true, reason: "block-updated" });
    expect(await follows(t.h)).toHaveLength(1);
    expect(await t.undoFrom({ id: again.id, type: "Block" })).toMatchObject({ applied: true });
    expect(await t.undoFrom({ id: block.id, type: "Block" })).toMatchObject({ applied: false });
    expect(await follows(t.h)).toEqual([{ account_id: t.r, target_account_id: t.alice.id, state: "accepted" }]);
    expect(await relationship(t.h, t.alice, t.r)).toMatchObject({ blocked_by: false, followed_by: true });
  });

  it("rejects a kept request during the block: the Reject, and its replay is refused after the Undo", async () => {
    const t = await blocked({ locked: true });
    const request = await t.followFrom();
    const block = await t.blockFrom();
    expect(await t.answer("reject")).toBe(200);
    expect(await follows(t.h)).toEqual([]);
    expect(await t.types()).toEqual(["Reject"]);
    expect(await t.retracted(request.id)).toBe(true);
    expect(await t.undoFrom({ id: block.id, type: "Block" })).toMatchObject({ applied: true });
    expect(await t.followFrom(request.id)).toMatchObject({ result: { applied: false, reason: "retracted" } });
  });

  it("an Undo of the Block keeps a pending request, and a replay of it is then a duplicate", async () => {
    const t = await blocked({ locked: true });
    const request = await t.followFrom();
    const block = await t.blockFrom();
    expect(await t.undoFrom({ id: block.id, type: "Block" })).toMatchObject({ applied: true });
    expect(await follows(t.h)).toEqual([{ account_id: t.r, target_account_id: t.alice.id, state: "pending" }]);
    expect(await t.followFrom(request.id)).toMatchObject({ result: { applied: false, reason: "duplicate" } });
  });

  it("unlocking authorizes a kept request during the block, with the Accept and the count", async () => {
    const t = await blocked({ locked: true });
    const request = await t.followFrom();
    await t.blockFrom();
    const unlocked = await t.h.request(
      "/api/v1/accounts/update_credentials",
      bearer(t.alice.token, { ...json({ locked: false }), method: "PATCH" }),
    );
    expect(unlocked.status).toBe(200);
    await runStoreJobs(t.h.store, BUILD, { now: NOW });
    expect(await follows(t.h)).toEqual([{ account_id: t.r, target_account_id: t.alice.id, state: "accepted" }]);
    const accept = (await outbound(t.h.store)).find((o) => o.activity.type === "Accept");
    expect(accept?.activity).toMatchObject({ object: { id: request.id } });
    expect(await t.followers()).toBe(1);
  });

  it("ends an accepted follow with one withdrawing Reject; a replay stays retracted, an old Undo spares a new one", async () => {
    const t = await blocked();
    const first = await t.followFrom();
    expect(first.result).toMatchObject({ reason: "followed" });
    const block = await t.blockFrom();
    expect(block.result).toMatchObject({ applied: true, reason: "blocked" });
    expect(await follows(t.h)).toEqual([]);
    expect(await t.followers()).toBe(0);
    expect(await rejects(t.h.store)).toEqual([{ signer: t.alice.id, follower: R_URI, retracts: 1 }]);
    expect(await t.retracted(first.id)).toBe(true);
    expect(await t.undoFrom({ id: block.id, type: "Block" })).toMatchObject({ applied: true });
    expect(await t.followFrom(first.id)).toMatchObject({ result: { applied: false, reason: "retracted" } });
    const second = await t.followFrom();
    expect(second.result).toMatchObject({ applied: true, reason: "followed" });
    await t.undoFrom({ id: first.id, type: "Follow" });
    expect(await sql(t.h.store, "SELECT uri, state FROM follows")).toEqual([{ uri: second.id, state: "accepted" }]);
  });

  it.each([
    ["a locked account waits for its owner", true, "follow-requested", "pending", []],
    ["an unlocked account accepts it", false, "followed", "accepted", ["Accept"]],
  ])("a Follow after the blocker's Block: %s", async (_, locked, reason, state, sent) => {
    const t = await blocked({ locked });
    const block = await t.blockFrom();
    const request = await t.followFrom();
    expect(request.result).toMatchObject({ applied: true, reason });
    expect(await follows(t.h)).toEqual([{ account_id: t.r, target_account_id: t.alice.id, state }]);
    expect(await t.types()).toEqual(sent);
    // Its replay changes nothing, during the block and after its Undo.
    expect(await t.followFrom(request.id)).toMatchObject({ result: { applied: false, reason: "duplicate" } });
    await t.undoFrom({ id: block.id, type: "Block" });
    expect(await t.followFrom(request.id)).toMatchObject({ result: { applied: false, reason: "duplicate" } });
    expect(await t.types()).toEqual(sent);
  });

  it.each(["pending", "accepted"])("ends alice's %s follow of the blocker and undoes it there", async (state) => {
    const t = await blocked();
    await follow(t.h, t.alice, t.r);
    await sql(t.h.store, "UPDATE follows SET state = ?", state);
    expect((await t.blockFrom()).result).toMatchObject({ applied: true, reason: "blocked" });
    expect(await follows(t.h)).toEqual([]);
    expect(await t.types()).toEqual(["Follow", "Undo"]);
  });
});

describe("blocked recipients (VIS-13, VIS-15)", () => {
  it("neither mentions nor addresses an account or domain the author blocks", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const bob = await remoteAccount(h.store, "bob");
    await remoteAccount(h.store, "far", "blocked.example");
    await remoteFollows(h.store, await remoteAccount(h.store, "fan", "other.example"), alice.id);
    await relate(h, alice, `/api/v1/accounts/${bob}/block`);
    await h.request("/api/v1/domain_blocks", bearer(alice.token, json({ domain: "blocked.example" })));

    const status = await post(h, alice, { status: "@bob@remote.example @far@blocked.example hi" });
    expect(status.mentions).toEqual([]);
    expect(status.content).not.toContain("<a");
    expect(await sql(h.store, "SELECT 1 FROM status_mentions WHERE status_id = ?", status.id)).toEqual([]);
    const create = (await sent(h)).find((o) => o.activity.type === "Create");
    expect(create?.inboxes).toEqual(["https://other.example/inbox"]);
    // The text keeps the names as text; no Mention, to or cc names the accounts.
    expect(JSON.stringify(create?.activity)).not.toMatch(/https:\/\/(remote|blocked)\.example\/users/);
  });

  it("drops a mention of an account blocked since when the status is edited", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const bob = await remoteAccount(h.store, "bob");
    const status = await post(h, alice, { status: "@bob@remote.example hi", visibility: "private" });
    await relate(h, alice, `/api/v1/accounts/${bob}/block`);
    const edited = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "@bob@remote.example hi again" }, { method: "PUT" })),
    );
    expect(edited.status).toBe(200);
    expect(await sql(h.store, "SELECT 1 FROM status_mentions WHERE status_id = ?", status.id)).toEqual([]);
  });

  it("boosts a status from a blocked domain without naming or sending to its author, in the outbox too", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const bob = await remoteAccount(h.store, "bob");
    await remoteFollows(h.store, await remoteAccount(h.store, "fan", "other.example"), alice.id);
    const original = await seedStatus(h.store, { accountId: bob, visibility: "public" });
    await h.request("/api/v1/domain_blocks", bearer(alice.token, json({ domain: "remote.example" })));
    await sql(h.store, "DELETE FROM outbound_activities");

    // As in Mastodon, the boost is allowed; the author is left out of it.
    expect((await act(h, alice, `/api/v1/statuses/${original}/reblog`)).status).toBe(200);
    const claim = await claimSent(h.store, { now: NOW, leaseToken: "lease" });
    expect(claim.deliveries.map((d) => d.inbox)).toEqual(["https://other.example/inbox"]);
    const body = JSON.parse(claim.deliveries[0]!.body) as { id: string; type: string; cc: string[] };
    expect(body.type).toBe("Announce");
    expect(JSON.stringify(body)).not.toContain("https://remote.example/users/bob");
    expect((await sent(h))[0]?.audience.accounts).toEqual([]);
    // The outbox serves the same Announce (one construction), without the author either.
    const page = await h.store.outbox(BUILD, { username: "alice", before: "~" });
    const served = (page?.items ?? []).map((item) => JSON.parse(item) as { id: string; type: string });
    expect(served.map((item) => [item.type, item.id])).toEqual([["Announce", body.id]]);
    expect(JSON.stringify(served)).not.toContain("https://remote.example/users/bob");
  });

  it("names and reaches the author in the Undo of a boost that left them out, as every retraction does", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const bob = await remoteAccount(h.store, "bob");
    await remoteFollows(h.store, await remoteAccount(h.store, "fan", "other.example"), alice.id);
    const original = await seedStatus(h.store, { accountId: bob, visibility: "public" });
    await h.request("/api/v1/domain_blocks", bearer(alice.token, json({ domain: "remote.example" })));
    expect((await act(h, alice, `/api/v1/statuses/${original}/reblog`)).status).toBe(200);
    await sql(h.store, "DELETE FROM outbound_activities");

    expect((await act(h, alice, `/api/v1/statuses/${original}/unreblog`)).status).toBe(200);
    // The unboost's job stages the Undo's targets.
    await settleDeliveries(h.store);
    const [undo] = await sent(h);
    expect(undo?.activity.type).toBe("Undo");
    expect(undo?.activity.cc).toContain("https://remote.example/users/bob");
    expect(undo?.audience.accounts).toEqual([bob]);
    expect(undo?.inboxes.toSorted()).toEqual(["https://other.example/inbox", "https://remote.example/inbox"]);
  });

  it("sends a profile Update, but no new status, to a follower on a domain the cleanup has not reached yet", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "fan", "other.example"), alice.id);
    await remoteFollows(h.store, await remoteAccount(h.store, "far", "blocked.example"), alice.id);
    // The block as it stands before its cleanup ends the follow there.
    await domainBlock(h.store, alice.id, "blocked.example");

    await post(h, alice, { status: "not for blocked.example" });
    const profile = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(alice.token, { ...json({ display_name: "Alice Again" }), method: "PATCH" }),
    );
    expect(profile.status).toBe(200);
    expect((await sent(h)).map((o) => [o.activity.type, o.inboxes.toSorted()])).toEqual([
      ["Create", ["https://other.example/inbox"]],
      ["Update", ["https://blocked.example/inbox", "https://other.example/inbox"]],
    ]);
  });

  it("addresses a status written after a block to nobody behind the blocked account", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const bob = await remoteAccount(h.store, "bob");
    await remoteAccount(h.store, "carol", "other.example");
    await relate(h, alice, `/api/v1/accounts/${bob}/block`);
    await sql(h.store, "DELETE FROM outbound_activities");

    // bob is the only recipient on remote.example: neither his personal nor his shared inbox gets it.
    await post(h, alice, { status: "@bob@remote.example @carol@other.example secret", visibility: "direct" });
    await post(h, alice, { status: "@bob@remote.example just you", visibility: "direct" });
    expect((await sent(h)).map((o) => [o.activity.type, o.audience.accounts.length, o.inboxes])).toEqual([
      ["Create", 1, ["https://other.example/inbox"]],
    ]);
  });
});

describe("mutes", () => {
  it("mutes with notifications by default, takes notifications and duration, lists and unmutes", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`)).toMatchObject({
      muting: true,
      muting_notifications: true,
      muting_expires_at: null,
    });
    const expires = new Date(NOW + 3600_000).toISOString();
    expect(
      await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`, { notifications: false, duration: 3600 }),
    ).toMatchObject({ muting: true, muting_notifications: false, muting_expires_at: expires });
    expect(await sql(h.store, "SELECT hide_notifications, expires_at FROM mutes")).toEqual([
      { hide_notifications: 0, expires_at: expires },
    ]);
    // A mute is local only, and the muted account sees nothing of it.
    expect(await outbound(h.store)).toEqual([]);
    expect(await relationship(h, bob, alice.id)).toMatchObject({ blocked_by: false, muting: false });
    const { body } = await getJson<{ id: string; mute_expires_at: string | null }[]>(h, "/api/v1/mutes", alice.token);
    expect(body.map((a) => [a.id, a.mute_expires_at])).toEqual([[bob.id, expires]]);

    expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/unmute`)).toMatchObject({
      muting: false,
      muting_notifications: false,
      muting_expires_at: null,
    });
    expect(await ids(h, "/api/v1/mutes", alice.token)).toEqual([]);
  });

  it("reads duration as Mastodon does: 0 or no number is indefinite, a negative one has already expired", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const path = `/api/v1/accounts/${bob.id}/mute`;
    expect(await relate(h, alice, path, { duration: "soon" })).toMatchObject({ muting: true, muting_expires_at: null });
    expect(await relate(h, alice, path, { duration: 0 })).toMatchObject({ muting: true, muting_expires_at: null });
    expect(await relate(h, alice, path, { duration: -5 })).toMatchObject({ muting: false });
    expect(await relate(h, alice, path, { duration: "1e400" })).toMatchObject({ muting: true });
    expect(await relate(h, alice, path, { duration: "99999999999999999999" })).toMatchObject({
      muting: true,
      muting_expires_at: "9999-12-31T23:59:59.999Z",
    });
  });

  it("hides the muted account from timelines and search; notifications only when it mutes them", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, alice, bob.id);
    const status = await post(h, bob, { status: "@alice hello #topic" });
    const everywhere = async () => ({
      home: await ids(h, "/api/v1/timelines/home", alice.token),
      public: await ids(h, "/api/v1/timelines/public", alice.token),
      tag: await ids(h, "/api/v1/timelines/tag/topic", alice.token),
      search: (
        await getJson<{ statuses: { id: string }[] }>(h, "/api/v2/search?q=hello", alice.token)
      ).body.statuses.map((s) => s.id),
      notifications: (await getJson<{ type: string }[]>(h, "/api/v1/notifications", alice.token)).body.map(
        (n) => n.type,
      ),
    });
    expect(await everywhere()).toEqual({
      home: [status.id],
      public: [status.id],
      tag: [status.id],
      search: [status.id],
      notifications: ["mention"],
    });

    await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`, { notifications: false });
    expect(await everywhere()).toEqual({ home: [], public: [], tag: [], search: [], notifications: ["mention"] });
    await post(h, bob, { status: "@alice still here" });
    expect((await everywhere()).notifications).toEqual(["mention", "mention"]);

    await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`);
    expect((await everywhere()).notifications).toEqual([]);
    // None is written while the mute hides them.
    await post(h, bob, { status: "@alice again" });
    expect(await sql(h.store, "SELECT count(*) AS n FROM notifications WHERE type = 'mention'")).toEqual([{ n: 2 }]);
    // The account's own profile still lists its statuses, as in Mastodon.
    expect(await ids(h, `/api/v1/accounts/${bob.id}/statuses`, alice.token)).toHaveLength(3);
  });

  it("stops applying an expired mute at its time, before any sweep removes it", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, alice, bob.id);
    const status = await post(h, bob, { status: "@alice hi" });
    await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`, { duration: 60 });
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([]);
    expect(await ids(h, "/api/v1/notifications", alice.token)).toEqual([]);

    h.now.mockReturnValue(NOW + 30_000);
    await post(h, bob, { status: "@alice during the mute" });
    h.now.mockReturnValue(NOW + 60_000);
    expect(await relationship(h, alice, bob.id)).toMatchObject({ muting: false, muting_expires_at: null });
    expect(await ids(h, "/api/v1/mutes", alice.token)).toEqual([]);
    const home = await ids(h, "/api/v1/timelines/home", alice.token);
    expect(home).toHaveLength(2);
    expect(home).toContain(status.id);
    // The notification written before the mute shows again; none was written during it.
    expect(await ids(h, "/api/v1/notifications", alice.token)).toHaveLength(1);
    await post(h, bob, { status: "@alice after" });
    expect(await ids(h, "/api/v1/notifications", alice.token)).toHaveLength(2);
    expect(await sql(h.store, "SELECT 1 FROM mutes")).toHaveLength(1);

    // The inbound sweep removes it later; a mute still running stays.
    const other = await remoteAccount(h.store, "other");
    await relate(h, alice, `/api/v1/accounts/${other}/mute`, { duration: 3600 });
    await runStoreJobs(h.store, BUILD, { now: NOW + 60_000 });
    expect(await sql(h.store, "SELECT target_account_id FROM mutes")).toEqual([{ target_account_id: other }]);
  });
});

describe("mentions of blocked and muted accounts", () => {
  it("leaves a status that mentions or replies to them out of home and mention notifications", async () => {
    const h = await community(["alice", "friend", "foe"]);
    const { alice, friend, foe } = h.users;
    await follow(h, alice, friend.id);
    const plain = await post(h, friend, { status: "nothing to see" });
    const aboutFoe = await post(h, friend, { status: "@foe hello" });
    const both = await post(h, friend, { status: "@alice @foe hey" });
    const parent = await post(h, foe, { status: "foe speaks" });
    const reply = await post(h, friend, { status: "@alice look", in_reply_to_id: parent.id });
    expect(await ids(h, "/api/v1/notifications", alice.token)).toHaveLength(2);

    await relate(h, alice, `/api/v1/accounts/${foe.id}/block`);
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([plain.id]);
    expect(await ids(h, "/api/v1/notifications", alice.token)).toEqual([]);

    // A mute filters home too; mention notifications only while it mutes notifications.
    await relate(h, alice, `/api/v1/accounts/${foe.id}/unblock`);
    await relate(h, alice, `/api/v1/accounts/${foe.id}/mute`, { notifications: false });
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([plain.id]);
    const shown = await getJson<{ status: { id: string } }[]>(h, "/api/v1/notifications", alice.token);
    expect(shown.body.map((n) => n.status.id)).toEqual([reply.id, both.id]);
    await relate(h, alice, `/api/v1/accounts/${foe.id}/mute`);
    expect(await ids(h, "/api/v1/notifications", alice.token)).toEqual([]);

    await relate(h, alice, `/api/v1/accounts/${foe.id}/unmute`);
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([both.id, aboutFoe.id, plain.id]);
  });

  it("leaves out post notifications (notify=true) that home leaves out, written and shown", async () => {
    const h = await community(["alice", "friend", "foe", "mutee"]);
    const { alice, friend, foe, mutee } = h.users;
    expect((await act(h, alice, `/api/v1/accounts/${friend.id}/follow`, { notify: true })).status).toBe(200);
    const early = await post(h, friend, { status: "@foe early" });
    expect(await ids(h, "/api/v1/notifications?types[]=status", alice.token)).toHaveLength(1);

    await relate(h, alice, `/api/v1/accounts/${foe.id}/block`);
    // A mute that keeps notifications still filters home, and so the post notification.
    await relate(h, alice, `/api/v1/accounts/${mutee.id}/mute`, { notifications: false });
    expect(await ids(h, "/api/v1/notifications?types[]=status", alice.token)).toEqual([]);
    await post(h, friend, { status: "@foe hello" });
    await post(h, friend, { status: "@mutee hey" });
    const plain = await post(h, friend, { status: "plain" });
    const shown = await getJson<{ status: { id: string } }[]>(h, "/api/v1/notifications?types[]=status", alice.token);
    expect(shown.body.map((n) => n.status.id)).toEqual([plain.id]);
    // None was written for the filtered posts.
    expect(await sql(h.store, "SELECT status_id FROM notifications WHERE type = 'status' ORDER BY id")).toEqual([
      { status_id: early.id },
      { status_id: plain.id },
    ]);
  });

  it("leaves out post notifications from a sender the recipient mutes, as home leaves the post out", async () => {
    const h = await community(["alice", "friend"]);
    const { alice, friend } = h.users;
    expect((await act(h, alice, `/api/v1/accounts/${friend.id}/follow`, { notify: true })).status).toBe(200);
    const before = await post(h, friend, { status: "before" });
    // A mute that keeps notifications still hides the sender's posts from home (FeedInsertWorker notifies only of
    // what home shows): none is written, and the earlier one is hidden while the mute lasts.
    await relate(h, alice, `/api/v1/accounts/${friend.id}/mute`, { notifications: false });
    await post(h, friend, { status: "muted" });
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([]);
    expect(await ids(h, "/api/v1/notifications?types[]=status", alice.token)).toEqual([]);
    expect(await sql(h.store, "SELECT status_id FROM notifications WHERE type = 'status'")).toEqual([
      { status_id: before.id },
    ]);
    // A mention by the same sender is still notified: the mute keeps notifications.
    await post(h, friend, { status: "@alice hi" });
    expect(await ids(h, "/api/v1/notifications?types[]=mention", alice.token)).toHaveLength(1);

    await relate(h, alice, `/api/v1/accounts/${friend.id}/unmute`);
    const shown = await getJson<{ status: { id: string } }[]>(h, "/api/v1/notifications?types[]=status", alice.token);
    expect(shown.body.map((n) => n.status.id)).toEqual([before.id]);
  });

  it("keeps the viewer's own statuses in home, whoever they mention", async () => {
    const h = await community(["alice", "foe"]);
    const { alice, foe } = h.users;
    await relate(h, alice, `/api/v1/accounts/${foe.id}/mute`);
    const own = await post(h, alice, { status: "@foe about you" });
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([own.id]);
    await relate(h, alice, `/api/v1/accounts/${foe.id}/block`);
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([own.id]);
  });
});

describe("domain blocks", () => {
  async function blockDomain(h: ApiHarness, user: User, domain: string) {
    return h.request("/api/v1/domain_blocks", bearer(user.token, json({ domain })));
  }

  it("normalizes the domain, refuses the local domain and invalid names, lists and unblocks", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const created = await blockDomain(h, alice, "Example.COM.");
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({});
    expect((await blockDomain(h, alice, "example.com/")).status).toBe(200);
    expect((await blockDomain(h, alice, "bücher.example")).status).toBe(200);
    for (const [domain, error] of [
      ["kopje.test", "Validation failed: Domain is this server's own domain"],
      ["", "Validation failed: Domain can't be blank"],
      ["not a domain", "Validation failed: Domain is invalid"],
      ["https://other.example", "Validation failed: Domain is invalid"],
    ] as const) {
      const refused = await blockDomain(h, alice, domain);
      expect({ domain, status: refused.status, body: await refused.json() }).toEqual({
        domain,
        status: 422,
        body: { error },
      });
    }
    expect((await getJson(h, "/api/v1/domain_blocks", alice.token)).body).toEqual([
      "xn--bcher-kva.example",
      "example.com",
    ]);
    const page = await h.request("/api/v1/domain_blocks?limit=1", bearer(alice.token));
    expect(await page.json()).toEqual(["xn--bcher-kva.example"]);
    expect(page.headers.get("link")).toMatch(/max_id=\d+>; rel="next"/);

    const removed = await h.request(
      "/api/v1/domain_blocks",
      bearer(alice.token, json({ domain: "EXAMPLE.com" }, { method: "DELETE" })),
    );
    expect(await removed.json()).toEqual({});
    const again = await h.request(
      "/api/v1/domain_blocks?domain=nothing.example",
      bearer(alice.token, { method: "DELETE" }),
    );
    expect(again.status).toBe(200);
    expect((await getJson(h, "/api/v1/domain_blocks", alice.token)).body).toEqual(["xn--bcher-kva.example"]);
  });

  it("ends our follows there with an Undo and theirs with a Reject, and hides the domain", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan", "blocked.example");
    const asker = await remoteAccount(h.store, "asker", "blocked.example");
    const star = await remoteAccount(h.store, "star", "blocked.example");
    const other = await remoteAccount(h.store, "other", "other.example");
    await sql(
      h.store,
      `INSERT INTO follows (account_id, target_account_id, state, uri) VALUES
				(?1, ?4, 'accepted', 'https://blocked.example/f/1'), (?2, ?4, 'pending', 'https://blocked.example/f/2'),
				(?3, ?4, 'accepted', 'https://other.example/f/3'), (?4, ?5, 'accepted', NULL)`,
      fan,
      asker,
      other,
      alice.id,
      star,
    );
    await sql(h.store, "UPDATE accounts SET followers_count = 2, following_count = 1 WHERE id = ?", alice.id);
    const starStatus = await seedStatus(h.store, { accountId: star, visibility: "public", content: "<p>star</p>" });
    expect((await getJson(h, "/api/v1/domain_blocks/preview?domain=Blocked.Example", alice.token)).body).toEqual({
      following_count: 1,
      followers_count: 1,
    });
    expect((await h.request("/api/v1/domain_blocks/preview", bearer(alice.token))).status).toBe(400);

    expect((await blockDomain(h, alice, "blocked.example")).status).toBe(200);
    expect(await follows(h)).toEqual([{ account_id: other, target_account_id: alice.id, state: "accepted" }]);
    expect((await sent(h)).map((o) => [o.activity.type, (o.activity.object as { id: string }).id, o.retracts])).toEqual(
      [
        ["Reject", "https://blocked.example/f/1", 1],
        ["Reject", "https://blocked.example/f/2", 0],
        ["Undo", expect.stringMatching(/^https:\/\/kopje\.test\/ap\/users\/alice#follows\/\d+$/), 1],
      ],
    );
    // Counts lose the accepted edges only.
    expect(await sql(h.store, "SELECT followers_count, following_count FROM accounts WHERE id = ?", alice.id)).toEqual([
      { followers_count: 1, following_count: 0 },
    ]);
    expect(await sql(h.store, "SELECT 1 FROM domain_block_cleanups")).toEqual([]);
    expect(await relationship(h, alice, star)).toMatchObject({ domain_blocking: true, following: false });
    expect(await relationship(h, alice, other)).toMatchObject({ domain_blocking: false });
    expect(await ids(h, "/api/v1/timelines/public", alice.token)).not.toContain(starStatus);
    // Following an account of the domain is refused (FollowService).
    expect((await act(h, alice, `/api/v1/accounts/${fan}/follow`)).status).toBe(403);
  });

  // Remote followers on spam.example, and as many on other.example, in alternating follow ids.
  async function spamFollowers(h: ApiHarness, user: User, each: number) {
    for (const [domain, base] of [
      ["spam.example", "300000000000000000"],
      ["other.example", "400000000000000000"],
    ] as const) {
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
				SELECT printf('%018d', CAST(?2 AS INTEGER) + i), 'https://' || ?3 || '/users/u' || i, 'u' || i, ?3,
					'https://' || ?3 || '/users/u' || i || '/inbox', 'https://' || ?3 || '/inbox' FROM n`,
        each,
        base,
        domain,
      );
    }
    await sql(
      h.store,
      `INSERT INTO follows (account_id, target_account_id, state)
			SELECT id, ?, 'accepted' FROM accounts WHERE domain IN ('spam.example', 'other.example') ORDER BY username, domain`,
      user.id,
    );
  }
  const fromDomain = (domain: string) =>
    `SELECT count(*) AS n FROM follows f JOIN accounts a ON a.id = f.account_id WHERE a.domain = '${domain}'`;

  it("finishes the cleanup in later rounds of the inbound jobs, delivering nothing to the domain meanwhile", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await spamFollowers(h, alice, DOMAIN_BLOCK_WINDOW * DOMAIN_BLOCK_BATCHES_PER_RUN);

    expect((await blockDomain(h, alice, "spam.example")).status).toBe(200);
    // The request did one batch: a window of follows, half of them on the domain.
    expect(await sql(h.store, fromDomain("spam.example"))).toEqual([
      { n: DOMAIN_BLOCK_WINDOW * DOMAIN_BLOCK_BATCHES_PER_RUN - DOMAIN_BLOCK_WINDOW / 2 },
    ]);
    await post(h, alice, { status: "not for spam" });
    const creates = await sql<{ inbox_url: string }>(
      h.store,
      `SELECT d.inbox_url FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
			WHERE json_extract(o.body, '$.activity.type') = 'Create'`,
    );
    expect(creates).toEqual([{ inbox_url: "https://other.example/inbox" }]);

    // The cron and the Queue run rounds until it is done; no second request.
    let rounds = 0;
    for (let pending = true; pending; rounds++) {
      pending = (await runStoreJobs(h.store, BUILD, { now: NOW })).pending;
    }
    expect(rounds).toBeGreaterThan(1);
    expect(await sql(h.store, fromDomain("spam.example"))).toEqual([{ n: 0 }]);
    expect(await sql(h.store, fromDomain("other.example"))).toEqual([
      { n: DOMAIN_BLOCK_WINDOW * DOMAIN_BLOCK_BATCHES_PER_RUN },
    ]);
    expect(await sql(h.store, "SELECT 1 FROM domain_block_cleanups")).toEqual([]);
  });

  it("records the block and its cleanup when the request’s batch fails, the cleanup backing off (RES-5)", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await spamFollowers(h, alice, DOMAIN_BLOCK_WINDOW);
    // The batch ends the follows of its window, then fails at its last write, the cleanup's cursor.
    await sql(
      h.store,
      "CREATE TRIGGER test_cleanup_fails BEFORE UPDATE OF cursor ON domain_block_cleanups BEGIN SELECT RAISE(ABORT, 'test: the batch fails'); END",
    );
    const undos = () =>
      sql(
        h.store,
        "SELECT 1 FROM outbound_activities WHERE json_extract(body, '$.activity.type') IN ('Undo', 'Reject')",
      );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await blockDomain(h, alice, "spam.example")).status).toBe(200);
      // The batch's writes were rolled back (no follow ended, no Undo or Reject recorded); the block (which hides the
      // domain at once) and its cleanup committed.
      expect(await sql(h.store, fromDomain("spam.example"))).toEqual([{ n: DOMAIN_BLOCK_WINDOW }]);
      expect(await undos()).toEqual([]);
      expect(await sql(h.store, "SELECT domain FROM domain_blocks WHERE account_id = ?", alice.id)).toEqual([
        { domain: "spam.example" },
      ]);
      expect(await sql(h.store, "SELECT cursor, attempts, due_at FROM domain_block_cleanups")).toEqual([
        { cursor: 0, attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]! },
      ]);
      await sql(h.store, "DROP TRIGGER test_cleanup_fails");
      // Not due: a round leaves it, and asks for none; at its due time a round runs it, and it is fresh again.
      expect(await runStoreJobs(h.store, BUILD, { now: NOW })).toMatchObject({ pending: false });
      expect(await sql(h.store, fromDomain("spam.example"))).toEqual([{ n: DOMAIN_BLOCK_WINDOW }]);
      await runStoreJobs(h.store, BUILD, { now: NOW + JOB_RETRY_DELAYS_MS[0]! });
      expect(await sql(h.store, fromDomain("spam.example"))).toEqual([{ n: 0 }]);
      expect(await sql(h.store, "SELECT 1 FROM domain_block_cleanups")).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stops the cleanup when the domain is unblocked, keeping what it removed removed", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await spamFollowers(h, alice, DOMAIN_BLOCK_WINDOW);
    expect((await blockDomain(h, alice, "spam.example")).status).toBe(200);
    expect(await sql(h.store, fromDomain("spam.example"))).toEqual([{ n: DOMAIN_BLOCK_WINDOW / 2 }]);

    await h.request(
      "/api/v1/domain_blocks",
      bearer(alice.token, json({ domain: "spam.example" }, { method: "DELETE" })),
    );
    expect(await sql(h.store, "SELECT 1 FROM domain_block_cleanups")).toEqual([]);
    expect(await runStoreJobs(h.store, BUILD, { now: NOW })).toMatchObject({ pending: false });
    expect(await sql(h.store, fromDomain("spam.example"))).toEqual([{ n: DOMAIN_BLOCK_WINDOW / 2 }]);
  });

  // A SqlStorage that counts the rows each statement reads.
  function countingSql(real: SqlStorage): { sql: SqlStorage; read: () => number } {
    let read = 0;
    const sql = {
      exec: (query: string, ...params: SqlStorageValue[]) => {
        const cursor = real.exec(query, ...params);
        return Object.defineProperty(
          watchedCursor(cursor, () => (read += cursor.rowsRead)),
          "rowsWritten",
          {
            get() {
              const written = cursor.rowsWritten;
              read += cursor.rowsRead;
              return written;
            },
          },
        );
      },
    } as unknown as SqlStorage;
    return { sql, read: () => read };
  }

  // Runs the domain block operation in its own transaction, with the storage's savepoint as the kernel passes it
  // (Db.savepoint), over a SqlStorage that counts the rows each statement reads.
  async function rowsRead(h: ApiHarness, user: User, domain: string): Promise<number> {
    const tokenHash = await sha256Hex(user.token);
    return runInDurableObject(h.store, (_instance, state) => {
      const { sql: counting, read } = countingSql(state.storage.sql);
      const result = state.storage.transactionSync(() =>
        blockDomainOperation.run(
          counting,
          { credential: { tokenHash, scope: "write:blocks", now: NOW }, domain, now: NOW },
          (fn) => state.storage.transactionSync(fn),
        ),
      );
      expect(result.status).toBe("ok");
      return read();
    });
  }

  it("picks the next cleanup through an index, however many are pending (RES-6, RES-7)", async () => {
    const reads: number[] = [];
    for (const jobs of [20, 200]) {
      const h = await community(["alice"]);
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
				INSERT INTO domain_blocks (account_id, domain) SELECT ?1, 'd' || i || '.example' FROM n`,
        h.users.alice.id,
        jobs,
      );
      await sql(
        h.store,
        "INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at) SELECT id, 1, id FROM domain_blocks",
      );
      reads.push(
        await runInDurableObject(h.store, (_instance, state) => {
          const { sql: counting, read } = countingSql(state.storage.sql);
          const round = state.storage.transactionSync(() =>
            runDomainBlockCleanups.run(counting, { now: NOW }, (fn) => state.storage.transactionSync(fn)),
          );
          expect(round).toEqual({ pending: true, delivers: false });
          return read();
        }),
      );
    }
    expect(reads[1]).toBe(reads[0]);
  });

  it("matches domain blocks through their index, however many other domains the viewer blocks (RES-7)", async () => {
    const reads: number[] = [];
    for (const blocked of [20, 2000]) {
      const h = await community(["alice"]);
      const author = await remoteAccount(h.store, "author", "open.example");
      const hidden = await remoteAccount(h.store, "hidden", "d1.example");
      for (const accountId of [author, author, hidden]) {
        await seedStatus(h.store, { accountId, visibility: "public" });
      }
      await sql(
        h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
				INSERT INTO domain_blocks (account_id, domain) SELECT ?1, 'd' || i || '.example' FROM n`,
        h.users.alice.id,
        blocked,
      );
      const tokenHash = await sha256Hex(h.users.alice.token);
      reads.push(
        await runInDurableObject(h.store, (_instance, state) => {
          const { sql: counting, read } = countingSql(state.storage.sql);
          const result = publicTimeline.run(counting, {
            credential: { tokenHash, scope: "read:statuses", now: NOW },
            page: { limit: 20 },
            local: false,
            remote: false,
            onlyMedia: false,
            now: NOW,
            present: { origin: "https://kopje.test" },
          });
          // The status on the blocked domain is left out, the others are listed.
          expect(result.status === "ok" && result.value.items.map((status) => status.account.id)).toEqual([
            author,
            author,
          ]);
          return read();
        }),
      );
    }
    expect(reads[1]).toBe(reads[0]);
  });

  it("reads a bounded number of rows to block a domain, however many follows do not match (RES-6, RES-7)", async () => {
    const reads: number[] = [];
    for (const each of [DOMAIN_BLOCK_WINDOW, DOMAIN_BLOCK_WINDOW * 4]) {
      const h = await community(["alice"]);
      await spamFollowers(h, h.users.alice, each);
      reads.push(await rowsRead(h, h.users.alice, "nowhere.example"));
    }
    expect(reads[1]).toBe(reads[0]);
    expect(reads[0]).toBeLessThan(DOMAIN_BLOCK_WINDOW * 4);
  });
});
