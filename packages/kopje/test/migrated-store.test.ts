import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import { freshStore, MIGRATION_NAMES, migratedStore, testKernel } from "./helpers";

// migratedStore() replays a template Store's schema and rows instead of applying the migrations (test/helpers.ts):
// the Store it gives is the one the upgrade leaves.

// Every schema object, SQLite's own included, and the rows of every table, workerd's own (_cf_*) left out. When each
// file was applied is left out of the bookkeeping.
async function contents(store: StoreStub) {
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const objects = sql
      .exec<{ type: string; name: string; tbl_name: string; sql: string | null }>(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 4) <> '_cf_' ORDER BY type, name",
      )
      .toArray();
    const rows = Object.fromEntries(
      objects
        .filter((o) => o.type === "table")
        .map(({ name }) => {
          const select = name === "kopje_migrations" ? "SELECT name, checksum" : "SELECT *";
          const found = sql.exec(`${select} FROM "${name}"`).toArray();
          return [name, found.map((row) => JSON.stringify(row)).toSorted()];
        }),
    );
    return { objects, rows };
  });
}

describe("migratedStore", () => {
  it("leaves the schema and rows the upgrade leaves", async () => {
    const upgraded = freshStore();
    const result = await runInDurableObject(upgraded, (_instance, state) => testKernel(state).upgrade());
    expect(result).toMatchObject({ ok: true, applied: MIGRATION_NAMES });

    const replayed = await contents(await migratedStore());
    expect(replayed.rows.kopje_migrations).toHaveLength(MIGRATION_NAMES.length);
    expect(replayed).toEqual(await contents(upgraded));
  });

  it("is a Store the kernel finds current, with every reference holding", async () => {
    const store = await migratedStore();
    await runInDurableObject(store, async (_instance, state) => {
      expect(await testKernel(state).upgrade()).toEqual({ ok: true, bookmark: null, applied: [] });
      const sql = state.storage.sql;
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
