import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { run } from "../cli/lib/main.js";
import { drainJournal } from "../src/app/cutover";
import { parseActivity } from "../src/federation/inbound";
import type { LegacyInboxMessage } from "../src/federation/legacy-inbox";
import { handleQueue } from "../src/jobs/queue";
import { createMaintenanceWorker, type MaintenanceSnapshot, SPOOL_QUEUE_BINDING } from "../src/maintenance";
import { DRAIN_LEASE_MS } from "../src/platform/store-admin";
import type { StoreStub } from "../src/platform/store-client";
import { type AccessTeam, adminClaims, adminHarness, adminTeam, setTeamAccess } from "./access-helpers";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD, migratedStore, rejectionOf } from "./helpers";
import { mastodonActor, RemoteWeb, signedInit, type TestActor } from "./inbox-helpers";
import { ACCESS, ADMIN_AUD, ADMIN_EMAIL, importChunks, importViaRpc, memoryIO, splitDump } from "./ops-helpers";
import { QueueSim } from "./queue-sim";

// Rolling a cutover back (docs/cutover-runbook.md, "Rolling back"), on the converted legacy dump of the global setup:
//   - the cutover reset takes a Store with a completed import back to empty, only before publication (OPS-8);
//   - the requests Kopje spooled during the window go to the legacy Queue, verified, in spool order, and leave
//     nothing behind that a later cutover could replay (OPS-9). The legacy consumer's side has no
//     test here (an OPS-9 residual).

declare module "vitest" {
  export interface ProvidedContext {
    cutover: { dump: string; expected: Record<string, Record<string, string>> };
    maintenance: { source: string; workerPath: string };
  }
}

const ORIGIN = "https://kopje.test";
const VAPID = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };
const TOKEN = { kind: "import-token" } as const;

let team: AccessTeam;
beforeEach(async () => {
  team = await adminTeam();
});

const authority = () => ({ ...ACCESS, teamDomain: team.teamDomain });

async function importedStore(): Promise<StoreStub> {
  const store = await migratedStore();
  await setTeamAccess(store, team, { domain: "kopje.test" });
  const { report } = await importViaRpc(store, inject("cutover").dump, 1 << 20, authority());
  expect(report).toMatchObject({ ok: true });
  return store;
}

function snapshot(): MaintenanceSnapshot {
  const line = inject("maintenance").source.split("\n")[1]!;
  return JSON.parse(line.slice("const KOPJE_MAINTENANCE_SNAPSHOT = ".length, -1)) as MaintenanceSnapshot;
}

async function count(store: StoreStub, from: string, ...params: SqlStorageValue[]): Promise<number> {
  return (await sql<{ n: number }>(store, `SELECT count(*) AS n FROM ${from}`, ...params))[0]!.n;
}

// What `kopje-admin cutover reset --yes` does: start the reset, then continue it as an import reset until it is done.
async function resetToEmpty(h: ReturnType<typeof adminHarness>): Promise<Response> {
  const started = await h.post(adminClaims(), "/admin/cutover/reset", { confirm: true });
  if (started.status !== 200) {
    return started;
  }
  const body: { id: string | null; done: boolean } = await started.clone().json();
  let done = body.done;
  while (!done) {
    const step = await h.post(adminClaims(), "/admin/import/reset", { confirm: true, id: body.id });
    expect(step.status).toBe(200);
    const next: { done: boolean } = await step.json();
    done = next.done;
  }
  return started;
}

// A request to the app that settles its waitUntil work before it returns.
async function serve(store: StoreStub, overrides: Record<string, unknown>, path: string) {
  const h = adminHarness(store, team, overrides);
  const ctx = createExecutionContext();
  const response = await h.app.fetch(new Request(`${ORIGIN}${path}`), h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the cutover reset after a completed import (OPS-8)", () => {
  it("empties the Store, keeps its configuration, and lets a new import in", async () => {
    const store = await importedStore();
    const full = adminHarness(store, team, { MAINTENANCE: "full" });
    expect(await count(store, "statuses")).toBeGreaterThan(0);

    // A verified import has no running record: import-reset cannot take it back.
    expect(await store.importReset(BUILD, authority(), "any")).toMatchObject({ ok: false, code: "import-not-found" });

    const reset = await resetToEmpty(full);
    expect(reset.status).toBe(200);
    expect(await store.cutoverStatus(BUILD)).toMatchObject({ empty: true, published: null, import: null });
    expect(await count(store, "statuses")).toBe(0);
    expect((await store.config(BUILD)).values).toMatchObject({ domain: "kopje.test", admin_email: ADMIN_EMAIL });

    // Admin access stayed usable, so the next import goes through Access.
    const again = await importViaRpc(store, inject("cutover").dump, 1 << 20, authority());
    expect(again.report).toMatchObject({ ok: true });
  });

  it("re-arms IMPORT_TOKEN only once the Access values are removed", async () => {
    const store = await importedStore();
    const full = adminHarness(store, team, { MAINTENANCE: "full" });
    expect((await resetToEmpty(full)).status).toBe(200);
    const { header } = splitDump(inject("cutover").dump);
    expect(await store.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: false, code: "not-bootstrap" });
    expect(await store.setConfig(BUILD, authority(), { access_admin_aud: null })).toMatchObject({ ok: true });
    expect(await store.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: true });
  });

  it("is refused without MAINTENANCE=full, without confirmation, and to anyone but an Access admin", async () => {
    const store = await importedStore();
    const off = adminHarness(store, team, { MAINTENANCE: "readonly" });
    const refused = await off.post(adminClaims(), "/admin/cutover/reset", { confirm: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "maintenance-required" });
    const full = adminHarness(store, team, {
      MAINTENANCE: "full",
      IMPORT_TOKEN: "import-token-0123456789abcdef0123456789",
    });
    expect((await full.post(adminClaims(), "/admin/cutover/reset", {})).status).toBe(400);
    const token = await full.request("/admin/cutover/reset", {
      method: "POST",
      headers: { "Kopje-Import-Token": "import-token-0123456789abcdef0123456789" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(token.status).toBe(403);
    expect(await store.cutoverReset(BUILD, TOKEN)).toMatchObject({ ok: false, code: "wrong-authority" });
    expect(await count(store, "statuses")).toBeGreaterThan(0);
  });

  it("is refused once published, and on a Store that never had an import", async () => {
    const store = await importedStore();
    const full = adminHarness(store, team, { MAINTENANCE: "full" });
    expect((await full.post(adminClaims(), "/admin/publish", { confirm: true })).status).toBe(200);
    const refused = await full.post(adminClaims(), "/admin/cutover/reset", { confirm: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "published" });
    expect(await count(store, "statuses")).toBeGreaterThan(0);

    const fresh = await migratedStore();
    await setTeamAccess(fresh, team, { domain: "kopje.test" });
    expect(await fresh.cutoverReset(BUILD, authority())).toMatchObject({ ok: false, code: "not-unpublished" });
  });

  it("never publishes a Store without an import, never imports into a published one, never resets one", async () => {
    const store = await migratedStore();
    await setTeamAccess(store, team, { domain: "kopje.test" });
    // Nothing to publish before an import: a published mark never lands on a Store an import may still begin into.
    expect(await store.publish(BUILD, authority())).toMatchObject({ ok: false, code: "not-unpublished" });
    expect(await store.cutoverStatus(BUILD)).toMatchObject({ published: null, empty: true });

    // A published Store (here an empty one, as an earlier version could leave it) takes no import.
    await sql(store, "INSERT INTO kopje_state (name, value) VALUES ('published', ?)", JSON.stringify({ at: NOW }));
    const { header } = splitDump(inject("cutover").dump);
    expect(await store.importBegin(BUILD, authority(), header)).toMatchObject({ ok: false, code: "published" });
    // Both marks at once (what that import used to leave): the reset still refuses.
    await sql(
      store,
      "INSERT INTO kopje_state (name, value) VALUES ('unpublished', ?)",
      JSON.stringify({ at: NOW, import: "earlier" }),
    );
    expect(await store.cutoverReset(BUILD, authority())).toMatchObject({ ok: false, code: "published" });
  });

  it("leaves an incomplete import to import-reset", async () => {
    const store = await migratedStore();
    await setTeamAccess(store, team, { domain: "kopje.test" });
    const begun = await store.importBegin(BUILD, authority(), splitDump(inject("cutover").dump).header);
    if (!begun.ok) throw new Error(begun.message);
    expect(await store.cutoverReset(BUILD, authority())).toMatchObject({ ok: false, code: "import-exists" });
    expect(await store.importReset(BUILD, authority(), begun.progress.id)).toMatchObject({ ok: true, done: true });
    expect((await store.cutoverStatus(BUILD)).empty).toBe(true);
  });
});

const SIGNED_SHAPE = {
  "content-type": "application/activity+json",
  signature: 'keyId="https://remote.example/users/a#main-key",headers="(request-target) host date",signature="x"',
};

// A rollback: the maintenance worker spools into Kopje's Queue (`kopje`), Kopje's consumer journals, the drain hands
// requests to a simulated legacy Queue (`legacy`, acknowledged by the test as the legacy consumer would) and reads the
// legacy dead-letter queue (`legacyDlq`).
async function rollback(store: StoreStub, overrides: Record<string, unknown> = {}) {
  const web = new RemoteWeb();
  const carol = await mastodonActor(web, "carol");
  const dave = await mastodonActor(web, "dave", { key: 1 });
  let clock = NOW;
  const worker = createMaintenanceWorker(snapshot(), () => (clock += 1000));
  const kopje = new QueueSim();
  const legacy = new QueueSim();
  const legacyDlq = new QueueSim();
  const kopjeDlq = new QueueSim();
  const accounts = snapshot().inboxes;
  const env = {
    MAINTENANCE: "full",
    USER_KEK: "legacy-kek",
    LEGACY_VAPID_JWK: JSON.stringify(VAPID),
    QUEUE: kopje.queue,
    LEGACY_QUEUE: legacy.queue,
    LEGACY_DLQ: legacyDlq.queue,
    KOPJE_DLQ: kopjeDlq.queue,
    ...overrides,
  };
  const h = adminHarness(store, team, env, { keygen: fixtureKeyGen, loader: web.loader });
  const post = async (path: string, init: RequestInit, expected = 202) => {
    const response = await worker.fetch!(
      new Request(`${ORIGIN}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
      { [SPOOL_QUEUE_BINDING]: kopje.queue },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(expected);
  };
  const spool = async (path: string, activity: Record<string, unknown>, signer: TestActor = carol) =>
    post(path, await signedInit(signer, path, activity));
  // Kopje's consumer, journaling or (journal: false) holding requests as in maintenance.
  const consume = (journal = true, ready = false) =>
    kopje.deliver(
      (batch) =>
        handleQueue(
          batch,
          { ...h.env, ...(journal ? { CUTOVER_ROLLBACK: "journal" } : {}) },
          inboxDeps(() => store, web.loader),
        ),
      { ready },
    );
  const drain = async (body: Record<string, unknown> = { accounts }) => {
    const response = await h.post(adminClaims(), "/admin/cutover/drain", body);
    return { status: response.status, body: await response.json() };
  };
  // The legacy consumer acknowledging what reached it.
  const handed: LegacyInboxMessage[] = [];
  const ackLegacy = () => handed.push(...legacy.pending.splice(0).map((m) => m.body as LegacyInboxMessage));
  return {
    web,
    carol,
    dave,
    kopje,
    legacy,
    legacyDlq,
    kopjeDlq,
    h,
    post,
    spool,
    consume,
    drain,
    handed,
    ackLegacy,
    accounts,
  };
}

const ctx = "https://www.w3.org/ns/activitystreams";
const alice = `${ORIGIN}/ap/users/alice`;
const follow = (actor: string, n: number) => ({
  "@context": ctx,
  id: `${actor}#follows/${n}`,
  type: "Follow",
  actor,
  object: alice,
});
const note = (actor: string, n: number, to: string[] = [alice]) => ({
  "@context": ctx,
  id: `${actor}/statuses/${n}/activity`,
  type: "Create",
  actor,
  to,
  object: {
    id: `${actor}/statuses/${n}`,
    type: "Note",
    attributedTo: actor,
    to,
    content: "<p>hello</p>",
    attachment: [],
    published: "2026-10-12T00:00:00Z",
  },
});

describe("the rollback drain (OPS-9)", () => {
  it.each([
    ["Follow", "Undo"],
    ["Create", "Delete"],
  ])("waits for a delayed %s before draining its newer %s, then hands off one at a time", async (first, second) => {
    const store = await importedStore();
    const r = await rollback(store);
    const older = first === "Follow" ? follow(r.carol.uri, 1) : note(r.carol.uri, 1);
    const newer =
      second === "Undo"
        ? { "@context": ctx, id: `${r.carol.uri}#undo/1`, type: "Undo", actor: r.carol.uri, object: older }
        : {
            "@context": ctx,
            id: `${r.carol.uri}/statuses/1#delete`,
            type: "Delete",
            actor: r.carol.uri,
            object: { id: `${r.carol.uri}/statuses/1`, type: "Tombstone" },
          };
    // The older request arrived during maintenance and is held in Kopje's Queue with the requeue delay.
    await r.spool("/ap/users/alice/inbox", older);
    await r.consume(false);
    expect(r.kopje.pending).toHaveLength(1);
    // Journaling starts; the newer request is journaled at once.
    await r.spool("/ap/users/alice/inbox", newer);
    await r.consume(true, true);
    expect((await store.cutoverStatus(BUILD)).journal.pending).toBe(1);

    // The collection barrier: nothing is sent while Kopje's Queue holds the delayed request.
    expect((await r.drain()).body).toMatchObject({ sent: 0, waiting: "kopje-backlog" });
    expect(r.legacy.pending).toEqual([]);
    await r.consume(true);
    expect(r.kopje.pending).toEqual([]);

    // The ordered lane: the older request first, the newer one only once the legacy consumer acknowledged it.
    expect((await r.drain()).body).toMatchObject({ sent: 1, waiting: null });
    expect((await r.drain()).body).toMatchObject({ sent: 0, waiting: "legacy-backlog" });
    r.ackLegacy();
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect((await r.drain()).body).toMatchObject({
      sent: 0,
      waiting: null,
      journal: { pending: 0, sending: 0, done: 2 },
    });
    expect(r.handed.map((m) => m.activity.type)).toEqual([first, second]);
    expect(r.handed[0]).toEqual({
      type: 1,
      actorId: alice,
      signerId: r.carol.uri,
      activity: expect.objectContaining({ type: first }),
      userKEK: "legacy-kek",
      vapidKeys: VAPID,
    });
  });

  it("holds the next request while the legacy consumer retries the previous one", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.spool("/ap/users/alice/inbox", {
      "@context": ctx,
      id: `${r.carol.uri}#undo/1`,
      type: "Undo",
      actor: r.carol.uri,
      object: follow(r.carol.uri, 1),
    });
    await r.consume();
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    // The legacy consumer failed the Follow (its Accept delivery failed) and retries it: it stays in the legacy Queue.
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await r.drain()).body).toMatchObject({ sent: 0, waiting: "legacy-backlog" });
    }
    r.ackLegacy();
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect(r.handed.map((m) => m.activity.type)).toEqual(["Follow", "Undo"]);
  });

  it("stops on a dead-lettered legacy message, and when a backlog cannot be read", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    await r.legacyDlq.send({ dead: true });
    expect((await r.drain()).body).toMatchObject({ sent: 0, stopped: "legacy-dlq" });
    r.legacyDlq.pending.splice(0);
    for (const binding of ["QUEUE", "LEGACY_QUEUE", "LEGACY_DLQ"]) {
      const without = await rollback(store, { [binding]: { send: () => Promise.resolve() } });
      expect((await without.drain({ accounts: without.accounts })).body, binding).toMatchObject({
        sent: 0,
        stopped: "metrics-unavailable",
      });
    }
    const unbound = await rollback(store, { LEGACY_DLQ: undefined });
    const refused = await unbound.drain({ accounts: unbound.accounts });
    expect(refused).toMatchObject({ status: 409, body: { code: "legacy-binding-missing" } });
    expect(r.legacy.pending).toEqual([]);
  });

  it("runs one drain at a time, resends a request a crash left being sent, and never journals a handed-off one again", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    const original = structuredClone(r.kopje.pending[0]!.body);
    await r.consume();

    // Another drain holds the journal.
    await store.drainLease(BUILD, authority(), { holder: "other" });
    expect(await r.drain()).toMatchObject({ status: 409, body: { code: "drain-in-progress" } });
    await store.drainLease(BUILD, authority(), { holder: "other", release: true });

    // A drain that marked the record as being sent and then died: the next one sends it again (at least once).
    await store.drainLease(BUILD, authority(), { holder: "crashed" });
    const next = (await store.journalNext(BUILD, authority(), "crashed")) as { entry: { id: string } };
    await store.journalMark(BUILD, authority(), "crashed", next.entry.id, "sending");
    await store.drainLease(BUILD, authority(), { holder: "crashed", release: true });
    expect((await r.drain()).body).toMatchObject({ sent: 1, journal: { sending: 0, done: 1 } });
    r.ackLegacy();

    // A late redelivery of the same spool message from Kopje's Queue is not journaled again.
    await r.kopje.send(original);
    await r.consume();
    expect((await store.cutoverStatus(BUILD)).journal).toMatchObject({ pending: 0, done: 1 });
    expect((await r.drain()).body).toMatchObject({ sent: 0, journal: { pending: 0 } });
    expect(r.handed).toHaveLength(1);
  });

  it("chooses only a legacy account as the recipient, and keeps a request that has none", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    const ghost = `${ORIGIN}/ap/users/ghost`;
    // A forged request (dave's key, carol's activity), a shared-inbox Create to a missing account then alice, and one
    // to the missing account only.
    await r.spool("/inbox", { ...follow(r.carol.uri, 2) }, r.dave);
    await r.spool("/inbox", note(r.carol.uri, 1, [ghost, alice]));
    await r.spool("/inbox", note(r.carol.uri, 2, [ghost]));
    await r.consume();
    expect(await r.drain({ accounts: r.accounts, fallback: "ghost" })).toMatchObject({
      status: 400,
      body: { code: "invalid-fallback" },
    });
    for (let round = 0; round < 3; round++) {
      await r.drain();
      r.ackLegacy();
    }
    expect(r.handed.map((m) => m.actorId)).toEqual([alice]);
    expect((await store.cutoverStatus(BUILD)).journal).toMatchObject({
      pending: 0,
      unverified: 1,
      noRecipient: 1,
      done: 1,
    });

    // The kept requests block the reset until the operator discards them.
    const full = adminHarness(store, team, { MAINTENANCE: "full" });
    expect(await (await full.post(adminClaims(), "/admin/cutover/reset", { confirm: true })).json()).toMatchObject({
      code: "journal-not-empty",
    });
    expect((await full.post(adminClaims(), "/admin/cutover/discard-kept", { confirm: true })).status).toBe(200);
    expect((await resetToEmpty(full)).status).toBe(200);
  });

  it("bounds the journal under a flood of signed-looking requests; the rest stays in the Queue", async () => {
    const store = await importedStore();
    const r = await rollback(store, { CUTOVER_JOURNAL_MAX_ENTRIES: "3" });
    for (let n = 0; n < 6; n++) {
      await r.post("/inbox", { method: "POST", headers: SIGNED_SHAPE, body: JSON.stringify({ n }) });
    }
    await r.consume();
    expect((await store.cutoverStatus(BUILD)).journal).toMatchObject({ pending: 3 });
    expect(r.kopje.pending).toHaveLength(3);
    // Nothing is sent while the Queue holds requests; the bogus ones are set aside meanwhile, still counted.
    expect((await r.drain()).body).toMatchObject({ sent: 0, unverified: 3, stopped: "journal-full" });
    await r.consume();
    expect(r.kopje.pending).toHaveLength(3);
    // The operator discards what was kept; the rest comes in, is set aside, and the Queue empties.
    const full = adminHarness(store, team, { MAINTENANCE: "full" });
    await full.post(adminClaims(), "/admin/cutover/discard-kept", { confirm: true });
    await r.consume();
    expect(r.kopje.pending).toEqual([]);
    expect((await r.drain()).body).toMatchObject({ sent: 0, unverified: 3, waiting: null });
    expect(r.handed).toEqual([]);
  });

  it("journals nothing once the instance is published: the Queue holds the requests as in maintenance", async () => {
    const store = await importedStore();
    expect(await store.publish(BUILD, authority())).toMatchObject({ ok: true });
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    expect(r.kopje.pending).toHaveLength(1);
    expect((await store.cutoverStatus(BUILD)).journal.pending).toBe(0);
  });

  it("accepts the drain from an Access admin only", async () => {
    const store = await importedStore();
    expect(await store.drainLease(BUILD, TOKEN, { holder: "x" })).toMatchObject({ ok: false, code: "wrong-authority" });
    expect(await store.journalNext(BUILD, TOKEN, "x")).toMatchObject({ ok: false, code: "wrong-authority" });
    expect(await store.journalMark(BUILD, TOKEN, "x", "id", "done")).toMatchObject({
      ok: false,
      code: "wrong-authority",
    });
  });
});

// The first attempt as the runbook runs it: the import token sets the domain and the Access values while the Store is
// in bootstrap, the import runs through Access, and it is interrupted; Rollback A then resets it and drains.
describe("Rollback A from the first attempt (OPS-9)", () => {
  it("resets an interrupted import, then journals and drains what was spooled meanwhile", async () => {
    const store = await migratedStore();
    const configured = await store.setConfig(BUILD, TOKEN, {
      domain: "kopje.test",
      access_team_domain: team.teamDomain,
      access_admin_aud: ADMIN_AUD,
      admin_email: ADMIN_EMAIL,
    });
    expect(configured).toMatchObject({ ok: true });
    const begun = await store.importBegin(BUILD, authority(), splitDump(inject("cutover").dump).header);
    if (!begun.ok) throw new Error(begun.message);
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    // During the import nothing is journaled: the request stays in Kopje's Queue.
    await r.consume();
    expect(r.kopje.pending).toHaveLength(1);

    const full = adminHarness(store, team, { MAINTENANCE: "full" });
    const reset = await full.post(adminClaims(), "/admin/import/reset", { confirm: true, id: begun.progress.id });
    expect(reset.status).toBe(200);
    const first: { done: boolean } = await reset.json();
    let done = first.done;
    while (!done) {
      const step = await full.post(adminClaims(), "/admin/import/reset", { confirm: true, id: begun.progress.id });
      const next: { done: boolean } = await step.json();
      done = next.done;
    }
    await r.consume();
    expect(r.kopje.pending).toEqual([]);
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect(r.handed.map((m) => [m.activity.type, m.actorId])).toEqual([["Follow", alice]]);
  });
});

// A Store configured through the token and Access, as the runbook's preparation leaves it, still without data.
async function preparedStore(): Promise<StoreStub> {
  const store = await migratedStore();
  expect(
    await store.setConfig(BUILD, TOKEN, {
      domain: "kopje.test",
      access_team_domain: team.teamDomain,
      access_admin_aud: ADMIN_AUD,
      admin_email: ADMIN_EMAIL,
    }),
  ).toMatchObject({ ok: true });
  return store;
}

// The Store as the app sees it, with one call replaced.
function withCall(store: StoreStub, name: string, call: (...args: unknown[]) => unknown): StoreStub {
  return new Proxy(store, {
    get: (target, property, receiver) =>
      property === name ? call : (Reflect.get(target, property, receiver) as unknown),
  });
}

describe("an import stays readonly until it is published (OPS-8)", () => {
  it("refuses queue replay, deliveries and writes with MAINTENANCE=off, and publishing lets them through", async () => {
    const store = await importedStore();
    expect(await store.cutoverStatus(BUILD)).toMatchObject({ unpublished: true, published: null });
    // The fixture's keys are wrapped with the empty KEK; the replay signs its fetches with alice's key.
    const r = await rollback(store, { MAINTENANCE: "off", USER_KEK: "" });
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    // Replay: the Store refuses the write, and the request stays in Kopje's Queue.
    await r.consume(false);

    expect(r.kopje.pending).toHaveLength(1);
    expect(await count(store, "follows f JOIN accounts a ON a.id = f.account_id WHERE a.uri = ?", r.carol.uri)).toBe(0);
    // Deliveries and other writes are refused as in readonly.
    expect(
      String(await rejectionOf(store.claimDeliveries(BUILD, { now: NOW, limit: 1, leaseMs: 1000 } as never))),
    ).toMatch(/unpublished/);
    expect((await serve(store, { MAINTENANCE: "off" }, "/api/v1/instance")).status).toBe(200);

    const published = await r.h.post(adminClaims(), "/admin/publish", { confirm: true });
    expect(published.status).toBe(200);
    expect(await store.cutoverStatus(BUILD)).toMatchObject({
      unpublished: false,
      published: { at: expect.any(Number) },
    });
    await r.consume(false);
    // The replay went through (its Accept now rings the delivery doorbell).
    expect(r.kopje.pending.map((m) => (m.body as { kind: string }).kind)).not.toContain("spool");
    expect(await count(store, "follows f JOIN accounts a ON a.id = f.account_id WHERE a.uri = ?", r.carol.uri)).toBe(1);
  });

  it("fetches nothing for a request it would refuse, and holds it as in maintenance rather than retrying", async () => {
    const store = await importedStore();
    const r = await rollback(store, { MAINTENANCE: "off", USER_KEK: "" });
    // The sender's server fails: a fetch would count a retry. None is made while unpublished.
    r.web.fail(r.carol.uri, 503);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume(false);
    expect(r.web.fetched).toEqual([]);
    expect(r.kopje.retries).toBe(0);
    expect(r.kopje.pending).toMatchObject([{ attempts: 1, body: { kind: "spool" } }]);

    // The live inbox spools it too, with nothing fetched.
    const path = "/ap/users/alice/inbox";
    const live = await r.h.request(path, await signedInit(r.carol, path, follow(r.carol.uri, 2)));
    expect(live.status).toBe(202);
    expect(r.web.fetched).toEqual([]);
    expect(r.kopje.pending).toHaveLength(2);
  });

  it("lets a restore without Access import and publish with IMPORT_TOKEN", async () => {
    const store = await migratedStore();
    expect(await store.setConfig(BUILD, TOKEN, { domain: "kopje.test" })).toMatchObject({ ok: true });
    const { header, trailer } = splitDump(inject("cutover").dump);
    const begun = await store.importBegin(BUILD, TOKEN, header);
    if (!begun.ok || begun.session === undefined) throw new Error("no session");
    const session = { kind: "import-session", secret: begun.session } as const;
    for (const [i, chunk] of (await importChunks(inject("cutover").dump, 1 << 20)).entries()) {
      await store.importChunk(BUILD, session, begun.progress.id, i + 1, chunk);
    }
    await store.importFinish(BUILD, session, begun.progress.id, trailer);
    expect(await store.importVerify(BUILD, session, begun.progress.id)).toMatchObject({ report: { ok: true } });
    expect((await store.cutoverStatus(BUILD)).unpublished).toBe(true);
    expect(await store.publish(BUILD, TOKEN)).toMatchObject({ ok: true });
    expect((await store.cutoverStatus(BUILD)).unpublished).toBe(false);
  });

  it("does not touch a Store that never had an import", async () => {
    const store = await migratedStore();
    expect(await store.cutoverStatus(BUILD)).toMatchObject({ unpublished: false, published: null });
  });
});

describe("a rollback in progress blocks publication, and a publication blocks the drain (OPS-8, OPS-9)", () => {
  it("refuses to publish while the journal holds requests, and drains nothing once published", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    const refused = await r.h.post(adminClaims(), "/admin/publish", { confirm: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "rollback-in-progress" });
    expect((await store.cutoverStatus(BUILD)).unpublished).toBe(true);

    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect((await r.h.post(adminClaims(), "/admin/publish", { confirm: true })).status).toBe(200);
    expect(await r.drain()).toMatchObject({ status: 409, body: { code: "published" } });
  });
});

describe("handoff receipts outlive the journal, an import and a reset (OPS-9)", () => {
  it("lets the next import in after Rollback A, and refuses a redelivery after a Rollback B reset", async () => {
    const prepared = await preparedStore();
    const a = await rollback(prepared);
    await a.spool("/ap/users/alice/inbox", follow(a.carol.uri, 1));
    await a.consume();
    expect((await a.drain()).body).toMatchObject({ sent: 1 });
    a.ackLegacy();
    const imported = await importViaRpc(prepared, inject("cutover").dump, 1 << 20, authority());
    expect(imported.report).toMatchObject({ ok: true });

    const store = await importedStore();
    const b = await rollback(store);
    await b.spool("/ap/users/alice/inbox", follow(b.carol.uri, 1));
    const original = structuredClone(b.kopje.pending[0]!.body);
    await b.consume();
    expect((await b.drain()).body).toMatchObject({ sent: 1 });
    b.ackLegacy();
    expect((await resetToEmpty(adminHarness(store, team, { MAINTENANCE: "full" }))).status).toBe(200);
    await b.kopje.send(original);
    await b.consume();
    expect((await store.cutoverStatus(BUILD)).journal).toMatchObject({ pending: 0, done: 1 });
    expect(b.kopje.pending).toEqual([]);
  });

  it("never replays a handed-off request after journaling is turned off, until the rollback is closed", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    const original = structuredClone(r.kopje.pending[0]!.body);
    await r.consume();
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    // The copy comes back after CUTOVER_ROLLBACK is removed, in maintenance and then at publication: dropped.
    const off = await rollback(store, { MAINTENANCE: "off" });
    await off.kopje.send(original);
    await off.consume(false);
    expect(off.kopje.pending).toEqual([]);
    expect(await count(store, "follows f JOIN accounts a ON a.id = f.account_id WHERE a.uri = ?", r.carol.uri)).toBe(0);

    // Closing needs Kopje's Queue and its dead-letter queue empty; then the receipts go.
    await r.kopje.send({ kind: "inbound-jobs" });
    const busy = await r.h.post(adminClaims(), "/admin/cutover/close", { confirm: true });
    expect(await busy.json()).toMatchObject({ code: "queue-not-empty" });
    r.kopje.pending.splice(0);
    // A copy of the handed-off request that exhausted its retries sits in the DLQ: closing would let a redrive replay it.
    await r.kopjeDlq.send(original);
    expect(await (await r.h.post(adminClaims(), "/admin/cutover/close", { confirm: true })).json()).toMatchObject({
      code: "queue-not-empty",
      deadLetters: 1,
    });
    const unbound = await rollback(store, { KOPJE_DLQ: undefined });
    expect(await (await unbound.h.post(adminClaims(), "/admin/cutover/close", { confirm: true })).json()).toMatchObject(
      {
        code: "queue-not-empty",
      },
    );
    r.kopjeDlq.pending.splice(0);
    expect(await (await r.h.post(adminClaims(), "/admin/cutover/close", { confirm: true })).json()).toMatchObject({
      receipts: 1,
    });
    expect((await store.cutoverStatus(BUILD)).journal.done).toBe(0);
  });
});

describe("the drain lane holds under timing faults (OPS-9)", () => {
  it("gives up a send that does not finish, keeping the lease so no other drain sends meanwhile", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    const suspended = {
      send: () => new Promise(() => {}),
      metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
    };
    const env = { ...r.h.env, LEGACY_QUEUE: suspended } as Env;
    const round = await drainJournal(
      env,
      { build: BUILD, store, loader: r.web.loader, holder: "stalled", sendTimeoutMs: 20 },
      authority(),
      { accounts: r.accounts, fallback: undefined },
    );
    expect(round).toMatchObject({ ok: true, sent: 0, stopped: "legacy-queue-timeout", journal: { sending: 1 } });
    expect(await r.drain()).toMatchObject({ status: 409, body: { code: "drain-in-progress" } });
  });

  it("sees a message the legacy consumer dead-lettered between the readings", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    const dlq: unknown[] = [];
    // The legacy Queue reads empty, and its last message moves to the DLQ right after.
    const legacy = {
      send: () => Promise.resolve(),
      metrics: async () => {
        await Promise.resolve();
        queueMicrotask(() => dlq.push({ dead: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { backlogCount: 0, backlogBytes: 0 };
      },
    };
    const legacyDlq = {
      send: () => Promise.resolve(),
      metrics: () => Promise.resolve({ backlogCount: dlq.length, backlogBytes: 0 }),
    };
    const env = { ...r.h.env, LEGACY_QUEUE: legacy, LEGACY_DLQ: legacyDlq } as Env;
    const round = await drainJournal(
      env,
      { build: BUILD, store, loader: r.web.loader, holder: "reader" },
      authority(),
      { accounts: r.accounts, fallback: undefined },
    );
    expect(round).toMatchObject({ ok: true, sent: 0, stopped: "legacy-dlq" });
  });

  it("keeps what Kopje would ignore: no context, no id, an id that is not a string", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    const base = follow(r.carol.uri, 1) as Record<string, unknown>;
    const { "@context": _context, ...noContext } = base;
    const { id: _id, ...noId } = base;
    for (const activity of [noContext, noId, { ...base, id: 42 }]) {
      expect(parseActivity(new TextEncoder().encode(JSON.stringify(activity)))).toMatchObject({ ok: false });
      await r.spool("/ap/users/alice/inbox", activity);
    }
    await r.consume();
    expect((await r.drain()).body).toMatchObject({ sent: 0, unverified: 3 });
    expect(r.legacy.pending).toEqual([]);
  });

  it("stops with journal-full when valid requests exceed the quota, and goes on once it is raised", async () => {
    const store = await importedStore();
    const r = await rollback(store, { CUTOVER_JOURNAL_MAX_ENTRIES: "1" });
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.spool("/ap/users/alice/inbox", {
      "@context": ctx,
      id: `${r.carol.uri}#undo/1`,
      type: "Undo",
      actor: r.carol.uri,
      object: follow(r.carol.uri, 1),
    });
    await r.consume();
    expect(r.kopje.pending).toHaveLength(1);
    expect((await r.drain()).body).toMatchObject({ sent: 0, waiting: null, stopped: "journal-full" });

    // The remedy: a higher quota (up to the Store's ceiling).
    const raised = await rollback(store, { CUTOVER_JOURNAL_MAX_ENTRIES: "5", QUEUE: r.kopje.queue });
    await r.kopje.deliver((batch) =>
      handleQueue(
        batch,
        { ...raised.h.env, CUTOVER_ROLLBACK: "journal" } as Env,
        inboxDeps(() => store, r.web.loader),
      ),
    );
    expect(r.kopje.pending).toEqual([]);
    const lane = await rollback(store, { QUEUE: r.kopje.queue, LEGACY_QUEUE: r.legacy.queue });
    expect((await lane.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect((await lane.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect(r.handed.map((m) => m.activity.type)).toEqual(["Follow", "Undo"]);
  });
});

describe("the drain never sends past its lease, and never stays stuck (OPS-9)", () => {
  it("sends nothing when the mark comes back after the lease ran out", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    let clock = Date.now();
    // The 'sending' mark is answered late: the Worker's clock has passed the lease when it returns.
    const late = withCall(store, "journalMark", async (...args: unknown[]) => {
      const result = await (store.journalMark as (...a: unknown[]) => Promise<unknown>)(...args);
      if (args[4] === "sending") {
        // Past the round's deadline, inside the lease (the report is still read).
        clock += DRAIN_LEASE_MS - 30_000;
      }
      return result;
    });
    const round = await drainJournal(
      r.h.env,
      { build: BUILD, store: late, loader: r.web.loader, holder: "late", now: () => clock },
      authority(),
      { accounts: r.accounts, fallback: undefined },
    );
    expect(round).toMatchObject({ ok: true, sent: 0, stopped: "lease-expiring", journal: { sending: 1 } });
    expect(r.legacy.pending).toEqual([]);
  });

  it("gives up a call that outlasts the round, sends nothing after it, and keeps the lease", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    let clock = NOW;
    // Once the lease is taken, the round's deadline is 50 ms away; the legacy Queue's reading never answers.
    const stalled = withCall(store, "drainLease", async (...args: unknown[]) => {
      const result = await (store.drainLease as (...a: unknown[]) => Promise<unknown>)(...args);
      clock = NOW + DRAIN_LEASE_MS - 60_000 - 50;
      return result;
    });
    const legacy = { send: () => Promise.resolve(), metrics: () => new Promise(() => {}) };
    const round = await drainJournal(
      { ...r.h.env, LEGACY_QUEUE: legacy } as Env,
      { build: BUILD, store: stalled, loader: r.web.loader, holder: "stalled", now: () => clock },
      authority(),
      { accounts: r.accounts, fallback: undefined },
    );
    expect(round).toMatchObject({ ok: true, sent: 0, stopped: "lease-expiring", journal: { pending: 1 } });
    expect(r.legacy.pending).toEqual([]);
    expect(await r.drain()).toMatchObject({ status: 409, body: { code: "drain-in-progress" } });
  });

  it("answers without a report when even the report outlasts the lease, having sent nothing", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    let clock = NOW;
    // The 'sending' mark comes back past the deadline (nothing is sent), and the report then never answers.
    const late = withCall(
      withCall(store, "journalMark", async (...args: unknown[]) => {
        const result = await (store.journalMark as (...a: unknown[]) => Promise<unknown>)(...args);
        clock = NOW + DRAIN_LEASE_MS - 50;
        return result;
      }),
      "cutoverStatus",
      () => new Promise(() => {}),
    );
    const round = await drainJournal(
      r.h.env,
      { build: BUILD, store: late, loader: r.web.loader, holder: "late", now: () => clock },
      authority(),
      { accounts: r.accounts, fallback: undefined },
    );
    expect(round).toMatchObject({ ok: false, status: 409, code: "lease-expiring" });
    expect(r.legacy.pending).toEqual([]);
  });

  it("keeps a journal-full stop through a transient key failure, and the CLI stops on it", async () => {
    const store = await importedStore();
    const r = await rollback(store, { CUTOVER_JOURNAL_MAX_ENTRIES: "1" });
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 2));
    await r.consume();
    r.web.fail(r.carol.uri, 503);
    const result = await cliDrain(r, []);
    expect(result.code, result.err).toBe(3);
    expect(result.err).toContain("journal-full");
  });

  it("takes --unordered only after a reported journal-full stop, even on its first request", async () => {
    const store = await importedStore();
    const r = await rollback(store, { CUTOVER_JOURNAL_MAX_ENTRIES: "1" });
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 2));
    await r.consume();
    // The first request asks for the escape: the Store has no stop recorded, so the round stops and reports it.
    const first = await cliDrain(r, ["--unordered", "--yes"]);
    expect(first.code, first.err).toBe(3);
    expect(first.err).toContain("journal-full");
    expect(r.legacy.pending).toEqual([]);
    // Run again with the journal as it was at the stop: now the head goes past the barrier.
    expect((await r.drain({ accounts: r.accounts, unordered: true })).body).toMatchObject({ sent: 1 });
    expect(r.legacy.pending).toHaveLength(1);
  });

  it("gives up after its deadline when a round makes no progress, pausing between rounds", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume(false);
    // The request stays held in Kopje's Queue: every round waits at the collection barrier.
    const result = await cliDrain(r, []);
    expect(result.code, result.err).toBe(3);
    expect(result.err).toContain("not done after 45 minutes");
    expect(result.pauses).toBeGreaterThan(0);
  });

  it("lets an unordered drain past the barrier once the journal is full, and only then", async () => {
    const store = await importedStore();
    const r = await rollback(store, { CUTOVER_JOURNAL_MAX_ENTRIES: "1" });
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.spool("/ap/users/alice/inbox", {
      "@context": ctx,
      id: `${r.carol.uri}#undo/1`,
      type: "Undo",
      actor: r.carol.uri,
      object: follow(r.carol.uri, 1),
    });
    await r.consume();
    expect((await r.drain()).body).toMatchObject({ stopped: "journal-full" });
    expect((await r.drain({ accounts: r.accounts, unordered: true })).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    // The journal has room again: the rest comes in and drains in order; --unordered no longer changes anything.
    await r.consume();
    expect(r.kopje.pending).toEqual([]);
    expect((await r.drain({ accounts: r.accounts, unordered: true })).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect(r.handed.map((m) => m.activity.type)).toEqual(["Follow", "Undo"]);
  });
});

// Queues leaves a delayed message out of backlogCount and counts it in backlogBytes only.
const reading = (metrics: unknown) => ({ send: () => Promise.resolve(), metrics: () => Promise.resolve(metrics) });
const delayedOnly = reading({ backlogCount: 0, backlogBytes: 2048 });

describe("a Queue holding only delayed messages is not empty (OPS-9)", () => {
  it("holds the drain on Kopje's Queue, the legacy Queue and the legacy DLQ", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.spool("/ap/users/alice/inbox", {
      "@context": ctx,
      id: `${r.carol.uri}#undo/1`,
      type: "Undo",
      actor: r.carol.uri,
      object: follow(r.carol.uri, 1),
    });
    await r.consume();
    const lane = async (overrides: Record<string, unknown>) => {
      const other = await rollback(store, overrides);
      return (await other.drain({ accounts: other.accounts })).body;
    };
    // The collection barrier: a delayed request in Kopje's Queue may be older than the journal's head.
    expect(await lane({ QUEUE: delayedOnly, LEGACY_QUEUE: r.legacy.queue })).toMatchObject({
      sent: 0,
      waiting: "kopje-backlog",
      stopped: null,
    });
    expect(r.legacy.pending).toEqual([]);
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    // A legacy retry with a delay: the next request waits for it.
    expect(await lane({ QUEUE: r.kopje.queue, LEGACY_QUEUE: delayedOnly })).toMatchObject({
      sent: 0,
      waiting: "legacy-backlog",
    });
    // A dead-lettered legacy message stops the drain whatever its count reads.
    expect(await lane({ QUEUE: r.kopje.queue, LEGACY_QUEUE: r.legacy.queue, LEGACY_DLQ: delayedOnly })).toMatchObject({
      sent: 0,
      stopped: "legacy-dlq",
    });
    expect(r.legacy.pending).toEqual([]);
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect(r.handed.map((m) => m.activity.type)).toEqual(["Follow", "Undo"]);
  });

  it("holds the next request while the legacy consumer retries the previous one with a delay", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.spool("/ap/users/alice/inbox", {
      "@context": ctx,
      id: `${r.carol.uri}#undo/1`,
      type: "Undo",
      actor: r.carol.uri,
      object: follow(r.carol.uri, 1),
    });
    await r.consume();
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    // The legacy consumer retries the Follow with a delay: the Queue's count leaves it out, its bytes do not.
    await r.legacy.deliver((batch) => batch.messages.forEach((m) => m.retry({ delaySeconds: 60 })), { ready: true });
    expect(r.legacy.retries).toBe(1);
    const { backlogCount, backlogBytes } = await r.legacy.metrics();
    expect(backlogCount).toBe(0);
    expect(backlogBytes).toBeGreaterThan(0);
    expect((await r.drain()).body).toMatchObject({ sent: 0, waiting: "legacy-backlog" });
    expect(r.legacy.pending).toHaveLength(1);
    // The delay passes and the legacy consumer acknowledges it: the Undo goes next.
    r.ackLegacy();
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    expect(r.handed.map((m) => m.activity.type)).toEqual(["Follow", "Undo"]);
  });

  it("refuses to close the rollback while a delayed copy may sit in Kopje's Queue or its DLQ", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    expect((await r.drain()).body).toMatchObject({ sent: 1 });
    r.ackLegacy();
    const close = async (overrides: Record<string, unknown>) =>
      (
        await (await rollback(store, overrides)).h.post(adminClaims(), "/admin/cutover/close", { confirm: true })
      ).json();
    expect(await close({ QUEUE: delayedOnly })).toMatchObject({ code: "queue-not-empty", backlog: 0 });
    expect(await close({ KOPJE_DLQ: delayedOnly })).toMatchObject({
      code: "queue-not-empty",
      backlog: 0,
      deadLetters: 0,
    });
    expect((await store.cutoverStatus(BUILD)).journal.done).toBe(1);
    expect(await close({})).toMatchObject({ receipts: 1 });
  });

  it("fails closed on a reading with a missing or malformed field", async () => {
    const store = await importedStore();
    const r = await rollback(store);
    await r.spool("/ap/users/alice/inbox", follow(r.carol.uri, 1));
    await r.consume();
    const malformed = [
      { backlogBytes: 0 },
      { backlogCount: 0 },
      { backlogCount: "0", backlogBytes: 0 },
      { backlogCount: 0, backlogBytes: Number.NaN },
      { backlogCount: -1, backlogBytes: 0 },
      { backlogCount: 0, backlogBytes: Number.POSITIVE_INFINITY },
      null,
    ];
    for (const metrics of malformed) {
      for (const binding of ["QUEUE", "LEGACY_QUEUE", "LEGACY_DLQ"]) {
        const other = await rollback(store, { [binding]: reading(metrics) });
        expect(
          (await other.drain({ accounts: other.accounts })).body,
          `${binding} ${JSON.stringify(metrics)}`,
        ).toMatchObject({
          sent: 0,
          stopped: "metrics-unavailable",
        });
      }
      for (const binding of ["QUEUE", "KOPJE_DLQ"]) {
        const other = await rollback(store, { [binding]: reading(metrics) });
        const closed = await other.h.post(adminClaims(), "/admin/cutover/close", { confirm: true });
        expect(await closed.json(), `${binding} ${JSON.stringify(metrics)}`).toMatchObject({ code: "queue-not-empty" });
      }
    }
    expect(r.legacy.pending).toEqual([]);
  });
});

// `kopje-admin cutover drain` through the real CLI, against the app as an Access admin.
async function cliDrain(r: Awaited<ReturnType<typeof rollback>>, extra: string[]) {
  const io = memoryIO(new Map([["pages/_worker.js", new TextEncoder().encode(inject("maintenance").source)]]));
  let clock = NOW;
  let pauses = 0;
  const out: string[] = [];
  const err: string[] = [];
  const code = await run({
    argv: ["cutover", "drain", "--worker", "pages", ...extra],
    env: { KOPJE_ADMIN_URL: "https://admin.kopje.test" },
    io,
    stdout: { write: (text: string) => void out.push(text), isTTY: false },
    stderr: { write: (text: string) => void err.push(text), isTTY: false },
    fetch: async (input, init) => {
      const url = new URL(input);
      return r.h.as(adminClaims(), `${url.pathname}${url.search}`, init);
    },
    now: () => (clock += 10 * 60 * 1000),
    sleep: () => {
      pauses++;
      return Promise.resolve();
    },
    platform: "linux",
  });
  return { code, out: out.join(""), err: err.join(""), pauses };
}
