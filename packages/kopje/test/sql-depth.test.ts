import { describe, expect, it } from "vitest";

import { measure, statements } from "./sql-depth-setup";
import { community, post } from "./status-helpers";

// The guard of test/sql-depth-setup.ts: it sees the statements the Store runs, and it reports a deep one.
describe("expression depth guard", () => {
  const nested = (depth: number) => `SELECT ${"-(".repeat(depth - 1)}1${")".repeat(depth - 1)}`;

  it("records the statements the Store runs through Db", async () => {
    const h = await community(["alice", "bob"]);
    await post(h, h.users.alice, { status: "@bob hi" });
    expect([...statements].some((sql) => sql.includes("INSERT INTO notifications"))).toBe(true);
  });

  it("reports a statement the Store would refuse, with its depth", async () => {
    expect(await measure([nested(10), nested(101)])).toEqual([{ depth: 101, sql: nested(101) }]);
  });

  it("refuses a batch, whose later statements it would not measure", async () => {
    await expect(measure([`SELECT 1; ${nested(101)}`])).rejects.toThrow("a batch of statements");
  });
});
