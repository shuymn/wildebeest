import { afterEach, describe, expect, it, vi } from "vitest";

import { PURGE_BATCH } from "../src/domain/inbox";
import { JOB_RETRY_DELAYS_MS } from "../src/domain/job-attempts";
import { QUOTE_ROUND } from "../src/domain/quotes";
import { COLLECTION_SYNCS_PER_ROUND } from "../src/federation/collections";
import { handleQueue, jobsRound, STORE_JOB_FAMILIES } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, sql } from "./api-helpers";
import { countingStore, harness, heldStore, inboxDeps, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY } from "./federation-helpers";
import { completeSetup, migratedStore } from "./helpers";
import { mastodonActor, RemoteWeb, signedInit } from "./inbox-helpers";
import { ALICE, create, followed, mastodonNote, remove, setup, statusRow } from "./inbox-status-helpers";
import { failItem } from "./job-item-helpers";
import { QueueSim } from "./queue-sim";
import { deferred } from "./quote-helpers";
import { act, world } from "./remote-suspension-helpers";
import { remoteAccount } from "./status-helpers";

// The families of a jobs round (jobsRound in src/jobs/queue.ts) are separate Store calls and error boundaries: one
// family's failure stops no other, a Store that refuses (maintenance) ends the round with nothing counted, and a Queue
// batch runs one round however many nudges it holds (RES-5).

// The seven families: the Store call that runs each (two pairs share a call, and so its transaction), the rows that
// show its state, the work it still has, and a test trigger on a table only it writes in a round.
const FAMILIES = {
  inbound: {
    call: "inbound",
    state: "SELECT kind, key, done_at FROM inbound_jobs ORDER BY kind, key",
    work: "SELECT 1 FROM inbound_jobs WHERE done_at IS NULL",
    fail: ["BEFORE UPDATE ON inbound_jobs"],
  },
  revocations: {
    call: "inbound",
    state: "SELECT authorization, pending FROM quote_revocations ORDER BY authorization",
    work: "SELECT 1 FROM quote_revocations WHERE pending = 1",
    fail: ["BEFORE UPDATE ON quote_revocations"],
  },
  domain_block_cleanups: {
    call: "domain_block_cleanups",
    state: "SELECT domain_block_id, cursor FROM domain_block_cleanups ORDER BY domain_block_id",
    work: "SELECT 1 FROM domain_block_cleanups",
    fail: ["BEFORE UPDATE ON domain_block_cleanups", "BEFORE DELETE ON domain_block_cleanups"],
  },
  notification_requests: {
    call: "notification_requests",
    state: "SELECT id, cursor FROM notification_request_jobs ORDER BY id",
    work: "SELECT 1 FROM notification_request_jobs",
    fail: ["BEFORE UPDATE ON notification_request_jobs", "BEFORE DELETE ON notification_request_jobs"],
  },
  local_moderation: {
    call: "moderation",
    state: "SELECT id, kind, account_id, phase, state FROM moderation_jobs ORDER BY id",
    work: "SELECT 1 FROM moderation_jobs",
    fail: ["BEFORE UPDATE ON moderation_jobs", "BEFORE DELETE ON moderation_jobs"],
  },
  remote_moderation: {
    call: "moderation",
    state: "SELECT id, kind, subject, phase, cursor FROM remote_moderation_jobs ORDER BY id",
    work: "SELECT 1 FROM remote_moderation_jobs",
    fail: ["BEFORE UPDATE ON remote_moderation_jobs", "BEFORE DELETE ON remote_moderation_jobs"],
  },
  unlock_accepts: {
    call: "unlock_accepts",
    state: `SELECT f.id, f.state, CAST(l.accept_requests_after AS TEXT) AS after FROM follows f
			JOIN local_accounts l ON l.account_id = f.target_account_id
			JOIN accounts a ON a.id = f.target_account_id WHERE a.username = 'bob' ORDER BY f.id`,
    work: "SELECT 1 FROM local_accounts WHERE accept_requests_after IS NOT NULL",
    fail: ["BEFORE UPDATE OF accept_requests_after ON local_accounts"],
  },
} as const;

type Family = keyof typeof FAMILIES;
const NAMES = Object.keys(FAMILIES) as Family[];
// The Store calls of the families, sorted.
const STORE_CALLS = [
  "runDomainBlockCleanups",
  "runInboundJobs",
  "runModerationJobs",
  "runNotificationRequestJobs",
  "runUnlockAccepts",
];

const FAILED = "kopje.jobs.family.failed";
const JOBS = { kind: "inbound-jobs" };
const DELIVER = { kind: "deliver" };

afterEach(() => {
  vi.restoreAllMocks();
});

// The family failures jobsRound logs while `run` runs.
async function failuresOf(run: () => Promise<void>): Promise<unknown[]> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run();
    return errors.mock.calls.map(([entry]) => entry as { event?: string }).filter((entry) => entry.event === FAILED);
  } finally {
    errors.mockRestore();
  }
}

// Two items of due work in every family, each left as the path that records it leaves it: the admin API's
// suspensions, the credentials update that unlocks, and the rows the other writers record (their requests finish a
// small job in the request, so the rows stand in for a job left over).
async function seeded() {
  const w = await world();
  const store = w.h.store;
  await sql(store, "UPDATE local_accounts SET pubkey = ?", LEGACY.pubkey);
  // Inbound: two delete jobs of statuses already gone; a batch finishes each.
  await sql(
    store,
    `INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES
			('delete', '900000000000000001', 'https://one.example/users/x', ?1),
			('delete', '900000000000000002', 'https://one.example/users/x', ?1)`,
    NOW,
  );
  // Revocations: two stamps revoked by an actor Kopje does not store; a batch clears each.
  await sql(
    store,
    `INSERT INTO quote_revocations (authorization, actor_uri, revoked_at, pending) VALUES
			('https://one.example/stamps/1', 'https://one.example/users/y', ?1, 1),
			('https://one.example/stamps/2', 'https://one.example/users/y', ?1, 1)`,
    NOW,
  );
  // Domain block cleanups: alice follows an account of each of two domains, then blocks both (domain/blocks.ts
  // blockDomain's rows); each cleanup ends her follow with an Undo.
  for (const domain of ["u.example", "v.example"]) {
    const other = await remoteAccount(store, "u", domain);
    await sql(store, "UPDATE accounts SET inbox_url = uri || '/inbox' WHERE id = ?", other);
    await sql(
      store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      w.alice.id,
      other,
    );
    await sql(
      store,
      "INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, ?, ?)",
      w.alice.id,
      domain,
      NOW,
    );
    await sql(
      store,
      `INSERT INTO domain_block_cleanups (domain_block_id, bound, cursor, created_at)
			SELECT (SELECT id FROM domain_blocks WHERE account_id = ?1 AND domain = ?2), max(id), 0, ?3 FROM follows`,
      w.alice.id,
      domain,
      NOW,
    );
  }
  // Notification requests: two dismissed requests of alice's, with nothing left to dismiss.
  for (const name of ["n1", "n2"]) {
    const from = await remoteAccount(store, name, "n.example");
    await sql(
      store,
      "INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor) VALUES (?, ?, 'dismiss', 0)",
      w.alice.id,
      from,
    );
  }
  // Local and remote moderation: the admin suspends carol and dan, and two remote accounts.
  const remotes = [await remoteAccount(store, "s1", "s.example"), await remoteAccount(store, "s2", "s.example")];
  for (const id of [w.carol.id, w.dan.id, ...remotes]) {
    expect(await act(w, id, { type: "suspend" })).toMatchObject({ status: 200 });
  }
  // Unlock: bob, locked, has two pending requests, then unlocks.
  await sql(store, "UPDATE accounts SET locked = 1 WHERE id = ?", w.bob.id);
  for (const name of ["q1", "q2"]) {
    const requester = await remoteAccount(store, name, "q.example");
    await sql(
      store,
      "INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
      requester,
      w.bob.id,
      `https://q.example/follows/${name}`,
    );
  }
  const unlocked = await w.h.request(
    "/api/v1/accounts/update_credentials",
    bearer(w.bob.token, { ...json({ locked: false }), method: "PATCH" }),
  );
  expect(unlocked.status).toBe(200);
  return w;
}

async function snapshot(store: StoreStub): Promise<Record<Family, unknown>> {
  const entries = await Promise.all(NAMES.map(async (name) => [name, await sql(store, FAMILIES[name].state)] as const));
  return Object.fromEntries(entries) as Record<Family, unknown>;
}

async function working(store: StoreStub): Promise<Record<Family, boolean>> {
  const entries = await Promise.all(
    NAMES.map(async (name) => [name, (await sql(store, `${FAMILIES[name].work} LIMIT 1`)).length > 0] as const),
  );
  return Object.fromEntries(entries) as Record<Family, boolean>;
}

const kinds = (sim: QueueSim, kind: string) =>
  sim.pending.map((m) => m.body as { kind?: string }).filter((body) => body.kind === kind);

function jobsEnv(base: Env, sim: QueueSim): Env {
  return { ...base, QUEUE: sim.queue, MAINTENANCE: "off" } as unknown as Env;
}

describe("a family failure (RES-5)", () => {
  // A RAISE(ABORT) trigger makes one family's Store call throw on its first write; the round still runs every family
  // outside that call, and its pending and delivery ring come from them.
  it.each(NAMES)(
    "%s failing stops no family outside its Store call",
    async (failing) => {
      const w = await seeded();
      const store = w.h.store;
      const before = await snapshot(store);
      // Every family has work (so each progress below is the round's).
      expect(Object.values(await working(store))).toEqual(NAMES.map(() => true));
      const triggers = FAMILIES[failing].fail.map((_when, i) => `test_fails_${i}`);
      for (const [i, when] of FAMILIES[failing].fail.entries()) {
        await sql(
          store,
          `CREATE TRIGGER ${triggers[i]} ${when} BEGIN SELECT RAISE(ABORT, 'test: the family fails'); END`,
        );
      }
      const sim = new QueueSim();
      const env = jobsEnv(w.h.env, sim);
      const deps = inboxDeps(() => store);
      const failures = await failuresOf(() => jobsRound(env, deps));
      const call = FAMILIES[failing].call;
      expect(failures).toEqual([expect.objectContaining({ family: call })]);
      const after = await snapshot(store);
      for (const name of NAMES) {
        if (FAMILIES[name].call === call) {
          expect(after[name], name).toEqual(before[name]);
        } else {
          expect(after[name], name).not.toEqual(before[name]);
        }
      }
      // One jobs message exactly when a family outside the failing call has work left: the failing one counts none.
      const left = await working(store);
      const pending = NAMES.some((name) => FAMILIES[name].call !== call && left[name]);
      expect(kinds(sim, "inbound-jobs")).toEqual(pending ? [JOBS] : []);
      // The cleanups' Undo or the unlock's Accept was recorded outside the failing call, and rang once.
      expect(kinds(sim, "deliver")).toEqual([DELIVER]);
      // Without the trigger, the failing family runs in the next round.
      for (const trigger of triggers) {
        await sql(store, `DROP TRIGGER ${trigger}`);
      }
      expect(await failuresOf(() => jobsRound(env, deps))).toEqual([]);
      const recovered = await snapshot(store);
      for (const name of NAMES.filter((n) => FAMILIES[n].call === call)) {
        expect(recovered[name], name).not.toEqual(before[name]);
      }
    },
    60_000,
  );
});

// The first item of each family as its round takes it, by its key: a test trigger on that item alone fails its batch
// at its own row's write (each batch writes its row: a cursor, a phase, an end), while the retry state's writes pass.
// Unlock acceptances keep no retry state: their first request's authorization fails instead (null).
const FIRST_ITEMS: Record<Family, { table: string; key: readonly string[]; first: string } | null> = {
  inbound: {
    table: "inbound_jobs",
    key: ["kind", "key"],
    first: "SELECT kind, key FROM inbound_jobs ORDER BY created_at, kind, key LIMIT 1",
  },
  revocations: {
    table: "quote_revocations",
    key: ["authorization", "actor_uri"],
    first: "SELECT authorization, actor_uri FROM quote_revocations ORDER BY revoked_at, authorization LIMIT 1",
  },
  domain_block_cleanups: {
    table: "domain_block_cleanups",
    key: ["domain_block_id"],
    first: "SELECT domain_block_id FROM domain_block_cleanups ORDER BY created_at, domain_block_id LIMIT 1",
  },
  notification_requests: {
    table: "notification_request_jobs",
    key: ["id"],
    first: "SELECT id FROM notification_request_jobs ORDER BY id LIMIT 1",
  },
  local_moderation: {
    table: "moderation_jobs",
    key: ["id"],
    first: "SELECT id FROM moderation_jobs ORDER BY id LIMIT 1",
  },
  remote_moderation: {
    table: "remote_moderation_jobs",
    key: ["id"],
    first: "SELECT id FROM remote_moderation_jobs ORDER BY id LIMIT 1",
  },
  unlock_accepts: null,
};

describe("an item failure (RES-5)", () => {
  // The first item of one family fails; the round records it on the item and runs every other item of every family,
  // its own family's second item included, with no family failure.
  it.each(NAMES)(
    "%s: its first item failing is recorded on it, and stops no other item",
    async (failing) => {
      const w = await seeded();
      const store = w.h.store;
      const before = await snapshot(store);
      const item = FIRST_ITEMS[failing];
      let first: Record<string, SqlStorageValue>;
      let request: { id: number } | undefined;
      if (item === null) {
        [request] = await sql<{ id: number }>(
          store,
          "SELECT f.id FROM follows f JOIN accounts a ON a.id = f.target_account_id WHERE a.username = 'bob' ORDER BY f.id LIMIT 1",
        );
        await sql(
          store,
          `CREATE TRIGGER test_item_fails BEFORE UPDATE ON follows WHEN OLD.id = ${request!.id}
					BEGIN SELECT RAISE(ABORT, 'test: the item fails'); END`,
        );
      } else {
        [first] = (await sql<Record<string, SqlStorageValue>>(store, item.first)) as [Record<string, SqlStorageValue>];
        await failItem(store, item.table, first, "test_item_fails");
      }
      const row = () =>
        item === null
          ? sql(store, "SELECT state FROM follows WHERE id = ?", request!.id)
          : sql<Record<string, SqlStorageValue>>(
              store,
              `SELECT * FROM ${item.table} WHERE ${item.key.map((column) => `${column} = ?`).join(" AND ")}`,
              ...item.key.map((column) => first[column]!),
            );
      const [held] = await row();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const sim = new QueueSim();
      await jobsRound(
        jobsEnv(w.h.env, sim),
        inboxDeps(() => store),
      );
      const events = errors.mock.calls.map(([entry]) => entry as { event?: string; family?: string });
      expect(events.filter((entry) => entry.event === FAILED)).toEqual([]);
      // The item was rolled back and recorded: an attempt on its row, or the unlock's request passed over, pending.
      if (item === null) {
        expect(await row()).toEqual([{ state: "pending" }]);
        expect(events).toContainEqual(expect.objectContaining({ event: "kopje.jobs.step.failed", family: failing }));
      } else {
        expect(await row()).toEqual([{ ...held, attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]! }]);
        expect(events).toContainEqual(
          expect.objectContaining({ event: "kopje.jobs.item.failed", attempts: 1, parked: false }),
        );
      }
      // Every family progressed, the failing one by its other item.
      const after = await snapshot(store);
      for (const name of NAMES) {
        expect(after[name], name).not.toEqual(before[name]);
      }
    },
    60_000,
  );
});

describe("maintenance (RES-5)", () => {
  it("ends the round at its first Store call while the Store is readonly, and runs every family once it is not", async () => {
    const w = await seeded();
    const store = w.h.store;
    const before = await snapshot(store);
    expect(await store.setMaintenance(w.h.env.CF_VERSION_METADATA.id, true)).toEqual({ maintenance: true });
    const counting = countingStore(store);
    const sim = new QueueSim();
    const env = jobsEnv(w.h.env, sim);
    const deps = inboxDeps(() => counting.stub);
    expect(await failuresOf(() => jobsRound(env, deps))).toEqual([]);
    expect(counting.calls.filter((name) => STORE_CALLS.includes(name))).toEqual(["runInboundJobs"]);
    expect(counting.records.find((record) => record.name === "runInboundJobs")?.error).toBeDefined();
    expect(await snapshot(store)).toEqual(before);
    expect(sim.pending).toEqual([]);
    // The guarded branch: out of maintenance the same round calls every family and each progresses.
    expect(await store.setMaintenance(w.h.env.CF_VERSION_METADATA.id, false)).toEqual({ maintenance: false });
    counting.calls.length = 0;
    expect(await failuresOf(() => jobsRound(env, deps))).toEqual([]);
    expect(counting.calls.filter((name) => STORE_CALLS.includes(name)).toSorted()).toEqual(STORE_CALLS);
    const after = await snapshot(store);
    for (const name of NAMES) {
      expect(after[name], name).not.toEqual(before[name]);
    }
  }, 60_000);
});

describe("one jobs round per Queue batch", () => {
  // `n` Follows signed by distinct remote actors, spooled while the Store was held (each replay stores its actor,
  // whose collections a jobs round reads, so each replay reports pending jobs), and a Store to replay them into.
  async function spooled(n: number) {
    const web = new RemoteWeb();
    const held = harness(await heldStore(), {}, undefined, { keygen: fixtureKeyGen, loader: web.loader });
    for (let i = 0; i < n; i++) {
      const actor = await mastodonActor(web, `b${i}`);
      const follow = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${actor.uri}#f`,
        type: "Follow",
        actor: actor.uri,
        object: "https://kopje.test/ap/users/alice",
      };
      expect((await held.request("/inbox", await signedInit(actor, "/inbox", follow))).status).toBe(202);
    }
    expect(held.queue.pending.map((m) => (m.body as { kind: string }).kind)).toEqual(Array<string>(n).fill("spool"));
    const store = await migratedStore();
    await completeSetup(store);
    const counting = countingStore(store);
    const env = { ...held.env, MAINTENANCE: "off" } as unknown as Env;
    const consume = () =>
      held.queue.deliver((batch) =>
        handleQueue(
          batch,
          env,
          inboxDeps(() => counting.stub, web.loader),
        ),
      );
    const actors = async () => (await sql(store, "SELECT 1 FROM accounts WHERE domain IS NOT NULL")).length;
    const syncs = async () => (await sql(store, "SELECT 1 FROM collection_syncs")).length;
    const rounds = () => counting.calls.filter((name) => name === "runInboundJobs").length;
    return { queue: held.queue, consume, actors, syncs, rounds, counting };
  }

  it("runs one round for replays that each report pending jobs", async () => {
    const t = await spooled(5);
    await t.consume();
    expect(await t.actors()).toBe(5);
    expect(t.rounds()).toBe(1);
    expect(t.counting.calls.filter((name) => STORE_CALLS.includes(name)).toSorted()).toEqual(STORE_CALLS);
    expect(kinds(t.queue, "spool")).toEqual([]);
    // The round synced COLLECTION_SYNCS_PER_ROUND of the five actors; the rest asks for the next round, once.
    expect(await t.syncs()).toBe(5 - COLLECTION_SYNCS_PER_ROUND);
    expect(kinds(t.queue, "inbound-jobs")).toEqual([JOBS]);
    expect(t.queue.retries).toBe(0);
  }, 60_000);

  it("runs one round and sends at most one jobs message for 3 jobs messages and 5 such replays", async () => {
    const t = await spooled(5);
    for (let i = 0; i < 3; i++) {
      await t.queue.send(JOBS);
    }
    await t.consume();
    expect(await t.actors()).toBe(5);
    expect(t.rounds()).toBe(1);
    expect(kinds(t.queue, "spool")).toEqual([]);
    // Every jobs message was acked; what is left is the round's own, for the syncs left.
    expect(await t.syncs()).toBe(5 - COLLECTION_SYNCS_PER_ROUND);
    expect(kinds(t.queue, "inbound-jobs")).toEqual([JOBS]);
    expect(
      t.queue.send.mock.calls.filter(([body]) => (body as { kind?: string }).kind === "inbound-jobs"),
    ).toHaveLength(3 + 1);
    expect(t.queue.retries).toBe(0);
  }, 60_000);
});

describe("a live Delete while a round holds before its send", () => {
  it("keeps its own nudge, and its job runs in the next round", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const note = mastodonNote(bob);
    await t.post(bob, create(bob, note));
    const row = (await statusRow(t.store, note.id))!;
    // A status whose deletion outlasts the request's batch: more boosts than PURGE_BATCH.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('4%017d', i), 'https://many.example/u/' || i, 'u' || i,
				'many.example' FROM n`,
      PURGE_BATCH + 50,
    );
    await sql(
      t.store,
      `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			SELECT printf('5%017d', CAST(substr(id, 2) AS INTEGER)), 'https://many.example/b/' || id, id, ?, 'public',
				'2026-10-11T13:00:00.000Z' FROM accounts WHERE domain = 'many.example'`,
      row.id,
    );
    // The family that reports pending: alice unlocked with more requests than one round accepts.
    await sql(
      t.store,
      `INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'pending' FROM accounts
			WHERE domain = 'many.example' AND id <= printf('4%017d', 25)`,
      ALICE,
    );
    await sql(t.store, "UPDATE local_accounts SET accept_requests_after = 0 WHERE account_id = ?", ALICE);
    t.queue.pending.length = 0;
    const reached = deferred();
    const release = deferred();
    let holding = true;
    const gated = {
      send: async (body: unknown, options?: QueueSendOptions) => {
        if (holding && (body as { kind?: string }).kind === "inbound-jobs") {
          holding = false;
          reached.resolve();
          await release.promise;
        }
        return t.queue.send(body, options);
      },
      metrics: () => t.queue.metrics(),
    } as unknown as Queue;
    const env = { ...t.env, MAINTENANCE: "off" } as unknown as Env;
    const deps = inboxDeps(() => t.store, t.web.loader);
    const round = jobsRound({ ...env, QUEUE: gated }, deps);
    const job = "SELECT done_at FROM inbound_jobs WHERE kind = 'delete' AND key = ?";
    try {
      await reached.promise;
      // The round committed its families and holds at its send; the live Delete commits and sends its own nudge.
      expect(await sql(t.store, "SELECT 1 FROM local_accounts WHERE accept_requests_after IS NOT NULL")).toHaveLength(
        1,
      );
      expect(kinds(t.queue, "inbound-jobs")).toEqual([]);
      expect(await t.post(bob, remove(bob, note.id))).toBe(202);
      expect(kinds(t.queue, "inbound-jobs")).toEqual([JOBS]);
      expect(await sql(t.store, job, row.id)).toEqual([{ done_at: null }]);
    } finally {
      release.resolve();
      await round;
    }
    expect(kinds(t.queue, "inbound-jobs")).toEqual([JOBS, JOBS]);
    // The next batch holds both nudges and runs one round, which finishes the Delete's job.
    await t.queue.deliver((batch) => handleQueue(batch, env, deps));
    expect(await sql(t.store, job, row.id)).toEqual([{ done_at: NOW }]);
    expect(await sql(t.store, "SELECT 1 FROM statuses WHERE reblog_of_id = ?", row.id)).toEqual([]);
  }, 60_000);
});

// A Store whose `failing` calls reject with `error` before they reach it.
function failingStore(store: StoreStub, failing: readonly string[], error: () => Error): StoreStub {
  return new Proxy(store, {
    get(target, key) {
      if (failing.includes(String(key))) {
        return () => Promise.reject(error());
      }
      return Reflect.get(target, key) as unknown;
    },
  });
}

// `n` quotes by bob of statuses not stored anywhere, due for verification now.
async function dueQuotes(t: Awaited<ReturnType<typeof setup>>, bobId: string, n: number): Promise<void> {
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
		INSERT INTO statuses (id, uri, account_id, visibility, published_at)
		SELECT printf('7%017d', i), 'https://mastodon.example/users/bob/statuses/q' || i, ?1, 'public',
			'2026-10-11T13:00:00.000Z' FROM n`,
    bobId,
    n,
  );
  await sql(
    t.store,
    `INSERT INTO quotes (status_id, quoted_uri, state, verify_after, updated_at)
		SELECT id, 'https://gone.example/statuses/' || id, 'pending', 0, '2026-10-11T13:00:00.000Z' FROM statuses
		WHERE id LIKE '7%'`,
  );
}

describe("Worker isolation of the round", () => {
  it("runs the quote verifications when every Store family and the collection syncs throw, and acks the message", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const bobId = await followed(t, bob);
    // Real work in both Worker families: bob's collections (his Follow stored him) and more quotes than one round.
    const syncs = "SELECT account_id, due_at, attempts FROM collection_syncs";
    const before = await sql(t.store, syncs);
    expect(before).toHaveLength(1);
    await dueQuotes(t, bobId, QUOTE_ROUND + 1);
    const claimedQuotes = "SELECT 1 FROM quotes WHERE generation > 0";
    expect(await sql(t.store, claimedQuotes)).toEqual([]);
    const failing = failingStore(t.store, [...STORE_CALLS, "claimCollectionSync"], () => new Error("test: fails"));
    const counting = countingStore(failing);
    t.queue.pending.length = 0;
    await t.queue.send(JOBS);
    const env = { ...t.env, MAINTENANCE: "off" } as unknown as Env;
    const failures = await failuresOf(() =>
      t.queue.deliver((batch) =>
        handleQueue(
          batch,
          env,
          inboxDeps(() => counting.stub, t.web.loader),
        ),
      ),
    );
    expect(failures).toEqual(
      [...STORE_JOB_FAMILIES.map(({ family }) => family), "collections"].map(
        (family) => expect.objectContaining({ family }) as unknown,
      ),
    );
    // Collections failed and kept their work; quotes ran a round, and the quote left over asks for the next one.
    expect(await sql(t.store, syncs)).toEqual(before);
    expect(await sql(t.store, claimedQuotes)).toHaveLength(QUOTE_ROUND);
    expect(t.queue.retries).toBe(0);
    expect(t.queue.pending.map((m) => m.body)).toEqual([JOBS]);
  }, 60_000);
});

describe("the delivery ring", () => {
  it("rings for the Store calls’ deliveries before the collection syncs fetch, and the jobs message follows", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    expect(await sql(t.store, "SELECT 1 FROM collection_syncs")).toHaveLength(1);
    // Unlock acceptances of remote requests deliver, and more than a round's are pending.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
			INSERT INTO accounts (id, uri, username, domain, inbox_url) SELECT printf('4%017d', i),
				'https://many.example/u/' || i, 'u' || i, 'many.example', 'https://many.example/u/' || i || '/inbox' FROM n`,
    );
    await sql(
      t.store,
      `INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'pending' FROM accounts
			WHERE domain = 'many.example'`,
      ALICE,
    );
    await sql(t.store, "UPDATE local_accounts SET accept_requests_after = 0 WHERE account_id = ?", ALICE);
    t.queue.pending.length = 0;
    const reached = deferred();
    const release = deferred();
    let holding = true;
    const loader = {
      ...t.web.loader,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (holding) {
          holding = false;
          reached.resolve();
          await release.promise;
        }
        return t.web.loader.fetch(input, init);
      },
    };
    const env = { ...t.env, MAINTENANCE: "off" } as unknown as Env;
    const round = jobsRound(
      env,
      inboxDeps(() => t.store, loader),
    );
    try {
      await reached.promise;
      expect(t.queue.pending.map((m) => m.body)).toEqual([DELIVER]);
    } finally {
      release.resolve();
      await round;
    }
    expect(t.queue.pending.map((m) => m.body)).toEqual([DELIVER, JOBS]);
  }, 60_000);
});

describe("Store refusals and failed stubs within a round (RES-5)", () => {
  it("ends the round at a retryable refusal after an earlier family reported pending, with nothing counted", async () => {
    const t = await setup();
    // Five inbound jobs: a round's four batches leave one, so the inbound family reports pending.
    await sql(
      t.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
			INSERT INTO inbound_jobs (kind, key, actor_uri, created_at)
			SELECT 'delete', printf('9%017d', i), 'https://one.example/users/x', ?1 FROM n`,
      NOW,
    );
    const reset = () => Object.assign(new Error("test: the object was reset"), { retryable: true });
    const counting = countingStore(failingStore(t.store, ["runModerationJobs"], reset));
    t.queue.pending.length = 0;
    const env = { ...t.env, MAINTENANCE: "off" } as unknown as Env;
    expect(
      await failuresOf(() =>
        jobsRound(
          env,
          inboxDeps(() => counting.stub, t.web.loader),
        ),
      ),
    ).toEqual([]);
    expect(await sql(t.store, "SELECT 1 FROM inbound_jobs WHERE done_at IS NULL")).toHaveLength(1);
    // The refused call is the last: no unlock acceptances, collection syncs or quote verifications.
    expect(counting.calls).toEqual([
      "runInboundJobs",
      "runDomainBlockCleanups",
      "runNotificationRequestJobs",
      "runModerationJobs",
    ]);
    expect(t.queue.pending).toEqual([]);
  });

  it("gives the family after a failure a newly resolved stub", async () => {
    const t = await setup();
    // Each resolution is a stub of its own; one whose call failed refuses every later call, as a broken stub does.
    let resolved = 0;
    const resolve = () => {
      resolved++;
      let broken = false;
      return new Proxy(t.store, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (typeof value !== "function") {
            return value;
          }
          return async (...args: unknown[]) => {
            if (broken) {
              throw new Error("test: a broken stub");
            }
            if (key === "runInboundJobs") {
              broken = true;
              throw new Error("test: the family fails");
            }
            return (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[String(key)]!(...args);
          };
        },
      });
    };
    const env = { ...t.env, MAINTENANCE: "off" } as unknown as Env;
    const failures = await failuresOf(() => jobsRound(env, inboxDeps(resolve, t.web.loader)));
    expect(failures).toEqual([expect.objectContaining({ family: "inbound" })]);
    expect(resolved).toBeGreaterThan(STORE_CALLS.length);
  });
});
