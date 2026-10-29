import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import { writeFlag } from "../src/platform/store-flags";
import { BUILD, freshStore, migratedStore, testKernel } from "./helpers";
import {
  ACCESS,
  copyConfig,
  dumpViaRpc,
  ensureAdmin,
  importViaRpc,
  seedStore,
  splitDump,
  tableSnapshot,
} from "./ops-helpers";

const ACCOUNT = "110000000000000001";

async function seeded(): Promise<StoreStub> {
  const store = await migratedStore();
  await seedStore(store, 0);
  return store;
}

async function roundTrip(source: StoreStub) {
  const { text } = await dumpViaRpc(source);
  const target = await migratedStore();
  await copyConfig(source, target);
  const { report } = await importViaRpc(target, text);
  return { text, target, report };
}

function withoutState(snapshot: Record<string, string[]>) {
  const { kopje_state: _state, ...rest } = snapshot;
  return rest;
}

describe("dump and import of values at the platform limits", () => {
  it("imports a TEXT value larger than the 100 KB SQL statement limit", async () => {
    const source = await seeded();
    await runInDurableObject(source, (_instance, state) => {
      state.storage.sql.exec("UPDATE accounts SET search_text = ? WHERE id = ?", "n".repeat(150_000), ACCOUNT);
    });
    const { target, report } = await roundTrip(source);
    expect(report).toMatchObject({ ok: true });
    expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)));
  });

  it("dumps and imports a BLOB of more than 1 MB and TEXT with NUL of more than 1 MB", async () => {
    const source = await seeded();
    await runInDurableObject(source, (_instance, state) => {
      const blob = new Uint8Array(1_100_000).map((_, i) => (i * 7) & 0xff);
      state.storage.sql.exec("UPDATE local_accounts SET privkey = ? WHERE account_id = ?", blob, ACCOUNT);
      state.storage.sql.exec(
        "UPDATE accounts SET search_text = ? WHERE id = ?",
        `a${String.fromCharCode(0)}${"b".repeat(1_100_000)}`,
        ACCOUNT,
      );
    });
    const { target, report } = await roundTrip(source);
    expect(report).toMatchObject({ ok: true });
    expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)));
  });

  it("keeps the exact bytes of TEXT that is not valid UTF-8, and verification depends on them", async () => {
    const source = await seeded();
    await runInDurableObject(source, (_instance, state) => {
      state.storage.sql.exec("UPDATE accounts SET note = CAST(X'6180FF62' AS TEXT) WHERE id = ?", ACCOUNT);
    });
    const { text, target, report } = await roundTrip(source);
    expect(text).toContain(`CAST(X'6180FF62' AS TEXT)`);
    expect(report).toMatchObject({ ok: true });
    const hex = (store: StoreStub) =>
      runInDurableObject(
        store,
        (_instance, state) =>
          state.storage.sql
            .exec<{ h: string }>("SELECT hex(CAST(note AS BLOB)) AS h FROM accounts WHERE id = ?", ACCOUNT)
            .one().h,
      );
    expect(await hex(target)).toBe("6180FF62");
    expect(await hex(target)).toBe(await hex(source));
  });

  it("writes REAL values in one canonical form, also in INTEGER columns", async () => {
    const source = await seeded();
    await runInDurableObject(source, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE accounts SET followers_count = ?, following_count = ? WHERE id = ?",
        1.2345678901234567,
        1e300,
        ACCOUNT,
      );
    });
    const { text, target, report } = await roundTrip(source);
    // ECMAScript's shortest round-trip spelling of the stored double, whatever SQLite's quote() would print.
    expect(text).toContain(",1.2345678901234567,1e+300,");
    expect(report).toMatchObject({ ok: true });
    const types = await runInDurableObject(target, (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT typeof(followers_count) AS a, followers_count AS b, typeof(following_count) AS c FROM accounts WHERE id = ?",
          ACCOUNT,
        )
        .one(),
    );
    expect(types).toEqual({ a: "real", b: 1.2345678901234567, c: "real" });
  });
});

describe("dump freeze and upgrade", () => {
  it("does not record or apply an upgrade when a dump starts while the bookmark is taken", async () => {
    const store = freshStore();
    await runInDurableObject(store, async (_instance, state) => {
      const kernel = testKernel(state, undefined, {
        inject: (phase) => {
          if (phase === "bookmark") {
            // A dump takes the lease while the upgrade awaits its bookmark.
            writeFlag(state.storage.sql, "dump", {
              id: "concurrent",
              startedAt: Date.now(),
              leaseMs: 600_000,
              leaseUntil: Date.now() + 600_000,
              header: { format: 1, createdAt: "", source: { build: BUILD, version: "" }, migrations: [], tables: [] },
              results: [],
            });
          }
        },
      });
      expect(await kernel.upgrade()).toMatchObject({ ok: false, reason: "dump-in-progress" });
      const sql = state.storage.sql;
      expect(sql.exec("SELECT count(*) AS n FROM kopje_migrations").one().n).toBe(0);
      expect(sql.exec("SELECT count(*) AS n FROM kopje_state WHERE name IN ('upgrade', 'hold')").one().n).toBe(0);
    });
  });
});

describe("dump completion", () => {
  it("answers a repeated finish with the same trailer after the freeze is released", async () => {
    const store = await seeded();
    const started = await store.dumpStart(BUILD);
    if (!started.ok) throw new Error(started.message);
    let cursor = started.cursor;
    for (;;) {
      const step = await store.dumpNext(BUILD, cursor);
      if (!step.ok) throw new Error(step.message);
      cursor = step.cursor;
      if (step.done) break;
    }
    const first = await store.dumpFinish(BUILD, cursor);
    expect(first).toMatchObject({ ok: true, aborted: false });
    expect(await store.health(BUILD)).toMatchObject({ dump: null, readonly: false });
    expect(await store.dumpFinish(BUILD, cursor)).toEqual(first);
    // A new dump can start; the receipt does not freeze anything.
    expect(await store.dumpStart(BUILD)).toMatchObject({ ok: true });
  });
});

describe("import resume", () => {
  it("resumes a finished import at verification without resetting its progress", async () => {
    const { text } = await dumpViaRpc(await seeded());
    const { header, trailer } = splitDump(text);
    const target = await migratedStore();
    await ensureAdmin(target);
    const begun = await target.importBegin(BUILD, ACCESS, header);
    if (!begun.ok) throw new Error(begun.message);
    const { importChunks } = await import("./ops-helpers");
    for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
      await target.importChunk(BUILD, ACCESS, begun.progress.id, i + 1, chunk);
    }
    expect(await target.importFinish(BUILD, ACCESS, begun.progress.id, trailer)).toMatchObject({ ok: true });

    const resumed = await target.importBegin(BUILD, ACCESS, header);
    expect(resumed).toMatchObject({ ok: true, resumed: true, progress: { id: begun.progress.id, state: "finished" } });
    expect(await target.importVerify(BUILD, ACCESS, begun.progress.id)).toMatchObject({
      ok: true,
      done: true,
      report: { ok: true },
    });
  });
});
