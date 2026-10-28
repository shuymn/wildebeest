import { Db } from "../db/sql";
import type { OperationKind, StoreOperation } from "../platform/store-kernel";

// Declares a domain operation. The Store runs it as one RPC inside one transactionSync, so "read, decide, write"
// is atomic. Operations are synchronous and do no external I/O; time and IDs arrive in the input. The kernel also passes
// a nested transactionSync, so a step can run in a savepoint of that transaction (Db.savepoint).
function declare(kind: OperationKind) {
  return <I, O>(run: (db: Db, input: I) => O): StoreOperation<I, O> => ({
    kind,
    run: (sql, input, savepoint) => run(new Db(sql, savepoint), input),
  });
}

export const readOperation = declare("read");

// A login or Web Push registration write: still served while the Store is readonly.
export const sessionOperation = declare("session");

export const writeOperation = declare("write");

// A write that dooms or deletes media, or picks R2 objects to delete: refused like any write, and also while the media
// rebuild holds its lease (platform/store-flags.ts).
export const mediaDeleteOperation = declare("media-delete");

// The media rebuild's writes only (domain/media-rebuild.ts); the gate admits them in readonly maintenance and while an
// import is unpublished (platform/store-flags.ts). Nothing else may be declared with it.
export const mediaRebuildOperation = declare("media-rebuild");
