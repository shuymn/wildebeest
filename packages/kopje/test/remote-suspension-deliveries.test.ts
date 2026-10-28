import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { enqueueActivity } from "../src/domain/deliveries";
import { deliveryRound } from "../src/jobs/deliver";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, settle, sql, userToken } from "./api-helpers";
import { NOW } from "./app-helpers";
import { LEGACY, signAsLegacy } from "./federation-helpers";
import { BUILD, claimAndSettle } from "./helpers";
import { newClient, VAPID } from "./push-helpers";
import { deferred, deliveryDeps, gatedHost, recordingFetch } from "./quote-helpers";
import { act, receive, unsuspend, uriOf, world, type World } from "./remote-suspension-helpers";
import { follow, post, remoteAccount, remoteFollows, seedStatus } from "./status-helpers";

// VIS-30's send-time check for an account the instance suspended (R38): content to it is dropped at the claim or at
// confirmation through the delivery's provenance, a retraction still goes in its lane's order, an operator's retry is
// checked again, and pushes from it are dropped. The check is stricter than Mastodon's DeliveryWorker, which has none.

type Row = { id: string; inbox: string; type: string; state: string };

const deliveries = (store: StoreStub) =>
  sql<Row>(
    store,
    `SELECT CAST(d.id AS TEXT) AS id, d.inbox_url AS inbox, json_extract(o.body, '$.activity.type') AS type, d.state
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
  );

type SentBody = { type: string; actor: string; object: { id?: string } };

// Claims until nothing is due; each row sent, in order: its body and inbox.
async function drainSent(store: StoreStub): Promise<{ body: SentBody; inbox: string }[]> {
  const sent: { body: SentBody; inbox: string }[] = [];
  for (let round = 0; round < 1_000; round++) {
    const { claim, sent: rows } = await claimAndSettle(store, {
      now: NOW,
      leaseToken: `drain-${round}`,
      outcome: { kind: "delivered", status: 202 },
    });
    sent.push(...rows.map(({ inbox, body }) => ({ body: JSON.parse(body) as SentBody, inbox })));
    if (claim.deliveries.length === 0 && claim.nextDueAt === null) {
      return sent;
    }
  }
  throw new Error("the deliveries did not drain");
}

// The activity type, signer and inbox of each row sent, in order.
async function drain(store: StoreStub): Promise<[string, string, string][]> {
  return (await drainSent(store)).map(({ body, inbox }) => [body.type, body.actor, inbox]);
}

const suspend = async (w: World, id: string) =>
  expect(await act(w, id, { type: "suspend" })).toMatchObject({ status: 200 });

describe("content to a suspended account is dropped", () => {
  it("drops a follower Create at its shared inbox, a private Create at a gateway inbox and a Like", async () => {
    const w = await world();
    const { alice } = w;
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    await remoteFollows(w.h.store, r, alice.id);
    // g lives on far.example behind a gateway's inboxes.
    const g = await remoteAccount(w.h.store, "g", "far.example");
    await sql(
      w.h.store,
      "UPDATE accounts SET inbox_url = 'https://gateway.example/users/g', shared_inbox_url = 'https://gateway.example/inbox' WHERE id = ?",
      g,
    );
    const status = await seedStatus(w.h.store, {
      accountId: r,
      visibility: "public",
      uri: "https://remote.example/statuses/1",
    });
    await post(w.h, alice, { status: "to followers" });
    await post(w.h, alice, { status: "@g@far.example a secret", visibility: "direct" });
    const favourited = await w.h.request(
      `/api/v1/statuses/${status}/favourite`,
      bearer(alice.token, { method: "POST" }),
    );
    expect(favourited.status).toBe(200);
    expect((await deliveries(w.h.store)).map((row) => [row.type, row.inbox])).toEqual([
      ["Create", "https://remote.example/inbox"],
      ["Create", "https://gateway.example/inbox"],
      ["Like", "https://remote.example/inbox"],
    ]);
    await suspend(w, r);
    await suspend(w, g);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await deliveries(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT * FROM outbound_receipts")).toEqual([]);
  });

  it("sends to a shared inbox that also serves an available recipient", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    const s = await remoteAccount(w.h.store, "s", "remote.example");
    await remoteFollows(w.h.store, r, w.alice.id);
    await remoteFollows(w.h.store, s, w.alice.id);
    await suspend(w, r);
    await settle(w.h.store);
    // Content leaves r out of its audience; s is still behind the shared inbox.
    await post(w.h, w.alice, { status: "to followers" });
    expect((await drain(w.h.store)).filter(([type]) => type === "Create")).toEqual([
      ["Create", await uriOf(w.h.store, w.alice.id), "https://remote.example/inbox"],
    ]);
  });

  it("sends a row without provenance (queued before migration 0044) by the inbox host rule alone", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    await remoteFollows(w.h.store, r, w.alice.id);
    await post(w.h, w.alice, { status: "queued long ago" });
    await sql(w.h.store, "UPDATE deliveries SET recipient_accounts = NULL, recipient_domains = NULL");
    await suspend(w, r);
    expect((await drain(w.h.store)).map(([type, , inbox]) => [type, inbox])).toEqual([
      ["Create", "https://remote.example/inbox"],
    ]);
  });
});

describe("a local follow of a suspended account", () => {
  it("drops the queued Follow, keeps the request pending, and ignores its Accept", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    await follow(w.h, w.alice, r);
    const [queued] = await sql<{ body: string }>(
      w.h.store,
      "SELECT body FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Follow'",
    );
    const followActivity = (JSON.parse(queued!.body) as { activity: { id: string; actor: string; object: string } })
      .activity;
    await suspend(w, r);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT state FROM follows WHERE target_account_id = ?", r)).toEqual([
      { state: "pending" },
    ]);
    expect(
      await receive(w.h.store, await uriOf(w.h.store, r), {
        type: "Accept",
        object: { id: followActivity.id, type: "Follow", actor: followActivity.actor, object: followActivity.object },
      }),
    ).toMatchObject({ applied: false, reason: "actor-suspended" });
    expect(await sql(w.h.store, "SELECT state FROM follows WHERE target_account_id = ?", r)).toEqual([
      { state: "pending" },
    ]);
    // A follow made after the suspension is not found (R21).
    const again = await w.h.request(`/api/v1/accounts/${r}/follow`, bearer(w.bob.token, json({})));
    expect(again.status).toBe(404);
  });
});

describe("lane order with the withdrawing Rejects", () => {
  it("sends only the Undo and the withdrawing Reject, in lane order; content and a request’s Reject are dropped", async () => {
    const w = await world();
    const { alice, bob } = w;
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    const uri = await uriOf(w.h.store, r);
    // r follows alice (her Accept is queued), alice posts, boosts r's status and undoes the boost.
    expect(await receive(w.h.store, uri, { type: "Follow", object: await uriOf(w.h.store, alice.id) })).toMatchObject({
      applied: true,
    });
    const status = await seedStatus(w.h.store, {
      accountId: r,
      visibility: "public",
      uri: "https://remote.example/statuses/1",
    });
    await post(w.h, alice, { status: "hello" });
    expect(
      (await w.h.request(`/api/v1/statuses/${status}/reblog`, bearer(alice.token, { method: "POST" }))).status,
    ).toBe(200);
    expect(
      (await w.h.request(`/api/v1/statuses/${status}/unreblog`, bearer(alice.token, { method: "POST" }))).status,
    ).toBe(200);
    // r asks locked bob, who rejects the request: a Reject that withdraws nothing.
    await sql(w.h.store, "UPDATE accounts SET locked = 1 WHERE id = ?", bob.id);
    expect(await receive(w.h.store, uri, { type: "Follow", object: await uriOf(w.h.store, bob.id) })).toMatchObject({
      applied: true,
    });
    expect(
      (await w.h.request(`/api/v1/follow_requests/${r}/reject`, bearer(bob.token, { method: "POST" }))).status,
    ).toBe(200);
    await suspend(w, r);
    await settle(w.h.store);
    const sent = await drain(w.h.store);
    const aliceUri = await uriOf(w.h.store, alice.id);
    expect(sent.map(([type, actor]) => [type, actor])).toEqual([
      ["Undo", aliceUri],
      ["Reject", aliceUri],
    ]);
    expect(await sql(w.h.store, "SELECT * FROM deliveries")).toEqual([]);
  });
});

describe("a re-formed follow after the severing", () => {
  it("sends only the new follow's Accept: the first follow's Accept and Reject, never claimed, are cancelled", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    const uri = await uriOf(w.h.store, r);
    const alice = await uriOf(w.h.store, w.alice.id);
    expect(await receive(w.h.store, uri, { type: "Follow", object: alice })).toMatchObject({ applied: true });
    await suspend(w, r);
    await settle(w.h.store);
    expect(await unsuspend(w, r)).toMatchObject({ status: 200 });
    // The lane holds the first follow's Accept, queued before the suspension, and the Reject that withdraws it.
    expect((await deliveries(w.h.store)).map((d) => d.type)).toEqual(["Accept", "Reject"]);
    // r follows alice again: both are stale, and only the new follow's Accept goes.
    const renewal = "https://remote.example/follows/renewed";
    expect(await receive(w.h.store, uri, { id: renewal, type: "Follow", object: alice })).toMatchObject({
      applied: true,
    });
    await settle(w.h.store);
    const sent = await drainSent(w.h.store);
    expect(sent.map(({ body }) => [body.type, body.actor, body.object.id])).toEqual([["Accept", alice, renewal]]);
  });
});

describe("the send boundary is confirmation", () => {
  const testEnv = { ...env, USER_KEK: LEGACY.kek } as unknown as Env;

  // A delivery round over `store` held at its host check, after the claim and before confirmation: `reached` resolves
  // when it gets there, and `release` lets it go on.
  function heldAtHostCheck(store: StoreStub, fetch: typeof globalThis.fetch) {
    const { checkHost, reached, release } = gatedHost();
    const round = deliveryRound(testEnv, {
      ...deliveryDeps(
        () => store,
        fetch,
        () => NOW,
      ),
      checkHost,
    });
    return { reached, release, round };
  }

  // alice signs with the legacy fixture key, so the round can load her signer; r follows her.
  async function signed() {
    const w = await world();
    await signAsLegacy(w.h.store, w.alice.id);
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    await remoteFollows(w.h.store, r, w.alice.id);
    return { w, r };
  }

  it("sends nothing when the suspension commits between the signer load and confirmation, and promotes the lane", async () => {
    const { w, r } = await signed();
    await post(w.h, w.alice, { status: "first" });
    await post(w.h, w.alice, { status: "second" });
    const { fetch, sent } = recordingFetch();
    const { reached, release, round } = heldAtHostCheck(w.h.store, fetch);
    await reached;
    expect((await deliveries(w.h.store)).map((row) => row.state)).toEqual(["leased", "queued"]);
    await suspend(w, r);
    release();
    expect(await round).toEqual({ claimed: 1, settled: ["dropped"], nextDueAt: NOW });
    expect(sent).toEqual([]);
    expect((await deliveries(w.h.store)).map((row) => row.state)).toEqual(["pending"]);
  });

  it.each([
    ["its author is suspended", true, false],
    ["its author is suspended, then deletes it", true, true],
    ["its author deletes it", false, true],
  ])(
    "drops a queued boost when %s between the claim and confirmation; its Undo goes",
    async (_, suspended, deleted) => {
      const { w } = await signed();
      // r follows alice (signed); s, on another server, does too. The original's author is o, whom alice boosts.
      const s2 = await remoteAccount(w.h.store, "s", "other.example");
      await remoteFollows(w.h.store, s2, w.alice.id);
      const o = await remoteAccount(w.h.store, "o", "origin.example");
      const original = await seedStatus(w.h.store, {
        accountId: o,
        visibility: "public",
        uri: "https://origin.example/statuses/1",
      });
      const boosted = await w.h.request(
        `/api/v1/statuses/${original}/reblog`,
        bearer(w.alice.token, { method: "POST" }),
      );
      expect(boosted.status).toBe(200);
      expect(new Set((await deliveries(w.h.store)).map((row) => row.type))).toEqual(new Set(["Announce"]));
      const { fetch, sent } = recordingFetch();
      const { reached, release, round } = heldAtHostCheck(w.h.store, fetch);
      await reached;
      if (suspended) {
        await suspend(w, o);
      }
      if (deleted) {
        // The author's Delete applies (also while it is suspended): the original is gone before confirmation.
        expect(
          await receive(w.h.store, await uriOf(w.h.store, o), {
            type: "Delete",
            object: "https://origin.example/statuses/1",
          }),
        ).toMatchObject({ applied: true });
      }
      release();
      const settled = await round;
      expect(settled.settled.length).toBeGreaterThan(0);
      expect(settled.settled.every((outcome) => outcome === "dropped")).toBe(true);
      expect(sent).toEqual([]);
      // o deletes the original (a suspended actor's Delete applies): the local boost is withdrawn with an Undo, a
      // retraction, which still goes.
      expect(
        await receive(w.h.store, await uriOf(w.h.store, o), {
          type: "Delete",
          object: "https://origin.example/statuses/1",
        }),
      ).toMatchObject({ applied: true });
      await settle(w.h.store);
      const bodies: string[] = [];
      const recording = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push((JSON.parse(await new Request(input, init).text()) as { type: string }).type);
        return new Response(null, { status: 202 });
      }) as unknown as typeof globalThis.fetch;
      for (let i = 0; i < 5; i++) {
        await deliveryRound(
          testEnv,
          deliveryDeps(
            () => w.h.store,
            recording,
            () => NOW,
            `undo-${i}`,
          ),
        );
      }
      expect(bodies.length).toBeGreaterThan(0);
      expect(new Set(bodies)).toEqual(new Set(["Undo"]));
    },
  );

  it("sends a row confirmed before the suspension commits", async () => {
    const { w, r } = await signed();
    await post(w.h, w.alice, { status: "confirmed" });
    const { fetch, sent } = recordingFetch();
    const reached = deferred();
    const release = deferred();
    const store = new Proxy(w.h.store, {
      get: (target, name) =>
        name === "confirmDelivery"
          ? async (...args: Parameters<StoreStub["confirmDelivery"]>) => {
              const confirmation = await target.confirmDelivery(...args);
              reached.resolve();
              await release.promise;
              return confirmation;
            }
          : (Reflect.get(target, name) as unknown),
    });
    const round = deliveryRound(
      testEnv,
      deliveryDeps(
        () => store,
        fetch,
        () => NOW,
      ),
    );
    await reached.promise;
    await suspend(w, r);
    release.resolve();
    expect(await round).toMatchObject({ claimed: 1, settled: ["delivered"] });
    expect(sent).toEqual(["https://remote.example/inbox"]);
  });
});

describe("an operator's retry and a long lane", () => {
  it("drops a given-up Create that the operator retries after the suspension, at its claim", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    await remoteFollows(w.h.store, r, w.alice.id);
    await post(w.h, w.alice, { status: "given up" });
    const claimed = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "one" });
    const id = claimed.deliveries[0]!.id;
    await w.h.store.confirmDelivery(BUILD, { id, leaseToken: "one", now: NOW });
    expect(
      await w.h.store.completeDelivery(BUILD, {
        id,
        leaseToken: "one",
        now: NOW,
        outcome: { kind: "failed", status: 400, error: "refused", permanent: true },
      }),
    ).toMatchObject({ status: "gave_up" });
    await suspend(w, r);
    expect(await w.h.store.retryDeliveries(BUILD, { ids: [id], now: NOW })).toMatchObject({ retried: 1 });
    expect(await drain(w.h.store)).toEqual([]);
    expect(await deliveries(w.h.store)).toEqual([]);
  });

  it("drains a lane of 500 rows to the suspended account, each claim deleting at least one", async () => {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    await remoteFollows(w.h.store, r, w.alice.id);
    const aliceUri = await uriOf(w.h.store, w.alice.id);
    await runInDurableObject(w.h.store, (_instance, state) =>
      state.storage.transactionSync(() => {
        const db = new Db(state.storage.sql);
        for (let i = 0; i < 500; i++) {
          enqueueActivity(
            db,
            w.alice.id,
            {
              activity: {
                id: `${aliceUri}#likes/${i}`,
                type: "Like",
                actor: aliceUri,
                object: `https://remote.example/statuses/${i}`,
              },
              audience: { followers: false, accounts: [r] },
            },
            NOW,
          );
        }
      }),
    );
    expect(await sql(w.h.store, "SELECT count(*) AS n FROM deliveries")).toEqual([{ n: 500 }]);
    await suspend(w, r);
    let left = 500;
    for (let round = 0; left > 0; round++) {
      expect(round).toBeLessThan(500);
      const claimed = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: `lane-${round}` });
      expect(claimed.deliveries).toEqual([]);
      const [{ n }] = (await sql<{ n: number }>(w.h.store, "SELECT count(*) AS n FROM deliveries")) as [{ n: number }];
      expect(n).toBeLessThan(left);
      left = n;
    }
  });
});

describe("pushes from a suspended account", () => {
  it("drops a push claimed before the suspension at its confirmation; the notification is listed after it", async () => {
    const w = await world({ VAPID_JWK: VAPID.env });
    const r = await remoteAccount(w.h.store, "r", "remote.example");
    const pushing = await userToken(w.h, "alice@example.com", "read write push");
    const client = await newClient();
    const subscribed = await w.h.request(
      "/api/v1/push/subscription",
      bearer(
        pushing,
        json({
          subscription: { endpoint: "https://push.example/x", keys: { p256dh: client.p256dh, auth: client.auth } },
          data: { alerts: { mention: true }, policy: "all" },
        }),
      ),
    );
    expect(subscribed.status).toBe(200);
    // r mentions alice (an inbound Create through the Store's inbox).
    const aliceUri = await uriOf(w.h.store, w.alice.id);
    const uri = await uriOf(w.h.store, r);
    expect(
      await receive(w.h.store, uri, {
        type: "Create",
        object: {
          uri: "https://remote.example/statuses/9",
          url: null,
          attributedTo: uri,
          content: "<p>@alice hi</p>",
          text: "@alice hi",
          spoilerText: "",
          sensitive: false,
          language: null,
          published: new Date(NOW).toISOString(),
          updated: null,
          inReplyTo: null,
          // Public, so no notification policy filters it.
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: [aliceUri],
          mentions: [aliceUri],
          tags: [],
          emojiTags: [],
          media: [],
          raw: "{}",
        },
      }),
    ).toMatchObject({ applied: true });
    const notifications = async () =>
      (await (await w.h.request("/api/v1/notifications", bearer(w.alice.token))).json<{ type: string }[]>()).map(
        (n) => n.type,
      );
    expect(await notifications()).toEqual(["mention"]);
    const claimed = await w.h.store.claimPushes(BUILD, { now: NOW, leaseToken: "push" });
    expect(claimed.pushes).toHaveLength(1);
    await suspend(w, r);
    expect(await w.h.store.confirmPush(BUILD, { id: claimed.pushes[0]!.id, leaseToken: "push", now: NOW })).toBeNull();
    expect(await sql(w.h.store, "SELECT * FROM push_deliveries")).toEqual([]);
    expect(await notifications()).toEqual([]);
    expect(await unsuspend(w, r)).toMatchObject({ status: 200 });
    expect(await notifications()).toEqual(["mention"]);
  });
});
