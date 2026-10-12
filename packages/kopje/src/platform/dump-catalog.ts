import { isLiteral, quoteIdentifier, type TableSpec } from './dump-format'

// What a dump contains, read from the live schema so a new migration needs no change here.
//
// Excluded, never restored blindly:
//   kopje_migrations      the header carries the applied migrations; the target recreates them with its runner
//   kopje_state           except the names in DUMPED_STATE. hold, upgrade, upgrade_bookmark (the bookmark belongs to
//                         the source object), maintenance, dump and import are state of one object at one time
//   _cf_*                 platform internals
//   sqlite_* internals    except sqlite_sequence (AUTOINCREMENT counters), which is restored by name
export const STATE_TABLE = 'kopje_state'
export const DUMPED_STATE = ['last_local_id'] as const
export const SEQUENCE_TABLE = 'sqlite_sequence'

function excluded(name: string): boolean {
	return (
		name === 'kopje_migrations' || name.startsWith('_cf_') || (name.startsWith('sqlite_') && name !== SEQUENCE_TABLE)
	)
}

type ForeignKey = { parent: string; columns: string[] }

export class CatalogError extends Error {}

export function readCatalog(sql: SqlStorage): TableSpec[] {
	const tables = sql
		.exec<{ name: string; sql: string | null }>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name COLLATE BINARY"
		)
		.toArray()
		.filter((t) => !excluded(t.name))

	const specs = new Map<string, TableSpec>()
	const foreignKeys = new Map<string, ForeignKey[]>()
	for (const table of tables) {
		const info = sql
			.exec<{ name: string; pk: number; hidden: number }>(
				'SELECT name, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
				table.name
			)
			.toArray()
			.filter((c) => c.hidden === 0)
		const columns = info.map((c) => c.name)
		const key = info
			.filter((c) => c.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((c) => c.name)
		const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*$/i.test(table.sql ?? '')
		const spec: TableSpec = {
			name: table.name,
			columns,
			order:
				table.name === SEQUENCE_TABLE
					? { by: 'key', columns: ['name'] }
					: withoutRowid
						? { by: 'key', columns: key }
						: { by: 'rowid' },
			key: table.name === SEQUENCE_TABLE ? ['name'] : key,
			deferred: [],
		}
		if (table.name === STATE_TABLE) {
			spec.only = { column: 'name', values: [...DUMPED_STATE] }
		}
		specs.set(table.name, spec)

		const byId = new Map<number, ForeignKey>()
		for (const fk of sql
			.exec<{
				id: number
				table: string
				from: string
			}>('SELECT id, "table", "from" FROM pragma_foreign_key_list(?) ORDER BY id, seq', table.name)
			.toArray()) {
			const entry = byId.get(fk.id) ?? { parent: fk.table, columns: [] }
			entry.columns.push(fk.from)
			byId.set(fk.id, entry)
		}
		foreignKeys.set(table.name, [...byId.values()])
	}

	// Parents before children (names break ties). A reference to the same table or, in a cycle, to a table not yet
	// placed is deferred: rows are inserted with NULL there and linked after all rows are in.
	const ordered: TableSpec[] = []
	const placed = new Set<string>()
	const remaining = [...specs.keys()].filter((name) => name !== SEQUENCE_TABLE)
	while (remaining.length > 0) {
		const ready = remaining.findIndex((name) =>
			(foreignKeys.get(name) ?? []).every((fk) => fk.parent === name || placed.has(fk.parent) || !specs.has(fk.parent))
		)
		const index = ready === -1 ? 0 : ready
		const name = remaining.splice(index, 1)[0] ?? ''
		const spec = specs.get(name)
		if (spec === undefined) {
			continue
		}
		const deferred = new Set<string>()
		for (const fk of foreignKeys.get(name) ?? []) {
			if (fk.parent === name || (specs.has(fk.parent) && !placed.has(fk.parent))) {
				fk.columns.forEach((column) => deferred.add(column))
			}
		}
		spec.deferred = spec.columns.filter((column) => deferred.has(column))
		if (spec.deferred.length > 0 && spec.key.length === 0) {
			throw new CatalogError(`${name} has deferred references but no primary key`)
		}
		placed.add(name)
		ordered.push(spec)
	}
	const sequence = specs.get(SEQUENCE_TABLE)
	if (sequence !== undefined) {
		ordered.push(sequence)
	}
	return ordered
}

// SQL literal of a value, as quote() writes it, except TEXT containing NUL (quote() would truncate it).
export function literalExpression(column: string): string {
	const q = quoteIdentifier(column)
	return `CASE WHEN typeof(${q}) = 'text' AND instr(${q}, char(0)) > 0 THEN 'CAST(' || quote(CAST(${q} AS BLOB)) || ' AS TEXT)' ELSE quote(${q}) END`
}

export function textLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

export type ScanMode = 'rows' | 'links'

// One row of a scan: the ordering key (to resume after it) and the literals of the selected columns. In rows mode
// those are all columns; in links mode the deferred columns followed by the primary key columns.
export type ScannedRow = { after: string[]; literals: string[] }

// Reads a table in its order, starting after a cursor key, and hands each row to `visit` until it returns false.
export function scanTable(
	sql: SqlStorage,
	spec: TableSpec,
	mode: ScanMode,
	after: readonly string[] | null,
	visit: (row: ScannedRow) => boolean
): void {
	const orderKeys = spec.order.by === 'rowid' ? ['CAST(rowid AS TEXT)'] : spec.order.columns.map(literalExpression)
	const selected = mode === 'rows' ? spec.columns : [...spec.deferred, ...spec.key]
	const where: string[] = []
	const bindings: string[] = []
	if (spec.only !== undefined) {
		where.push(`${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map(textLiteral).join(',')})`)
	}
	if (mode === 'links') {
		where.push(`(${spec.deferred.map((c) => `${quoteIdentifier(c)} IS NOT NULL`).join(' OR ')})`)
	}
	if (after !== null) {
		if (spec.order.by === 'rowid') {
			if (after.length !== 1 || !/^-?\d{1,19}$/.test(after[0] ?? '')) {
				throw new CatalogError(`invalid cursor key for ${spec.name}`)
			}
			where.push('rowid > CAST(? AS INTEGER)')
			bindings.push(after[0] ?? '')
		} else {
			if (after.length !== spec.order.columns.length || !after.every(isLiteral)) {
				throw new CatalogError(`invalid cursor key for ${spec.name}`)
			}
			where.push(`(${spec.order.columns.map(quoteIdentifier).join(',')}) > (${after.join(',')})`)
		}
	}
	const order = spec.order.by === 'rowid' ? 'rowid' : spec.order.columns.map(quoteIdentifier).join(',')
	const query =
		`SELECT ${[...orderKeys, ...selected.map(literalExpression)].join(', ')} FROM ${quoteIdentifier(spec.name)}` +
		(where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
		` ORDER BY ${order}`
	const width = orderKeys.length
	for (const raw of sql.exec(query, ...bindings).raw()) {
		const values = raw as string[]
		if (!visit({ after: values.slice(0, width), literals: values.slice(width) })) {
			return
		}
	}
}

export function rowCount(sql: SqlStorage, spec: TableSpec): number {
	const where =
		spec.only === undefined
			? ''
			: ` WHERE ${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map(textLiteral).join(',')})`
	return sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quoteIdentifier(spec.name)}${where}`).one().n
}
