type Row = Record<string, SqlStorageValue>

// Thin typed access to the Store's SQLite. Only used inside a Store transaction.
export class Db {
	constructor(
		private readonly sql: SqlStorage,
		private readonly meter?: RowMeter
	) {}

	all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
		return this.meter === undefined
			? this.sql.exec<T>(query, ...params).toArray()
			: [...this.iterate<T>(query, ...params)]
	}

	first<T extends Row>(query: string, ...params: SqlStorageValue[]): T | undefined {
		return this.all<T>(query, ...params)[0]
	}

	run(query: string, ...params: SqlStorageValue[]): number {
		return this.sql.exec(query, ...params).rowsWritten
	}

	// The rows of `query` one at a time, as the cursor steps: workerd's SqlStorageCursor runs the statement lazily, one
	// row per step (test/status-rows.test.ts), so a meter that throws stops the statement at the row that passed its cap.
	*iterate<T extends Row>(query: string, ...params: SqlStorageValue[]): Generator<T, undefined> {
		for (const row of this.sql.exec<T>(query, ...params)) {
			this.meter?.add(row)
			yield row
		}
	}

	metered(meter: RowMeter): Db {
		return new Db(this.sql, meter)
	}
}

// A row's heap as a JavaScript object, in bytes, by the model of "Heap at 8 MiB per answer" (docs/threat-model.md);
// shared by rowHeapSql (src/db/columns.ts) and RowMeter.
export const ROW_OBJECT_BYTES = 64
export const VALUE_BYTES = 32

export function rowHeapBytes(row: Row): number {
	let bytes = ROW_OBJECT_BYTES
	for (const value of Object.values(row)) {
		bytes +=
			VALUE_BYTES + (typeof value === 'string' ? 2 * value.length : value instanceof ArrayBuffer ? value.byteLength : 0)
	}
	return bytes
}

export class RowCapExceeded extends Error {
	constructor(readonly cap: number) {
		super(`the rows read passed ${cap} bytes of heap`)
		this.name = 'RowCapExceeded'
	}
}

// The runtime backstop of a memory bound that rests on an estimate: it adds each row's heap (rowHeapBytes) as the row
// arrives and throws RowCapExceeded once the total passes `cap`, so the rows held are at most `cap` plus the last row.
export class RowMeter {
	total = 0

	constructor(readonly cap: number) {}

	add(row: Row): void {
		this.total += rowHeapBytes(row)
		if (this.total > this.cap) {
			throw new RowCapExceeded(this.cap)
		}
	}
}
