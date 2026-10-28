import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { classifyRequest, decide, type RequestClass } from "../src/app/gate";
import { processInbox } from "../src/federation/inbox";
import { type SpoolMessage, spoolInbox } from "../src/federation/spool";
import { handleQueue, SPOOL_REQUEUE_DELAY_SECONDS } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { countingStore, harness, heldStore, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, migratedStore, rejectionOf } from "./helpers";
import { mastodonActor, RemoteWeb, signedInit } from "./inbox-helpers";
import { MAX_RETRIES, QueueSim } from "./queue-sim";
import { storeWith } from "./setup-helpers";

describe("request classification", () => {
  it.each<[string, string, RequestClass]>([
    ["GET", "/ap/users/alice", "always"],
    ["GET", "/actor", "always"],
    ["GET", "/.well-known/webfinger", "always"],
    ["GET", "/.well-known/nodeinfo", "always"],
    ["GET", "/nodeinfo/2.0", "always"],
    ["GET", "/health", "always"],
    ["GET", "/ap/users/alice/outbox", "read"],
    ["GET", "/actor/outbox", "read"],
    ["GET", "/ap/o/123", "read"],
    ["GET", "/api/v1/timelines/home", "read"],
    ["GET", "/@alice", "read"],
    ["GET", "/oauth/authorize", "read"],
    ["OPTIONS", "/ap/users/alice", "read"],
    ["POST", "/oauth/token", "session"],
    ["POST", "/oauth/revoke", "session"],
    ["GET", "/oauth/token/info", "read"],
    ["POST", "/oauth/introspect", "session"],
    ["POST", "/oauth/authorize", "session"],
    ["POST", "/api/v1/apps", "session"],
    ["GET", "/api/v1/apps/verify_credentials", "read"],
    ["POST", "/api/v1/accounts/1/follow", "write"],
    ["POST", "/api/v1/push/subscription", "session"],
    ["PUT", "/api/v1/push/subscription", "session"],
    ["DELETE", "/api/v1/push/subscription", "write"],
    ["POST", "/api/v1/statuses", "write"],
    ["POST", "/ap/users/alice/outbox", "write"],
    ["POST", "/inbox", "inbox"],
    ["POST", "/ap/users/alice/inbox", "inbox"],
    ["POST", "/actor/inbox", "inbox"],
  ])("%s %s is %s", (method, path, expected) => {
    expect(classifyRequest(method, path)).toBe(expected);
  });

  it("follows the design table for every mode", () => {
    const table = Object.fromEntries(
      (["always", "read", "session", "write", "inbox"] as const).map((c) => [
        c,
        [decide(c, "off"), decide(c, "readonly"), decide(c, "full")],
      ]),
    );
    expect(table).toEqual({
      always: ["serve", "serve", "serve"],
      read: ["serve", "serve", "unavailable"],
      session: ["serve", "serve", "unavailable"],
      write: ["serve", "unavailable", "unavailable"],
      inbox: ["serve", "spool", "spool"],
    });
  });
});

const AP = { "content-type": "application/activity+json" };

// A Follow signed by a remote actor whose documents the returned federation deps serve.
async function remoteFollow() {
  const web = new RemoteWeb();
  const bob = await mastodonActor(web, "bob");
  const follow = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${bob.uri}#f`,
    type: "Follow",
    actor: bob.uri,
    object: "https://kopje.test/ap/users/alice",
  };
  return { init: await signedInit(bob, "/inbox", follow), federation: { keygen: fixtureKeyGen, loader: web.loader } };
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(stream).text();
}

describe("maintenance gate", () => {
  // Probe routes stand in for handlers that do not exist yet, so "let through" means the handler ran.
  async function probed(mode: string) {
    const h = harness(await migratedStore(), { MAINTENANCE: mode });
    for (const path of ["/api/v1/probe", "/oauth/probe"]) {
      h.app.all(path, (c) => c.text("reached"));
    }
    return h;
  }

  it("answers writes with a Mastodon 503 in readonly but lets reads and sessions through", async () => {
    const { request } = await probed("readonly");

    const write = await request("/api/v1/probe", { method: "POST" });
    expect(write.status).toBe(503);
    expect(await write.json()).toEqual({ error: expect.stringContaining("maintenance") });
    for (const [path, method] of [
      ["/api/v1/probe", "GET"],
      ["/oauth/probe", "POST"],
    ] as const) {
      const response = await request(path, { method });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe("reached");
    }
  });

  it("refuses reads and sessions in full but keeps always-served routes", async () => {
    const { request } = await probed("full");

    expect((await request("/api/v1/probe")).status).toBe(503);
    expect((await request("/oauth/probe", { method: "POST" })).status).toBe(503);
    expect((await request("/health")).status).toBe(200);
  });

  it("spools inbox POSTs when the env is off but the Store is held readonly, after one Store call", async () => {
    const remote = await remoteFollow();
    const { stub, calls } = countingStore(await heldStore());
    const { request, send } = harness(stub, {}, BUILD, remote.federation);

    const response = await request("/inbox", remote.init);
    expect(response.status).toBe(202);
    expect(calls).toEqual(["inboxGate"]);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ kind: "spool", url: "https://kopje.test/inbox" });
  });

  it("hands inbox POSTs to the inbox handler without spooling when nothing is held", async () => {
    const store = await migratedStore();
    const { request, send } = harness(store);
    await completeSetup(store);

    // Processed at once: an unsigned request is refused by the handler (ID-1), not spooled.
    expect((await request("/inbox", { method: "POST", headers: AP, body: "{}" })).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  // ID-5, ID-8: refused before anything is spooled, whatever the maintenance state.
  it.each(["off", "readonly"])(
    "refuses a personal inbox of nobody and a non-ActivityStreams body (MAINTENANCE=%s)",
    async (mode) => {
      const store = await migratedStore();
      await completeSetup(store);
      await seedLocalAccount(store, "kopje.test", {
        id: "111111111111111111",
        username: "Alice",
        key: LEGACY_EMPTY_KEK,
      });
      const { request, send } = harness(store, { MAINTENANCE: mode });

      for (const path of ["/ap/users/bob/inbox", "/ap/users/alice/inbox", "/ap/users/Ali%63e/inbox"]) {
        expect((await request(path, { method: "POST", headers: AP, body: "{}" })).status, path).toBe(404);
      }
      for (const type of ["application/json", "text/plain", "application/ld+json", ""]) {
        const response = await request("/inbox", { method: "POST", headers: { "content-type": type }, body: "{}" });
        expect(response.status, type).toBe(415);
      }
      expect(send).not.toHaveBeenCalled();
      const known = await request("/ap/users/Alice/inbox", { method: "POST", headers: AP, body: "{}" });
      expect(known.status).toBe(mode === "off" ? 401 : 202);
    },
  );

  it("spools inbox POSTs as one deflated v8 message and answers 202", async () => {
    const { request, send } = harness(await migratedStore(), { MAINTENANCE: "readonly" });
    const body = JSON.stringify({ type: "Follow", actor: "https://remote.test/users/a" });

    const response = await request("/inbox", {
      method: "POST",
      headers: { "content-type": "application/activity+json", signature: 'keyId="k"' },
      body,
    });

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    const [message, options] = send.mock.calls[0]! as [SpoolMessage, QueueSendOptions];
    expect(options).toEqual({ contentType: "v8" });
    expect(message).toMatchObject({
      kind: "spool",
      url: "https://kopje.test/inbox",
      method: "POST",
      spooledAt: NOW,
    });
    expect(message.headers).toContainEqual(["signature", 'keyId="k"']);
    expect(await inflate(message.body)).toBe(body);
  });

  it("answers 503 when the deflated request does not fit one message", async () => {
    const { request, send } = harness(await migratedStore(), { MAINTENANCE: "full" });
    // 128 KiB of random bytes does not shrink under deflate.
    const chunk = () => crypto.getRandomValues(new Uint8Array(64 * 1024));
    const body = new Uint8Array([...chunk(), ...chunk()]);

    expect((await request("/inbox", { method: "POST", headers: AP, body })).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  // A 2 MiB body in 64 KiB chunks that records how much was pulled and whether it was cancelled.
  function trackedBody() {
    const chunk = 64 * 1024;
    const tracker = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (tracker.pulled >= 2 * 1024 * 1024) {
            controller.close();
            return;
          }
          tracker.pulled += chunk;
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          tracker.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, tracker };
  }

  it("refuses an inbox body over 1 MiB by Content-Length without reading it", async () => {
    const { request, send } = harness(await migratedStore(), { MAINTENANCE: "readonly" });
    const { stream, tracker } = trackedBody();

    const response = await request("/inbox", {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024) },
      body: stream,
    });
    expect(response.status).toBe(413);
    expect(tracker.pulled).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("stops reading a streamed inbox body as soon as it passes 1 MiB", async () => {
    const { request, send } = harness(await migratedStore(), { MAINTENANCE: "readonly" });
    const { stream, tracker } = trackedBody();

    const response = await request("/inbox", { method: "POST", body: stream });
    expect(response.status).toBe(413);
    expect(tracker.cancelled).toBe(true);
    expect(tracker.pulled).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
    expect(send).not.toHaveBeenCalled();
  });

  it("maps a Store version mismatch to spool for inboxes and 503 for everything else", async () => {
    const { request, send } = harness(await migratedStore(), {}, "0.0.0-other");

    expect((await request("/inbox", { method: "POST", headers: AP, body: "{}" })).status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    const webfinger = await request("/.well-known/webfinger?resource=acct:a@kopje.test");
    expect(webfinger.status).toBe(503);
    expect(await webfinger.json()).toEqual({ error: expect.stringContaining("maintenance") });
  });

  it("refuses to send a message over the Queue size limit", async () => {
    const queue = new QueueSim();
    await expect(queue.send({ body: new Uint8Array(130_000) })).rejects.toThrow("message too large");
    await expect(queue.send({ body: new Uint8Array(100_000) })).resolves.toBeUndefined();
  });
});

describe("spool consumer", () => {
  // A signed Follow spooled because the Store, held readonly, refuses the write it needs.
  async function spooled(store: StoreStub, overrides: Record<string, unknown> = {}) {
    const remote = await remoteFollow();
    const h = harness(store, overrides, BUILD, remote.federation);
    const response = await h.request("/inbox", remote.init);
    expect(response.status).toBe(202);
    expect(h.queue.pending).toHaveLength(1);
    const consume = (env = h.env, resolve: () => StoreStub = () => store) =>
      h.queue.deliver((batch) => handleQueue(batch, env, inboxDeps(resolve, remote.federation.loader)));
    return { ...h, consume, original: h.queue.pending[0]!.body as SpoolMessage };
  }

  it("never exhausts retries while the Store stays held, however long", async () => {
    const { queue, consume, original } = await spooled(await heldStore());

    // One cycle more than the retry budget; each replay is held by the gate's write refusal before it is verified.
    for (let cycle = 0; cycle <= MAX_RETRIES; cycle++) {
      await consume();
    }

    expect(queue.retries).toBe(0);
    expect(queue.dropped).toEqual([]);
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]).toMatchObject({ attempts: 1, delaySeconds: SPOOL_REQUEUE_DELAY_SECONDS });
    expect(queue.pending[0]!.body).toEqual(original);
    expect(original.spooledAt).toBe(NOW);
  }, 30_000);

  it("requeues while the env is in maintenance and replays once it is off", async () => {
    const store = await heldStore();
    const { queue, consume, env } = await spooled(store, { MAINTENANCE: "readonly" });
    for (let cycle = 0; cycle < 3; cycle++) {
      await consume();
    }
    expect(queue.pending).toHaveLength(1);

    // Maintenance is over: the env is off and the Store serves writes again.
    const healthy = await migratedStore();
    await completeSetup(healthy);
    await consume({ ...env, MAINTENANCE: "off" } as Env, () => healthy);
    // The spooled request is gone; the Follow stored its actor, whose collections the batch's one jobs round read, so
    // no sync and no jobs message is left.
    expect(queue.pending.map((m) => m.body)).toEqual([]);
    const left = await runInDurableObject(healthy, (_instance, state) => ({
      actors: state.storage.sql.exec("SELECT 1 FROM accounts WHERE domain IS NOT NULL").toArray().length,
      syncs: state.storage.sql.exec("SELECT 1 FROM collection_syncs").toArray().length,
    }));
    expect(left).toEqual({ actors: 1, syncs: 0 });
    expect(queue.retries).toBe(0);
  });

  it("retries, and so counts against max_retries, only on real processing errors", async () => {
    const { queue, consume, env } = await spooled(await heldStore());
    const broken = {
      handedOff: () => Promise.resolve(false),
      inboxGate: () => Promise.reject(new Error("boom")),
      version: () => Promise.resolve({ build: BUILD }),
    } as unknown as StoreStub;

    await consume(env, () => broken);
    expect(queue.retries).toBe(1);
    expect(queue.pending).toHaveLength(1);
  });
});

// processInbox's gate (federation/inbox.ts): the order of its answers, live and on replay, and the Store failures it
// meets.
describe("inbox gate", () => {
  const ALICE = { id: "111111111111111111", username: "alice", key: LEGACY_EMPTY_KEK };
  const INBOXES = { shared: "/inbox", known: "/ap/users/alice/inbox", unknown: "/ap/users/nobody/inbox" } as const;
  type Inbox = keyof typeof INBOXES;
  const unsigned = { method: "POST", headers: AP, body: "{}" };

  // A Store with alice, held readonly (an upgrade hold) or not, with the domain set or not.
  type StoreState = { readonly: boolean; domain: boolean };
  async function storeIn({ readonly, domain }: StoreState): Promise<StoreStub> {
    const store = await migratedStore();
    await runInDurableObject(store, (_instance, state) => {
      if (domain) {
        state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')");
      }
      if (readonly) {
        const hold = { reason: "upgrade-failed", build: BUILD, detail: "test", at: NOW };
        state.storage.sql.exec("INSERT INTO kopje_state (name, value) VALUES ('hold', ?)", JSON.stringify(hold));
      }
    });
    await seedLocalAccount(store, "kopje.test", ALICE);
    return store;
  }

  // A request to `path` spooled by hand, as an env in maintenance would have spooled it, then replayed over `store`.
  async function replayed(store: StoreStub, path: string) {
    const h = harness(store);
    const body = new TextEncoder().encode("{}");
    expect(
      (await spoolInbox(new Request(`https://kopje.test${path}`, unsigned), body, h.queue.queue, NOW)).status,
    ).toBe(202);
    const { stub, calls } = countingStore(store);
    await h.queue.deliver((batch) =>
      handleQueue(
        batch,
        h.env,
        inboxDeps(() => stub),
      ),
    );
    return { queue: h.queue, calls };
  }

  function requeued(queue: QueueSim): void {
    expect(queue.retries).toBe(0);
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]).toMatchObject({ delaySeconds: SPOOL_REQUEUE_DELAY_SECONDS });
    expect(queue.pending[0]!.body).toMatchObject({ kind: "spool" });
  }

  const STATES = [
    ["readonly without a domain", { readonly: true, domain: false }],
    ["writable without a domain", { readonly: false, domain: false }],
    ["readonly with a domain", { readonly: true, domain: true }],
  ] as const;
  const CASES = STATES.flatMap(([name, state]) =>
    (Object.keys(INBOXES) as Inbox[]).map((inbox): [string, Inbox, StoreState] => [name, inbox, state]),
  );

  // Live: an unknown inbox (404, ID-5), then setup (503), then the write refusal (spooled, OPS-1).
  it.each(CASES)("answers live, %s, the %s inbox in the order 404, setup, spool", async (_name, inbox, state) => {
    const { stub, calls } = countingStore(await storeIn(state));
    const { request, send } = harness(stub);
    const response = await request(INBOXES[inbox], unsigned);
    expect(calls).toEqual(["inboxGate"]);
    if (inbox === "unknown") {
      expect(response.status).toBe(404);
      expect(send).not.toHaveBeenCalled();
    } else if (!state.domain) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "This server has not been set up yet" });
      expect(send).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(202);
      expect(send).toHaveBeenCalledOnce();
    }
  });

  // Replay: held (requeued, no retry spent) while writes are refused or the domain is unset, whatever the inbox.
  it.each(CASES)("requeues a replay, %s, to the %s inbox without spending a retry", async (_name, inbox, state) => {
    const { queue, calls } = await replayed(await storeIn(state), INBOXES[inbox]);
    expect(calls).toEqual(["handedOff", "inboxGate"]);
    requeued(queue);
  });

  it("drops a replay to an unknown inbox once the Store serves writes and has its domain", async () => {
    const { queue, calls } = await replayed(await storeIn({ readonly: false, domain: true }), INBOXES.unknown);
    expect(calls).toEqual(["handedOff", "inboxGate"]);
    expect(queue.pending).toEqual([]);
    expect(queue.retries).toBe(0);
  });

  // What the runtime answers for a method the Store's class does not have, as a Store of an older build lacks
  // inboxGate.
  async function missingMethod(store: StoreStub, args: unknown[]): Promise<unknown> {
    return (store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).inboxGateOfNoBuild!(...args);
  }

  it("pins the runtime’s refusal of a method the Store does not implement", async () => {
    const store = await storeIn({ readonly: false, domain: true });
    const error = await rejectionOf(missingMethod(store, [BUILD]));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("does not implement");
  });

  // Durable Object code rolls out eventually consistently: a new Worker can meet a Store of the previous build.
  function olderBuild(store: StoreStub): StoreStub {
    return storeWith(store, {
      inboxGate: (...args) => missingMethod(store, args),
      version: () => Promise.resolve({ build: "older-build", expected: null, applied: null, version: "0.0.0" }),
    });
  }

  it("spools a live POST to a Store of an older build without inboxGate", async () => {
    const { stub, calls } = countingStore(olderBuild(await storeIn({ readonly: false, domain: true })));
    const { request, send } = harness(stub);
    expect((await request("/inbox", unsigned)).status).toBe(202);
    expect(calls).toEqual(["inboxGate", "version"]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("requeues a replay to a Store of an older build without spending a retry", async () => {
    const { queue } = await replayed(olderBuild(await storeIn({ readonly: false, domain: true })), INBOXES.shared);
    requeued(queue);
  });

  it("lets a failure of a method this very build lacks propagate: a 500, nothing spooled", async () => {
    const store = await storeIn({ readonly: false, domain: true });
    const { stub, calls } = countingStore(storeWith(store, { inboxGate: (...args) => missingMethod(store, args) }));
    const { request, send } = harness(stub);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await request("/inbox", unsigned);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: "kopje.error", status: 500 }));
    errors.mockRestore();
    expect(response.status).toBe(500);
    // version answered this build: the original error stands.
    expect(calls).toEqual(["inboxGate", "version"]);
    expect(send).not.toHaveBeenCalled();
  });

  // processInbox itself, over a Store whose inboxGate fails with `original` (unclassified) and whose version answers
  // as given: the error it rejects with, as the endpoint and replay receive it.
  async function gateFailure(version: () => Promise<unknown>) {
    const original = new TypeError('The RPC receiver does not implement "inboxGate".');
    const store = await storeIn({ readonly: false, domain: true });
    const stub = storeWith(store, { inboxGate: () => Promise.reject(original), version });
    const h = harness(stub);
    const rejected = await rejectionOf(
      processInbox(
        h.env,
        inboxDeps(() => stub),
        {
          url: "https://kopje.test/inbox",
          method: "POST",
          headers: Object.entries(AP),
          body: new TextEncoder().encode("{}"),
          receivedAt: NOW,
        },
        "live",
      ),
    );
    return { original, rejected, store, stub };
  }

  it("rethrows the very error inboxGate failed with when the Store answers this build", async () => {
    const { original, rejected } = await gateFailure(() => Promise.resolve({ build: BUILD }));
    expect(rejected).toBe(original);
  });

  it("rethrows the original error, unspooled, when version also fails unclassified", async () => {
    const versionError = new Error("version broke");
    const { original, rejected, stub } = await gateFailure(() => Promise.reject(versionError));
    expect(rejected).toBe(original);

    const { request, send } = harness(stub);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await request("/inbox", unsigned)).status).toBe(500);
    errors.mockRestore();
    expect(send).not.toHaveBeenCalled();
    // On replay: a real processing error, which spends a retry.
    const { queue } = await replayed(stub, INBOXES.shared);
    expect(queue.retries).toBe(1);
    expect(queue.pending).toHaveLength(1);
  });

  it("holds the request when version fails as maintenance: spooled live, requeued on replay", async () => {
    const transient = Object.assign(new Error("Durable Object reset"), { retryable: true });
    const { rejected, stub } = await gateFailure(() => Promise.reject(transient));
    expect(rejected).toBeInstanceOf(StoreUnavailableError);
    expect((rejected as StoreUnavailableError).reason).toBe("transient");

    const { request, send } = harness(stub);
    expect((await request("/inbox", unsigned)).status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    const { queue } = await replayed(stub, INBOXES.shared);
    requeued(queue);
  });

  it("spools at once when the gate fails transiently, without asking the version (OPS-1)", async () => {
    const transient = Object.assign(new Error("Durable Object reset"), { retryable: true });
    const store = await storeIn({ readonly: false, domain: true });
    const { stub, calls } = countingStore(storeWith(store, { inboxGate: () => Promise.reject(transient) }));
    const { request, send } = harness(stub);
    expect((await request("/ap/users/alice/inbox", unsigned)).status).toBe(202);
    expect(calls).toEqual(["inboxGate"]);
    expect(send).toHaveBeenCalledOnce();
  });
});
