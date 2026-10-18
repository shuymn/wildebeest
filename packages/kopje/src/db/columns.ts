// The result columns of a query as one map, name to SQL expression, from which both the select list and the bound of
// a row's payload are generated, so the bound cannot drift from what the query reads (RES-3, "Heap at 8 MiB per
// answer" in docs/threat-model.md). A leaf: modules that build SQL at load can import it whatever the import order.

export type ColumnMap = Readonly<Record<string, string>>

// The payload a value counts at least: a number or NULL, as test/answer-budgets.test.ts counts SQLite bytes.
const VALUE_BYTES = 8

export function selectSql(columns: ColumnMap): string {
	return Object.entries(columns)
		.map(([name, expression]) => `${expression} AS ${name}`)
		.join(', ')
}

// An upper bound on the payload of one row of `columns`: the UTF-8 bytes of each text value (octet_length does not
// load the value), and VALUE_BYTES for any value shorter or not text. The sum is a balanced tree, so its expression
// depth grows with the logarithm of the column count (SQLite refuses a tree deeper than 100; test-node/sql-depth.ts).
export function rowBytesSql(columns: ColumnMap): string {
	return balancedSum(
		Object.values(columns).map(
			(expression) => `coalesce(max(${VALUE_BYTES}, octet_length(${expression})), ${VALUE_BYTES})`
		)
	)
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

// Columns whose values have a fixed largest size (ids, flags, numbers): the payload of one row is a constant.
export type FixedColumns = { readonly columns: ColumnMap; readonly rowBytes: number }

// `bytes`: the most UTF-8 bytes each column's value takes.
export function fixedColumns<C extends ColumnMap>(
	columns: C,
	bytes: { readonly [K in keyof C]: number }
): FixedColumns {
	return {
		columns,
		rowBytes: Object.keys(columns).reduce((sum, name) => sum + Math.max(VALUE_BYTES, bytes[name]!), 0),
	}
}
