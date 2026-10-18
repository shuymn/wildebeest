import { ROW_OBJECT_BYTES, VALUE_BYTES } from './sql'

// The result columns of a query as one map, name to SQL expression, from which both the select list and a bound of
// the heap a row takes are generated, so the bound cannot drift from what the query reads (RES-3, "Heap at 8 MiB per
// answer" in docs/threat-model.md). It imports only src/db/sql.ts, a leaf, so modules that build SQL at load can use
// it whatever the import order.

export type ColumnMap = Readonly<Record<string, string>>

export function selectSql(columns: ColumnMap): string {
	return Object.entries(columns)
		.map(([name, expression]) => `${expression} AS ${name}`)
		.join(', ')
}

// An upper bound on the heap one row of `columns` takes as RowMeter counts it (rowHeapBytes in src/db/sql.ts):
// ROW_OBJECT_BYTES, and for each value VALUE_BYTES and twice its UTF-8 bytes (octet_length, which does not load the
// value). A string's UTF-16 code units are at most its UTF-8 bytes; a number counts its decimal digits, which the
// meter does not, and NULL nothing. The sum is a balanced tree, so its expression depth grows with the logarithm of
// the column count (SQLite refuses a tree deeper than 100; test-node/sql-depth.ts).
export function rowHeapSql(columns: ColumnMap): string {
	return balancedSum([
		String(ROW_OBJECT_BYTES),
		...Object.values(columns).map((expression) => `(${VALUE_BYTES} + coalesce(2 * octet_length(${expression}), 0))`),
	])
}

export function balancedSum(terms: readonly string[]): string {
	if (terms.length === 0) {
		return '0'
	}
	if (terms.length === 1) {
		return terms[0]!
	}
	const half = Math.ceil(terms.length / 2)
	return `(${balancedSum(terms.slice(0, half))} + ${balancedSum(terms.slice(half))})`
}

// Columns whose values have a fixed largest size (ids, flags, numbers): the heap of one row is a constant.
export type FixedColumns = { readonly columns: ColumnMap; readonly rowHeap: number }

// `bytes`: the most UTF-8 bytes each column's value takes as text (0 for a number).
export function fixedColumns<C extends ColumnMap>(
	columns: C,
	bytes: { readonly [K in keyof C]: number }
): FixedColumns {
	return {
		columns,
		rowHeap: Object.keys(columns).reduce((sum, name) => sum + VALUE_BYTES + 2 * bytes[name]!, ROW_OBJECT_BYTES),
	}
}
