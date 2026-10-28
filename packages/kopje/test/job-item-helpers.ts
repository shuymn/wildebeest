import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";

// A job item that fails (RES-5): test triggers `name`_u and `name`_d make every write of the item's own row in `table`,
// named by `key` (its key columns and their values), throw, except the writes of its retry state (attempts changes),
// so a batch or round of it fails at its row's write after its other writes, and its attempts are still recorded.
export async function failItem(
  store: StoreStub,
  table: string,
  key: Readonly<Record<string, SqlStorageValue>>,
  name: string,
): Promise<void> {
  const literal = (value: SqlStorageValue) => (typeof value === "number" ? String(value) : `'${value as string}'`);
  const old = Object.entries(key)
    .map(([column, value]) => `OLD.${column} = ${literal(value)}`)
    .join(" AND ");
  const fail = "BEGIN SELECT RAISE(ABORT, 'test: the item fails'); END";
  await sql(
    store,
    `CREATE TRIGGER ${name}_u BEFORE UPDATE ON ${table} WHEN ${old} AND NEW.attempts = OLD.attempts ${fail}`,
  );
  await sql(store, `CREATE TRIGGER ${name}_d BEFORE DELETE ON ${table} WHEN ${old} ${fail}`);
}
