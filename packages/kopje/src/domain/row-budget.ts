import type { Db } from "../db/sql";

// The rows changed so far in the Store's connection (SQLite's total_changes()): every row a statement inserted, updated
// or deleted, cascades and trigger writes included. A savepoint's rollback does not reduce it (job-attempts.ts
// isolated), so a budget for a step that may roll back is created inside the step.
export function totalChanges(db: Db): number {
  return db.first<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0;
}

// The rows a step may change, counted with totalChanges from the budget's creation, so nothing the step writes
// escapes the count (RES-6). left() is clamped at zero; a caller that keeps a reserve computes its room from spent().
export class RowBudget {
  readonly #start: number;

  constructor(
    protected readonly db: Db,
    readonly limit: number,
  ) {
    this.#start = totalChanges(db);
  }

  spent(): number {
    return totalChanges(this.db) - this.#start;
  }

  left(): number {
    return Math.max(this.limit - this.spent(), 0);
  }
}
