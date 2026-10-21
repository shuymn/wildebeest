import type { Db } from './sql'

// A write of rows of an INTEGER PRIMARY KEY table by key: `ids` selects them (`CAST(id AS TEXT) AS id`, so an id past
// 2^53 is never rounded), and `each` writes one, its id as ?1. An IN over the selection would let statistics older
// than the Store's growth scan the table written (RES-7); one statement per row seeks it.
export type ByIds = { readonly ids: string; readonly each: string }

// Runs `write` over what its selection returns with `params`, each row by its own statement; how many rows the
// statements changed. The rows written are those an IN over the same selection writes.
export function writeEach(db: Db, write: ByIds, ...params: SqlStorageValue[]): number {
	let written = 0
	for (const { id } of db.all<{ id: string }>(write.ids, ...params)) {
		written += db.run(write.each, id)
	}
	return written
}
