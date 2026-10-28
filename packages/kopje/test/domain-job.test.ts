import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { MODERATION_ROUND_ROWS } from "../src/domain/moderation-bounds";
import { writeOperation } from "../src/domain/operation";
import { upsertRemoteActor } from "../src/domain/remote-actors";
import {
  CLEAR_ROUND,
  MARK_ACCOUNTS,
  MARK_WINDOW,
  remoteModerationRound,
  SEVER_ROUND,
} from "../src/domain/remote-suspension";
import { requestInboundJobs } from "../src/federation/inbox";
import { handleQueue, runScheduledJobs } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, form, seedFollows, settle, sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { blockDomain, setSeverity, unblockDomain } from "./domain-block-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { QueueSim } from "./queue-sim";
import { deferred } from "./quote-helpers";
import { plannedRun, type PlannedStatement, remoteAccounts, scansOf, staleStatistics } from "./read-helpers";
import {
  act,
  adminEntity,
  jobs,
  ORIGIN,
  receive,
  rejects,
  round,
  toFollows,
  unsuspend,
  uriOf,
  world,
  type World,
} from "./remote-suspension-helpers";
import { byText } from "./sort";
import { follow, remoteAccount, remoteFollows } from "./status-helpers";

// The domain job of R38 (instance domain blocks, severity suspend): its reset by each transition, the marks it
// reconciles and the clearing walk, both-way severing, the conversion of an individual suspension into a domain one,
// the admin's lists while marks lag (503), and its interleavings with transitions, suspensions and the Queue and cron.

const D = "d.example";

// A remote actor's document as the inbox's refresh reads it (remote-actors.ts RemoteActorInput).
const ACTOR = {
  domain: "",
  actorType: "Person",
  displayName: "R",
  note: "",
  url: null,
  avatarUrl: null,
  headerUrl: null,
  locked: false,
  discoverable: null,
  indexable: false,
  inboxUrl: "https://moved.example/users/r/inbox",
  sharedInboxUrl: null,
  published: null,
  keys: [],
  emojiTags: [],
  raw: "{}",
  movedTo: null,
};
const BASE = 600_000_000_000_000_000;

// `n` accounts on `domain`, each followed by alice (accepted), as seedFollows writes them, with their inboxes.
async function followedOn(w: World, n: number, domain = D, base = BASE): Promise<void> {
  await seedFollows(w.h.store, w.alice.id, n, { direction: "following", domain, base });
  await sql(w.h.store, "UPDATE accounts SET inbox_url = uri || '/inbox' WHERE domain = ?", domain);
}

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
  (await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n;

const marked = (store: StoreStub, domain = D) =>
  count(store, "SELECT 1 FROM accounts WHERE domain = ? AND suspension_source = 'domain'", domain);

const followsOn = (store: StoreStub, domain = D) =>
  count(
    store,
    `SELECT 1 FROM follows f JOIN accounts a ON a.id IN (f.account_id, f.target_account_id)
		WHERE a.domain = ?`,
    domain,
  );

// The Undo activities recorded, per Follow they undo.
const undos = (store: StoreStub) =>
  sql<{ follow: string; n: number }>(
    store,
    `SELECT json_extract(body, '$.activity.object.id') AS follow, count(*) AS n FROM outbound_activities
		WHERE json_extract(body, '$.activity.type') = 'Undo' GROUP BY follow`,
  );

// `n` local accounts with ids from 500000000000000000 (LIKE '5000%'), with their local_accounts rows.
async function localAccounts(store: StoreStub, n: number): Promise<void> {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, created_at) SELECT printf('%018d', 500000000000000000 + i),
			'https://kopje.test/ap/users/l' || i, 'l' || i, ?2 FROM n`,
    n,
    new Date(NOW).toISOString(),
  );
  await sql(
    store,
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@example.com', X'00', X'00', 'test' FROM accounts WHERE id LIKE '5000%'`,
  );
}

// Rounds of the remote jobs until none is left, each within the round budget; how many.
async function drain(store: StoreStub, limit = 2_000): Promise<number> {
  let rounds = 0;
  for (let ran = await round(store); ran !== null; ran = await round(store)) {
    expect(ran.rows).toBeLessThanOrEqual(MODERATION_ROUND_ROWS);
    expect(++rounds).toBeLessThan(limit);
  }
  return rounds;
}

async function rounds(store: StoreStub, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await round(store);
  }
}

describe("the domain job (R38: marks and both-way severing)", () => {
  it("is reset by every transition into or out of suspend for some host, and by nothing else", async () => {
    const w = await world();
    const store = w.h.store;
    const domainJob = async () => (await jobs(store)).filter((job) => job.kind === "domain");
    const parent = await blockDomain(store, D);
    expect(await domainJob()).toEqual([{ kind: "domain", subject: "", mode: "domain", phase: "clear", cursor: "" }]);
    await drain(store);
    // A noop child under nothing: no host changes. A stricter suspend child under the suspend parent: none either.
    await blockDomain(store, "other.example", "noop");
    const child = await blockDomain(store, `a.${D}`, "suspend");
    expect(await domainJob()).toEqual([]);
    // Deleting the child leaves its hosts under the parent's suspend; deleting the parent uncovers them.
    await unblockDomain(store, child.id);
    expect(await domainJob()).toEqual([]);
    await setSeverity(store, parent.id, "noop");
    expect(await domainJob()).toHaveLength(1);
    await drain(store);
    await setSeverity(store, parent.id, "noop");
    expect(await domainJob()).toEqual([]);
    await setSeverity(store, parent.id, "suspend");
    expect(await domainJob()).toHaveLength(1);
    await drain(store);
    await unblockDomain(store, parent.id);
    expect(await domainJob()).toHaveLength(1);
  });

  it("marks every covered account, by its stored domain, its subdomain or its actor host, and severs both ways", async () => {
    const w = await world();
    const store = w.h.store;
    const onDomain = await remoteAccount(store, "x", D);
    const onSub = await remoteAccount(store, "y", `deep.sub.${D}`);
    // Covered only through its actor host: its stored domain is elsewhere.
    const byHost = await remoteAccount(store, "z", "elsewhere.example");
    await sql(store, "UPDATE accounts SET uri = 'https://h.' || ? || '/users/z' WHERE id = ?", D, byHost);
    const free = await remoteAccount(store, "f", "free.example");
    for (const r of [onDomain, onSub, byHost, free]) {
      await follow(w.h, w.alice, r);
      await remoteFollows(store, r, w.bob.id);
    }
    await sql(store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", w.alice.id);
    await blockDomain(store, D);
    await drain(store);
    expect(await sql(store, "SELECT id FROM accounts WHERE suspension_source = 'domain' ORDER BY id")).toEqual(
      [onDomain, onSub, byHost].toSorted().map((id) => ({ id })),
    );
    // Both ways: alice's follows of them end with an Undo each, their follows of bob with a withdrawing Reject.
    expect(await sql(store, "SELECT account_id, target_account_id FROM follows ORDER BY id")).toEqual([
      { account_id: w.alice.id, target_account_id: free },
      { account_id: free, target_account_id: w.bob.id },
    ]);
    expect((await undos(store)).map((row) => row.n)).toEqual([1, 1, 1]);
    expect(await rejects(store)).toHaveLength(3);
    expect((await rejects(store)).every((row) => row.retracts === 1 && row.signer === w.bob.id)).toBe(true);
    expect(await jobs(store)).toEqual([]);
  });

  it("block, 2 rounds, unblock, 1 round, block again: every account marked, each follow severed once", async () => {
    const w = await world();
    const store = w.h.store;
    await followedOn(w, 3_000);
    const first = await blockDomain(store, D);
    await rounds(store, 2);
    expect(await marked(store)).toBeGreaterThan(0);
    await unblockDomain(store, first.id);
    await rounds(store, 1);
    // While d is unblocked, bob follows one of its accounts (a request, until its server accepts).
    const [late] = await sql<{ id: string }>(store, "SELECT id FROM accounts WHERE domain = ? ORDER BY id LIMIT 1", D);
    await follow(w.h, w.bob, late!.id);
    await blockDomain(store, D);
    await drain(store);
    expect(await marked(store)).toBe(3_000);
    expect(await followsOn(store)).toBe(0);
    const undone = await undos(store);
    expect(undone).toHaveLength(3_001);
    expect(undone.every((row) => row.n === 1)).toBe(true);
    expect(await sql(store, "SELECT following_count FROM accounts WHERE id = ?", w.alice.id)).toEqual([
      { following_count: 0 },
    ]);
  });

  it("suspend → noop → suspend by PUT, then a transition between every round, converges the same way", async () => {
    const w = await world();
    const store = w.h.store;
    await followedOn(w, 600);
    const block = await blockDomain(store, D);
    await rounds(store, 3);
    await setSeverity(store, block.id, "noop");
    await rounds(store, 1);
    await setSeverity(store, block.id, "suspend");
    // A transition between every round, for 20 rounds, ending under suspend.
    for (let i = 0; i < 20; i++) {
      await round(store);
      await setSeverity(store, block.id, i % 2 === 0 ? "noop" : "suspend");
    }
    await drain(store);
    expect(await marked(store)).toBe(600);
    expect(await followsOn(store)).toBe(0);
    expect((await undos(store)).every((row) => row.n === 1)).toBe(true);
    expect(await undos(store)).toHaveLength(600);
  });

  it("nested blocks; unblocking the child keeps its accounts marked, unblocking the parent clears them", async () => {
    const w = await world();
    const store = w.h.store;
    const x = await remoteAccount(store, "x", `a.${D}`);
    const child = await blockDomain(store, `a.${D}`);
    const parent = await blockDomain(store, D);
    await drain(store);
    await unblockDomain(store, child.id);
    await drain(store);
    expect(await adminEntity(w, x)).toMatchObject({ suspended: true });
    expect(await sql(store, "SELECT suspension_source FROM accounts WHERE id = ?", x)).toEqual([
      { suspension_source: "domain" },
    ]);
    await unblockDomain(store, parent.id);
    // The mark lags until the job clears it; availability does not read it.
    expect(await adminEntity(w, x)).toMatchObject({ suspended: false });
    await drain(store);
    expect(await sql(store, "SELECT suspended_at, suspension_source FROM accounts WHERE id = ?", x)).toEqual([
      { suspended_at: null, suspension_source: null },
    ]);
  });

  it("a child noop exempts its accounts from the parent suspend: neither marked nor severed", async () => {
    const w = await world();
    const store = w.h.store;
    const kept = await remoteAccount(store, "k", `a.${D}`);
    const taken = await remoteAccount(store, "t", D);
    await remoteFollows(store, kept, w.bob.id);
    await remoteFollows(store, taken, w.bob.id);
    await blockDomain(store, `a.${D}`, "noop");
    await blockDomain(store, D);
    await drain(store);
    expect(await sql(store, "SELECT id FROM accounts WHERE suspension_source = 'domain'")).toEqual([{ id: taken }]);
    expect(await sql(store, "SELECT account_id FROM follows")).toEqual([{ account_id: kept }]);
  });

  it("deleting a child noop under the suspended parent resets the job, which marks and severs its accounts", async () => {
    const w = await world();
    const store = w.h.store;
    const x = await remoteAccount(store, "x", `a.${D}`);
    await remoteFollows(store, x, w.bob.id);
    const child = await blockDomain(store, `a.${D}`, "noop");
    await blockDomain(store, D);
    await drain(store);
    expect(await marked(store, `a.${D}`)).toBe(0);
    expect(await jobs(store)).toEqual([]);
    await unblockDomain(store, child.id);
    expect(await jobs(store)).toEqual([{ kind: "domain", subject: "", mode: "domain", phase: "clear", cursor: "" }]);
    await drain(store);
    expect(await marked(store, `a.${D}`)).toBe(1);
    expect(await sql(store, "SELECT * FROM follows WHERE account_id = ?", x)).toEqual([]);
    expect(await rejects(store)).toEqual([{ signer: w.bob.id, follower: await uriOf(store, x), retracts: 1 }]);
  });

  it("reconciles at most MARK_ACCOUNTS accounts a round, the one it resumes included", async () => {
    const w = await world();
    const store = w.h.store;
    // The first covered account by id has more local followers than a round ends; MARK_ACCOUNTS + 50 come after it.
    const first = await remoteAccount(store, "first", D);
    await localAccounts(store, SEVER_ROUND);
    await sql(
      store,
      `INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts
			WHERE id LIKE '5000%'`,
      first,
    );
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, created_at)
			SELECT printf('%018d', CAST(?2 AS INTEGER) + i), 'https://d.example/users/m' || i, 'm' || i, 'd.example', ?3 FROM n`,
      MARK_ACCOUNTS + 50,
      BASE,
      new Date(NOW).toISOString(),
    );
    expect(first < String(BASE)).toBe(true);
    await blockDomain(store, D);
    let resumed = 0;
    for (;;) {
      const [job] = await sql<{ cursor: string; phase: string }>(
        store,
        "SELECT phase, cursor FROM remote_moderation_jobs",
      );
      if (job === undefined) {
        break;
      }
      const resuming = job.phase === "mark" && (JSON.parse(job.cursor) as { severing?: string }).severing !== undefined;
      const before = await marked(store);
      await round(store);
      if (resuming) {
        resumed++;
        // The resumed account was marked already: at most MARK_ACCOUNTS - 1 more.
        expect((await marked(store)) - before).toBeLessThanOrEqual(MARK_ACCOUNTS - 1);
      }
    }
    expect(resumed).toBeGreaterThan(0);
    expect(await marked(store)).toBe(MARK_ACCOUNTS + 51);
  });

  it("removes a follower’s list memberships of an account in bounded rounds, legacy lists beyond the API limit", async () => {
    const w = await world();
    const store = w.h.store;
    const r = await remoteAccount(store, "r", D);
    await follow(w.h, w.alice, r);
    await sql(store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", w.alice.id);
    // As a converted instance keeps them: 700 of alice's lists, each with r, and one of bob's.
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 700 - 1)
			INSERT INTO lists (id, account_id, title) SELECT printf('7%017d', i), ?, 'l' || i FROM n`,
      w.alice.id,
    );
    await sql(store, "INSERT INTO lists (id, account_id, title) VALUES ('800000000000000000', ?, 'b')", w.bob.id);
    await sql(store, "INSERT INTO list_accounts (list_id, account_id) SELECT id, ? FROM lists", r);
    await blockDomain(store, D);
    const rounds = await drain(store);
    expect(rounds).toBeGreaterThan(3);
    expect(await sql(store, "SELECT * FROM follows WHERE target_account_id = ?", r)).toEqual([]);
    expect(await sql(store, "SELECT list_id FROM list_accounts")).toEqual([{ list_id: "800000000000000000" }]);
    expect((await undos(store)).map((row) => row.n)).toEqual([1]);
  });

  it("unblock, then correct the stored domain before clearing: active, and no mark left", async () => {
    const w = await world();
    const store = w.h.store;
    // r's address is confirmed on d, while its actor lives on moved.example.
    const r = await remoteAccount(store, "r", D);
    const uri = "https://moved.example/users/r";
    await sql(store, "UPDATE accounts SET uri = ?, confirmed_username = 'r' WHERE id = ?", uri, r);
    const block = await blockDomain(store, D);
    await drain(store);
    expect(await marked(store)).toBe(1);
    await unblockDomain(store, block.id);
    // A permitted refresh corrects its stored domain to its host: the same transaction reconciles the mark.
    const refreshed = await runInDurableObject(store, (_instance, state) =>
      state.storage.transactionSync(() => {
        const db = new Db(state.storage.sql);
        upsertRemoteActor(db, { ...ACTOR, uri, username: "r", confirmedDomain: "moved.example" }, ORIGIN, NOW);
        return db.all("SELECT domain, suspended_at, suspension_source FROM accounts WHERE id = ?", r);
      }),
    );
    expect(refreshed).toEqual([{ domain: "moved.example", suspended_at: null, suspension_source: null }]);
    await drain(store);
    const response = await w.h.request("/api/v2/admin/accounts?origin=remote&status=active", bearer(w.admin));
    expect((await response.json<{ id: string }[]>()).map((a) => a.id)).toContain(r);
    expect(await sql(store, "SELECT suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspension_source: null },
    ]);
  });

  it("the clearing walk finds a mark whatever the stored domain is now", async () => {
    const w = await world();
    const store = w.h.store;
    const r = await remoteAccount(store, "r", D);
    const block = await blockDomain(store, D);
    await drain(store);
    await unblockDomain(store, block.id);
    // The stored domain changes without a refresh (as a row restored from a dump would): only the mark index finds it.
    await sql(store, "UPDATE accounts SET domain = 'moved.example', uri = 'https://moved.example/u/r' WHERE id = ?", r);
    await drain(store);
    expect(await marked(store, "moved.example")).toBe(0);
    const response = await w.h.request("/api/v2/admin/accounts?origin=remote&status=active", bearer(w.admin));
    expect((await response.json<{ id: string }[]>()).map((a) => a.id)).toContain(r);
  });
});

describe("an individual suspension and a block on one account", () => {
  async function setup() {
    const w = await world();
    const r = await remoteAccount(w.h.store, "r", D);
    await follow(w.h, w.alice, r);
    await sql(w.h.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", w.alice.id);
    await remoteFollows(w.h.store, r, w.bob.id);
    return { w, r };
  }

  it("suspended, then blocked: its local follows are kept; unblocked: still suspended; unsuspended: available", async () => {
    const { w, r } = await setup();
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    const block = await blockDomain(w.h.store, D);
    await settle(w.h.store);
    expect(await sql(w.h.store, "SELECT account_id FROM follows WHERE target_account_id = ?", r)).toEqual([
      { account_id: w.alice.id },
    ]);
    expect(await sql(w.h.store, "SELECT suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspension_source: "account" },
    ]);
    await unblockDomain(w.h.store, block.id);
    await settle(w.h.store);
    expect(await adminEntity(w, r)).toMatchObject({ suspended: true });
    expect(await unsuspend(w, r)).toMatchObject({ status: 200, body: { suspended: false } });
    expect(await sql(w.h.store, "SELECT suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspension_source: null },
    ]);
  });

  it("suspended and blocked, unsuspended first: 200, suspended by the domain, severed; unblocked: available", async () => {
    const { w, r } = await setup();
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    const block = await blockDomain(w.h.store, D);
    await settle(w.h.store);
    const answer = await unsuspend(w, r);
    expect(answer).toMatchObject({ status: 200, body: { id: r, suspended: true } });
    expect(await sql(w.h.store, "SELECT suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspension_source: "domain" },
    ]);
    // Held only by the block now: unsuspending again is refused, as lowering the block is the way.
    expect(await unsuspend(w, r)).toEqual({ status: 403, body: { error: "This action is not allowed" } });
    await settle(w.h.store);
    expect(await sql(w.h.store, "SELECT * FROM follows WHERE ? IN (account_id, target_account_id)", r)).toEqual([]);
    await unblockDomain(w.h.store, block.id);
    await settle(w.h.store);
    expect(await adminEntity(w, r)).toMatchObject({ suspended: false });
    expect(await sql(w.h.store, "SELECT suspended_at, suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspended_at: null, suspension_source: null },
    ]);
  });

  it("blocked first, then suspended: account wins; unsuspending converts back to the domain mark", async () => {
    const { w, r } = await setup();
    await blockDomain(w.h.store, D);
    await settle(w.h.store);
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    expect(await sql(w.h.store, "SELECT suspension_source FROM accounts WHERE id = ?", r)).toEqual([
      { suspension_source: "account" },
    ]);
    expect(await unsuspend(w, r)).toMatchObject({ status: 200, body: { suspended: true } });
    expect(await jobs(w.h.store)).toEqual([{ kind: "account", subject: r, mode: "domain", phase: "out", cursor: "" }]);
    await settle(w.h.store);
    expect(await jobs(w.h.store)).toEqual([]);
  });
});

describe("the conversion mode", () => {
  // r is suspended with its job held before its follows phase; d is blocked and its job run to its end (it skips r,
  // individually suspended). r has a pending request to locked carol, and alice and bob follow r.
  async function converted() {
    const w = await world();
    const store = w.h.store;
    const r = await remoteAccount(store, "r", D);
    await sql(store, "UPDATE accounts SET locked = 1 WHERE id = ?", w.carol.id);
    expect(
      await receive(store, await uriOf(store, r), { type: "Follow", object: await uriOf(store, w.carol.id) }),
    ).toMatchObject({ applied: true });
    await follow(w.h, w.alice, r);
    await follow(w.h, w.bob, r);
    await sql(store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", w.alice.id);
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    await blockDomain(store, D);
    const [account, domain] = await sql<{ id: string }>(
      store,
      "SELECT CAST(id AS TEXT) AS id FROM remote_moderation_jobs ORDER BY id",
    );
    for (let i = 0; i < 10 && (await jobs(store)).length > 1; i++) {
      await round(store, account!.id);
    }
    expect((await jobs(store)).map((job) => job.kind)).toEqual(["account"]);
    expect(domain).toBeDefined();
    expect(await count(store, "SELECT 1 FROM follows WHERE ? IN (account_id, target_account_id)", r)).toBe(3);
    return { w, store, r };
  }

  it("removes r's pending request to locked carol, and alice's and bob's follows of r", async () => {
    const { w, store, r } = await converted();
    expect(await unsuspend(w, r)).toMatchObject({ status: 200, body: { suspended: true } });
    await drain(store);
    expect(await sql(store, "SELECT * FROM follows WHERE ? IN (account_id, target_account_id)", r)).toEqual([]);
    // The request goes without a Reject; alice's accepted follow and bob's request each with their Undo.
    expect(await rejects(store)).toEqual([]);
    expect(await undos(store)).toHaveLength(2);
  });

  it("leaves alice's and bob's follows of r when r is suspended again before the conversion's round", async () => {
    const { w, store, r } = await converted();
    expect(await unsuspend(w, r)).toMatchObject({ status: 200 });
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    expect((await jobs(store))[0]).toMatchObject({ mode: "account" });
    await drain(store);
    expect(
      await sql(store, "SELECT account_id FROM follows WHERE target_account_id = ? ORDER BY account_id", r),
    ).toEqual([w.alice.id, w.bob.id].toSorted().map((id) => ({ account_id: id })));
    expect(await undos(store)).toEqual([]);
  });
});

describe("the account job reset, with the conversion mode", () => {
  it("gated before its Rejects: block, unsuspend (converted), suspend again; one withdrawing Reject each", async () => {
    const w = await world();
    const store = w.h.store;
    const r = await remoteAccount(store, "r", D);
    for (const local of [w.alice, w.bob, w.carol]) {
      await remoteFollows(store, r, local.id);
    }
    await follow(w.h, w.dan, r);
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    await toFollows(store);
    const block = await blockDomain(store, D);
    expect(await unsuspend(w, r)).toMatchObject({ status: 200, body: { suspended: true } });
    expect((await jobs(store))[0]).toMatchObject({ kind: "account", mode: "domain", phase: "out" });
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    expect((await jobs(store))[0]).toMatchObject({ kind: "account", mode: "account", phase: "reports" });
    await drain(store);
    const uri = await uriOf(store, r);
    expect((await rejects(store)).map((row) => [row.signer, row.follower, row.retracts]).toSorted(byText)).toEqual(
      [w.alice.id, w.bob.id, w.carol.id].map((id) => [id, uri, 1]).toSorted(byText),
    );
    // The suspension again keeps dan's follow of r (account wins), and the domain job skipped r.
    expect(await sql(store, "SELECT account_id FROM follows WHERE target_account_id = ?", r)).toEqual([
      { account_id: w.dan.id },
    ]);
    // Unsuspended again while covered, then unblocked before its round: the stale mode ends the job, nothing severed.
    expect(await unsuspend(w, r)).toMatchObject({ status: 200, body: { suspended: true } });
    await unblockDomain(store, block.id);
    await drain(store);
    expect(await sql(store, "SELECT account_id FROM follows WHERE target_account_id = ?", r)).toEqual([
      { account_id: w.dan.id },
    ]);
    expect(await adminEntity(w, r)).toMatchObject({ suspended: false });
  });
});

describe("the admin lists while the marks lag", () => {
  const ACCOUNTS = 50_000;
  const OTHERS = 100;

  async function list(w: World, query: string): Promise<{ status: number; ids: string[]; retry: string | null }> {
    const response = await w.h.request(`/api/v2/admin/accounts?${query}`, bearer(w.admin));
    const body = await response.json<{ id: string }[] | { error: string }>();
    if (response.status !== 200) {
      expect(body).toEqual({ error: "moderation in progress, try again" });
    }
    return {
      status: response.status,
      ids: Array.isArray(body) ? body.map((a) => a.id) : [],
      retry: response.headers.get("retry-after"),
    };
  }

  it(`pages ${ACCOUNTS} accounts of d before, during and after marking, and after an unblock (max_id)`, async () => {
    const w = await world();
    const store = w.h.store;
    // d's accounts at even offsets, other.example's spread among them at odd ones.
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, created_at)
			SELECT printf('%018d', CAST(?2 AS INTEGER) + 2 * i), 'https://d.example/users/u' || i, 'u' || i, 'd.example', ?3 FROM n`,
      ACCOUNTS,
      BASE,
      new Date(NOW).toISOString(),
    );
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, created_at)
			SELECT printf('%018d', CAST(?2 AS INTEGER) + 1 + 2 * i * CAST(?3 / ?1 AS INTEGER)), 'https://other.example/users/o' || i, 'o' || i,
				'other.example', ?4 FROM n`,
      OTHERS,
      BASE,
      ACCOUNTS,
      new Date(NOW).toISOString(),
    );
    const others = (await sql<{ id: string }>(store, "SELECT id FROM accounts WHERE domain = 'other.example'")).map(
      (row) => row.id,
    );
    // Fedilab's paging: page 1 before the block, then max_id from its last account.
    const first = await list(w, "origin=remote&status=active&limit=40");
    expect(first.ids).toHaveLength(40);
    const maxId = first.ids.at(-1)!;
    const block = await blockDomain(store, D);
    const during = async () => {
      for (const query of [`origin=remote&status=active&limit=40&max_id=${maxId}`, "status=suspended&limit=40"]) {
        expect(await list(w, query)).toMatchObject({ status: 503, ids: [], retry: "30" });
      }
    };
    await during();
    // Across the walk's windows and the marking rounds, never a short or empty 200.
    let calls = 0;
    while ((await runStoreJobs(store, BUILD, { now: NOW })).pending) {
      if (++calls % 40 === 0) {
        await during();
      }
    }
    expect(calls).toBeGreaterThanOrEqual(ACCOUNTS / MARK_ACCOUNTS / 4);
    expect(await marked(store)).toBe(ACCOUNTS);
    // After: the next active page holds only other.example's accounts below max_id, the suspended list d's.
    const next = await list(w, `origin=remote&status=active&limit=40&max_id=${maxId}`);
    expect(next.status).toBe(200);
    expect(next.ids).toEqual(
      others
        .filter((id) => id < maxId)
        .toSorted()
        .reverse()
        .slice(0, 40),
    );
    const suspended = await list(w, "status=suspended&limit=40");
    expect(suspended.ids).toHaveLength(40);
    const second = await list(w, `status=suspended&limit=40&max_id=${suspended.ids.at(-1)}`);
    expect(second.ids).toHaveLength(40);
    expect(second.ids[0]! < suspended.ids.at(-1)!).toBe(true);
    // Unblock: both answer 503 while the marks are cleared, then active lists d's accounts again.
    await unblockDomain(store, block.id);
    await round(store);
    await during();
    await settle(store);
    expect(await marked(store)).toBe(0);
    const again = await list(w, `origin=remote&status=active&limit=40&max_id=${maxId}`);
    expect(again.ids).toHaveLength(40);
    expect(again.ids.some((id) => !others.includes(id))).toBe(true);
    expect(await list(w, "status=suspended&limit=40")).toMatchObject({ status: 200, ids: [] });
  }, 300_000);
});

describe("Queue and cron rounds interleaved under a gate", () => {
  // A Store whose runInboundJobs holds its caller before the call until released: the Queue consumer stops at the
  // Store call of its rounds, while the cron's rounds and the admin's transitions commit.
  function gated(store: StoreStub) {
    const reached = deferred();
    const release = deferred();
    const proxy = new Proxy(store, {
      get(target, key) {
        if (key === "runInboundJobs") {
          return async (...args: Parameters<StoreStub["runInboundJobs"]>) => {
            reached.resolve();
            await release.promise;
            return target.runInboundJobs(...args);
          };
        }
        return Reflect.get(target, key) as unknown;
      },
    });
    return { proxy, reached: reached.promise, release: release.resolve };
  }

  // `n` local accounts, each followed by `r` (accepted): more than one severing round ends.
  async function followedByR(store: StoreStub, r: string, n: number): Promise<void> {
    await localAccounts(store, n);
    await sql(
      store,
      `INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts
			WHERE id LIKE '5000%'`,
      r,
    );
  }

  it("account and domain jobs: each generation’s follows are severed once, and the marks converge", async () => {
    const w = await world();
    const store = w.h.store;
    const sim = new QueueSim();
    const env = { ...w.h.env, QUEUE: sim.queue, MAINTENANCE: "off" } as unknown as Env;
    const deps = inboxDeps(() => store);
    await followedOn(w, 400);
    const r = await remoteAccount(store, "r");
    await followedByR(store, r, 150);
    const block = await blockDomain(store, D);
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    const gate = gated(store);
    await requestInboundJobs(env.QUEUE);
    const queue = sim.deliver((batch) =>
      handleQueue(
        batch,
        env,
        inboxDeps(() => gate.proxy),
      ),
    );
    await gate.reached;
    // At the gate the Queue's round has not run; the cron's round runs and leaves both jobs unfinished.
    expect((await jobs(store)).map((job) => job.kind).toSorted()).toEqual(["account", "domain"]);
    await runScheduledJobs(env, deps);
    expect((await jobs(store)).map((job) => job.kind).toSorted()).toEqual(["account", "domain"]);
    expect(await count(store, "SELECT 1 FROM follows WHERE account_id = ?", r)).toBeGreaterThan(0);
    // The admin unblocks and unsuspends; r follows dan meanwhile (a second generation); both decisions come back.
    await unblockDomain(store, block.id);
    expect(await unsuspend(w, r)).toMatchObject({ status: 200 });
    expect(
      await receive(store, await uriOf(store, r), { type: "Follow", object: await uriOf(store, w.dan.id) }),
    ).toMatchObject({ applied: true });
    await runScheduledJobs(env, deps);
    await blockDomain(store, D);
    expect(await act(w, r, { type: "suspend" })).toMatchObject({ status: 200 });
    gate.release();
    await queue;
    // The Queue and the cron take turns until the jobs end.
    for (let i = 0; i < 400 && (await jobs(store)).length > 0; i++) {
      await sim.deliver((batch) => handleQueue(batch, env, deps));
      await runScheduledJobs(env, deps);
    }
    expect(await jobs(store)).toEqual([]);
    expect(await marked(store)).toBe(400);
    expect(await followsOn(store)).toBe(0);
    const undone = await undos(store);
    expect(undone).toHaveLength(400);
    expect(undone.every((row) => row.n === 1)).toBe(true);
    // r's follows of both generations: each of the 150 and dan's, a withdrawing Reject each, once.
    expect(await count(store, "SELECT 1 FROM follows WHERE account_id = ?", r)).toBe(0);
    const rejected = await rejects(store);
    expect(rejected).toHaveLength(151);
    expect(new Set(rejected.map((row) => row.signer)).size).toBe(151);
    expect(rejected.map((row) => row.signer)).toContain(w.dan.id);
    expect(rejected.every((row) => row.retracts === 1)).toBe(true);
  });
});

describe("a user’s domain block cleanup and the instance job, interleaved", () => {
  it("ends each follow once, whichever removes it first", async () => {
    const w = await world();
    const store = w.h.store;
    await followedOn(w, 300);
    await sql(store, `UPDATE follows SET state = 'accepted'`);
    // alice blocks d herself: the first batch runs in the request, the rest in rounds.
    const response = await w.h.request("/api/v1/domain_blocks", bearer(w.alice.token, form({ domain: D })));
    expect(response.status).toBe(200);
    await blockDomain(store, D);
    await rounds(store, 3);
    await settle(store);
    expect(await followsOn(store)).toBe(0);
    const undone = await undos(store);
    expect(undone).toHaveLength(300);
    expect(undone.every((row) => row.n === 1)).toBe(true);
    expect(await marked(store)).toBe(300);
  });
});

describe("bounds of the rounds (growth: reads others control)", () => {
  // The rows one round reads and writes, by the production round in its own transaction.
  async function measured(store: StoreStub): Promise<{ read: number; written: number } | null> {
    return runInDurableObject(store, (_instance, state) =>
      state.storage.transactionSync(() => {
        const real = state.storage.sql;
        const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
        const counting = {
          exec: (query: string, ...params: SqlStorageValue[]) => {
            const cursor = real.exec(query, ...params);
            cursors.push(cursor);
            return cursor;
          },
        } as unknown as SqlStorage;
        const db = new Db(counting, (fn) => state.storage.transactionSync(fn));
        const before = db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
        const ran = remoteModerationRound(db, NOW);
        const written = db.first<{ n: number }>("SELECT total_changes() AS n")!.n - before;
        return ran === null ? null : { read: cursors.reduce((sum, c) => sum + c.rowsRead, 0), written };
      }),
    );
  }

  it("a marking round reads a bounded window however many accounts or marks there are", async () => {
    const w = await world();
    const store = w.h.store;
    // 3 windows of accounts covered only every 7th, and as many already-marked stale accounts.
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, created_at, suspended_at, suspension_source)
			SELECT printf('%018d', CAST(?2 AS INTEGER) + i), 'https://' || CASE WHEN i % 7 = 0 THEN 'd.example' ELSE 'e.example' END || '/u/' || i,
				'u' || i, CASE WHEN i % 7 = 0 THEN 'd.example' ELSE 'e.example' END, ?3,
				CASE WHEN i % 3 = 0 AND i % 7 <> 0 THEN ?3 END, CASE WHEN i % 3 = 0 AND i % 7 <> 0 THEN 'domain' END FROM n`,
      3 * MARK_WINDOW,
      BASE,
      new Date(NOW).toISOString(),
    );
    await blockDomain(store, D);
    let maxRead = 0;
    let n = 0;
    for (let ran = await measured(store); ran !== null; ran = await measured(store)) {
      expect(ran.written).toBeLessThanOrEqual(MODERATION_ROUND_ROWS);
      maxRead = Math.max(maxRead, ran.read);
      n++;
    }
    // A clearing round reads its window of suspended accounts, a marking round its window of accounts (twice: the
    // window's end, then the matches), each with the blocks a predicate seeks per account.
    expect(maxRead).toBeLessThan(40 * Math.max(CLEAR_ROUND, MARK_WINDOW));
    expect(n).toBeGreaterThan(3);
    expect(await marked(store)).toBe(Math.ceil((3 * MARK_WINDOW) / 7));
    expect(await count(store, "SELECT 1 FROM accounts WHERE domain = 'e.example' AND suspended_at IS NOT NULL")).toBe(
      0,
    );
  });

  // r on d with `followers` of LOCALS local accounts following it (the same accounts either way, so the marking
  // window reads the same); the most rows a round read, and the rounds, until the job ended.
  const LOCALS = SEVER_ROUND * 6 + 5;
  async function severed(followers: number): Promise<{ maxRead: number; rounds: number }> {
    const w = await world();
    const store = w.h.store;
    const r = await remoteAccount(store, "r", D);
    await localAccounts(store, LOCALS);
    await sql(
      store,
      `INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts
			WHERE id LIKE '5000%' ORDER BY id LIMIT ?`,
      r,
      followers,
    );
    await blockDomain(store, D);
    let maxRead = 0;
    let rounds = 0;
    for (let ran = await measured(store); ran !== null; ran = await measured(store)) {
      expect(ran.written).toBeLessThanOrEqual(MODERATION_ROUND_ROWS);
      maxRead = Math.max(maxRead, ran.read);
      rounds++;
    }
    expect(await count(store, "SELECT 1 FROM follows WHERE target_account_id = ?", r)).toBe(0);
    expect(await undos(store)).toHaveLength(followers);
    return { maxRead, rounds };
  }

  it("an account's severing reads the same rows a round with 2 or 6 rounds' worth of local followers", async () => {
    const small = await severed(SEVER_ROUND * 2 + 5);
    const large = await severed(LOCALS);
    expect(small.rounds).toBeGreaterThan(3);
    expect(large.rounds).toBeGreaterThan(small.rounds);
    expect(large.maxRead).toBeLessThanOrEqual(small.maxRead * 1.1);
  });
});

describe("the clearing walk with stale statistics (RES-7)", () => {
  const moderationRound = writeOperation<undefined, unknown>((db) => remoteModerationRound(db, NOW));

  it("restores each stale account by id, the accounts grown after ANALYZE", async () => {
    const w = await world();
    const store = w.h.store;
    const blocks: { id: number }[] = [];
    for (const domain of ["one.example", "two.example"]) {
      for (const name of ["x", "y", "z"]) {
        await remoteAccount(store, name, domain);
      }
      blocks.push(await blockDomain(store, domain));
      await drain(store);
    }
    // The domain's unblock, then rounds until the job is done: the clearing walk's restores.
    const lift = async (block: { id: number }, domain: string) => {
      await unblockDomain(store, block.id);
      const plans: PlannedStatement[] = [];
      for (let i = 0; i < 50; i++) {
        const ran = await plannedRun(w.h, /^\s*UPDATE accounts INDEXED BY/, moderationRound, undefined);
        plans.push(...ran.plans);
        if (ran.result === null) {
          break;
        }
      }
      expect(await marked(store, domain)).toBe(0);
      return plans;
    };
    const { before, after } = await staleStatistics(w.h, {
      capture: (phase) => (phase === "before" ? lift(blocks[0]!, "one.example") : lift(blocks[1]!, "two.example")),
      grow: () => remoteAccounts(w.h, 100, 200),
    });
    expect(after).toHaveLength(1);
    const { plan, rows } = after[0]!;
    expect(plan).toContain("SEARCH accounts USING INDEX sqlite_autoindex_accounts_1 (id=?)");
    expect(scansOf(plan, ["accounts"])).toEqual([]);
    expect(rows).toBe(before[0]!.rows);
  }, 60_000);
});
