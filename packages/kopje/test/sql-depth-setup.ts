import { env } from "cloudflare:workers";
import { afterAll, expect } from "vitest";

import { Db } from "../src/db/sql";

// Setup of every Workers suite (vitest.config.ts): records each distinct statement the suite runs through Db, in the
// Store or in a test, and after the suite has its expression depth measured on Node (test-node/sql-depth.ts). Db is
// where the domain code, and the policy fragments it composes (src/domain/audience.ts), run their SQL; the Store
// kernel's migrations and the dump, import and backup statements run on SqlStorage directly, as fixed or
// catalog-generated text without such nesting.

export const statements = new Set<string>();

// As test-node/sql-depth.ts reports one.
export type DeepStatement = { depth: number; sql: string };

// The suites run without isolation, so Db is loaded once per worker while this file runs again for each suite: Db is
// wrapped once, and each run points the wrapper at its own suite's set.
const recorder = Symbol.for("kopje.sql-depth.statements");
const prototype = Db.prototype as Db & { [recorder]?: Set<string> };
if (prototype[recorder] === undefined) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- each is called back on the Db it was called on
  const { all, run } = prototype;
  prototype.all = function (this: Db, query: string, ...params: SqlStorageValue[]) {
    prototype[recorder]!.add(query);
    return all.call(this, query, ...params);
  } as typeof all;
  prototype.run = function (this: Db, query: string, ...params: SqlStorageValue[]) {
    prototype[recorder]!.add(query);
    return run.call(this, query, ...params);
  };
}
prototype[recorder] = statements;

export async function measure(sql: string[]): Promise<DeepStatement[]> {
  const service = (env as unknown as { SQL_DEPTH: Fetcher }).SQL_DEPTH;
  const response = await service.fetch("http://sql-depth/", { method: "POST", body: JSON.stringify(sql) });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

afterAll(async () => {
  expect(await measure([...statements])).toEqual([]);
});
