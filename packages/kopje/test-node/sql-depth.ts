// The expression depth of the Store's SQL, measured on Node: the SQLite of Durable Objects refuses a statement whose
// expression tree is deeper than 100, and workerd cannot lower that limit, while node:sqlite can. The Workers suites
// send every statement they run through Db here (test/sql-depth-setup.ts, through the SQL_DEPTH binding of
// vitest.config.ts), so a statement nearing the limit fails the suite that runs it, not a request in production.

import type { DatabaseSync } from "node:sqlite";

import { createKopjeDatabase } from "../cli/lib/cutover/kopje-db.js";

// The suites allow 10 levels less than the Store does: a variant of a statement no test runs (another viewer kind, an
// extra filter) nests a few levels more or less than the one a test runs.
export const ALLOWED_EXPR_DEPTH = 90;
const MEASURED_UP_TO = 1000;

// As test/sql-depth-setup.ts reads it.
export type DeepStatement = { depth: number; sql: string };

let database: DatabaseSync | undefined;

// Each statement of `statements` deeper than ALLOWED_EXPR_DEPTH, with its depth. A statement that fails to compile for
// another reason throws, and so does a batch (SqlStorage.exec runs every statement of a text, prepare compiles the
// first): the guard does not skip what it cannot measure.
export function deepStatements(statements: string[]): DeepStatement[] {
  database ??= createKopjeDatabase();
  const db = database;
  const compiles = (sql: string, depth: number): boolean => {
    db.limits.exprDepth = depth;
    try {
      if (db.prepare(sql).sourceSQL.trimEnd() !== sql.trimEnd()) {
        throw new Error("a batch of statements");
      }
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Expression tree is too large")) {
        return false;
      }
      throw new Error(`cannot compile a Store statement on Node: ${String(error)}\n${sql}`, { cause: error });
    }
  };
  const deep: DeepStatement[] = [];
  for (const sql of statements) {
    if (compiles(sql, ALLOWED_EXPR_DEPTH)) {
      continue;
    }
    let low = ALLOWED_EXPR_DEPTH + 1;
    let high = MEASURED_UP_TO;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compiles(sql, middle)) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    deep.push({ depth: low, sql });
  }
  return deep;
}

// The SQL_DEPTH binding: a JSON array of statements in, the deep ones out.
export async function sqlDepthService(request: Request): Promise<Response> {
  return Response.json(deepStatements((await request.json()) as string[]));
}
