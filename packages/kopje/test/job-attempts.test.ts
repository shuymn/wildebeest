import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db, RowMeter } from "../src/db/sql";
import { isolated } from "../src/domain/job-attempts";
import { readOperation, writeOperation } from "../src/domain/operation";
import type { StoreKernel } from "../src/platform/store-kernel";
import { BUILD, migratedStore, testKernel } from "./helpers";

// A step isolated in a savepoint of its operation's transaction (Db.savepoint, isolated in src/domain/job-attempts.ts),
// through a real Store kernel: the step's writes roll back alone, the operation's commit, and total_changes() keeps
// counting what was rolled back (docs/engineering.md, "Ordering, rounds and fences").

const PREFIX = "test.savepoint.";

const put = (db: Db, name: string) =>
  db.run("INSERT INTO instance_settings (name, value) VALUES (?, ?)", PREFIX + name, name);

const changes = (db: Db) => db.first<{ n: number }>("SELECT total_changes() AS n")!.n;

const names = readOperation((db) =>
  db
    .all<{ name: string }>("SELECT name FROM instance_settings WHERE name LIKE ? ORDER BY name", `${PREFIX}%`)
    .map((row) => row.name.slice(PREFIX.length)),
);

// A migrated Store, `body` run on a kernel of it whose state is loaded, and the names committed afterwards.
async function withKernel<T>(body: (kernel: StoreKernel, sql: SqlStorage) => Promise<T>): Promise<T> {
  const store = await migratedStore();
  return runInDurableObject(store, async (_instance, state) => {
    const kernel = testKernel(state);
    expect(await kernel.execute(BUILD, names, undefined)).toEqual([]);
    return body(kernel, state.storage.sql);
  });
}

describe("isolated (Db.savepoint)", () => {
  it("rolls back the step’s writes alone, commits the operation’s, and leaves total_changes() as it was", async () => {
    await withKernel(async (kernel) => {
      const run = writeOperation((db) => {
        put(db, "a");
        const before = changes(db);
        const step = isolated(db, () => {
          put(db, "b");
          put(db, "c");
          throw new Error("test: the step fails");
        });
        const after = changes(db);
        put(db, "d");
        return { step, before, after };
      });
      const { step, before, after } = await kernel.execute(BUILD, run, undefined);
      expect(step).toEqual({ ok: false, error: new Error("test: the step fails") });
      // The two rolled-back inserts still count.
      expect(after).toBe(before + 2);
      expect(await kernel.execute(BUILD, names, undefined)).toEqual(["a", "d"]);
    });
  });

  it("returns the step’s value and commits its writes when it does not throw", async () => {
    await withKernel(async (kernel) => {
      const run = writeOperation((db) => isolated(db, () => put(db, "a")));
      expect(await kernel.execute(BUILD, run, undefined)).toEqual({ ok: true, value: 1 });
      expect(await kernel.execute(BUILD, names, undefined)).toEqual(["a"]);
    });
  });

  it("catches a RAISE(ABORT) inside the step, and the transaction stays usable", async () => {
    await withKernel(async (kernel, sql) => {
      sql.exec(
        `CREATE TRIGGER test_refused BEFORE INSERT ON instance_settings WHEN NEW.name = '${PREFIX}refused'
				BEGIN SELECT RAISE(ABORT, 'test: refused'); END`,
      );
      const run = writeOperation((db) => {
        put(db, "a");
        const step = isolated(db, () => {
          put(db, "b");
          put(db, "refused");
        });
        put(db, "c");
        return step.ok ? null : String((step.error as Error).message);
      });
      expect(await kernel.execute(BUILD, run, undefined)).toContain("test: refused");
      expect(await kernel.execute(BUILD, names, undefined)).toEqual(["a", "c"]);
    });
  });

  it("nests: an inner failure leaves the outer step’s writes, and an outer failure takes the inner step’s too", async () => {
    await withKernel(async (kernel) => {
      const run = writeOperation((db) => {
        const kept = isolated(db, () => {
          put(db, "a");
          const inner = isolated(db, () => {
            put(db, "b");
            throw new Error("test: inner");
          });
          put(db, "c");
          return inner.ok;
        });
        const dropped = isolated(db, () => {
          const inner = isolated(db, () => put(db, "d"));
          put(db, "e");
          throw new Error(`test: outer after ${inner.ok}`);
        });
        return { kept, dropped };
      });
      expect(await kernel.execute(BUILD, run, undefined)).toEqual({
        kept: { ok: true, value: false },
        dropped: { ok: false, error: new Error("test: outer after true") },
      });
      expect(await kernel.execute(BUILD, names, undefined)).toEqual(["a", "c"]);
    });
  });

  it("returns a thrown NaN or other primitive as the step’s error", async () => {
    await withKernel(async (kernel) => {
      const run = writeOperation((db) =>
        [Number.NaN, "test: a string", 0, undefined].map((value) =>
          isolated(db, () => {
            put(db, "a");
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a thrown primitive is the case under test
            throw value;
          }),
        ),
      );
      expect(await kernel.execute(BUILD, run, undefined)).toEqual([
        { ok: false, error: Number.NaN },
        { ok: false, error: "test: a string" },
        { ok: false, error: 0 },
        { ok: false, error: undefined },
      ]);
      expect(await kernel.execute(BUILD, names, undefined)).toEqual([]);
    });
  });

  it("keeps the capability in a metered Db", async () => {
    await withKernel(async (kernel) => {
      const run = writeOperation((db) => {
        const metered = db.metered(new RowMeter(1_000_000));
        return isolated(metered, () => {
          put(metered, "a");
          throw new Error("test: the step fails");
        }).ok;
      });
      expect(await kernel.execute(BUILD, run, undefined)).toBe(false);
      expect(await kernel.execute(BUILD, names, undefined)).toEqual([]);
    });
  });

  // A real full rollback inside a savepoint (RAISE(ROLLBACK)) breaks workerd's output gate for the whole object, so the
  // kernel's transaction seam stands in for it: its nested transactions roll back the step's writes and then fail as
  // a rollback of an ended transaction does, with an error of their own.
  it("propagates a failure of the rollback itself instead of returning the step’s error", async () => {
    const store = await migratedStore();
    await runInDurableObject(store, async (_instance, state) => {
      let depth = 0;
      const transaction = <T>(fn: () => T): T => {
        depth++;
        try {
          return state.storage.transactionSync(fn);
        } catch (error) {
          throw depth > 1 ? new Error("test: cannot rollback - no transaction is active") : error;
        } finally {
          depth--;
        }
      };
      const kernel = testKernel(state, undefined, { transaction });
      let returned = false;
      const run = writeOperation((db) => {
        put(db, "a");
        isolated(db, () => {
          put(db, "b");
          throw new Error("test: the step fails");
        });
        returned = true;
        put(db, "c");
      });
      await expect(kernel.execute(BUILD, run, undefined)).rejects.toThrow("test: cannot rollback");
      expect(returned).toBe(false);
      expect(await kernel.execute(BUILD, names, undefined)).toEqual([]);
    });
  });
});

describe("Db.savepoint without the capability", () => {
  it("throws without running the step, and isolated propagates it", async () => {
    const store = await migratedStore();
    await runInDurableObject(store, (_instance, state) => {
      // A Db over the storage's SQL alone, as an operation run directly (op.run(sql, input)) builds it.
      const db = new Db(state.storage.sql);
      let ran = false;
      expect(() =>
        db.savepoint(() => {
          ran = true;
        }),
      ).toThrow("savepoint unavailable");
      expect(() =>
        isolated(db, () => {
          ran = true;
        }),
      ).toThrow("savepoint unavailable");
      expect(() => writeOperation((op) => isolated(op, () => put(op, "a"))).run(state.storage.sql, undefined)).toThrow(
        "savepoint unavailable",
      );
      expect(ran).toBe(false);
      // The guarded branch: with the storage's transactionSync, the same Db runs the step.
      expect(new Db(state.storage.sql, (fn) => state.storage.transactionSync(fn)).savepoint(() => 7)).toBe(7);
    });
  });
});
