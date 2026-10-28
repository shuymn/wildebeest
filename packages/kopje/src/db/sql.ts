type Row = Record<string, SqlStorageValue>;

// A nested transactionSync of the Store's storage, inside the operation's transaction: a named SQLite savepoint, which
// commits into the enclosing transaction or rolls back to where it began. Its rollback does not reduce total_changes().
export type Savepoint = <T>(fn: () => T) => T;

// Thin typed access to the Store's SQLite. Only used inside a Store transaction.
export class Db {
  // The operation's own Db: each operation runs on one (operation.ts), and every metered view of it shares its root,
  // so a memo of the operation (admin-authority.ts) keys on it.
  readonly root: Db;

  // savepoint: absent where no nested transaction can run (a Db over another SQLite, maintenance-render.ts).
  constructor(
    private readonly sql: SqlStorage,
    private readonly nested?: Savepoint,
    private readonly meter?: RowMeter,
    root?: Db,
  ) {
    this.root = root ?? this;
  }

  // Runs fn in a savepoint of the enclosing transaction: its writes commit with that transaction, or are rolled back
  // alone when fn throws (the error propagates). Refused without the capability, never run inline.
  savepoint<T>(fn: () => T): T {
    if (this.nested === undefined) {
      throw new Error("savepoint unavailable");
    }
    return this.nested(fn);
  }

  all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
    return this.meter === undefined
      ? this.sql.exec<T>(query, ...params).toArray()
      : [...this.iterate<T>(query, ...params)];
  }

  first<T extends Row>(query: string, ...params: SqlStorageValue[]): T | undefined {
    return this.all<T>(query, ...params)[0];
  }

  run(query: string, ...params: SqlStorageValue[]): number {
    return this.sql.exec(query, ...params).rowsWritten;
  }

  // The rows of `query` one at a time, as the cursor steps: workerd's SqlStorageCursor runs the statement lazily, one
  // row per step (test/status-rows.test.ts), so a meter that throws stops the statement at the row that passed its cap.
  *iterate<T extends Row>(query: string, ...params: SqlStorageValue[]): Generator<T, undefined> {
    for (const row of this.sql.exec<T>(query, ...params)) {
      this.meter?.add(row);
      yield row;
    }
  }

  metered(meter: RowMeter): Db {
    return new Db(this.sql, this.nested, meter, this.root);
  }
}

// A row's heap as a JavaScript object, in bytes, by the model of "Heap at 8 MiB per answer" (docs/threat-model.md);
// shared by rowHeapSql (src/db/columns.ts) and RowMeter.
export const ROW_OBJECT_BYTES = 64;
export const VALUE_BYTES = 32;

export function rowHeapBytes(row: Row): number {
  let bytes = ROW_OBJECT_BYTES;
  for (const value of Object.values(row)) {
    bytes +=
      VALUE_BYTES +
      (typeof value === "string" ? 2 * value.length : value instanceof ArrayBuffer ? value.byteLength : 0);
  }
  return bytes;
}

export class RowCapExceeded extends Error {
  constructor(readonly cap: number) {
    super(`the rows read passed ${cap} bytes of heap`);
    this.name = "RowCapExceeded";
  }
}

// The runtime backstop of a memory bound that rests on an estimate: it adds each row's heap (rowHeapBytes) as the row
// arrives and throws RowCapExceeded once the total passes `cap`, so the rows held are at most `cap` plus the last row.
export class RowMeter {
  total = 0;

  constructor(readonly cap: number) {}

  add(row: Row): void {
    this.total += rowHeapBytes(row);
    if (this.total > this.cap) {
      throw new RowCapExceeded(this.cap);
    }
  }
}
