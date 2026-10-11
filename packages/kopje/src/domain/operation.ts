import { Db } from '../db/sql'
import type { StoreOperation } from '../platform/store-kernel'

// Declares a domain operation. The Store runs it as one RPC inside one transactionSync, so "read, decide, write"
// is atomic. Operations are synchronous and do no external I/O; time and IDs arrive in the input.
export function readOperation<I, O>(run: (db: Db, input: I) => O): StoreOperation<I, O> {
	return { kind: 'read', run: (sql, input) => run(new Db(sql), input) }
}

export function writeOperation<I, O>(run: (db: Db, input: I) => O): StoreOperation<I, O> {
	return { kind: 'write', run: (sql, input) => run(new Db(sql), input) }
}
