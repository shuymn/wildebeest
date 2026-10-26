import type { Db } from '../db/sql'

export type Isolated<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Runs one step in its own savepoint of the operation's transaction (Db.savepoint): when fn throws, its writes are
// rolled back and its error is returned, and the operation goes on with the writes before and around it. An error
// that is not fn's own propagates: the savepoint is unavailable, or its rollback failed (SQLite already ended the
// transaction, as after an error it cannot recover from). A row budget for the step is created inside fn: the
// rollback does not reduce total_changes().
export function isolated<T>(db: Db, fn: () => T): Isolated<T> {
	const thrown: { error?: unknown; by: boolean } = { by: false }
	try {
		const value = db.savepoint(() => {
			try {
				return fn()
			} catch (error) {
				thrown.by = true
				thrown.error = error
				throw error
			}
		})
		return { ok: true, value }
	} catch (error) {
		if (thrown.by && error === thrown.error) {
			return { ok: false, error }
		}
		throw error
	}
}
