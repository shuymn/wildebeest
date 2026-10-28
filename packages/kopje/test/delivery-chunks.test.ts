import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claimDeliveries, EXPANSION_STEP, TARGET_CHUNK_BYTES, TARGET_CHUNK_SIZE } from "../src/domain/deliveries";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, migratedStore } from "./helpers";
import { ACCESS, copyConfig, dumpViaRpc, ensureAdmin, importViaRpc } from "./ops-helpers";
import { community } from "./status-helpers";

// The lifecycle of an intent's target chunks (RES-6): the chunk boundary, several intents across chunks with lane
// order kept, an Update replacing a partly expanded intent, a claim that fails at a chunk transition, a dump and
// import of a partly expanded intent, and a target too large for any chunk.

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
  (await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n;

afterEach(() => {
  vi.restoreAllMocks();
});

// `n` accepted remote followers of alice, each with a personal inbox and no shared inbox. `servers` spreads them over
// that many origins (one per follower by default); `pad` lengthens each inbox.
async function withFollowers(n: number, options: { servers?: number; pad?: string } = {}) {
  const h = await community(["alice"]);
  const servers = options.servers ?? n;
  await sql(
    h.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		SELECT printf('6%017d', i), 'https://s' || (i % ?2) || '.example/users/u' || i, 'u' || i, 's' || (i % ?2) || '.example',
			'https://s' || (i % ?2) || '.example/users/u' || i || '/inbox' || ?3, '' FROM n`,
    n,
    servers,
    options.pad ?? "",
  );
  await sql(
    h.store,
    "INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '6*'",
    h.users.alice.id,
  );
  const post = async (status: string) => {
    const response = await h.request("/api/v1/statuses", bearer(h.users.alice.token, json({ status })));
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string; uri: string };
  };
  return { ...h, post };
}

const chunks = (store: StoreStub) =>
  sql<{ activity: string; size: number; next: number; bytes: number }>(
    store,
    `SELECT CAST(activity_id AS TEXT) AS activity, json_array_length(targets) AS size, next, length(targets) AS bytes
		FROM outbound_targets ORDER BY id`,
  );

// Claims until nothing is left to expand, checking that each claim expands at most one step.
async function drain(store: StoreStub, rounds = 100) {
  let rows = await count(store, "SELECT 1 FROM deliveries");
  for (let round = 0; round < rounds && (await count(store, "SELECT 1 FROM outbound_targets")) > 0; round++) {
    await store.claimDeliveries(BUILD, { now: NOW, leaseToken: `drain-${round}` });
    const next = await count(store, "SELECT 1 FROM deliveries");
    expect(next - rows).toBeLessThanOrEqual(EXPANSION_STEP);
    rows = next;
  }
  expect(await count(store, "SELECT 1 FROM outbound_targets")).toBe(0);
}

// The deliveries of the Create of each status, by inbox.
const createsOf = (store: StoreStub, uri: string) =>
  sql<{ inbox_url: string; n: number }>(
    store,
    `SELECT d.inbox_url, count(*) AS n FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
		WHERE json_extract(o.body, '$.activity.type') = 'Create' AND json_extract(o.body, '$.activity.object.id') = ?
		GROUP BY d.inbox_url`,
    uri,
  );

describe("RES-6: target chunks", () => {
  it.each([TARGET_CHUNK_SIZE, TARGET_CHUNK_SIZE + 1, 1000])(
    "splits %i short targets at the chunk boundary and delivers each once",
    async (n) => {
      const h = await withFollowers(n);
      const status = await h.post("hello");
      // The recording transaction expanded one step; the rest wait in whole chunks.
      const left = await chunks(h.store);
      expect(left.map((c) => c.size)).toEqual(
        Array.from({ length: Math.ceil(n / TARGET_CHUNK_SIZE) - 1 }, (_, i) =>
          Math.min(TARGET_CHUNK_SIZE, n - TARGET_CHUNK_SIZE * (i + 1)),
        ),
      );
      expect(left.every((c) => c.next === 0)).toBe(true);
      await drain(h.store);
      const creates = await createsOf(h.store, status.uri);
      expect(creates).toHaveLength(n);
      expect(creates.every((c) => c.n === 1)).toBe(true);
    },
  );

  it("keeps lane order across two intents that span chunks", async () => {
    const h = await withFollowers(250, { servers: 5 });
    const first = await h.post("first");
    const second = await h.post("second");
    expect((await chunks(h.store)).length).toBeGreaterThan(2);
    await drain(h.store);
    const rows = await sql<{ lane: string; object: string }>(
      h.store,
      `SELECT d.lane, json_extract(o.body, '$.activity.object.id') AS object
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
    );
    expect(rows).toHaveLength(500);
    for (const lane of new Set(rows.map((r) => r.lane))) {
      const order = rows.filter((r) => r.lane === lane).map((r) => r.object);
      expect(order).toEqual([...order.filter((o) => o === first.uri), ...order.filter((o) => o === second.uri)]);
      expect(order.filter((o) => o === first.uri)).toHaveLength(50);
    }
    expect(second.uri).not.toBe(first.uri);
  });

  // The first post leaves 50 targets; the second's recording expands them and the first 50 of its own first chunk.
  async function partlyExpanded() {
    const h = await withFollowers(150);
    const first = await h.post("first");
    const second = await h.post("second");
    const left = await chunks(h.store);
    expect(left.map((c) => [c.size, c.next])).toEqual([
      [100, 50],
      [50, 0],
    ]);
    return { h, first, second };
  }

  it("leaves no stale chunk when an Update replaces a partly expanded intent", async () => {
    const { h, first, second } = await partlyExpanded();
    const edited = await h.request(
      `/api/v1/statuses/${second.id}`,
      bearer(h.users.alice.token, json({ status: "second, edited" }, { method: "PUT" })),
    );
    expect(edited.status).toBe(200);
    const left = await chunks(h.store);
    expect(left.every((c) => c.next < c.size)).toBe(true);
    const original = await sql<{ id: string }>(
      h.store,
      `SELECT CAST(id AS TEXT) AS id FROM outbound_activities
			WHERE json_extract(body, '$.activity.object.id') = ? AND json_extract(body, '$.activity.object.content') LIKE '%second</p>%'`,
      second.uri,
    );
    for (const { id } of original) {
      expect(await count(h.store, "SELECT 1 FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER)", id)).toBe(0);
    }
    await drain(h.store);
    const creates = await createsOf(h.store, second.uri);
    expect(creates).toHaveLength(150);
    expect(creates.every((c) => c.n === 1)).toBe(true);
    expect((await createsOf(h.store, first.uri)).every((c) => c.n === 1)).toBe(true);
    // Each server new to the status gets the edit after the Create too (deliveries.ts enqueueActivity), once.
    expect(
      await count(
        h.store,
        `SELECT 1 FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE json_extract(o.body, '$.activity.type') = 'Update'`,
      ),
    ).toBe(150);
  });

  it("changes nothing when a claim fails at a chunk transition, and the next claim resumes", async () => {
    const { h, second } = await partlyExpanded();
    const snapshot = async () => ({
      chunks: await chunks(h.store),
      deliveries: await sql(h.store, "SELECT id, inbox_url, state FROM deliveries ORDER BY id"),
    });
    const before = await snapshot();
    // The claim expands across the end of the first chunk into the next, then the transaction fails.
    await runInDurableObject(h.store, (_instance, state) => {
      expect(() =>
        state.storage.transactionSync(() => {
          claimDeliveries.run(state.storage.sql, { now: NOW, leaseToken: "crash" });
          throw new Error("crash");
        }),
      ).toThrow("crash");
    });
    expect(await snapshot()).toEqual(before);
    await drain(h.store);
    const creates = await createsOf(h.store, second.uri);
    expect(creates).toHaveLength(150);
    expect(creates.every((c) => c.n === 1)).toBe(true);
  });

  it("restores a partly expanded intent from a dump and delivers each remaining target once", async () => {
    const { h, first, second } = await partlyExpanded();
    await ensureAdmin(h.store);
    const { text } = await dumpViaRpc(h.store);
    const target = await migratedStore();
    await copyConfig(h.store, target);
    const { report } = await importViaRpc(target, text);
    expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0 });
    // An imported Store is readonly until published.
    expect(await target.publish(BUILD, ACCESS)).toMatchObject({ ok: true });
    expect(await chunks(target)).toEqual(await chunks(h.store));
    await drain(target);
    for (const uri of [first.uri, second.uri]) {
      const creates = await createsOf(target, uri);
      expect(creates).toHaveLength(150);
      expect(creates.every((c) => c.n === 1)).toBe(true);
    }
  });

  it("leaves out a target too large for any chunk, counted and logged without its value", async () => {
    const h = await withFollowers(3);
    const huge = `https://huge.example/inbox/${"x".repeat(TARGET_CHUNK_BYTES)}`;
    await sql(h.store, "UPDATE accounts SET inbox_url = ? WHERE id = printf('6%017d', 1)", huge);
    const warn = vi.spyOn(console, "warn");
    const status = await h.post("hello");
    const largest = (
      await sql<{ n: number | null }>(h.store, "SELECT max(length(targets)) AS n FROM outbound_targets")
    )[0]!.n;
    expect(largest ?? 0).toBeLessThanOrEqual(TARGET_CHUNK_BYTES);
    await drain(h.store);
    const creates = await createsOf(h.store, status.uri);
    expect(creates.map((c) => c.inbox_url)).not.toContain(huge);
    expect(creates).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith({ event: "kopje.delivery.oversized_target", count: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("huge.example");
  });
});
